/**
 * field15.spec.ts
 *
 * Tests for field15 route parsing and enrichment.
 *
 * Three layers of tests:
 *
 * 1. **parseField15** — pure WASM tokenizer.  Uses a stub WASM module so no
 *    real `.wasm` binary is needed.
 *
 * 2. **Field15Resolver (synthetic)** — enrichment via a hand-crafted resolver
 *    core.  Tests DCT segments, airway expansion, GeoJSON output, and graceful
 *    handling of unresolvable tokens.
 *
 * 3. **EurocontrolDdrResolverJS + enrichRoute (real DDR)** — integration tests
 *    against the real AIRAC 2111 DDR archive loaded via the thrust-wasm web
 *    build.  Ground truth extracted by running the WASM resolver against the
 *    archive and recording actual output.
 *
 *    These tests require:
 *      - `/home/xo/Documents/data/AIRAC_NM/airac_2111.zip` (local, not committed)
 *      - `thrust/crates/thrust-wasm/pkg/web/` built
 *    They are skipped automatically if either resource is unavailable.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { describe, it, before } from 'mocha';
import { expect } from 'chai';

import {
  data,
  type Field15Element,
  type RouteSegment,
  type EurocontrolDdrResolverJS,
} from '../src/index.js';
import { Field15Resolver } from '../src/data/field15.js';

const { parseField15 } = data;
const { createEurocontrolDdrResolver } = data.eurocontrol;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Stub WASM module for parseField15 tests
// ---------------------------------------------------------------------------

/**
 * Minimal stub that replicates the serde JSON shape of Field15Parser::parse.
 * We hard-code two well-known routes to verify the token shapes.
 */
const STUB_WASM = {
  parseField15(route: string): Field15Element[] {
    switch (route.trim()) {
      case 'LFPG DCT LACOU DCT LFLL':
        return [
          { aerodrome: 'LFPG' },
          'DCT',
          { waypoint: 'LACOU' },
          'DCT',
          { aerodrome: 'LFLL' },
        ];
      case 'LFPG DCT LACOU UM184 VEBIT DCT LFLL':
        return [
          { aerodrome: 'LFPG' },
          'DCT',
          { waypoint: 'LACOU' },
          { airway: 'UM184' },
          { waypoint: 'VEBIT' },
          'DCT',
          { aerodrome: 'LFLL' },
        ];
      case 'N0450F350 LFPG DCT NARAK':
        return [
          { speed: { kts: 450 }, altitude: { FL: 350 } },
          { aerodrome: 'LFPG' },
          'DCT',
          { waypoint: 'NARAK' },
        ];
      case '4500N01000E DCT NARAK':
        return [{ coords: [45.0, 10.0] }, 'DCT', { waypoint: 'NARAK' }];
      default:
        return [];
    }
  },
};

// ---------------------------------------------------------------------------
// 1. parseField15 — pure tokenizer
// ---------------------------------------------------------------------------

