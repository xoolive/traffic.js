/**
 * nasr.spec.ts
 *
 * Tests for `NasrResolverJS` and `createNasrResolver`.
 *
 * Two test layers:
 *
 * 1. **NasrResolverJS unit tests (stub core)** — verify the JS wrapper class
 *    behaviour using a stub core whose segment data is taken verbatim from the
 *    real WASM output (NASR 2026-03-19 archive, J48 airway, Q105 airway,
 *    KJFK/KBOS airports).  No real WASM binary or archive needed.
 *
 * 2. **Integration tests (real NASR archive)** — load the real WASM and the
 *    cached NASR ZIP, then assert ground truth values derived from the actual
 *    resolver output.  Auto-skipped if the archive is not found at:
 *      ~/.cache/thrust-faa/nasr/28DaySubscription_Effective_*.zip
 *      ~/.cache/traffic/nasr/28DaySubscription_Effective_*.zip
 *    or via FAA_NASR_ZIP env var.
 *
 * Ground truth extracted from NasrResolver WASM on NASR 2026-03-19:
 *   - Airport KJFK: lat=40.63992805  lon=-73.77869222
 *   - Airport KBOS: lat=42.36294444  lon=-71.00638888
 *   - Airport KLAX: lat=33.94249638  lon=-118.40804861
 *   - Navaid  BAF:  lat=42.16195908  lon=-72.7161995   kind=navaid  point_type=VORTAC
 *   - Fix    BASYE: lat=41.34372222  lon=-73.79860833  kind=fix
 *   - Navaid  JFK:  lat=40.63288377  lon=-73.77139175  kind=navaid  (VOR/DME)
 *   - Airway J48 (8 pts): LANNA→PTW→BYRDD→HAAGN→PENSY→EMI→CSN→MOL
 *   - enrichRoute("LANNA J48 MOL"): 7 segs, all name="J48"
 *   - enrichRoute("MOL J48 LANNA"): 7 segs reversed, all name="J48"
 *   - enrichRoute("LANNA J48 EMI"):  5 segs (subset)
 *   - enrichRoute("LANNA J48 PTW"):  1 seg  (single hop)
 *   - Airway Q105 (4 pts): HRV→FATSO→REDFN→BLVNS
 *   - enrichRoute("HRV Q105 BLVNS"): 3 segs, all name="Q105"
 *   - enrichRoute("FATSO Q105 REDFN"): 1 seg  (interior single hop)
 *   - enrichRoute("JFK DCT BOS"): 1 DCT seg (name=undefined)
 *   - enrichRoute("KJFK DCT KBOS"): 1 DCT seg using airport codes
 *   - Airway Q448 (7 pts): PTW→LANNA→DBABE→BASYE→TRIBS→BIGGO→BAF
 *   - enrichRoute("PTW Q448 BAF"):  6 segs, all name="Q448"
 *     PTW resolves as airport (lat=40.23955555 lon=-75.55672222)
 *     BAF resolves as navaid (lat=42.16195908 lon=-72.7161995)
 *     BASYE resolves as fix  (lat=41.34372222 lon=-73.79860833)
 *   - enrichRoute("BAF Q448 PTW"):  6 segs reversed, all name="Q448"
 *   - enrichRoute("LANNA Q448 BASYE"): 2 segs (interior subset via DBABE)
 *
 * Note on PTW kind discrepancy: PTW appears as kind="navaid" on J48 but as
 * kind="airport" on Q448.  This reflects what the WASM resolver returns for
 * each airway's context — both values are verbatim ground truth from the same
 * NASR 2026-03-19 archive.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { describe, it, before } from 'mocha';
import { expect } from 'chai';

import { data, type RouteSegment } from '../src/index.js';

const {
  NasrResolverJS,
  createNasrResolver,
  airacCodeFromDate,
  effectiveDateFromAiracCode,
  nasrZipUrlFromAiracCode,
  nasrZipUrlFromDate,
} = data.faa;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Real ground-truth segment data
// (Extracted verbatim from NasrResolver WASM, NASR 2026-03-19)
// ---------------------------------------------------------------------------

// J48 — 7-segment full traversal LANNA→MOL
const J48_LANNA_MOL: RouteSegment[] = [
  {
    start: {
      name: 'LANNA',
      latitude: 40.55974166,
      longitude: -75.027725,
      kind: 'fix',
    },
    end: {
      name: 'PTW',
      latitude: 40.22223183,
      longitude: -75.56025083,
      kind: 'navaid',
    },
    name: 'J48',
  },
  {
    start: {
      name: 'PTW',
      latitude: 40.22223183,
      longitude: -75.56025083,
      kind: 'navaid',
    },
    end: {
      name: 'BYRDD',
      latitude: 40.09220277,
      longitude: -75.81869166,
      kind: 'fix',
    },
    name: 'J48',
  },
  {
    start: {
      name: 'BYRDD',
      latitude: 40.09220277,
      longitude: -75.81869166,
      kind: 'fix',
    },
    end: {
      name: 'HAAGN',
      latitude: 39.96149722,
      longitude: -76.0762,
      kind: 'fix',
    },
    name: 'J48',
  },
  {
    start: {
      name: 'HAAGN',
      latitude: 39.96149722,
      longitude: -76.0762,
      kind: 'fix',
    },
    end: {
      name: 'PENSY',
      latitude: 39.90721111,
      longitude: -76.18253611,
      kind: 'fix',
    },
    name: 'J48',
  },
  {
    start: {
      name: 'PENSY',
      latitude: 39.90721111,
      longitude: -76.18253611,
      kind: 'fix',
    },
    end: {
      name: 'EMI',
      latitude: 39.49500738,
      longitude: -76.97857197,
      kind: 'navaid',
    },
    name: 'J48',
  },
  {
    start: {
      name: 'EMI',
      latitude: 39.49500738,
      longitude: -76.97857197,
      kind: 'navaid',
    },
    end: {
      name: 'CSN',
      latitude: 38.64120213,
      longitude: -77.86549941,
      kind: 'navaid',
    },
    name: 'J48',
  },
  {
    start: {
      name: 'CSN',
      latitude: 38.64120213,
      longitude: -77.86549941,
      kind: 'navaid',
    },
    end: {
      name: 'MOL',
      latitude: 37.90052472,
      longitude: -79.10688916,
      kind: 'navaid',
    },
    name: 'J48',
  },
];

// J48 — full traversal MOL→LANNA (reverse of above)
const J48_MOL_LANNA: RouteSegment[] = J48_LANNA_MOL.slice()
  .reverse()
  .map((seg) => ({ start: seg.end, end: seg.start, name: seg.name }));

// J48 — 5-segment subset LANNA→EMI
const J48_LANNA_EMI = J48_LANNA_MOL.slice(0, 5);

// J48 — 1-segment single hop LANNA→PTW
const J48_LANNA_PTW = J48_LANNA_MOL.slice(0, 1);

// Q105 — 3-segment full traversal HRV→BLVNS
const Q105_HRV_BLVNS: RouteSegment[] = [
  {
    start: {
      name: 'HRV',
      latitude: 29.85019472,
      longitude: -90.00298416,
      kind: 'navaid',
    },
    end: {
      name: 'FATSO',
      latitude: 29.68999722,
      longitude: -89.78457222,
      kind: 'fix',
    },
    name: 'Q105',
  },
  {
    start: {
      name: 'FATSO',
      latitude: 29.68999722,
      longitude: -89.78457222,
      kind: 'fix',
    },
    end: {
      name: 'REDFN',
      latitude: 28.88296944,
      longitude: -88.70178055,
      kind: 'fix',
    },
    name: 'Q105',
  },
  {
    start: {
      name: 'REDFN',
      latitude: 28.88296944,
      longitude: -88.70178055,
      kind: 'fix',
    },
    end: {
      name: 'BLVNS',
      latitude: 28.382275,
      longitude: -88.03416111,
      kind: 'fix',
    },
    name: 'Q105',
  },
];

// Q105 — 1-segment interior FATSO→REDFN
const Q105_FATSO_REDFN = Q105_HRV_BLVNS.slice(1, 2);

// Q448 — 6-segment full traversal PTW→BAF
// Coordinates are verbatim from enrichRoute("PTW Q448 BAF") on NASR 2026-03-19.
// Note: PTW resolves as kind="airport" in Q448 context (different from J48 where
// it resolves as kind="navaid") — both values are ground truth from the same archive.
const Q448_PTW_BAF: RouteSegment[] = [
  {
    start: {
      name: 'PTW',
      latitude: 40.23955555,
      longitude: -75.55672222,
      kind: 'airport',
    },
    end: {
      name: 'LANNA',
      latitude: 40.55974166,
      longitude: -75.027725,
      kind: 'fix',
    },
    name: 'Q448',
  },
  {
    start: {
      name: 'LANNA',
      latitude: 40.55974166,
      longitude: -75.027725,
      kind: 'fix',
    },
    end: {
      name: 'DBABE',
      latitude: 41.14166666,
      longitude: -74.09611111,
      kind: 'fix',
    },
    name: 'Q448',
  },
  {
    start: {
      name: 'DBABE',
      latitude: 41.14166666,
      longitude: -74.09611111,
      kind: 'fix',
    },
    end: {
      name: 'BASYE',
      latitude: 41.34372222,
      longitude: -73.79860833,
      kind: 'fix',
    },
    name: 'Q448',
  },
  {
    start: {
      name: 'BASYE',
      latitude: 41.34372222,
      longitude: -73.79860833,
      kind: 'fix',
    },
    end: {
      name: 'TRIBS',
      latitude: 41.65805555,
      longitude: -73.3175,
      kind: 'fix',
    },
    name: 'Q448',
  },
  {
    start: {
      name: 'TRIBS',
      latitude: 41.65805555,
      longitude: -73.3175,
      kind: 'fix',
    },
    end: {
      name: 'BIGGO',
      latitude: 41.95580833,
      longitude: -73.06794166,
      kind: 'fix',
    },
    name: 'Q448',
  },
  {
    start: {
      name: 'BIGGO',
      latitude: 41.95580833,
      longitude: -73.06794166,
      kind: 'fix',
    },
    end: {
      name: 'BAF',
      latitude: 42.16195908,
      longitude: -72.7161995,
      kind: 'navaid',
    },
    name: 'Q448',
  },
];

// Q448 — full traversal BAF→PTW (reverse of above)
const Q448_BAF_PTW: RouteSegment[] = Q448_PTW_BAF.slice()
  .reverse()
  .map((seg) => ({ start: seg.end, end: seg.start, name: seg.name }));

// Q448 — 2-segment interior subset LANNA→BASYE (via DBABE)
const Q448_LANNA_BASYE = Q448_PTW_BAF.slice(1, 3);

// DCT — JFK navaid → BOS navaid
const DCT_JFK_BOS: RouteSegment = {
  start: {
    name: 'JFK',
    latitude: 40.63992805,
    longitude: -73.77869222,
    kind: 'airport',
  },
  end: {
    name: 'BOS',
    latitude: 42.36294444,
    longitude: -71.00638888,
    kind: 'airport',
  },
  name: undefined,
};

// DCT — KJFK airport → KBOS airport
const DCT_KJFK_KBOS: RouteSegment = {
  start: {
    name: 'KJFK',
    latitude: 40.63992805,
    longitude: -73.77869222,
    kind: 'airport',
  },
  end: {
    name: 'KBOS',
    latitude: 42.36294444,
    longitude: -71.00638888,
    kind: 'airport',
  },
  name: undefined,
};

// ---------------------------------------------------------------------------
// Stub core (returns pre-baked real segments by route string)
// ---------------------------------------------------------------------------

function makeStubCore(routes: Record<string, RouteSegment[]>): {
  airports(): unknown;
  navaids(): unknown;
  fixes(): unknown;
  airways(): unknown;
  airspaces(): unknown;
  resolve_airport(c: string): unknown;
  resolve_navaid(c: string): unknown;
  resolve_fix(c: string): unknown;
  resolve_airway(n: string): unknown;
  resolve_sid?(n: string): unknown;
  resolve_star?(n: string): unknown;
  resolve_airspace(d: string): unknown;
  enrichRoute(route: string): RouteSegment[];
} {
  return {
    airports: () => [],
    navaids: () => [],
    fixes: () => [],
    airways: () => [],
    airspaces: () => [],
    resolve_airport: () => null,
    resolve_navaid: () => null,
    resolve_fix: () => null,
    resolve_airway: () => null,
    resolve_sid: () => null,
    resolve_star: () => null,
    resolve_airspace: () => null,
    enrichRoute: (route: string) => [...(routes[route.trim()] ?? [])],
  };
}

const STUB_ROUTES: Record<string, RouteSegment[]> = {
  'LANNA J48 MOL': J48_LANNA_MOL,
  'MOL J48 LANNA': J48_MOL_LANNA,
  'LANNA J48 EMI': J48_LANNA_EMI,
  'LANNA J48 PTW': J48_LANNA_PTW,
  'HRV Q105 BLVNS': Q105_HRV_BLVNS,
  'FATSO Q105 REDFN': Q105_FATSO_REDFN,
  'PTW Q448 BAF': Q448_PTW_BAF,
  'BAF Q448 PTW': Q448_BAF_PTW,
  'LANNA Q448 BASYE': Q448_LANNA_BASYE,
  'JFK DCT BOS': [DCT_JFK_BOS],
  'KJFK DCT KBOS': [DCT_KJFK_KBOS],
};

// ---------------------------------------------------------------------------
// 1. NasrResolverJS — constructor and API surface
// ---------------------------------------------------------------------------

describe('NasrResolverJS — constructor', () => {
  it('can be constructed directly with a stub core', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    expect(r).to.be.an.instanceOf(NasrResolverJS);
  });

  it('exposes enrichRoute method', () => {
    expect(new NasrResolverJS(makeStubCore({})).enrichRoute).to.be.a(
      'function'
    );
  });

  it('exposes enrichRouteAsGeoJSON method', () => {
    expect(new NasrResolverJS(makeStubCore({})).enrichRouteAsGeoJSON).to.be.a(
      'function'
    );
  });

  it('exposes resolve method', () => {
    expect(new NasrResolverJS(makeStubCore({})).resolve).to.be.a('function');
  });

  it('resolve({STAR}) returns a procedure feature when core supports resolve_star', async () => {
    const r = new NasrResolverJS({
      ...makeStubCore({}),
      resolve_star: (name: string) =>
        name.toUpperCase() === 'KEPER9E'
          ? {
              name: 'KEPER9E',
              procedure_kind: 'STAR',
              route_class: 'AP',
              points: [
                { code: 'KEPER', latitude: 44.0, longitude: 2.0 },
                { code: 'LFBO', latitude: 43.63, longitude: 1.37 },
              ],
            }
          : null,
    });
    const star = (await r.resolve({ STAR: 'KEPER9E', airport: 'LFBO' })) as {
      type: string;
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown } | null;
    };
    expect(star.type).to.equal('Feature');
    expect(star.properties['procedure_kind']).to.equal('STAR');
    expect(star.geometry?.type).to.equal('LineString');
  });
});

// ---------------------------------------------------------------------------
// 2. NasrResolverJS — enrichRoute (real segment fixtures from J48 / Q105)
// ---------------------------------------------------------------------------

describe('NasrResolverJS — enrichRoute (J48 / Q105 fixtures)', () => {
  it('LANNA J48 PTW — 1 segment, single hop', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA J48 PTW');
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('LANNA');
    expect(segs[0].end.name).to.equal('PTW');
    expect(segs[0].name).to.equal('J48');
  });

  it('LANNA J48 PTW — start coordinates match NASR 2026-03-19', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA J48 PTW');
    expect(segs[0].start.latitude).to.be.closeTo(40.55974, 0.00001);
    expect(segs[0].start.longitude).to.be.closeTo(-75.02773, 0.00001);
  });

  it('LANNA J48 PTW — end coordinates match NASR 2026-03-19', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA J48 PTW');
    expect(segs[0].end.latitude).to.be.closeTo(40.22223, 0.00001);
    expect(segs[0].end.longitude).to.be.closeTo(-75.56025, 0.00001);
  });

  it('LANNA J48 MOL — 7 segments (full J48 forward traversal)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA J48 MOL');
    expect(segs).to.have.length(7);
  });

  it('LANNA J48 MOL — all segments carry airway name J48', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    for (const seg of r.enrichRoute('LANNA J48 MOL')) {
      expect(seg.name).to.equal('J48');
    }
  });

  it('LANNA J48 MOL — waypoint sequence LANNA→PTW→BYRDD→HAAGN→PENSY→EMI→CSN→MOL', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA J48 MOL');
    const sequence = [segs[0].start, ...segs.map((s) => s.end)].map(
      (p) => p.name
    );
    expect(sequence).to.deep.equal([
      'LANNA',
      'PTW',
      'BYRDD',
      'HAAGN',
      'PENSY',
      'EMI',
      'CSN',
      'MOL',
    ]);
  });

  it('MOL J48 LANNA — 7 segments (reverse traversal)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('MOL J48 LANNA');
    expect(segs).to.have.length(7);
    expect(segs[0].start.name).to.equal('MOL');
    expect(segs[segs.length - 1].end.name).to.equal('LANNA');
  });

  it('MOL J48 LANNA — waypoint sequence is exact reverse of LANNA J48 MOL', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fwd = r.enrichRoute('LANNA J48 MOL');
    const rev = r.enrichRoute('MOL J48 LANNA');
    const fwdSeq = [fwd[0].start, ...fwd.map((s) => s.end)].map((p) => p.name);
    const revSeq = [rev[0].start, ...rev.map((s) => s.end)].map((p) => p.name);
    expect(revSeq).to.deep.equal([...fwdSeq].reverse());
  });

  it('LANNA J48 EMI — 5 segments (subset stops at EMI)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA J48 EMI');
    expect(segs).to.have.length(5);
    expect(segs[segs.length - 1].end.name).to.equal('EMI');
  });

  it('HRV Q105 BLVNS — 3 segments (full Q105 traversal)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('HRV Q105 BLVNS');
    expect(segs).to.have.length(3);
    expect(segs[0].start.name).to.equal('HRV');
    expect(segs[segs.length - 1].end.name).to.equal('BLVNS');
    for (const seg of segs) {
      expect(seg.name).to.equal('Q105');
    }
  });

  it('HRV Q105 BLVNS — start at HRV gulf coast navaid (lat≈29.85, lon≈-90.00)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('HRV Q105 BLVNS');
    expect(segs[0].start.latitude).to.be.closeTo(29.85, 0.001);
    expect(segs[0].start.longitude).to.be.closeTo(-90.003, 0.001);
  });

  it('FATSO Q105 REDFN — 1 segment (interior single hop)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('FATSO Q105 REDFN');
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('FATSO');
    expect(segs[0].end.name).to.equal('REDFN');
    expect(segs[0].name).to.equal('Q105');
  });

  it('PTW Q448 BAF — 6 segments (full Q448 forward traversal)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('PTW Q448 BAF');
    expect(segs).to.have.length(6);
    expect(segs[0].start.name).to.equal('PTW');
    expect(segs[segs.length - 1].end.name).to.equal('BAF');
    for (const seg of segs) {
      expect(seg.name).to.equal('Q448');
    }
  });

  it('PTW Q448 BAF — waypoint sequence PTW→LANNA→DBABE→BASYE→TRIBS→BIGGO→BAF', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('PTW Q448 BAF');
    const seq = [segs[0].start, ...segs.map((s) => s.end)].map((p) => p.name);
    expect(seq).to.deep.equal([
      'PTW',
      'LANNA',
      'DBABE',
      'BASYE',
      'TRIBS',
      'BIGGO',
      'BAF',
    ]);
  });

  it('PTW Q448 BAF — PTW start is airport (lat≈40.240, lon≈-75.557)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('PTW Q448 BAF');
    expect(segs[0].start.kind).to.equal('airport');
    expect(segs[0].start.latitude).to.be.closeTo(40.23955555, 0.00001);
    expect(segs[0].start.longitude).to.be.closeTo(-75.55672222, 0.00001);
  });

  it('PTW Q448 BAF — BAF end is navaid VORTAC (lat≈42.162, lon≈-72.716)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('PTW Q448 BAF');
    expect(segs[segs.length - 1].end.kind).to.equal('navaid');
    expect(segs[segs.length - 1].end.latitude).to.be.closeTo(
      42.16195908,
      0.00001
    );
    expect(segs[segs.length - 1].end.longitude).to.be.closeTo(
      -72.7161995,
      0.00001
    );
  });

  it('PTW Q448 BAF — BASYE fix at lat≈41.344, lon≈-73.799', () => {
    // BASYE is the 3rd waypoint (end of seg[2]) — tests a real ground-truth fix coordinate
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('PTW Q448 BAF');
    const basye = segs[2].end;
    expect(basye.name).to.equal('BASYE');
    expect(basye.kind).to.equal('fix');
    expect(basye.latitude).to.be.closeTo(41.34372222, 0.00001);
    expect(basye.longitude).to.be.closeTo(-73.79860833, 0.00001);
  });

  it('BAF Q448 PTW — 6 segments (reverse traversal)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('BAF Q448 PTW');
    expect(segs).to.have.length(6);
    expect(segs[0].start.name).to.equal('BAF');
    expect(segs[segs.length - 1].end.name).to.equal('PTW');
  });

  it('BAF Q448 PTW — waypoint sequence is exact reverse of PTW Q448 BAF', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fwd = r.enrichRoute('PTW Q448 BAF');
    const rev = r.enrichRoute('BAF Q448 PTW');
    const fwdSeq = [fwd[0].start, ...fwd.map((s) => s.end)].map((p) => p.name);
    const revSeq = [rev[0].start, ...rev.map((s) => s.end)].map((p) => p.name);
    expect(revSeq).to.deep.equal([...fwdSeq].reverse());
  });

  it('LANNA Q448 BASYE — 2 segments (interior subset via DBABE)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('LANNA Q448 BASYE');
    expect(segs).to.have.length(2);
    expect(segs[0].start.name).to.equal('LANNA');
    expect(segs[0].end.name).to.equal('DBABE'); // DBABE is the intermediate waypoint
    expect(segs[1].end.name).to.equal('BASYE');
    for (const seg of segs) {
      expect(seg.name).to.equal('Q448');
    }
  });

  it('JFK DCT BOS — 1 DCT segment, name is undefined', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('JFK DCT BOS');
    expect(segs).to.have.length(1);
    expect(segs[0].name).to.be.undefined;
  });

  it('JFK DCT BOS — JFK at lat≈40.640 lon≈-73.779 (airport), BOS at lat≈42.363 lon≈-71.006', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const segs = r.enrichRoute('JFK DCT BOS');
    expect(segs[0].start.latitude).to.be.closeTo(40.64, 0.001);
    expect(segs[0].start.longitude).to.be.closeTo(-73.779, 0.001);
    expect(segs[0].end.latitude).to.be.closeTo(42.363, 0.001);
    expect(segs[0].end.longitude).to.be.closeTo(-71.006, 0.001);
  });

  it('unknown route returns empty array', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    expect(r.enrichRoute('ZZZZ DCT YYYY')).to.have.length(0);
  });

  it('route string is forwarded to the core unchanged', () => {
    const received: string[] = [];
    const core = makeStubCore(STUB_ROUTES);
    const orig = core.enrichRoute.bind(core);
    core.enrichRoute = (route: string) => {
      received.push(route);
      return orig(route);
    };
    new NasrResolverJS(core).enrichRoute('LANNA J48 MOL');
    expect(received).to.deep.equal(['LANNA J48 MOL']);
  });
});

// ---------------------------------------------------------------------------
// 3. NasrResolverJS — enrichRouteAsGeoJSON
// ---------------------------------------------------------------------------

describe('NasrResolverJS — enrichRouteAsGeoJSON (J48 / Q105 fixtures)', () => {
  it('returns a FeatureCollection', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    expect(r.enrichRouteAsGeoJSON('LANNA J48 MOL').type).to.equal(
      'FeatureCollection'
    );
  });

  it('LANNA J48 MOL — 7 LineString features', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('LANNA J48 MOL');
    expect(fc.features).to.have.length(7);
    for (const f of fc.features) {
      expect(f.geometry.type).to.equal('LineString');
    }
  });

  it('coordinates are [longitude, latitude] (GeoJSON convention)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('LANNA J48 PTW');
    const [lon, lat] = fc.features[0].geometry.coordinates[0];
    // LANNA: lat=40.55974, lon=-75.02773
    expect(lon).to.be.closeTo(-75.028, 0.001);
    expect(lat).to.be.closeTo(40.56, 0.001);
  });

  it('J48 airway features all have name="J48" in properties', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('LANNA J48 MOL');
    for (const f of fc.features) {
      expect(f.properties.name).to.equal('J48');
    }
  });

  it('DCT features remain unnamed when core does not provide segment metadata', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('JFK DCT BOS');
    expect(fc.features[0].properties.name).to.equal(null);
    expect(fc.features[0].properties.segment_type).to.equal(null);
    expect(fc.features[0].properties.connector).to.equal(null);
  });

  it('features carry start_name and end_name', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('LANNA J48 PTW');
    expect(fc.features[0].properties.start_name).to.equal('LANNA');
    expect(fc.features[0].properties.end_name).to.equal('PTW');
  });

  it('features carry start_kind and end_kind (fix / navaid from real data)', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('LANNA J48 PTW');
    // LANNA is a fix, PTW is a navaid — from real NASR data
    expect(fc.features[0].properties.start_kind).to.equal('fix');
    expect(fc.features[0].properties.end_kind).to.equal('navaid');
  });

  it('HRV Q105 BLVNS — 3 features, all name="Q105"', () => {
    const r = new NasrResolverJS(makeStubCore(STUB_ROUTES));
    const fc = r.enrichRouteAsGeoJSON('HRV Q105 BLVNS');
    expect(fc.features).to.have.length(3);
    for (const f of fc.features) {
      expect(f.properties.name).to.equal('Q105');
    }
  });

  it('empty route produces empty FeatureCollection', () => {
    const r = new NasrResolverJS(makeStubCore({}));
    const fc = r.enrichRouteAsGeoJSON('ZZZZ DCT YYYY');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.have.length(0);
  });
});

// ---------------------------------------------------------------------------
// 4. createNasrResolver — factory path (fake WASM module, no real archive)
// ---------------------------------------------------------------------------

function makeFakeWasmModule(routes: Record<string, RouteSegment[]> = {}): {
  default: (input?: unknown) => Promise<void>;
  NasrResolver: new (zipBytes: Uint8Array) => ReturnType<typeof makeStubCore>;
  _initCalled: boolean;
  _lastZipLength: number;
} {
  const mod = {
    _initCalled: false,
    _lastZipLength: 0,
    default: async (_input?: unknown) => {
      mod._initCalled = true;
    },
    NasrResolver: class {
      constructor(zipBytes: Uint8Array) {
        mod._lastZipLength = zipBytes.length;
      }
      airports() {
        return [];
      }
      navaids() {
        return [];
      }
      fixes() {
        return [];
      }
      airways() {
        return [];
      }
      airspaces() {
        return [];
      }
      resolve_airport() {
        return null;
      }
      resolve_navaid() {
        return null;
      }
      resolve_fix() {
        return null;
      }
      resolve_airway() {
        return null;
      }
      resolve_airspace() {
        return null;
      }
      enrichRoute(route: string) {
        return [...(routes[route.trim()] ?? [])];
      }
    },
  };
  return mod as typeof mod & { _initCalled: boolean; _lastZipLength: number };
}

describe('createNasrResolver — factory', () => {
  it('throws when neither archive nor archiveUrl is provided', async () => {
    let threw = false;
    try {
      await createNasrResolver({ thrustModule: makeFakeWasmModule() as never });
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).to.match(
        /archive.*required|archiveUrl.*required/i
      );
    }
    expect(threw).to.equal(true);
  });

  it('builds FAA NASR URL from AIRAC code', () => {
    expect(nasrZipUrlFromAiracCode('2602')).to.equal(
      'https://nfdc.faa.gov/webContent/28DaySub/28DaySubscription_Effective_2026-02-19.zip'
    );
  });

  it('converts date to AIRAC before generating NASR URL', () => {
    const code = airacCodeFromDate('2026-02-19');
    expect(code).to.equal('2602');
    const fromDate = nasrZipUrlFromDate('2026-02-19');
    const fromCode = nasrZipUrlFromAiracCode(code);
    expect(fromDate).to.equal(fromCode);
  });

  it('effectiveDateFromAiracCode round-trips through URL builder', () => {
    const effective = effectiveDateFromAiracCode('2602');
    expect(effective.toISOString().slice(0, 10)).to.equal('2026-02-19');
    expect(nasrZipUrlFromAiracCode('2602')).to.include('2026-02-19');
  });

  it('calls wasm.default() to initialise the module', async () => {
    const wasm = makeFakeWasmModule();
    await createNasrResolver({
      thrustModule: wasm as never,
      archive: new Uint8Array([1, 2, 3]),
    });
    expect(wasm._initCalled).to.equal(true);
  });

  it('passes archive bytes to NasrResolver constructor', async () => {
    const archive = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const wasm = makeFakeWasmModule();
    await createNasrResolver({ thrustModule: wasm as never, archive });
    expect(wasm._lastZipLength).to.equal(3);
  });

  it('accepts ArrayBuffer as archive and wraps it in Uint8Array', async () => {
    const buf = new Uint8Array([0x11, 0x22]).buffer;
    const wasm = makeFakeWasmModule();
    await createNasrResolver({ thrustModule: wasm as never, archive: buf });
    expect(wasm._lastZipLength).to.equal(2);
  });

  it('returns a NasrResolverJS instance', async () => {
    const wasm = makeFakeWasmModule(STUB_ROUTES);
    const resolver = await createNasrResolver({
      thrustModule: wasm as never,
      archive: new Uint8Array([1, 2, 3]),
    });
    expect(resolver).to.be.an.instanceOf(NasrResolverJS);
  });

  it('returned resolver correctly enriches LANNA J48 MOL (7 segs)', async () => {
    const wasm = makeFakeWasmModule(STUB_ROUTES);
    const resolver = await createNasrResolver({
      thrustModule: wasm as never,
      archive: new Uint8Array([1, 2, 3]),
    });
    const segs = resolver.enrichRoute('LANNA J48 MOL');
    expect(segs).to.have.length(7);
    expect(segs[0].start.name).to.equal('LANNA');
    expect(segs[segs.length - 1].end.name).to.equal('MOL');
  });

  it('fetches archive from archiveUrl when archive is not provided', async () => {
    const archiveBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const wasm = makeFakeWasmModule();
    const fetchImpl = async (): Promise<Response> =>
      new Response(archiveBytes.buffer, { status: 200, headers: {} });
    const resolver = await createNasrResolver({
      thrustModule: wasm as never,
      archiveUrl: 'https://example.com/nasr.zip',
      fetchImpl,
    });
    expect(wasm._lastZipLength).to.equal(4);
    expect(resolver).to.be.an.instanceOf(NasrResolverJS);
  });

  it('fetches archive from computed URL when airac is provided', async () => {
    const archiveBytes = new Uint8Array([1, 2, 3]);
    const wasm = makeFakeWasmModule();
    const called: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      called.push(String(input));
      return new Response(archiveBytes.buffer, { status: 200, headers: {} });
    };

    await createNasrResolver({
      thrustModule: wasm as never,
      airac: '2602',
      fetchImpl,
    });

    expect(called).to.have.length(1);
    expect(called[0]).to.equal(
      'https://nfdc.faa.gov/webContent/28DaySub/28DaySubscription_Effective_2026-02-19.zip'
    );
  });

  it('fetches archive from computed URL when date is provided', async () => {
    const archiveBytes = new Uint8Array([1, 2, 3]);
    const wasm = makeFakeWasmModule();
    const called: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      called.push(String(input));
      return new Response(archiveBytes.buffer, { status: 200, headers: {} });
    };

    await createNasrResolver({
      thrustModule: wasm as never,
      date: '2026-02-19',
      fetchImpl,
    });

    expect(called).to.have.length(1);
    expect(called[0]).to.equal(
      'https://nfdc.faa.gov/webContent/28DaySub/28DaySubscription_Effective_2026-02-19.zip'
    );
  });

  it('throws a descriptive error when fetch returns non-ok status', async () => {
    const wasm = makeFakeWasmModule();
    const fetchImpl = async (): Promise<Response> =>
      new Response(null, { status: 404, statusText: 'Not Found' });
    let threw = false;
    try {
      await createNasrResolver({
        thrustModule: wasm as never,
        archiveUrl: 'https://example.com/nasr_missing.zip',
        fetchImpl,
      });
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).to.match(/404|Not Found/i);
    }
    expect(threw).to.equal(true);
  });

  it('calls onProgress during streamed archiveUrl fetch', async () => {
    const wasm = makeFakeWasmModule();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const progress: Array<{ loaded: number; total: number }> = [];
    await createNasrResolver({
      thrustModule: wasm as never,
      archiveUrl: 'https://example.com/nasr.zip',
      fetchImpl: async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-length': '5' },
        }),
      onProgress: (loaded, total) => progress.push({ loaded, total }),
    });
    expect(progress.length).to.be.greaterThan(0);
    expect(progress[progress.length - 1].loaded).to.equal(5);
    expect(progress[progress.length - 1].total).to.equal(5);
  });

  it('throws when module could not be loaded (autoLoadThrustModule=false)', async () => {
    let threw = false;
    try {
      await createNasrResolver({
        autoLoadThrustModule: false,
        archive: new Uint8Array([1]),
      });
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).to.match(/could not be loaded/i);
    }
    expect(threw).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Integration tests — real WASM + real NASR archive
// ---------------------------------------------------------------------------

function findNasrArchive(): string | null {
  // 1. Explicit env var
  const fromEnv = process.env.FAA_NASR_ZIP;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // 2. Cache directories used by thrust and traffic
  const cacheDirs = [
    join(homedir(), '.cache', 'thrust-faa', 'nasr'),
    join(homedir(), '.cache', 'thrust', 'faa', 'nasr'),
    join(homedir(), '.cache', 'traffic', 'nasr'),
  ];
  for (const dir of cacheDirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir)
      .filter(
        (n) =>
          n.startsWith('28DaySubscription_Effective_') && n.endsWith('.zip')
      )
      .sort()
      .reverse(); // newest first
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const NASR_ZIP = findNasrArchive();
const WASM_JS = resolve(
  __dirname,
  '../../thrust/crates/thrust-wasm/pkg/web/thrust_wasm.js'
);
const WASM_BIN = resolve(
  __dirname,
  '../../thrust/crates/thrust-wasm/pkg/web/thrust_wasm_bg.wasm'
);

const INTEGRATION_AVAILABLE =
  NASR_ZIP !== null && existsSync(WASM_JS) && existsSync(WASM_BIN);

// Integration tests — skipped when archive or WASM build is absent
describe('NasrResolverJS — integration (real NASR archive)', function () {
  if (!INTEGRATION_AVAILABLE) {
    it.skip('skipped — NASR archive or thrust-wasm web build not available', () => {});
    return;
  }

  // Increase timeout — parsing the full NASR archive takes a few seconds
  this.timeout(30_000);

  let nasr: NasrResolverJS;

  before(async () => {
    // Load web build with local WASM binary (avoids fetch in Node.js)
    const wasm = (await import(WASM_JS)) as {
      default: (b: ArrayBuffer) => Promise<void>;
      NasrResolver: new (bytes: Uint8Array) => unknown;
    };
    await wasm.default(readFileSync(WASM_BIN).buffer);
    const zipBytes = new Uint8Array(readFileSync(NASR_ZIP!));
    nasr = await createNasrResolver({
      thrustModule: wasm as never,
      archive: zipBytes,
    });
  });

  // --- Airport lookups ---
  it('KLAX resolves to Los Angeles Intl, lat≈33.942 lon≈-118.408', () => {
    const segs = nasr.enrichRoute('KLAX DCT KJFK');
    // Even a DCT verifies KLAX is found and has real coordinates
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('KLAX');
    expect(segs[0].start.latitude).to.be.closeTo(33.94249638, 0.0001);
    expect(segs[0].start.longitude).to.be.closeTo(-118.40804861, 0.0001);
    expect(segs[0].start.kind).to.equal('airport');
  });

  it('KJFK resolves to JFK airport, lat≈40.640 lon≈-73.779', () => {
    const segs = nasr.enrichRoute('KJFK DCT KBOS');
    expect(segs[0].start.latitude).to.be.closeTo(40.63992805, 0.0001);
    expect(segs[0].start.longitude).to.be.closeTo(-73.77869222, 0.0001);
  });

  it('KBOS resolves to Boston Logan, lat≈42.363 lon≈-71.006', () => {
    const segs = nasr.enrichRoute('KJFK DCT KBOS');
    expect(segs[0].end.latitude).to.be.closeTo(42.36294444, 0.0001);
    expect(segs[0].end.longitude).to.be.closeTo(-71.00638888, 0.0001);
  });

  // --- J48 airway ---
  describe('J48 forward LANNA→MOL', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('LANNA J48 MOL');
    });

    it('produces 7 segments', () => {
      expect(segs).to.have.length(7);
    });

    it('starts at LANNA (fix, lat≈40.560 lon≈-75.028)', () => {
      expect(segs[0].start.name).to.equal('LANNA');
      expect(segs[0].start.kind).to.equal('fix');
      expect(segs[0].start.latitude).to.be.closeTo(40.55974166, 0.0001);
      expect(segs[0].start.longitude).to.be.closeTo(-75.027725, 0.0001);
    });

    it('ends at MOL (navaid, lat≈37.901 lon≈-79.107)', () => {
      expect(segs[segs.length - 1].end.name).to.equal('MOL');
      expect(segs[segs.length - 1].end.kind).to.equal('navaid');
      expect(segs[segs.length - 1].end.latitude).to.be.closeTo(
        37.90052472,
        0.0001
      );
      expect(segs[segs.length - 1].end.longitude).to.be.closeTo(
        -79.10688916,
        0.0001
      );
    });

    it('traverses PTW→BYRDD→HAAGN→PENSY→EMI→CSN in between', () => {
      const intermediate = segs.slice(0, -1).map((s) => s.end.name);
      expect(intermediate).to.deep.equal([
        'PTW',
        'BYRDD',
        'HAAGN',
        'PENSY',
        'EMI',
        'CSN',
      ]);
    });

    it('all segments carry airway name J48', () => {
      for (const seg of segs) {
        expect(seg.name).to.equal('J48');
      }
    });
  });

  describe('J48 reverse MOL→LANNA', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('MOL J48 LANNA');
    });

    it('produces 7 segments', () => {
      expect(segs).to.have.length(7);
    });

    it('starts at MOL, ends at LANNA', () => {
      expect(segs[0].start.name).to.equal('MOL');
      expect(segs[segs.length - 1].end.name).to.equal('LANNA');
    });

    it('waypoint sequence is exact reverse of forward direction', () => {
      const fwd = nasr.enrichRoute('LANNA J48 MOL');
      const fwdSeq = [fwd[0].start, ...fwd.map((s) => s.end)].map(
        (p) => p.name
      );
      const revSeq = [segs[0].start, ...segs.map((s) => s.end)].map(
        (p) => p.name
      );
      expect(revSeq).to.deep.equal([...fwdSeq].reverse());
    });
  });

  describe('J48 subset LANNA→EMI (5 hops)', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('LANNA J48 EMI');
    });

    it('produces 5 segments', () => {
      expect(segs).to.have.length(5);
    });

    it('last segment ends at EMI (navaid)', () => {
      expect(segs[segs.length - 1].end.name).to.equal('EMI');
      expect(segs[segs.length - 1].end.kind).to.equal('navaid');
    });
  });

  describe('J48 single hop LANNA→PTW', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('LANNA J48 PTW');
    });

    it('produces exactly 1 segment', () => {
      expect(segs).to.have.length(1);
    });

    it('LANNA→PTW via J48 with real coordinates', () => {
      expect(segs[0].start.name).to.equal('LANNA');
      expect(segs[0].end.name).to.equal('PTW');
      expect(segs[0].name).to.equal('J48');
      expect(segs[0].start.latitude).to.be.closeTo(40.55974166, 0.0001);
      expect(segs[0].end.latitude).to.be.closeTo(40.22223183, 0.0001);
    });
  });

  // --- Q105 airway ---
  describe('Q105 full HRV→BLVNS', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('HRV Q105 BLVNS');
    });

    it('produces 3 segments', () => {
      expect(segs).to.have.length(3);
    });

    it('HRV→FATSO→REDFN→BLVNS waypoint sequence', () => {
      const seq = [segs[0].start, ...segs.map((s) => s.end)].map((p) => p.name);
      expect(seq).to.deep.equal(['HRV', 'FATSO', 'REDFN', 'BLVNS']);
    });

    it('HRV navaid at lat≈29.850 lon≈-90.003', () => {
      expect(segs[0].start.latitude).to.be.closeTo(29.85019472, 0.0001);
      expect(segs[0].start.longitude).to.be.closeTo(-90.00298416, 0.0001);
    });

    it('all segments carry airway name Q105', () => {
      for (const seg of segs) {
        expect(seg.name).to.equal('Q105');
      }
    });
  });

  describe('Q105 interior single hop FATSO→REDFN', () => {
    it('produces exactly 1 segment', () => {
      const segs = nasr.enrichRoute('FATSO Q105 REDFN');
      expect(segs).to.have.length(1);
      expect(segs[0].start.name).to.equal('FATSO');
      expect(segs[0].end.name).to.equal('REDFN');
    });
  });

  // --- Q448 airway (PTW→LANNA→DBABE→BASYE→TRIBS→BIGGO→BAF) ---
  describe('Q448 full PTW→BAF', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('PTW Q448 BAF');
    });

    it('produces 6 segments', () => {
      expect(segs).to.have.length(6);
    });

    it('waypoint sequence PTW→LANNA→DBABE→BASYE→TRIBS→BIGGO→BAF', () => {
      const seq = [segs[0].start, ...segs.map((s) => s.end)].map((p) => p.name);
      expect(seq).to.deep.equal([
        'PTW',
        'LANNA',
        'DBABE',
        'BASYE',
        'TRIBS',
        'BIGGO',
        'BAF',
      ]);
    });

    it('PTW start is airport (lat≈40.240, lon≈-75.557)', () => {
      expect(segs[0].start.kind).to.equal('airport');
      expect(segs[0].start.latitude).to.be.closeTo(40.23955555, 0.0001);
      expect(segs[0].start.longitude).to.be.closeTo(-75.55672222, 0.0001);
    });

    it('BASYE fix at lat≈41.344, lon≈-73.799 (3rd waypoint)', () => {
      const basye = segs[2].end;
      expect(basye.name).to.equal('BASYE');
      expect(basye.kind).to.equal('fix');
      expect(basye.latitude).to.be.closeTo(41.34372222, 0.0001);
      expect(basye.longitude).to.be.closeTo(-73.79860833, 0.0001);
    });

    it('BAF end is navaid (lat≈42.162, lon≈-72.716)', () => {
      expect(segs[segs.length - 1].end.kind).to.equal('navaid');
      expect(segs[segs.length - 1].end.latitude).to.be.closeTo(
        42.16195908,
        0.0001
      );
      expect(segs[segs.length - 1].end.longitude).to.be.closeTo(
        -72.7161995,
        0.0001
      );
    });

    it('all segments carry airway name Q448', () => {
      for (const seg of segs) {
        expect(seg.name).to.equal('Q448');
      }
    });
  });

  describe('Q448 reverse BAF→PTW', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('BAF Q448 PTW');
    });

    it('produces 6 segments', () => {
      expect(segs).to.have.length(6);
    });

    it('starts at BAF, ends at PTW', () => {
      expect(segs[0].start.name).to.equal('BAF');
      expect(segs[segs.length - 1].end.name).to.equal('PTW');
    });
  });

  describe('Q448 interior subset LANNA→BASYE', () => {
    let segs: RouteSegment[];
    before(() => {
      segs = nasr.enrichRoute('LANNA Q448 BASYE');
    });

    it('produces 2 segments (via DBABE)', () => {
      expect(segs).to.have.length(2);
      expect(segs[0].end.name).to.equal('DBABE');
      expect(segs[1].end.name).to.equal('BASYE');
    });
  });

  // --- DCT and airport lookup ---
  it('JFK DCT BOS — 1 DCT segment (navaid codes)', () => {
    const segs = nasr.enrichRoute('JFK DCT BOS');
    expect(segs).to.have.length(1);
    expect(segs[0].name).to.be.undefined;
    expect(segs[0].start.name).to.equal('JFK');
    expect(segs[0].end.name).to.equal('BOS');
  });

  it('KJFK DCT KBOS — 1 DCT segment (ICAO codes)', () => {
    const segs = nasr.enrichRoute('KJFK DCT KBOS');
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('KJFK');
    expect(segs[0].end.name).to.equal('KBOS');
  });

  // --- GeoJSON ---
  it('enrichRouteAsGeoJSON for LANNA J48 MOL — 7 LineString features', () => {
    const fc = nasr.enrichRouteAsGeoJSON('LANNA J48 MOL');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.have.length(7);
    for (const f of fc.features) {
      expect(f.geometry.type).to.equal('LineString');
      expect(f.properties.name).to.equal('J48');
    }
    // First feature: LANNA start coords [lon, lat]
    const [lon, lat] = fc.features[0].geometry.coordinates[0];
    expect(lon).to.be.closeTo(-75.027725, 0.0001);
    expect(lat).to.be.closeTo(40.55974166, 0.0001);
  });
});
