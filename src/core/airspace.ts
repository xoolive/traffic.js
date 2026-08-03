/**
 * airspaceGeometry.ts
 *
 * Standalone utility to build consolidated GeoJSON geometry from an
 * AirspaceCompositeRecord's raw_layers array, mirroring the Python
 * traffic `unary_union_with_alt` semantics.
 *
 * This function is the canonical geometry builder for the JS/TS side.
 * It is called internally by both the EUROCONTROL DDR and FAA ArcGIS
 * adapters but can also be called directly from application code when
 * you have raw_layers available and want to (re)build geometry on demand.
 *
 * ## Data model
 *
 * A `RawLayer` is one altitude slice from the Rust `AirspaceLayerRecord`:
 * ```
 * { lower: number | null, upper: number | null,
 *   coordinates: Array<[lon: number, lat: number]> }
 * ```
 *
 * A `MergedLayer` is the output of the altitude-slice merge algorithm:
 * ```
 * { lower: number | null, upper: number | null,
 *   geometry: GeoJsonPolygon | GeoJsonMultiPolygon }
 * ```
 *
 * ## Algorithm (mirrors Python unary_union_with_alt exactly)
 *
 * 1. Parse each raw layer's coordinate ring into a turf Polygon Feature.
 *    Drop layers with fewer than 4 valid coordinate pairs (need ≥ 3
 *    distinct points + closing point to form a valid ring).
 *
 * 2. Collect all unique, non-null altitude boundary values (lower + upper)
 *    from all valid layers. Sort them ascending.
 *
 * 3. Edge case: fewer than 2 unique altitudes (single-band or all-null):
 *    union all layer polygons into one geometry with lower=null, upper=null.
 *
 * 4. For each consecutive pair of breakpoints [lo, hi]:
 *    a. Find all valid layers whose band **contains** [lo, hi]:
 *       `layer.lower <= lo && layer.upper >= hi`
 *    b. Union those covering polygons with turf.union.
 *    c. Adjacent-band collapsing: if the resulting geometry is
 *       **geometrically equal** to the previous merged layer (via
 *       turf.booleanEqual), extend the previous layer's `upper` to `hi`
 *       instead of pushing a new entry. This directly mirrors the Python:
 *       ```python
 *       if results and new_poly.polygon.equals(results[-1].polygon):
 *           results[-1] = ExtrudedPolygon(new_poly.polygon, results[-1].lower, up)
 *       ```
 *    d. On turf.union failure, fall back to `combineAsMultiPolygon` which
 *       collects all rings into a raw MultiPolygon without topology merging.
 *
 * 5. Return `{ layers: MergedLayer[], geometry: GeoJsonGeometry }` where
 *    `geometry` is the union of all merged-layer polygons (the footprint),
 *    matching what `Airspace.flatten()` does in Python.
 */

import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One altitude slice from the Rust wasm layer (coordinates = [lon, lat] pairs) */
export interface RawLayer {
  lower: number | null;
  upper: number | null;
  coordinates: Array<[number, number]>;
}

/** GeoJSON geometry types used in output */
export type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: Array<Array<[number, number]>>;
};

export type GeoJsonMultiPolygon = {
  type: 'MultiPolygon';
  coordinates: Array<Array<Array<[number, number]>>>;
};

export type GeoJsonGeometry = GeoJsonPolygon | GeoJsonMultiPolygon | null;

/** One consolidated altitude band with its merged geometry */
export interface MergedLayer {
  lower: number | null;
  upper: number | null;
  /** GeoJSON Polygon or MultiPolygon — NOT a Feature wrapper */
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
}

/** Full result of buildAirspaceGeometry */
export interface AirspaceGeometryResult {
  /**
   * Consolidated altitude bands after merging.
   * Adjacent bands with identical geometry are collapsed into one,
   * just like Python's unary_union_with_alt.
   */
  layers: MergedLayer[];
  /**
   * Flat 2D footprint: union of all merged-layer polygons.
   * Equivalent to Python's Airspace.flatten() / Airspace.shape.
   * null if no valid geometry could be computed.
   */
  geometry: GeoJsonGeometry;
}

// ---------------------------------------------------------------------------
// Internal helpers (mirrors eurocontrolDdr.ts / faaArcgis.ts private functions)
// ---------------------------------------------------------------------------

/**
 * Convert a raw coordinate array into a closed GeoJSON ring.
 * Returns [] if fewer than 3 valid points are found (ring would be degenerate).
 */
