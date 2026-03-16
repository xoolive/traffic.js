import type {
  RouteEnricher,
  RouteSegment,
  RouteSegmentFeature,
  Field15Element,
} from './field15.js';
import { parseField15 } from './field15.js';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * A multi-source ICAO field 15 route resolver.
 *
 * Attach one or more navigation data sources (EUROCONTROL DDR, FAA NASR,
 * FAA ArcGIS, or any custom enricher) and resolve a filed route string into
 * a sequence of geographic segments.
 *
 * Sources are tried in the order they are attached. For each airway segment,
 * the first source that can expand the entry→exit pair wins. When multiple
 * sources resolve the same pair, the higher-priority source is kept.
 *
 * This mirrors the Python `traffic` `Resolver` pattern.
 *
 * @example
 * ```js
 * // Observable — set up once in a preamble cell:
 * traffic.setThrustWasm({ thrustModuleUrl: "http://localhost:8002/web/thrust_wasm.js" })
 *
 * // Load sources (can be done in parallel):
 * [ddr, nasr] = await Promise.all([
 *   traffic.createEurocontrolDdrResolver({ archive: await FileAttachment("ddr.zip").arrayBuffer() }),
 *   traffic.createNasrResolver({ archiveUrl: "https://example.com/nasr.zip" }),
 * ])
 *
 * // Build the resolver:
 * resolver = new traffic.Resolver().withDdr(ddr).withNasr(nasr)
 *
 * // Resolve a route:
 * route = "N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LIZAD DCT LFPG"
 * segments = resolver.enrichRoute(route)
 * fc       = resolver.enrichRouteAsGeoJSON(route)
 * tokens   = await resolver.parseField15(route)
 * ```
 */
export class Resolver {
  private _sources: Array<{ name: string; enricher: RouteEnricher }> = [];

  // -------------------------------------------------------------------------
  // Builder methods — each returns `this` for chaining
  // -------------------------------------------------------------------------

  /**
   * Attach a EUROCONTROL DDR resolver as a navigation source.
   *
   * DDR data covers European airways, navaids, and airports. Attach this
   * first if your routes are primarily European.
   *
   * @param ddr - An `EurocontrolDdrResolverJS` instance from
   *   {@link createEurocontrolDdrResolver}.
   */
  withDdr(ddr: RouteEnricher): this {
    return this.withSource('ddr', ddr);
  }

  /**
   * Attach a FAA NASR resolver as a navigation source.
   *
   * NASR data covers US airways, navaids, and airports. Attach this for
   * routes that cross US airspace.
   *
   * @param nasr - A `NasrResolverJS` instance from {@link createNasrResolver}.
   */
  withNasr(nasr: RouteEnricher): this {
    return this.withSource('nasr', nasr);
  }

  /**
   * Attach a FAA ArcGIS resolver as a navigation source.
   *
   * ArcGIS data is an alternative US source with different coverage than NASR.
   *
   * Requires thrust-wasm ≥ 0.3 and the datasets to be preloaded. Call
   * `await arcgis.preloadAll()` (or construct with `{ eager: true }`) before
   * passing the resolver to this method.
   *
   * @param arcgis - A `FaaArcgisResolverJS` instance from
   *   {@link createFaaArcgisResolver}.
   */
  withArcgis(arcgis: RouteEnricher): this {
    return this.withSource('arcgis', arcgis);
  }