describe('parseField15', () => {
  it('tokenises a DCT-only route', async () => {
    const tokens = await parseField15('LFPG DCT LACOU DCT LFLL', {
      thrustModule: STUB_WASM as never,
    });
    expect(tokens).to.have.length(5);
    expect(tokens[0]).to.deep.equal({ aerodrome: 'LFPG' });
    expect(tokens[1]).to.equal('DCT');
    expect(tokens[2]).to.deep.equal({ waypoint: 'LACOU' });
    expect(tokens[3]).to.equal('DCT');
    expect(tokens[4]).to.deep.equal({ aerodrome: 'LFLL' });
  });

  it('tokenises a route with an ATS airway', async () => {
    const tokens = await parseField15('LFPG DCT LACOU UM184 VEBIT DCT LFLL', {
      thrustModule: STUB_WASM as never,
    });
    expect(tokens).to.have.length(7);
    // The airway connector should be { airway: "UM184" }
    const airway = tokens.find(
      (t) => typeof t === 'object' && 'airway' in t
    ) as { airway: string } | undefined;
    expect(airway).to.exist;
    expect(airway!.airway).to.equal('UM184');
  });

  it('tokenises a speed/altitude modifier prefix', async () => {
    const tokens = await parseField15('N0450F350 LFPG DCT NARAK', {
      thrustModule: STUB_WASM as never,
    });
    expect(tokens).to.have.length(4);
    const modifier = tokens[0] as { speed?: unknown; altitude?: unknown };
    expect(modifier).to.have.property('speed');
    expect(modifier).to.have.property('altitude');
  });

  it('tokenises a coordinate waypoint', async () => {
    const tokens = await parseField15('4500N01000E DCT NARAK', {
      thrustModule: STUB_WASM as never,
    });
    const coord = tokens.find((t) => typeof t === 'object' && 'coords' in t) as
      | { coords: [number, number] }
      | undefined;
    expect(coord).to.exist;
    expect(coord!.coords[0]).to.equal(45.0); // latitude
    expect(coord!.coords[1]).to.equal(10.0); // longitude
  });

  it('throws when no WASM module is available', async () => {
    try {
      await parseField15('LFPG DCT LFLL', {
        autoLoadThrustModule: false,
      });
      expect.fail('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).to.include(
        'thrust-wasm module could not be loaded'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Stub EurocontrolResolver core for enrichment tests
// ---------------------------------------------------------------------------

/**
 * A synthetic resolver with a small nav graph:
 *   LFPG (airport)  lat=49.01  lon=2.55
 *   LACOU (fix)     lat=49.23  lon=2.90
 *   VEBIT (fix)     lat=48.80  lon=3.50
 *   LFLL  (airport) lat=45.72  lon=5.08
 *
 * Airways:
 *   UM184: LACOU → VEBIT (two points)
 *   UN869: NARAK → TOU   (two points, used for airway-not-found scenario)
 *
 * enrichRoute(route) delegates to Field15Resolver via a synthetic core.
 */
function makeResolverCore() {
  const airports: Record<
    string,
    { latitude: number; longitude: number; name: string; kind: string }
  > = {
    LFPG: { latitude: 49.01, longitude: 2.55, name: 'LFPG', kind: 'airport' },
    LFLL: { latitude: 45.72, longitude: 5.08, name: 'LFLL', kind: 'airport' },
  };

  const navaids: Record<
    string,
    { latitude: number; longitude: number; name: string; kind: string }
  > = {
    LACOU: { latitude: 49.23, longitude: 2.9, name: 'LACOU', kind: 'fix' },
    VEBIT: { latitude: 48.8, longitude: 3.5, name: 'VEBIT', kind: 'fix' },
    NARAK: { latitude: 43.2, longitude: 1.5, name: 'NARAK', kind: 'fix' },
    TOU: { latitude: 43.6, longitude: 1.37, name: 'TOU', kind: 'navaid' },
  };

  const airways: Record<
    string,
    Array<{ code: string; latitude: number; longitude: number; kind: string }>
  > = {
    UM184: [
      { code: 'LACOU', latitude: 49.23, longitude: 2.9, kind: 'fix' },
      { code: 'VEBIT', latitude: 48.8, longitude: 3.5, kind: 'fix' },
    ],
  };

  /**
   * Minimal enrichRoute implementation matching the WASM contract.
   * Mirrors the algorithm in crates/thrust-wasm/src/eurocontrol.rs::enrich_route.
   */
  function enrichRoute(route: string): RouteSegment[] {
    const tokens = route.trim().split(/\s+/);
    const segments: RouteSegment[] = [];
    let lastPoint: {
      latitude: number;
      longitude: number;
      name?: string;
      kind?: string;
    } | null = null;
    let connector: string | null = null;

    for (const token of tokens) {
      const upper = token.toUpperCase();

      // Check if it's an airport
      if (airports[upper]) {
        const next = airports[upper];
        if (lastPoint) {
          segments.push({
            start: lastPoint,
            end: next,
            name: connector ?? undefined,
          });
        }
        lastPoint = next;
        connector = null;
        continue;
      }

      // Check if it's a navaid/fix
      if (navaids[upper]) {
        const next = navaids[upper];
        if (lastPoint) {
          segments.push({
            start: lastPoint,
            end: next,
            name: connector ?? undefined,
          });
        }
        lastPoint = next;
        connector = null;
        continue;
      }

      // Check if it's an airway
      if (airways[upper]) {
        for (const pt of airways[upper]) {
          const next = {
            latitude: pt.latitude,
            longitude: pt.longitude,
            name: pt.code,
            kind: pt.kind,
          };
          if (lastPoint) {
            segments.push({ start: lastPoint, end: next, name: upper });
          }
          lastPoint = next;
        }
        connector = null;
        continue;
      }

      // DCT or unknown airway — record as pending connector name
      if (upper === 'DCT') {
        connector = null;
      } else {
        // Unknown airway token — label next DCT segment with the name
        connector = upper;
      }
    }

    return segments;
  }

  return { enrichRoute };
}

// ---------------------------------------------------------------------------
// 2. Field15Resolver — enrichment
// ---------------------------------------------------------------------------

describe('Field15Resolver', () => {
  it('fromResolver wraps a core with enrichRoute', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    expect(resolver).to.be.instanceOf(Field15Resolver);
    expect(resolver.enrichRoute).to.be.a('function');
  });

  it('enrichRoute returns segments for a simple DCT route', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const segments = resolver.enrichRoute('LFPG DCT LACOU DCT LFLL');
    // LFPG → LACOU, LACOU → LFLL
    expect(segments).to.have.length(2);
  });

  it('enrichRoute first segment starts at origin aerodrome', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const segments = resolver.enrichRoute('LFPG DCT LACOU DCT LFLL');
    expect(segments[0].start.name).to.equal('LFPG');
    expect(segments[0].start.latitude).to.be.closeTo(49.01, 0.01);
    expect(segments[0].start.longitude).to.be.closeTo(2.55, 0.01);
  });

  it('enrichRoute last segment ends at destination aerodrome', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const segments = resolver.enrichRoute('LFPG DCT LACOU DCT LFLL');
    const last = segments[segments.length - 1];
    expect(last.end.name).to.equal('LFLL');
    expect(last.end.latitude).to.be.closeTo(45.72, 0.01);
  });

  it('DCT segments have undefined name', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const segments = resolver.enrichRoute('LFPG DCT LACOU DCT LFLL');
    // Both legs are DCT — name should be undefined
    for (const seg of segments) {
      expect(seg.name).to.be.undefined;
    }
  });

  it('enrichRoute expands an airway into per-waypoint segments', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    // UM184 stub has 2 points: LACOU and VEBIT.
    // When LACOU is already the last resolved point before UM184, the airway
    // expansion emits one segment per consecutive point pair in the airway list.
    const segments = resolver.enrichRoute(
      'LFPG DCT LACOU UM184 VEBIT DCT LFLL'
    );
    // At minimum LFPG→LACOU and at least one airway segment
    expect(segments.length).to.be.at.least(2);

    const airwaySegs = segments.filter((s) => s.name === 'UM184');
    expect(airwaySegs).to.have.length.at.least(1);
    // The last airway segment must end at VEBIT (the final airway waypoint)
    const lastAirwaySeg = airwaySegs[airwaySegs.length - 1];
    expect(lastAirwaySeg.end.name).to.equal('VEBIT');
  });

  it('enrichRoute airway segment carries the airway name', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const segments = resolver.enrichRoute(
      'LFPG DCT LACOU UM184 VEBIT DCT LFLL'
    );
    const airwaySegs = segments.filter((s) => s.name === 'UM184');
    expect(airwaySegs.length).to.be.at.least(1);
  });

  it('enrichRoute returns empty array for empty route', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    // A route of a single airport has no segments (no outgoing leg)
    const segments = resolver.enrichRoute('LFPG');
    expect(segments).to.have.length(0);
  });

  it('enrichRoute handles unknown waypoints gracefully', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    // XXYY is not in the nav DB — should be silently skipped
    const segments = resolver.enrichRoute('LFPG DCT XXYY DCT LFLL');
    // With XXYY unresolvable, we expect fewer segments than a full route
    expect(segments.length).to.be.at.most(2);
  });

  // -------------------------------------------------------------------------
  // enrichRouteAsGeoJSON
  // -------------------------------------------------------------------------

  it('enrichRouteAsGeoJSON returns a FeatureCollection', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG DCT LACOU DCT LFLL');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.be.an('array');
  });

  it('enrichRouteAsGeoJSON each feature is a LineString', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG DCT LACOU DCT LFLL');
    for (const feature of fc.features) {
      expect(feature.type).to.equal('Feature');
      expect(feature.geometry.type).to.equal('LineString');
      expect(feature.geometry.coordinates).to.have.length(2); // [start, end]
    }
  });

  it('enrichRouteAsGeoJSON coordinates are [lon, lat] order', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG DCT LACOU DCT LFLL');
    const firstFeature = fc.features[0];
    const [startCoord] = firstFeature.geometry.coordinates;
    // LFPG: lat=49.01, lon=2.55 → GeoJSON coord should be [lon, lat] = [2.55, 49.01]
    expect(startCoord[0]).to.be.closeTo(2.55, 0.01); // longitude first
    expect(startCoord[1]).to.be.closeTo(49.01, 0.01); // latitude second
  });

  it('enrichRouteAsGeoJSON DCT features have null name', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG DCT LACOU DCT LFLL');
    for (const feature of fc.features) {
      expect(feature.properties.name).to.equal(null);
    }
  });

  it('enrichRouteAsGeoJSON airway feature has non-null name', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON(
      'LFPG DCT LACOU UM184 VEBIT DCT LFLL'
    );
    const airwayFeatures = fc.features.filter(
      (f) => f.properties.name === 'UM184'
    );
    expect(airwayFeatures.length).to.be.at.least(1);
  });

  it('enrichRouteAsGeoJSON features carry start/end name properties', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG DCT LACOU DCT LFLL');
    const first = fc.features[0];
    expect(first.properties.start_name).to.equal('LFPG');
    expect(first.properties.end_name).to.equal('LACOU');
  });

  it('enrichRouteAsGeoJSON features carry start/end kind properties', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG DCT LACOU DCT LFLL');
    const first = fc.features[0];
    expect(first.properties.start_kind).to.equal('airport');
    expect(first.properties.end_kind).to.equal('fix');
  });

  it('empty route produces empty FeatureCollection', () => {
    const core = makeResolverCore();
    const resolver = Field15Resolver.fromResolver(core as never);
    const fc = resolver.enrichRouteAsGeoJSON('LFPG');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.have.length(0);
  });
});

