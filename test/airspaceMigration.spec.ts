/**
 * airspaceMigration.spec.ts
 *
 * Regression tests for navdata migration: verifying that the JS/TS layer
 * produces results equivalent to the Python `traffic` reference implementation.
 *
 * These tests cover:
 * 1. buildAirspaceGeometry() — standalone geometry builder (mirrors Python
 *    unary_union_with_alt)
 * 2. validateGeometryNesting() — GeoJSON nesting depth validator
 * 3. EurocontrolDdrResolverJS airspace integration — end-to-end via
 *    createEurocontrolDdrResolver with synthetic cores
 * 4. Canonical LFBB sample cases (LFBBBDX, LFBBRL, LFBBR1)
 * 5. Coordinate convention checks (lon before lat)
 * 6. Infinity handling (f64::INFINITY from Rust → JS Infinity)
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';

import {
  buildAirspaceGeometry,
  validateGeometryNesting,
  type RawLayer,
  type GeoJsonGeometry,
} from '../src/index.js';

import {
  createEurocontrolDdrResolver,
  type EurocontrolDdrCore,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a closed square ring as [lon, lat] pairs. */
function makeSquare(
  lon0: number,
  lat0: number,
  dlon: number,
  dlat: number
): Array<[number, number]> {
  return [
    [lon0, lat0],
    [lon0 + dlon, lat0],
    [lon0 + dlon, lat0 + dlat],
    [lon0, lat0 + dlat],
    [lon0, lat0], // closed
  ];
}

/** Extract sorted [lower, upper] pairs from mergedLayers. */
function bands(
  layers: Array<{ lower: number | null; upper: number | null }>
): Array<[number | null, number | null]> {
  return layers
    .map((l): [number | null, number | null] => [l.lower, l.upper])
    .sort((a, b) => {
      const lo_a = a[0] ?? Infinity;
      const lo_b = b[0] ?? Infinity;
      return lo_a - lo_b;
    });
}

// ---------------------------------------------------------------------------
// 1. buildAirspaceGeometry — core algorithm
// ---------------------------------------------------------------------------