function toPolygonRing(raw: Array<[number, number]>): Array<[number, number]> {
  const ring = raw
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const lon = Number(pair[0]);
      const lat = Number(pair[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return [lon, lat] as [number, number];
    })
    .filter((v): v is [number, number] => v !== null);

  if (ring.length < 3) return [];

  // Close the ring if not already closed
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

/** Iteratively union a list of Polygon/MultiPolygon Features. */
function unionPolygons(
  features: Array<Feature<Polygon | MultiPolygon>>
): Feature<Polygon | MultiPolygon> | null {
  if (features.length === 0) return null;
  let merged = features[0];
  const failed: Array<Feature<Polygon | MultiPolygon>> = [];
  for (let i = 1; i < features.length; i++) {
    try {
      const result = turf.union(
        turf.featureCollection([merged, features[i]])
      ) as Feature<Polygon | MultiPolygon> | null;
      if (result) {
        merged = result;
      } else {
        failed.push(features[i]);
      }
    } catch {
      failed.push(features[i]);
    }
  }
  if (failed.length === 0) return merged;
  // Some pairs failed topologically — fold them in as extra rings.
  const fallbackGeom = combineAsMultiPolygon([merged, ...failed]);
  if (!fallbackGeom) return merged;
  return {
    type: 'Feature',
    properties: {},
    geometry: fallbackGeom,
  } as Feature<MultiPolygon>;
}

/** Fallback: collect all rings into a raw MultiPolygon without topology merging. */
function combineAsMultiPolygon(
  features: Array<Feature<Polygon | MultiPolygon>>
): GeoJsonMultiPolygon | null {
  if (features.length === 0) return null;
  const coords: Array<Array<Array<[number, number]>>> = [];
  for (const f of features) {
    if (f.geometry.type === 'Polygon') {
      coords.push(f.geometry.coordinates as Array<Array<[number, number]>>);
    } else {
      coords.push(
        ...(f.geometry.coordinates as Array<Array<Array<[number, number]>>>)
      );
    }
  }
  return { type: 'MultiPolygon', coordinates: coords };
}

/** Check geometric equality between two Features. */
function geometriesEqual(
  left: Feature<Polygon | MultiPolygon>,
  right: Feature<Polygon | MultiPolygon>
): boolean {
  try {
    return turf.booleanEqual(left, right);
  } catch {
    return false;
  }
}

/** Convert a raw geometry object ({ type, coordinates }) to a turf Feature. */
function geometryToFeature(
  geometry: unknown
): Feature<Polygon | MultiPolygon> | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    return turf.polygon(g.coordinates as Position[][]) as Feature<
      Polygon | MultiPolygon
    >;
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    return turf.multiPolygon(g.coordinates as Position[][][]) as Feature<
      Polygon | MultiPolygon
    >;
  }
  return null;
}