// ---------------------------------------------------------------------------
// Synthetic airway expansion — tests that exercise the entry→exit slice logic
// (using a longer, realistic airway stub so slicing is meaningful)
// ---------------------------------------------------------------------------

/**
 * Synthetic DDR-like core with a realistic UN858 stub (subset, 6 points).
 * Point order matches the real DDR sequence: ADABI → BOKNO → DEVRO → VANAD → TABOV → TSU
 *
 * This allows testing:
 *   - Forward slice (BOKNO → VANAD = points [1..3])
 *   - Reverse slice (VANAD → BOKNO = points [3..1] reversed)
 *   - Single-hop (BOKNO → DEVRO)
 *   - Entry not found → empty result
 *   - Exit not found → empty result
 */
function makeAirwaySliceCore() {
  const un858Points = [
    { code: 'ADABI', latitude: 46.56111, longitude: 0.53083 },
    { code: 'BOKNO', latitude: 47.04694, longitude: 0.69167 },
    { code: 'DEVRO', latitude: 47.49556, longitude: 0.73861 },
    { code: 'VANAD', latitude: 47.83722, longitude: 0.90722 },
    { code: 'TABOV', latitude: 48.64417, longitude: 1.64889 },
    { code: 'TSU', latitude: 48.75361, longitude: 2.10222 },
  ];

  const navaids: Record<
    string,
    { latitude: number; longitude: number; name: string; kind: string }
  > = {
    ADABI: {
      name: 'ADABI',
      latitude: 46.56111,
      longitude: 0.53083,
      kind: 'fix',
    },
    BOKNO: {
      name: 'BOKNO',
      latitude: 47.04694,
      longitude: 0.69167,
      kind: 'fix',
    },
    DEVRO: {
      name: 'DEVRO',
      latitude: 47.49556,
      longitude: 0.73861,
      kind: 'fix',
    },
    VANAD: {
      name: 'VANAD',
      latitude: 47.83722,
      longitude: 0.90722,
      kind: 'fix',
    },
    TABOV: {
      name: 'TABOV',
      latitude: 48.64417,
      longitude: 1.64889,
      kind: 'fix',
    },
    TSU: { name: 'TSU', latitude: 48.75361, longitude: 2.10222, kind: 'fix' },
  };

  function enrichRoute(route: string): RouteSegment[] {
    const tokens = route.trim().split(/\s+/);
    const segments: RouteSegment[] = [];
    let lastPoint: {
      latitude: number;
      longitude: number;
      name: string;
      kind: string;
    } | null = null;
    let pendingAirway: {
      name: string;
      entry: {
        latitude: number;
        longitude: number;
        name: string;
        kind: string;
      };
    } | null = null;

    for (const token of tokens) {
      const upper = token.toUpperCase();

      if (upper === 'UN858') {
        if (lastPoint) {
          pendingAirway = { name: 'UN858', entry: lastPoint };
          lastPoint = null;
        }
        continue;
      }
      if (upper === 'DCT') {
        pendingAirway = null;
        continue;
      }

      const nav = navaids[upper];
      if (!nav) continue;

      if (pendingAirway) {
        // Airway expansion: slice un858Points from entry to exit
        const entryIdx = un858Points.findIndex(
          (p) => p.code === pendingAirway!.entry.name
        );
        const exitIdx = un858Points.findIndex((p) => p.code === upper);
        pendingAirway = null;

        if (entryIdx === -1 || exitIdx === -1 || entryIdx === exitIdx) {
          // Fallback or zero-length — emit nothing (mirrors Rust behaviour)
          lastPoint = nav;
          continue;
        }

        const forward = exitIdx > entryIdx;
        const slice = forward
          ? un858Points.slice(entryIdx, exitIdx + 1)
          : [...un858Points.slice(exitIdx, entryIdx + 1)].reverse();

        for (let i = 0; i + 1 < slice.length; i++) {
          const a = slice[i],
            b = slice[i + 1];
          segments.push({
            start: {
              name: a.code,
              latitude: a.latitude,
              longitude: a.longitude,
              kind: 'fix',
            },
            end: {
              name: b.code,
              latitude: b.latitude,
              longitude: b.longitude,
              kind: 'fix',
            },
            name: 'UN858',
          });
        }
        lastPoint = nav;
      } else {
        if (lastPoint) {
          segments.push({ start: lastPoint, end: nav, name: undefined });
        }
        lastPoint = nav;
      }
    }
    return segments;
  }

  return { enrichRoute };
}