  /**
   * Attach any custom enricher as a navigation source.
   *
   * The enricher must implement `enrichRoute(route: string): RouteSegment[]`.
   * `EurocontrolDdrResolverJS`, `NasrResolverJS`, and `FaaArcgisResolverJS`
   * (thrust-wasm ≥ 0.3, after `preloadAll()`) all satisfy this interface.
   *
   * @param name - A label for this source (used for debugging only).
   * @param enricher - Any object with an `enrichRoute` method.
   * @throws If `enricher.enrichRoute` is not a function.
   */
  withSource(name: string, enricher: RouteEnricher): this {
    if (typeof enricher?.enrichRoute !== 'function') {
      throw new Error(
        `Source "${name}" does not implement enrichRoute(). ` +
          `FaaArcgisResolverJS requires thrust-wasm ≥ 0.3 and preloaded datasets — ` +
          `call await arcgis.preloadAll() before passing it to withArcgis().`
      );
    }
    this._sources.push({ name, enricher });
    return this;
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Parse a raw ICAO field 15 route string into structured tokens.
   *
   * This is a pure tokeniser — no navigation database is required.
   * It calls the global {@link parseField15} function using whichever
   * thrust-wasm module was configured via {@link setThrustWasm}.
   *
   * @example
   * ```js
   * tokens = await resolver.parseField15("LFPG DCT LACOU UM184 VEBIT DCT LFLL")
   * // [{ aerodrome: "LFPG" }, "DCT", { waypoint: "LACOU" }, ...]
   * ```
   */
  async parseField15(route: string): Promise<Field15Element[]> {
    return parseField15(route);
  }

  /**
   * Resolve a raw ICAO field 15 route string into geographic segments.
   *
   * Each attached source independently resolves the full route. Results are
   * merged: the first source that resolves a given entry→exit pair wins.
   * Segments that no source can resolve are silently dropped.
   *
   * Returns an array of `{ start, end, name? }` objects where `start` and
   * `end` are `{ latitude, longitude, name?, kind? }`.
   *
   * @throws If no sources have been attached.
   *
   * @example
   * ```js
   * segments = resolver.enrichRoute(
   *   "N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LFPG"
   * )
   * for (const seg of segments) {
   *   console.log(seg.start.name, "→", seg.end.name, "via", seg.name ?? "DCT")
   * }
   * ```
   */
  enrichRoute(route: string): RouteSegment[] {
    if (this._sources.length === 0) {
      throw new Error(
        'Resolver has no sources. ' +
          'Call .withDdr(), .withNasr(), or .withSource() before enrichRoute().'
      );
    }
    if (this._sources.length === 1) {
      return this._sources[0].enricher.enrichRoute(route);
    }

    // Collect all segments from all sources tagged with source priority.
    const allSegments: Array<RouteSegment & { _pri: number }> = [];
    for (let i = 0; i < this._sources.length; i++) {
      try {
        for (const seg of this._sources[i].enricher.enrichRoute(route)) {
          allSegments.push({ ...seg, _pri: i });
        }
      } catch {
        // Source failed — skip it silently.
      }
    }

    // Merge: deduplicate by (start_name|end_name) key, keeping lowest _pri.
    // Priority is tracked in a parallel array to avoid stripping _pri from merged objects.
    const seen = new Map<string, number>(); // key → index in merged
    const merged: RouteSegment[] = [];
    const mergedPri: number[] = []; // parallel: priority of the segment at merged[i]

    for (const seg of allSegments) {
      const sk =
        seg.start.name ?? `${seg.start.latitude},${seg.start.longitude}`;
      const ek = seg.end.name ?? `${seg.end.latitude},${seg.end.longitude}`;
      const key = `${sk}|${ek}`;

      const existingIdx = seen.get(key);
      if (existingIdx === undefined) {
        seen.set(key, merged.length);
        const { _pri: _, ...clean } = seg;
        merged.push(clean);
        mergedPri.push(seg._pri);
      } else {
        // Replace only if the new source has strictly higher priority (lower index)
        // AND adds an airway name where the existing entry has none.
        const existingPri = mergedPri[existingIdx];
        const existing = merged[existingIdx];
        if (
          seg._pri < existingPri &&
          seg.name !== undefined &&
          existing.name === undefined
        ) {
          const { _pri: _, ...clean } = seg;
          merged[existingIdx] = clean;
          mergedPri[existingIdx] = seg._pri;
        }
      }
    }

    return merged;
  }

  /**
   * Resolve a route and return the result as a GeoJSON `FeatureCollection`
   * of `LineString` features — one feature per route segment.
   *
   * Each feature's `properties` contains:
   * - `name` — airway designator (e.g. `"UT300"`) or `null` for DCT legs
   * - `start_name`, `end_name` — waypoint/navaid/aerodrome codes
   * - `start_kind`, `end_kind` — point type: `"airport"`, `"fix"`, `"navaid"`,
   *   `"coords"`, …
   *
   * Coordinates follow the GeoJSON convention: `[longitude, latitude]`.
   *
   * @example
   * ```js
   * fc = resolver.enrichRouteAsGeoJSON(
   *   "N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LFPG"
   * )
   * // Use with Observable Plot, Leaflet, deck.gl, …
   * Plot.plot({
   *   projection: { type: "mercator", … },
   *   marks: [
   *     Plot.geo(fc, { stroke: d => d.properties.name ?? "DCT", tip: true }),
   *   ]
   * })
   * ```
   */
  enrichRouteAsGeoJSON(route: string): {
    type: 'FeatureCollection';
    features: RouteSegmentFeature[];
  } {
    const segments = this.enrichRoute(route);
    const features: RouteSegmentFeature[] = segments.map((seg) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [seg.start.longitude, seg.start.latitude],
          [seg.end.longitude, seg.end.latitude],
        ],
      },
      properties: {
        name: seg.name ?? null,
        start_name: seg.start.name ?? null,
        end_name: seg.end.name ?? null,
        start_kind: seg.start.kind ?? null,
        end_kind: seg.end.kind ?? null,
      },
    }));
    return { type: 'FeatureCollection', features };
  }
}