/** Extract the plain geometry object from a turf Feature. */
function featureToGeometry(
  f: Feature<Polygon | MultiPolygon>
): GeoJsonPolygon | GeoJsonMultiPolygon {
  return f.geometry as GeoJsonPolygon | GeoJsonMultiPolygon;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build consolidated GeoJSON geometry from an array of raw altitude layers.
 *
 * This is the canonical geometry builder for the JS/TS side, mirroring
 * Python traffic's `unary_union_with_alt`.
 *
 * @param rawLayers  Array of `{ lower, upper, coordinates }` objects as
 *                   returned by Rust `AirspaceLayerRecord`.
 * @returns          `{ layers, geometry }` — see `AirspaceGeometryResult`.
 *
 * @example
 * ```typescript
 * const raw = composite.layers; // from EurocontrolResolver.resolve_airspace()
 * const { layers, geometry } = buildAirspaceGeometry(raw);
 * // geometry is ready for use as a GeoJSON Feature geometry
 * // layers carries the per-altitude-band geometries + bounds
 * ```
 */
export function buildAirspaceGeometry(
  rawLayers: RawLayer[]
): AirspaceGeometryResult {
  // Step 1: parse coordinate rings; drop degenerate layers
  const parsed = rawLayers
    .map((layer) => {
      const ring = toPolygonRing(layer.coordinates);
      if (ring.length < 4) return null; // need ≥ 3 distinct + closing point
      const lower =
        layer.lower === null || layer.lower === undefined
          ? null
          : Number.isFinite(Number(layer.lower))
            ? Number(layer.lower)
            : null;
      const upper =
        layer.upper === null || layer.upper === undefined
          ? null
          : Number.isFinite(Number(layer.upper)) ||
              Number(layer.upper) === Infinity
            ? Number(layer.upper)
            : null;
      return {
        lower,
        upper,
        feature: turf.polygon([ring]) as Feature<Polygon | MultiPolygon>,
      };
    })
    .filter(
      (
        v
      ): v is {
        lower: number | null;
        upper: number | null;
        feature: Feature<Polygon | MultiPolygon>;
      } => v !== null
    );

  if (parsed.length === 0) {
    return { layers: [], geometry: null };
  }

  // Step 2: collect unique altitude breakpoints
  const altSet = new Set<number>();
  for (const p of parsed) {
    if (typeof p.lower === 'number') altSet.add(p.lower);
    if (typeof p.upper === 'number') altSet.add(p.upper);
  }
  const altitudes = Array.from(altSet).sort((a, b) => a - b);

  const mergedLayers: MergedLayer[] = [];

  if (altitudes.length < 2) {
    // Step 3: single-band / no altitude info — union everything
    const merged = unionPolygons(parsed.map((p) => p.feature));
    if (merged) {
      mergedLayers.push({
        lower: altitudes[0] ?? null,
        upper: altitudes[0] ?? null,
        geometry: featureToGeometry(merged),
      });
    }
  } else {
    // Step 4: iterate over consecutive pairs of altitude breakpoints
    for (let i = 0; i < altitudes.length - 1; i++) {
      const lo = altitudes[i];
      const hi = altitudes[i + 1];

      // Find all layers whose band *contains* this slice
      const covering = parsed
        .filter(
          (p) =>
            p.lower !== null &&
            p.upper !== null &&
            p.lower <= lo &&
            p.upper >= hi
        )
        .map((p) => p.feature);

      if (covering.length === 0) continue;

      let sliceGeom: GeoJsonPolygon | GeoJsonMultiPolygon | null = null;
      const merged = unionPolygons(covering);

      if (merged) {
        // Step 4c: adjacent-band collapsing
        const previous = mergedLayers[mergedLayers.length - 1];
        if (previous) {
          const prevFeature = geometryToFeature(previous.geometry);
          if (prevFeature && geometriesEqual(prevFeature, merged)) {
            // Extend the previous band's upper bound — same as Python:
            //   results[-1] = ExtrudedPolygon(new_poly.polygon, results[-1].lower, up)
            previous.upper = hi;
            continue;
          }
        }
        sliceGeom = featureToGeometry(merged);
      } else {
        // Step 4d: fallback to raw MultiPolygon
        const fallback = combineAsMultiPolygon(covering);
        if (!fallback) continue;
        sliceGeom = fallback;
      }

      mergedLayers.push({ lower: lo, upper: hi, geometry: sliceGeom });
    }
  }

  if (mergedLayers.length === 0) {
    return { layers: [], geometry: null };
  }

  // Step 5: compute flat 2D footprint from all merged-layer geometries
  const allFeatures = mergedLayers
    .map((ml) => geometryToFeature(ml.geometry))
    .filter((f): f is Feature<Polygon | MultiPolygon> => f !== null);

  const footprint = unionPolygons(allFeatures);
  const geometry: GeoJsonGeometry = footprint
    ? featureToGeometry(footprint)
    : combineAsMultiPolygon(allFeatures);

  return { layers: mergedLayers, geometry };
}

/**
 * Validate GeoJSON coordinate nesting depth.
 *
 * Returns true if the geometry has correct nesting:
 * - Polygon:      coordinates is Array<Array<[number,number]>>  (depth 3)
 * - MultiPolygon: coordinates is Array<Array<Array<[number,number]>>>  (depth 4)
 */
export function validateGeometryNesting(geometry: GeoJsonGeometry): boolean {
  if (!geometry) return false;

  if (geometry.type === 'Polygon') {
    // depth-3: coordinates[ring][point] = [lon, lat]
    if (!Array.isArray(geometry.coordinates)) return false;
    for (const ring of geometry.coordinates) {
      if (!Array.isArray(ring)) return false;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2) return false;
        if (typeof point[0] !== 'number' || typeof point[1] !== 'number')
          return false;
        // Check it's not a nested array (extra wrapping level)
        if (Array.isArray(point[0])) return false;
      }
    }
    return true;
  }

  if (geometry.type === 'MultiPolygon') {
    // depth-4: coordinates[polygon][ring][point] = [lon, lat]
    if (!Array.isArray(geometry.coordinates)) return false;
    for (const poly of geometry.coordinates) {
      if (!Array.isArray(poly)) return false;
      for (const ring of poly) {
        if (!Array.isArray(ring)) return false;
        for (const point of ring) {
          if (!Array.isArray(point) || point.length < 2) return false;
          if (typeof point[0] !== 'number' || typeof point[1] !== 'number')
            return false;
          if (Array.isArray(point[0])) return false;
        }
      }
    }
    return true;
  }

  return false;
}