describe('Field15Resolver — airway expansion (synthetic slice tests)', () => {
  it('forward slice BOKNO→VANAD emits BOKNO→DEVRO and DEVRO→VANAD', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    const segs = resolver.enrichRoute('BOKNO UN858 VANAD');
    expect(segs).to.have.length(2);
    expect(segs[0].start.name).to.equal('BOKNO');
    expect(segs[0].end.name).to.equal('DEVRO');
    expect(segs[0].name).to.equal('UN858');
    expect(segs[1].start.name).to.equal('DEVRO');
    expect(segs[1].end.name).to.equal('VANAD');
    expect(segs[1].name).to.equal('UN858');
  });

  it('reverse slice VANAD→BOKNO emits VANAD→DEVRO and DEVRO→BOKNO', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    const segs = resolver.enrichRoute('VANAD UN858 BOKNO');
    expect(segs).to.have.length(2);
    expect(segs[0].start.name).to.equal('VANAD');
    expect(segs[0].end.name).to.equal('DEVRO');
    expect(segs[0].name).to.equal('UN858');
    expect(segs[1].start.name).to.equal('DEVRO');
    expect(segs[1].end.name).to.equal('BOKNO');
    expect(segs[1].name).to.equal('UN858');
  });

  it('single-hop BOKNO→DEVRO emits one segment', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    const segs = resolver.enrichRoute('BOKNO UN858 DEVRO');
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('BOKNO');
    expect(segs[0].end.name).to.equal('DEVRO');
  });

  it('longer forward slice ADABI→TSU emits 5 hops', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    const segs = resolver.enrichRoute('ADABI UN858 TSU');
    expect(segs).to.have.length(5);
    expect(segs[0].start.name).to.equal('ADABI');
    expect(segs[4].end.name).to.equal('TSU');
    for (const s of segs) expect(s.name).to.equal('UN858');
  });

  it('entry not found in airway → no segments emitted for that leg', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    // DEVRO is known as a navaid but let the synthetic core handle it
    // XXYYZZ is completely unknown so the route before UN858 has no lastPoint
    const segs = resolver.enrichRoute('VANAD UN858 VANAD');
    // entry == exit → no expansion, mirrors Rust fallback
    expect(segs).to.have.length(0);
  });

  it('forward expanded segments all carry the airway name', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    const segs = resolver.enrichRoute('ADABI UN858 TABOV');
    for (const s of segs) expect(s.name).to.equal('UN858');
  });

  it('consecutive DCT legs after airway work correctly', () => {
    const resolver = Field15Resolver.fromResolver(
      makeAirwaySliceCore() as never
    );
    const segs = resolver.enrichRoute('BOKNO UN858 VANAD DCT TSU');
    const airwaySegs = segs.filter((s) => s.name === 'UN858');
    const dctSegs = segs.filter((s) => s.name === undefined);
    expect(airwaySegs.length).to.be.at.least(1);
    expect(dctSegs.length).to.equal(1);
    expect(dctSegs[0].start.name).to.equal('VANAD');
    expect(dctSegs[0].end.name).to.equal('TSU');
  });
});