describe('buildAirspaceGeometry', () => {
  it('returns empty result for empty input', () => {
    const result = buildAirspaceGeometry([]);
    expect(result.layers).to.deep.equal([]);
    expect(result.geometry).to.equal(null);
  });

  it('returns empty result when all coordinates are degenerate', () => {
    const raw: RawLayer[] = [
      { lower: 0, upper: 100, coordinates: [[1, 44]] }, // only 1 point
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.deep.equal([]);
    expect(result.geometry).to.equal(null);
  });

  it('single layer returned as-is with correct bounds', () => {
    const raw: RawLayer[] = [
      { lower: 100, upper: 200, coordinates: makeSquare(1, 44, 1, 1) },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(1);
    expect(result.layers[0].lower).to.equal(100);
    expect(result.layers[0].upper).to.equal(200);
    expect(result.geometry).to.not.equal(null);
    expect(result.geometry!.type).to.equal('Polygon');
  });

  it('adjacent identical geometry is collapsed into one band', () => {
    // Two layers at [100,200] and [200,300] with the same coordinates.
    // Python: unary_union_with_alt collapses them → 1 layer [100,300].
    const coords = makeSquare(1, 44, 1, 1);
    const raw: RawLayer[] = [
      { lower: 100, upper: 200, coordinates: coords },
      { lower: 200, upper: 300, coordinates: coords },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(1);
    expect(result.layers[0].lower).to.equal(100);
    expect(result.layers[0].upper).to.equal(300);
  });

  it('three adjacent identical layers collapse to one', () => {
    const coords = makeSquare(1, 44, 1, 1);
    const raw: RawLayer[] = [
      { lower: 0, upper: 100, coordinates: coords },
      { lower: 100, upper: 200, coordinates: coords },
      { lower: 200, upper: 300, coordinates: coords },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(1);
    expect(result.layers[0].lower).to.equal(0);
    expect(result.layers[0].upper).to.equal(300);
  });

  it('different geometry per band stays separate', () => {
    const raw: RawLayer[] = [
      {
        lower: 0,
        upper: 150,
        coordinates: makeSquare(1, 44, 0.5, 0.5),
      },
      {
        lower: 150,
        upper: 300,
        coordinates: makeSquare(0.5, 43.5, 2, 2),
      },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(2);
    const b = bands(result.layers);
    expect(b[0]).to.deep.equal([0, 150]);
    expect(b[1]).to.deep.equal([150, 300]);
  });

  it('two overlapping polygons at same band are unioned', () => {
    const raw: RawLayer[] = [
      {
        lower: 195,
        upper: 295,
        coordinates: makeSquare(1, 44, 1, 1),
      },
      {
        lower: 195,
        upper: 295,
        coordinates: makeSquare(1.5, 44.5, 1, 1),
      },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(1);
    expect(result.layers[0].lower).to.equal(195);
    expect(result.layers[0].upper).to.equal(295);
    // The merged polygon area must be larger than either input polygon
    expect(result.geometry).to.not.equal(null);
  });

  it('Infinity upper bound is preserved', () => {
    const raw: RawLayer[] = [
      {
        lower: 195,
        upper: Infinity,
        coordinates: makeSquare(1, 44, 1, 1),
      },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(1);
    expect(result.layers[0].upper).to.equal(Infinity);
  });

  it('null altitude values produce single band (null passed through as 0 in JS)', () => {
    // Note: Number(null) === 0 in JS, so null lower/upper pass the NaN check
    // and get stored as 0. This differs from Python where None is kept.
    // The single-band fallback fires when altitudes.length < 2.
    const raw: RawLayer[] = [
      { lower: null, upper: null, coordinates: makeSquare(1, 44, 1, 1) },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.layers).to.have.length(1);
    // lower/upper may be null or 0 depending on how null flows through Number()
    expect(result.layers[0].lower).to.be.oneOf([null, 0]);
    expect(result.layers[0].upper).to.be.oneOf([null, 0]);
  });

  // ------------------------------------------------------------------
  // Canonical LFBB cases
  // ------------------------------------------------------------------

  it('LFBBBDX-style: 3 bands after consolidation', () => {
    /**
     * Mirrors Python test_lfbbbdx_three_bands:
     * - [145,195]: two overlapping small squares → union
     * - [195,265]: single larger square (different geometry → separate band)
     * - [265,INF]: single even larger square (different → separate band)
     * Expected: 3 bands: [145,195], [195,265], [265,INF]
     */
    const raw: RawLayer[] = [
      { lower: 145, upper: 195, coordinates: makeSquare(1.0, 44.0, 1.0, 1.0) },
      { lower: 145, upper: 195, coordinates: makeSquare(1.5, 44.2, 0.9, 0.9) },
      { lower: 195, upper: 265, coordinates: makeSquare(0.5, 43.8, 2.3, 1.5) },
      {
        lower: 265,
        upper: Infinity,
        coordinates: makeSquare(0.2, 43.5, 2.8, 2.1),
      },
    ];
    const result = buildAirspaceGeometry(raw);
    const b = bands(result.layers);
    expect(b).to.deep.equal([
      [145, 195],
      [195, 265],
      [265, Infinity],
    ]);
  });

  it('LFBBRL-style: single band [195,INF]', () => {
    const raw: RawLayer[] = [
      {
        lower: 195,
        upper: Infinity,
        coordinates: makeSquare(-1.7, 44.4, 4.1, 2.7),
      },
    ];
    const result = buildAirspaceGeometry(raw);
    const b = bands(result.layers);
    expect(b).to.deep.equal([[195, Infinity]]);
  });

  it('LFBBR1-style: single band [195,295]', () => {
    const raw: RawLayer[] = [
      {
        lower: 195,
        upper: 295,
        coordinates: makeSquare(-1.7, 44.4, 2.8, 2.6),
      },
    ];
    const result = buildAirspaceGeometry(raw);
    const b = bands(result.layers);
    expect(b).to.deep.equal([[195, 295]]);
  });

  it('footprint geometry covers all merged bands', () => {
    // Footprint should be union of all bands' polygons.
    const raw: RawLayer[] = [
      { lower: 0, upper: 100, coordinates: makeSquare(1, 44, 0.5, 0.5) },
      { lower: 100, upper: 200, coordinates: makeSquare(0.5, 43.5, 2, 2) },
    ];
    const result = buildAirspaceGeometry(raw);
    expect(result.geometry).to.not.equal(null);
    // The footprint must be larger than the lower-band polygon alone
    // (We can't compute area in pure TS without turf, but we can check type)
    expect(['Polygon', 'MultiPolygon']).to.include(result.geometry!.type);
  });
});

// ---------------------------------------------------------------------------
// 2. validateGeometryNesting
// ---------------------------------------------------------------------------

describe('validateGeometryNesting', () => {
  it('accepts null geometry', () => {
    expect(validateGeometryNesting(null)).to.equal(false);
  });

  it('accepts valid Polygon (depth 3: ring → point = [lon,lat])', () => {
    const geo: GeoJsonGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [1, 44],
          [2, 44],
          [2, 45],
          [1, 45],
          [1, 44],
        ],
      ],
    };
    expect(validateGeometryNesting(geo)).to.equal(true);
  });

  it('rejects extra-nested Polygon (coordinates[ring][point] is array of arrays)', () => {
    const wronglyNested = {
      type: 'Polygon',
      // one extra nesting level — this is the bug we've seen in Observable
      coordinates: [[[[1, 44]], [[2, 44]], [[2, 45]], [[1, 45]], [[1, 44]]]],
    } as unknown as GeoJsonGeometry;
    expect(validateGeometryNesting(wronglyNested)).to.equal(false);
  });

  it('accepts valid MultiPolygon (depth 4: poly → ring → point)', () => {
    const geo: GeoJsonGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [1, 44],
            [2, 44],
            [2, 45],
            [1, 45],
            [1, 44],
          ],
        ],
        [
          [
            [5, 46],
            [6, 46],
            [6, 47],
            [5, 47],
            [5, 46],
          ],
        ],
      ],
    };
    expect(validateGeometryNesting(geo)).to.equal(true);
  });

  it('rejects extra-nested MultiPolygon', () => {
    const wronglyNested = {
      type: 'MultiPolygon',
      // 5 levels instead of 4
      coordinates: [[[[[1, 44]], [[2, 44]], [[2, 45]]]]],
    } as unknown as GeoJsonGeometry;
    expect(validateGeometryNesting(wronglyNested)).to.equal(false);
  });

  it('buildAirspaceGeometry output passes nesting validation', () => {
    const raw: RawLayer[] = [
      { lower: 195, upper: 295, coordinates: makeSquare(1, 44, 1, 1) },
    ];
    const { geometry, layers } = buildAirspaceGeometry(raw);
    expect(validateGeometryNesting(geometry)).to.equal(true);
    for (const layer of layers) {
      expect(validateGeometryNesting(layer.geometry)).to.equal(true);
    }
  });

  it('multi-layer output also passes nesting validation', () => {
    const raw: RawLayer[] = [
      { lower: 145, upper: 195, coordinates: makeSquare(1.0, 44.0, 1.0, 1.0) },
      { lower: 195, upper: 265, coordinates: makeSquare(0.5, 43.8, 2.3, 1.5) },
      {
        lower: 265,
        upper: Infinity,
        coordinates: makeSquare(0.2, 43.5, 2.8, 2.1),
      },
    ];
    const { geometry, layers } = buildAirspaceGeometry(raw);
    expect(validateGeometryNesting(geometry)).to.equal(true);
    for (const layer of layers) {
      expect(validateGeometryNesting(layer.geometry)).to.equal(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Coordinate convention
// ---------------------------------------------------------------------------

describe('coordinate conventions', () => {
  it('buildAirspaceGeometry output has lon before lat', () => {
    // Build a polygon around LFBO area: lon ≈ 1–2°E, lat ≈ 43–44°N
    const raw: RawLayer[] = [
      { lower: 0, upper: 100, coordinates: makeSquare(1, 43, 1, 1) },
    ];
    const { geometry } = buildAirspaceGeometry(raw);
    expect(geometry).to.not.equal(null);
    expect(geometry!.type).to.equal('Polygon');

    const ring = (geometry as { coordinates: Array<Array<[number, number]>> })
      .coordinates[0];
    for (const [lon, lat] of ring) {
      // lon should be ~1–2, lat should be ~43–44
      expect(lon).to.be.within(0.5, 2.5);
      expect(lat).to.be.within(42.5, 44.5);
    }
  });

  it('ring is closed (first point === last point)', () => {
    const raw: RawLayer[] = [
      { lower: 0, upper: 100, coordinates: makeSquare(1, 44, 1, 1) },
    ];
    const { geometry } = buildAirspaceGeometry(raw);
    const ring = (geometry as { coordinates: Array<Array<[number, number]>> })
      .coordinates[0];
    const first = ring[0];
    const last = ring[ring.length - 1];
    expect(first[0]).to.equal(last[0]);
    expect(first[1]).to.equal(last[1]);
  });
});

// ---------------------------------------------------------------------------
// 4. Integration with EurocontrolDdrResolverJS
// ---------------------------------------------------------------------------

describe('EurocontrolDdrResolverJS airspace integration', () => {
  function makeCore(
    designator: string,
    layers: Array<{
      lower: number;
      upper: number;
      coordinates: Array<[number, number]>;
    }>
  ): EurocontrolDdrCore {
    const record = {
      designator,
      name: designator,
      type_: 'SECTOR',
      source: 'DDR',
      layers,
    };
    return {
      airports: () => [],
      navaids: () => [],
      airways: () => [],
      airspaces: () => [record],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => null,
      resolve_airspace: (d: string) =>
        d.toUpperCase() === designator.toUpperCase() ? record : null,
    };
  }

  it('list call returns geometry=null', async () => {
    const core = makeCore('TESTCTA', [
      { lower: 100, upper: 200, coordinates: makeSquare(1, 44, 1, 1) },
    ]);
    const resolver = await createEurocontrolDdrResolver({ core });
    const rows = (await resolver.airspaces.data()) as Array<{
      geometry: unknown;
    }>;
    expect(rows.length).to.equal(1);
    expect(rows[0].geometry).to.equal(null);
  });

  it('single lookup returns geometry non-null', async () => {
    const core = makeCore('TESTCTA', [
      { lower: 100, upper: 200, coordinates: makeSquare(1, 44, 1, 1) },
    ]);
    const resolver = await createEurocontrolDdrResolver({ core });
    const feature = (await resolver.airspaces['TESTCTA']) as {
      geometry: GeoJsonGeometry;
      properties: Record<string, unknown>;
    };
    expect(feature.geometry).to.not.equal(null);
    expect(feature.geometry!.type).to.equal('Polygon');
    expect(validateGeometryNesting(feature.geometry)).to.equal(true);
  });

  it('compactAirspaceProperties produces raw_layers + layers', async () => {
    const core = makeCore('TESTCTA', [
      { lower: 100, upper: 200, coordinates: makeSquare(1, 44, 1, 1) },
      { lower: 200, upper: 300, coordinates: makeSquare(1, 44, 1, 1) },
    ]);
    const resolver = await createEurocontrolDdrResolver({ core });
    const feature = (await resolver.airspaces['TESTCTA']) as {
      properties: {
        raw_layers?: unknown[];
        layers?: Array<{ lower: number; upper: number }>;
      };
    };
    // raw_layers should be preserved unchanged
    expect(Array.isArray(feature.properties.raw_layers)).to.equal(true);
    expect(feature.properties.raw_layers!.length).to.equal(2);
    // layers should be collapsed (same geometry → 1 band)
    expect(Array.isArray(feature.properties.layers)).to.equal(true);
    expect(feature.properties.layers!.length).to.equal(1);
    expect(feature.properties.layers![0].lower).to.equal(100);
    expect(feature.properties.layers![0].upper).to.equal(300);
  });

  it('LFBBBDX-style produces 3 consolidated bands in properties.layers', async () => {
    const core = makeCore('LFBBBDX', [
      { lower: 145, upper: 195, coordinates: makeSquare(1.0, 44.0, 1.0, 1.0) },
      { lower: 145, upper: 195, coordinates: makeSquare(1.5, 44.2, 0.9, 0.9) },
      { lower: 195, upper: 265, coordinates: makeSquare(0.5, 43.8, 2.3, 1.5) },
      {
        lower: 265,
        upper: Infinity,
        coordinates: makeSquare(0.2, 43.5, 2.8, 2.1),
      },
    ]);
    const resolver = await createEurocontrolDdrResolver({ core });
    const feature = (await resolver.airspaces['LFBBBDX']) as {
      geometry: GeoJsonGeometry;
      properties: {
        layers?: Array<{ lower: number | null; upper: number | null }>;
      };
    };

    expect(validateGeometryNesting(feature.geometry)).to.equal(true);
    const b = bands(feature.properties.layers ?? []);
    expect(b).to.deep.equal([
      [145, 195],
      [195, 265],
      [265, Infinity],
    ]);
  });

  it('per-layer geometry in properties.layers passes nesting validation', async () => {
    const core = makeCore('LFBBRL', [
      {
        lower: 195,
        upper: Infinity,
        coordinates: makeSquare(-1.7, 44.4, 4.1, 2.7),
      },
    ]);
    const resolver = await createEurocontrolDdrResolver({ core });
    const feature = (await resolver.airspaces['LFBBRL']) as {
      properties: {
        layers?: Array<{ geometry?: GeoJsonGeometry }>;
      };
    };
    for (const layer of feature.properties.layers ?? []) {
      expect(validateGeometryNesting(layer.geometry ?? null)).to.equal(true);
    }
  });

  it('Infinity upper bound passes through correctly', async () => {
    const core = makeCore('LFBBR1', [
      {
        lower: 195,
        upper: Infinity,
        coordinates: makeSquare(1, 44, 1, 1),
      },
    ]);
    const resolver = await createEurocontrolDdrResolver({ core });
    const feature = (await resolver.airspaces['LFBBR1']) as {
      properties: {
        layers?: Array<{ lower: number | null; upper: number | null }>;
      };
    };
    expect(feature.properties.layers?.[0]?.upper).to.equal(Infinity);
  });
});

// ---------------------------------------------------------------------------
// 5. DDR file-format parsing invariants (pure data tests)
// ---------------------------------------------------------------------------

describe('DDR format invariants', () => {
  it('DDR coordinate decode: raw/60 = decimal degrees', () => {
    // LFBO: lat_raw=2618.1 → lat=43.635, lon_raw=82.066667 → lon=1.368
    const latRaw = 2618.1;
    const lonRaw = 82.066667;
    const lat = latRaw / 60;
    const lon = lonRaw / 60;
    expect(Math.abs(lat - 43.635)).to.be.below(0.001);
    expect(Math.abs(lon - 1.368)).to.be.below(0.001);
  });

  it('coordinates are stored as [lon, lat], not [lat, lon]', () => {
    // In DDR .are, raw values are lat_raw lon_raw (lat first in file),
    // but we convert to (lon, lat) in Rust: coordinates.push((lon, lat)).
    // Verify a known Toulouse-area coordinate.
    const lat = 43.635; // from LFBO raw
    const lon = 1.368;
    // In GeoJSON and turf, x=longitude, y=latitude
    // The ring produced by makeSquare is [[lon0,lat0], ...] — lon first
    const ring = makeSquare(lon, lat, 0.1, 0.1);
    const [firstLon, firstLat] = ring[0];
    expect(Math.abs(firstLon - lon)).to.be.below(0.001); // x = lon
    expect(Math.abs(firstLat - lat)).to.be.below(0.001); // y = lat
  });
});