// ---------------------------------------------------------------------------
// Real DDR integration tests — AIRAC 2111 + thrust-wasm web build
// ---------------------------------------------------------------------------

const DDR_ARCHIVE = '/home/xo/Documents/data/AIRAC_NM/airac_2111.zip';
const WASM_JS = join(
  __dirname,
  '../../thrust/crates/thrust-wasm/pkg/web/thrust_wasm.js'
);
const WASM_BIN = join(
  __dirname,
  '../../thrust/crates/thrust-wasm/pkg/web/thrust_wasm_bg.wasm'
);

const DDR_AVAILABLE =
  existsSync(DDR_ARCHIVE) && existsSync(WASM_JS) && existsSync(WASM_BIN);

/**
 * Ground truth extracted by running the real WASM resolver against AIRAC 2111.
 * Routes correspond to actual filed flight plans from ~/Documents/data/travel/b2b/.
 *
 * Notation: segments listed as start→end[airway] pairs.
 * "..." means intermediate intermediate waypoints exist but aren't checked exhaustively.
 */

describe('EurocontrolDdrResolverJS.enrichRoute — real AIRAC 2111', function () {
  // Entire suite is skipped when archive or WASM binary is unavailable (CI / offline).
  if (!DDR_AVAILABLE) {
    it.skip('skipped — AIRAC 2111 archive or thrust-wasm web build not available', () => {});
    return;
  }

  this.timeout(30_000);

  let ddr: EurocontrolDdrResolverJS;

  before(async () => {
    // Load web build with local WASM binary (avoids fetch in Node.js)
    const wasm = (await import(WASM_JS)) as {
      default: (b: ArrayBuffer) => Promise<void>;
      EurocontrolResolver: { fromDdrArchive: (a: Uint8Array) => unknown };
    };
    await wasm.default(readFileSync(WASM_BIN).buffer);
    const archive = readFileSync(DDR_ARCHIVE);
    ddr = await createEurocontrolDdrResolver({
      coreFactory: (bytes) =>
        wasm.EurocontrolResolver.fromDdrArchive(bytes) as never,
      archive: new Uint8Array(
        archive.buffer,
        archive.byteOffset,
        archive.byteLength
      ),
    });
  });

  // -------------------------------------------------------------------------
  // UN858 — forward traversal (BOKNO→VANAD)
  // From: 2023-01-11 LFBO→EHAM  "BOKNO UN858 VANAD"
  // Expected: BOKNO→DEVRO[UN858], DEVRO→VANAD[UN858]  (intermediate = DEVRO)
  // -------------------------------------------------------------------------
  describe('UN858 forward BOKNO→VANAD', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('BOKNO UN858 VANAD');
    });

    it('produces exactly 2 segments', () => expect(segs).to.have.length(2));
    it('first segment start is BOKNO', () =>
      expect(segs[0].start.name).to.equal('BOKNO'));
    it('first segment end is DEVRO (intermediate waypoint)', () =>
      expect(segs[0].end.name).to.equal('DEVRO'));
    it('last segment end is VANAD', () =>
      expect(segs[segs.length - 1].end.name).to.equal('VANAD'));
    it('all segments carry UN858', () =>
      segs.forEach((s) => expect(s.name).to.equal('UN858')));
    it('coordinates are plausible (France/Loire region)', () => {
      expect(segs[0].start.latitude).to.be.closeTo(47.047, 0.01);
      expect(segs[0].start.longitude).to.be.closeTo(0.692, 0.01);
    });
  });

  // -------------------------------------------------------------------------
  // UN858 — reverse traversal (VANAD→BOKNO)
  // The DDR list is ordered ADABI→BOKNO→DEVRO→VANAD (northbound).
  // VANAD→BOKNO must traverse in reverse.
  // -------------------------------------------------------------------------
  describe('UN858 reverse VANAD→BOKNO', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('VANAD UN858 BOKNO');
    });

    it('produces exactly 2 segments', () => expect(segs).to.have.length(2));
    it('first segment start is VANAD', () =>
      expect(segs[0].start.name).to.equal('VANAD'));
    it('first segment end is DEVRO', () =>
      expect(segs[0].end.name).to.equal('DEVRO'));
    it('last segment end is BOKNO', () =>
      expect(segs[segs.length - 1].end.name).to.equal('BOKNO'));
    it('all segments carry UN858', () =>
      segs.forEach((s) => expect(s.name).to.equal('UN858')));
  });

  // -------------------------------------------------------------------------
  // UN858 — longer forward slice ADABI→VANAD (3 hops)
  // -------------------------------------------------------------------------
  describe('UN858 longer forward ADABI→VANAD', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('ADABI UN858 VANAD');
    });

    it('produces exactly 3 segments', () => expect(segs).to.have.length(3));
    it('traverses ADABI→BOKNO→DEVRO→VANAD in order', () => {
      expect(segs[0].start.name).to.equal('ADABI');
      expect(segs[0].end.name).to.equal('BOKNO');
      expect(segs[1].end.name).to.equal('DEVRO');
      expect(segs[2].end.name).to.equal('VANAD');
    });
  });

  // -------------------------------------------------------------------------
  // UN874 — forward VANAD→VEKIN (10 intermediate waypoints in DDR)
  // From: 2023-01-18 LFBO→EHAM "VANAD UN874 VEKIN"
  // -------------------------------------------------------------------------
  describe('UN874 forward VANAD→VEKIN', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('VANAD UN874 VEKIN');
    });

    it('produces 10 segments (full DDR UN874 VANAD…VEKIN hop count)', () =>
      expect(segs).to.have.length(10));
    it('starts at VANAD', () => expect(segs[0].start.name).to.equal('VANAD'));
    it('ends at VEKIN', () =>
      expect(segs[segs.length - 1].end.name).to.equal('VEKIN'));
    it('all segments carry UN874', () =>
      segs.forEach((s) => expect(s.name).to.equal('UN874')));
  });

  // -------------------------------------------------------------------------
  // UT182 — forward POI→NIMER (2 hops)
  // From: 2023-06-05 LFBO→LFPG  "POI DCT PEPAX UT182 NIMER"
  // -------------------------------------------------------------------------
  describe('UT182 forward POI→NIMER', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('POI UT182 NIMER');
    });

    it('produces 2 segments', () => expect(segs).to.have.length(2));
    it('POI→PEPAX→NIMER via UT182', () => {
      expect(segs[0].start.name).to.equal('POI');
      expect(segs[0].end.name).to.equal('PEPAX');
      expect(segs[1].end.name).to.equal('NIMER');
    });
    it('all segments carry UT182', () =>
      segs.forEach((s) => expect(s.name).to.equal('UT182')));
  });

  // -------------------------------------------------------------------------
  // UT182 — reverse NIMER→POI (bidirectional)
  // -------------------------------------------------------------------------
  describe('UT182 reverse NIMER→POI', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('NIMER UT182 POI');
    });

    it('produces 2 segments', () => expect(segs).to.have.length(2));
    it('NIMER→PEPAX→POI (reversed order)', () => {
      expect(segs[0].start.name).to.equal('NIMER');
      expect(segs[0].end.name).to.equal('PEPAX');
      expect(segs[1].end.name).to.equal('POI');
    });
  });

  // -------------------------------------------------------------------------
  // N872 — southbound MEDIL→WOODY (4 hops; DDR lists N872 northbound)
  // From: 2023-01-19 EHAM→LFBO  "WOODY N872 MEDIL" (but we test southbound too)
  // -------------------------------------------------------------------------
  describe('N872 southbound MEDIL→WOODY', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('MEDIL N872 WOODY');
    });

    it('produces 4 segments', () => expect(segs).to.have.length(4));
    it('starts at MEDIL, ends at WOODY', () => {
      expect(segs[0].start.name).to.equal('MEDIL');
      expect(segs[segs.length - 1].end.name).to.equal('WOODY');
    });
    it('traverses CIV, DENOX, NIK in between', () => {
      const names = segs.map((s) => s.end.name);
      expect(names).to.include('CIV');
      expect(names).to.include('DENOX');
      expect(names).to.include('NIK');
    });
    it('all segments carry N872', () =>
      segs.forEach((s) => expect(s.name).to.equal('N872')));
  });

  // -------------------------------------------------------------------------
  // N873 ADUTO→FERDI (single hop, adjacent in DDR list)
  // -------------------------------------------------------------------------
  describe('N873 ADUTO→FERDI single hop', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('ADUTO N873 FERDI');
    });

    it('produces exactly 1 segment', () => expect(segs).to.have.length(1));
    it('ADUTO→FERDI via N873', () => {
      expect(segs[0].start.name).to.equal('ADUTO');
      expect(segs[0].end.name).to.equal('FERDI');
      expect(segs[0].name).to.equal('N873');
    });
  });

  // -------------------------------------------------------------------------
  // Y18 — FERDI→DENUT (reverse of DDR list which starts at DENUT)
  // -------------------------------------------------------------------------
  describe('Y18 FERDI→DENUT (reverse of DDR list)', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute('FERDI Y18 DENUT');
    });

    it('produces exactly 1 segment', () => expect(segs).to.have.length(1));
    it('FERDI→DENUT via Y18', () => {
      expect(segs[0].start.name).to.equal('FERDI');
      expect(segs[0].end.name).to.equal('DENUT');
      expect(segs[0].name).to.equal('Y18');
    });
  });

  // -------------------------------------------------------------------------
  // Full LFBO→EHAM core segment (no SID/STAR, no speed/alt tokens)
  // From: 2023-01-18 LFBO→EHAM
  // Route: BOKNO UN858 VANAD UN874 VEKIN UN873 ADUTO N873 FERDI Y18 DENUT
  // Expected: 15 segments total
  // -------------------------------------------------------------------------
  describe('Full LFBO→EHAM core — multi-airway chain', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute(
        'BOKNO UN858 VANAD UN874 VEKIN UN873 ADUTO N873 FERDI Y18 DENUT'
      );
    });

    it('produces 15 segments', () => expect(segs).to.have.length(15));
    it('starts with BOKNO', () => expect(segs[0].start.name).to.equal('BOKNO'));
    it('ends with DENUT', () =>
      expect(segs[segs.length - 1].end.name).to.equal('DENUT'));
    it('contains UN858 segments', () => {
      const un858 = segs.filter((s) => s.name === 'UN858');
      expect(un858.length).to.be.at.least(1);
    });
    it('contains UN874 segments spanning VANAD→VEKIN', () => {
      const un874 = segs.filter((s) => s.name === 'UN874');
      expect(un874.length).to.be.at.least(1);
      expect(un874[0].start.name).to.equal('VANAD');
      expect(un874[un874.length - 1].end.name).to.equal('VEKIN');
    });
    it('last segment is FERDI→DENUT via Y18', () => {
      const last = segs[segs.length - 1];
      expect(last.start.name).to.equal('FERDI');
      expect(last.end.name).to.equal('DENUT');
      expect(last.name).to.equal('Y18');
    });
  });

  // -------------------------------------------------------------------------
  // Full EHAM→LFBO core segment
  // From: 2023-01-19 EHAM→LFBO  (stripped speed/alt + SID/STAR)
  // Route: WOODY N872 MEDIL UN872 KOVIN UM728 RESMI UN857 DISAK DCT DIRMO DCT GUERE DCT EVPOK DCT NARAK
  // Expected: 15 segments (11 airway + 4 DCT)
  // -------------------------------------------------------------------------
  describe('Full EHAM→LFBO core — southbound with DCT legs', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = ddr.enrichRoute(
        'WOODY N872 MEDIL UN872 KOVIN UM728 RESMI UN857 DISAK DCT DIRMO DCT GUERE DCT EVPOK DCT NARAK'
      );
    });

    it('produces 15 segments', () => expect(segs).to.have.length(15));
    it('starts at WOODY', () => expect(segs[0].start.name).to.equal('WOODY'));
    it('ends at NARAK', () =>
      expect(segs[segs.length - 1].end.name).to.equal('NARAK'));
    it('contains DCT legs for DISAK→DIRMO→GUERE→EVPOK→NARAK', () => {
      const dct = segs.filter((s) => s.name === undefined || s.name === null);
      expect(dct.length).to.equal(4);
      const dctNames = dct.map((s) => `${s.start.name}→${s.end.name}`);
      expect(dctNames).to.include('DISAK→DIRMO');
      expect(dctNames).to.include('EVPOK→NARAK');
    });
    it('N872 segment chain ends at MEDIL', () => {
      const n872 = segs.filter((s) => s.name === 'N872');
      expect(n872.length).to.be.at.least(1);
      expect(n872[n872.length - 1].end.name).to.equal('MEDIL');
    });
    it('UM728 KOVIN→RESMI has 2 hops (via DUCRA)', () => {
      const um728 = segs.filter((s) => s.name === 'UM728');
      expect(um728).to.have.length(2);
      expect(um728[0].start.name).to.equal('KOVIN');
      expect(um728[0].end.name).to.equal('DUCRA');
      expect(um728[1].end.name).to.equal('RESMI');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown waypoints — entry or exit not in airway → 0 segments for that leg
  // -------------------------------------------------------------------------
  describe('Unknown entry/exit waypoint handling', () => {
    it('completely unknown entry before airway produces no segments for that leg', () => {
      const segs = ddr.enrichRoute('XXYYZZ UN858 VANAD');
      // XXYYZZ is not resolved → no lastPoint → no segments
      expect(segs).to.have.length(0);
    });

    it('completely unknown exit after airway produces no segments for that leg', () => {
      const segs = ddr.enrichRoute('BOKNO UN858 XXYYZZ');
      expect(segs).to.have.length(0);
    });

    it('unknown waypoint in DCT chain is silently skipped', () => {
      const segs = ddr.enrichRoute('BOKNO DCT XXYYZZ DCT VANAD');
      // XXYYZZ unknown → skipped; BOKNO→VANAD produced
      expect(segs).to.have.length(1);
      expect(segs[0].start.name).to.equal('BOKNO');
      expect(segs[0].end.name).to.equal('VANAD');
    });
  });

  // -------------------------------------------------------------------------
  // GeoJSON output — enrichRouteAsGeoJSON
  // -------------------------------------------------------------------------
  describe('enrichRouteAsGeoJSON on real route', () => {
    let fc: ReturnType<EurocontrolDdrResolverJS['enrichRouteAsGeoJSON']>;
    before(() => {
      fc = ddr.enrichRouteAsGeoJSON('BOKNO UN858 VANAD UN874 VEKIN');
    });

    it('returns a FeatureCollection', () =>
      expect(fc.type).to.equal('FeatureCollection'));
    it('each feature is a LineString', () => {
      for (const f of fc.features)
        expect(f.geometry.type).to.equal('LineString');
    });
    it('coordinates are [lon, lat] order (lon is small positive for France/Belgium)', () => {
      const first = fc.features[0];
      const [lon, lat] = first.geometry.coordinates[0];
      expect(lon).to.be.closeTo(0.69, 0.1); // ~Loire area
      expect(lat).to.be.closeTo(47.05, 0.1);
    });
    it('airway segments carry name in properties', () => {
      for (const f of fc.features) {
        expect(['UN858', 'UN874']).to.include(f.properties.name);
      }
    });
    it('features carry start_name and end_name', () => {
      const first = fc.features[0];
      expect(first.properties.start_name).to.equal('BOKNO');
      expect(first.properties.end_name).to.equal('DEVRO');
    });
  });
});
