/**
 * resolver.spec.ts
 *
 * Tests for the `Resolver` multi-source builder class.
 *
 * Coverage:
 * 1. Builder validation — withSource() accepts lookup/enrich sources
 * 2. Single-source routing — delegates directly to that source
 * 3. Multi-source priority — first source wins for shared segments
 * 4. Multi-source gap-filling — second source resolves what first can't
 * 5. Source failure tolerance — a throwing source is skipped silently
 * 6. No-sources guard — throws a descriptive error
 * 7. GeoJSON output — enrichRouteAsGeoJSON mirrors enrichRoute shape
 *
 * All tests use synthetic enricher stubs — no real WASM or nav data required.
 *
 * Ground truth coordinates are taken from two real data sources:
 *
 * European fixes (UN858 airway) — DDR AIRAC 2111
 *   BOKNO: lat=47.04694  lon=0.69167  (fix)
 *   DEVRO: lat=47.49556  lon=0.73861  (fix)
 *   VANAD: lat=47.83722  lon=0.90722  (fix)
 *   Source: field15.spec.ts integration tests, verified against airac_2111.zip
 *
 * US fixes (J48 airway) — NASR 2026-03-19
 *   LANNA: lat=40.55974166  lon=-75.027725    (fix)
 *   PTW:   lat=40.22223183  lon=-75.56025083  (navaid)
 *   Source: nasr.spec.ts integration tests, verified against 28DaySubscription_Effective_2026-03-19.zip
 *
 * US airports (DCT) — NASR 2026-03-19
 *   KJFK:  lat=40.63992805  lon=-73.77869222  (airport)
 *   KBOS:  lat=42.36294444  lon=-71.00638888  (airport)
 *   Source: nasr.spec.ts integration tests
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data, type RouteSegment } from '../src/index.js';

const { Resolver } = data;

// ---------------------------------------------------------------------------
// Synthetic enricher helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal synthetic enricher that returns the given segment list
 * for any route string.
 */
function makeEnricher(segs: RouteSegment[]): {
  enrichRoute: (route: string) => RouteSegment[];
} {
  return { enrichRoute: (_route: string) => [...segs] };
}

/**
 * Build an enricher that throws for any call.
 */
function makeThrowingEnricher(): {
  enrichRoute: (route: string) => RouteSegment[];
} {
  return {
    enrichRoute: () => {
      throw new Error('source unavailable');
    },
  };
}

function makeCollectionSource(collections: {
  airports?: unknown[];
  navaids?: unknown[];
  airways?: unknown[];
  airspaces?: unknown[];
}) {
  const makeCollection = (rows: unknown[]) => ({
    data: async () => rows,
    search: async (text: string) => {
      const q = String(text ?? '').toUpperCase();
      return rows.filter((row) =>
        Object.values(
          row &&
            typeof row === 'object' &&
            'properties' in (row as Record<string, unknown>)
            ? (((row as Record<string, unknown>).properties ?? {}) as Record<
                string,
                unknown
              >)
            : ((row ?? {}) as Record<string, unknown>)
        ).some((value) =>
          String(value ?? '')
            .toUpperCase()
            .includes(q)
        )
      );
    },
  });

  return {
    resolve: (_query: unknown) => null,
    ...(collections.airports
      ? { airports: makeCollection(collections.airports as unknown[]) }
      : {}),
    ...(collections.navaids
      ? { navaids: makeCollection(collections.navaids as unknown[]) }
      : {}),
    ...(collections.airways
      ? { airways: makeCollection(collections.airways as unknown[]) }
      : {}),
    ...(collections.airspaces
      ? { airspaces: makeCollection(collections.airspaces as unknown[]) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Real-data fixture segments
// Coordinates are verbatim from DDR AIRAC 2111 and NASR 2026-03-19 archives.
// ---------------------------------------------------------------------------

/**
 * European route: BOKNO→DEVRO via UN858 (DDR AIRAC 2111).
 * This is the first of two consecutive segments on the UN858 airway.
 */
const SEG_EU_A: RouteSegment = {
  start: { name: 'BOKNO', latitude: 47.04694, longitude: 0.69167, kind: 'fix' },
  end: { name: 'DEVRO', latitude: 47.49556, longitude: 0.73861, kind: 'fix' },
  name: 'UN858',
};

/**
 * European route: DEVRO→VANAD via UN858 (DDR AIRAC 2111).
 * Continues from SEG_EU_A.
 */
const SEG_EU_B: RouteSegment = {
  start: { name: 'DEVRO', latitude: 47.49556, longitude: 0.73861, kind: 'fix' },
  end: { name: 'VANAD', latitude: 47.83722, longitude: 0.90722, kind: 'fix' },
  name: 'UN858',
};

/**
 * DCT segment: KJFK airport → KBOS airport (NASR 2026-03-19).
 * No airway name (direct routing).
 */
const SEG_DCT: RouteSegment = {
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

/**
 * Same BOKNO→DEVRO pair as SEG_EU_A, but as it might appear from a second source
 * that has the pair with no airway name.  Coordinates match SEG_EU_A exactly so
 * the Resolver can recognise start.name+end.name as a shared key.
 * Used to verify source-priority logic: whichever source is registered first wins.
 */
const SEG_NASR_OVERLAP: RouteSegment = {
  start: { name: 'BOKNO', latitude: 47.04694, longitude: 0.69167, kind: 'fix' },
  end: { name: 'DEVRO', latitude: 47.49556, longitude: 0.73861, kind: 'fix' },
  name: undefined, // second source doesn't know the airway name
};

/**
 * US route: LANNA→PTW via J48 (NASR 2026-03-19).
 * A segment only a US source (NASR) knows — not present in DDR.
 */
const SEG_US_ONLY: RouteSegment = {
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
};

// ---------------------------------------------------------------------------
// 1. Builder validation
// ---------------------------------------------------------------------------

describe('Resolver — builder validation', () => {
  it('withSource() accepts a lookup-only source', () => {
    expect(() =>
      new Resolver().withSource('lookup', {
        resolve: (_query: unknown) => null,
      })
    ).not.to.throw();
  });

  it('withSource() accepts a source implementing both resolve and enrichRoute', () => {
    expect(() =>
      new Resolver().withSource('both', {
        resolve: (_query: unknown) => null,
        enrichRoute: (_route: string) => [SEG_EU_A],
      })
    ).not.to.throw();
  });

  it('withSource() error message names the bad source', () => {
    try {
      new Resolver().withSource('my-source', {} as never);
      expect.fail('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).to.include('my-source');
    }
  });

  it('withSource() rejects sources implementing neither resolve nor enrichRoute', () => {
    expect(() => new Resolver().withSource('bad', {} as never)).to.throw(
      /must implement resolve\(\) or enrichRoute\(\)/
    );
  });

  it('withSource() error message mentions FaaArcgisResolverJS', () => {
    try {
      new Resolver().withSource('arcgis', {} as never);
      expect.fail('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).to.include('FaaArcgisResolverJS');
    }
  });

  it('withDdr() delegates to withSource() and validates input shape', () => {
    expect(() => new Resolver().withDdr({} as never)).to.throw(
      /must implement resolve\(\) or enrichRoute\(\)/
    );
  });

  it('withNasr() delegates to withSource() and validates input shape', () => {
    expect(() => new Resolver().withNasr({} as never)).to.throw(
      /must implement resolve\(\) or enrichRoute\(\)/
    );
  });

  it('withArcgis() delegates to withSource() and validates input shape', () => {
    expect(() => new Resolver().withArcgis({} as never)).to.throw(
      /must implement resolve\(\) or enrichRoute\(\)/
    );
  });

  it('enrichRoute() throws a descriptive error when no sources are attached', () => {
    expect(() => new Resolver().enrichRoute('BOKNO UN858 VANAD')).to.throw(
      /Resolver has no sources/
    );
  });

  it('withSource() with a valid enricher does not throw', () => {
    expect(() =>
      new Resolver().withSource('ok', makeEnricher([SEG_EU_A]))
    ).not.to.throw();
  });

  it('enrichRoute() throws a descriptive error when only lookup sources are attached', () => {
    const r = new Resolver().withSource('lookup', {
      resolve: (_query: unknown) => null,
    });
    expect(() => r.enrichRoute('BOKNO UN858 VANAD')).to.throw(
      /no enrich-capable sources/
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Single-source routing
// ---------------------------------------------------------------------------

describe('Resolver — single source', () => {
  it("returns the source's segments unchanged", () => {
    const r = new Resolver().withSource(
      'ddr',
      makeEnricher([SEG_EU_A, SEG_EU_B])
    );
    const segs = r.enrichRoute('any route');
    expect(segs).to.have.length(2);
    expect(segs[0].start.name).to.equal('BOKNO');
    expect(segs[1].end.name).to.equal('VANAD');
  });

  it('returns empty array when source finds nothing', () => {
    const r = new Resolver().withSource('ddr', makeEnricher([]));
    expect(r.enrichRoute('anything')).to.have.length(0);
  });

  it('returns segments for a DCT-only route', () => {
    const r = new Resolver().withSource('nasr', makeEnricher([SEG_DCT]));
    const segs = r.enrichRoute('KJFK DCT KBOS');
    expect(segs).to.have.length(1);
    expect(segs[0].name).to.be.undefined;
  });

  it('chaining returns the same Resolver instance', () => {
    const r = new Resolver();
    const r2 = r.withSource('ddr', makeEnricher([]));
    expect(r2).to.equal(r);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-source priority — first source wins for shared pair
// ---------------------------------------------------------------------------

describe('Resolver — multi-source priority', () => {
  it('first source wins when both resolve the same pair (DDR before NASR)', () => {
    // DDR has SEG_EU_A (name: UN858), second source has SEG_NASR_OVERLAP (name: undefined)
    // DDR is attached first → DDR segment should win.
    const r = new Resolver()
      .withSource('ddr', makeEnricher([SEG_EU_A]))
      .withSource('nasr', makeEnricher([SEG_NASR_OVERLAP]));
    const segs = r.enrichRoute('route');
    expect(segs).to.have.length(1);
    expect(segs[0].name).to.equal('UN858'); // DDR's airway name preserved
    expect(segs[0].start.latitude).to.be.closeTo(47.04694, 0.00001); // DDR coordinates
  });

  it('second-source-first order gives it priority over DDR', () => {
    const r = new Resolver()
      .withSource('nasr', makeEnricher([SEG_NASR_OVERLAP]))
      .withSource('ddr', makeEnricher([SEG_EU_A]));
    const segs = r.enrichRoute('route');
    expect(segs).to.have.length(1);
    expect(segs[0].name).to.be.undefined; // second source's segment (no airway name)
    expect(segs[0].start.latitude).to.be.closeTo(47.04694, 0.00001); // same real coordinates
  });

  it('segments from different pairs are both included', () => {
    // DDR knows EU pair, NASR knows US-only pair
    const r = new Resolver()
      .withSource('ddr', makeEnricher([SEG_EU_A]))
      .withSource('nasr', makeEnricher([SEG_US_ONLY]));
    const segs = r.enrichRoute('route');
    // Both pairs have unique start|end keys → both included
    expect(segs).to.have.length(2);
    const names = segs.map((s) => s.start.name);
    expect(names).to.include('BOKNO');
    expect(names).to.include('LANNA');
  });

  it('order within merged result follows source order (DDR segs first)', () => {
    const r = new Resolver()
      .withSource('ddr', makeEnricher([SEG_EU_A, SEG_EU_B]))
      .withSource('nasr', makeEnricher([SEG_US_ONLY]));
    const segs = r.enrichRoute('route');
    expect(segs[0].start.name).to.equal('BOKNO');
    expect(segs[1].start.name).to.equal('DEVRO');
    expect(segs[2].start.name).to.equal('LANNA');
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-source gap-filling
// ---------------------------------------------------------------------------

describe('Resolver — multi-source gap-filling', () => {
  it('NASR fills segments DDR returns nothing for', () => {
    // DDR returns empty, NASR has the US segment
    const r = new Resolver()
      .withSource('ddr', makeEnricher([]))
      .withSource('nasr', makeEnricher([SEG_US_ONLY]));
    const segs = r.enrichRoute('route');
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('LANNA');
    expect(segs[0].name).to.equal('J48');
  });

  it('DDR covers European legs, NASR covers US legs together', () => {
    const r = new Resolver()
      .withSource('ddr', makeEnricher([SEG_EU_A, SEG_EU_B]))
      .withSource('nasr', makeEnricher([SEG_US_ONLY]));
    const segs = r.enrichRoute('transatlantic route');
    expect(segs).to.have.length(3);

    const europeanSegs = segs.filter((s) => s.name === 'UN858');
    const usSegs = segs.filter((s) => s.name === 'J48');
    expect(europeanSegs).to.have.length(2);
    expect(usSegs).to.have.length(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Source failure tolerance
// ---------------------------------------------------------------------------

describe('Resolver — source failure tolerance', () => {
  it('a throwing source is skipped and the other source still resolves', () => {
    const r = new Resolver()
      .withSource('failing', makeThrowingEnricher())
      .withSource('working', makeEnricher([SEG_EU_A]));
    // Should not throw — failing source is silently skipped
    const segs = r.enrichRoute('route');
    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('BOKNO');
  });

  it('when the first source throws, the second can still fill all gaps', () => {
    const r = new Resolver()
      .withSource('primary', makeThrowingEnricher())
      .withSource('fallback', makeEnricher([SEG_EU_A, SEG_EU_B, SEG_DCT]));
    const segs = r.enrichRoute('route');
    expect(segs).to.have.length(3);
  });

  it('when all sources throw, returns empty array (not a throw)', () => {
    const r = new Resolver()
      .withSource('a', makeThrowingEnricher())
      .withSource('b', makeThrowingEnricher());
    expect(() => r.enrichRoute('route')).not.to.throw();
    expect(r.enrichRoute('route')).to.have.length(0);
  });
});

// ---------------------------------------------------------------------------
// 6. enrichRouteAsGeoJSON
// ---------------------------------------------------------------------------

describe('Resolver — enrichRouteAsGeoJSON', () => {
  it('returns a FeatureCollection', () => {
    const r = new Resolver().withSource('ddr', makeEnricher([SEG_EU_A]));
    const fc = r.enrichRouteAsGeoJSON('route');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.be.an('array');
  });

  it('each feature is a LineString with 2 coordinates', () => {
    const r = new Resolver().withSource(
      'ddr',
      makeEnricher([SEG_EU_A, SEG_EU_B])
    );
    const fc = r.enrichRouteAsGeoJSON('route');
    expect(fc.features).to.have.length(2);
    for (const f of fc.features) {
      expect(f.geometry.type).to.equal('LineString');
      expect(f.geometry.coordinates).to.have.length(2);
    }
  });

  it('coordinates are [longitude, latitude] (GeoJSON convention)', () => {
    const r = new Resolver().withSource('ddr', makeEnricher([SEG_EU_A]));
    const fc = r.enrichRouteAsGeoJSON('route');
    const [lon, lat] = fc.features[0].geometry.coordinates[0];
    // BOKNO: lat=47.04694 lon=0.69167 (DDR AIRAC 2111)
    expect(lon).to.be.closeTo(0.69167, 0.00001);
    expect(lat).to.be.closeTo(47.04694, 0.00001);
  });

  it('airway segments have name in properties, DCT segments have null', () => {
    const r = new Resolver().withSource(
      'ddr',
      makeEnricher([SEG_EU_A, SEG_DCT])
    );
    const fc = r.enrichRouteAsGeoJSON('route');
    const airwayFeature = fc.features.find(
      (f) => f.properties.name === 'UN858'
    );
    const dctFeature = fc.features.find((f) => f.properties.name === null);
    expect(airwayFeature).to.exist;
    expect(dctFeature).to.exist;
  });

  it('features carry start_name and end_name', () => {
    const r = new Resolver().withSource('ddr', makeEnricher([SEG_EU_A]));
    const fc = r.enrichRouteAsGeoJSON('route');
    const f = fc.features[0];
    expect(f.properties.start_name).to.equal('BOKNO');
    expect(f.properties.end_name).to.equal('DEVRO');
  });

  it('features carry start_kind and end_kind', () => {
    const r = new Resolver().withSource('ddr', makeEnricher([SEG_EU_A]));
    const fc = r.enrichRouteAsGeoJSON('route');
    const f = fc.features[0];
    expect(f.properties.start_kind).to.equal('fix');
    expect(f.properties.end_kind).to.equal('fix');
  });

  it('empty route produces empty FeatureCollection', () => {
    const r = new Resolver().withSource('ddr', makeEnricher([]));
    const fc = r.enrichRouteAsGeoJSON('route');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.have.length(0);
  });

  it('three-source resolver produces correct GeoJSON feature count', () => {
    const r = new Resolver()
      .withSource('a', makeEnricher([SEG_EU_A]))
      .withSource('b', makeEnricher([SEG_EU_B]))
      .withSource('c', makeEnricher([SEG_US_ONLY]));
    const fc = r.enrichRouteAsGeoJSON('route');
    expect(fc.features).to.have.length(3);
  });
});

// ---------------------------------------------------------------------------
// 8. Lookup API and airport normalization
// ---------------------------------------------------------------------------

describe('Resolver — lookup API', () => {
  const AIRPORTS = [
    {
      type: 'Feature',
      properties: {
        icao: 'LFBO',
        iata: 'TLS',
        name: 'Toulouse Blagnac',
      },
    },
    {
      type: 'Feature',
      properties: {
        icao: 'LFBD',
        iata: 'BOD',
        name: 'Bordeaux Merignac',
      },
    },
    {
      type: 'Feature',
      properties: {
        icao: 'ZZZ1',
        iata: 'ZZ1',
        name: 'Toulouse Test North',
      },
    },
    {
      type: 'Feature',
      properties: {
        icao: 'ZZZ2',
        iata: 'ZZ2',
        name: 'Toulouse Test South',
      },
    },
  ];

  const lookupOnly = {
    resolve: async (_query: unknown) => null,
    airports: {
      data: async () => AIRPORTS,
    },
  };

  it('resolve({airport}) matches ICAO exactly first', async () => {
    const r = new Resolver().withSource('airports', lookupOnly);
    const hit = await r.resolve({ airport: 'LFBO' });
    expect(
      (hit as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('LFBO');
  });

  it('resolve({airport}) matches IATA exactly when ICAO not found', async () => {
    const r = new Resolver().withSource('airports', lookupOnly);
    const hit = await r.resolve({ airport: 'TLS' });
    expect(
      (hit as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('LFBO');
  });

  it('resolve({airport}) matches by airport name (case-insensitive)', async () => {
    const r = new Resolver().withSource('airports', lookupOnly);
    const hit = await r.resolve({ airport: 'toulouse blagnac' });
    expect(
      (hit as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('LFBO');
  });

  it('resolve({airport}) supports prefix matching as fallback', async () => {
    const r = new Resolver().withSource('airports', lookupOnly);
    const hit = await r.resolve({ airport: 'Toulouse Test' });
    expect(
      (hit as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('ZZZ1');
  });

  it('get(query) is an alias of resolve(query)', async () => {
    const r = new Resolver().withSource('airports', lookupOnly);
    const hit = await r.get({ airport: 'LFBD' });
    expect(
      (hit as { properties?: { iata?: string } })?.properties?.iata
    ).to.equal('BOD');
  });

  it('resolve(query) uses source.resolve() before fallback list matching', async () => {
    const forced = {
      type: 'Feature',
      properties: { icao: 'FORCED', iata: 'FRC', name: 'Forced' },
    };
    const source = {
      resolve: async (query: { airport?: string }) =>
        query.airport === 'TLS' ? forced : null,
      airports: {
        data: async () => AIRPORTS,
      },
    };
    const r = new Resolver().withSource('airports', source);
    const hit = await r.resolve({ airport: 'TLS' });
    expect(
      (hit as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('FORCED');
  });

  it('resolve({source}) restricts lookup to one source', async () => {
    const s1 = makeCollectionSource({
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBO', name: 'Toulouse Blagnac' },
        },
      ],
    });
    const s2 = makeCollectionSource({
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBD', name: 'Bordeaux Merignac' },
        },
      ],
    });

    const r = new Resolver().withSource('fr24', s1).withSource('ddr', s2);
    const hit = await r.resolve({
      airport: 'Bordeaux Merignac',
      source: 'fr24',
    });
    expect(hit).to.equal(null);
  });

  it('resolve({source:[...]}) uses provided list as custom priority order', async () => {
    const xplaneSource = {
      resolve: async (query: { navaid?: string }) =>
        query.navaid === 'KLO'
          ? {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [8.55, 47.46] },
              properties: { ident: 'KLO', source: 'xplane' },
            }
          : null,
    };
    const ddrSource = {
      resolve: async (query: { navaid?: string }) =>
        query.navaid === 'KLO'
          ? {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [8.56, 47.47] },
              properties: { ident: 'KLO', source: 'ddr' },
            }
          : null,
    };

    const r = new Resolver()
      .withSource('xplane', xplaneSource)
      .withSource('ddr', ddrSource);
    const hit = await r.resolve({ navaid: 'KLO', source: ['ddr', 'xplane'] });
    expect(
      (hit as { properties?: { source?: string } })?.properties?.source
    ).to.equal('ddr');
  });

  it('resolve({SID, airport}) resolves procedure from airway collections', async () => {
    const source = makeCollectionSource({
      airways: [
        {
          type: 'Feature',
          properties: {
            name: 'FISTO5A',
            raw_name: 'FISTO5ALFBO',
            airport: 'LFBO',
            route_class: 'DP',
            type: 'SID',
          },
        },
      ],
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBO', name: 'Toulouse Blagnac' },
        },
      ],
    });

    const r = new Resolver().withSource('ddr', source);
    const hit = await r.resolve({ SID: 'FISTO5A', airport: 'LFBO' });
    expect(
      (hit as { properties?: { name?: string; route_class?: string } })
        ?.properties?.name
    ).to.equal('FISTO5A');
    expect(
      (hit as { properties?: { route_class?: string } })?.properties
        ?.route_class
    ).to.equal('DP');
  });

  it('resolve({STAR, airport}) resolves STAR and does not return airport feature', async () => {
    const source = makeCollectionSource({
      airways: [
        {
          type: 'Feature',
          properties: {
            name: 'KEPER9E',
            raw_name: 'KEPER9ELFBO',
            airport: 'LFBO',
            route_class: 'AP',
            type: 'STAR',
          },
        },
      ],
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBO', name: 'Toulouse Blagnac' },
        },
      ],
    });

    const r = new Resolver().withSource('ddr', source);
    const hit = await r.resolve({ STAR: 'KEPER9E', airport: 'LFBO' });
    expect(
      (hit as { properties?: { type?: string } })?.properties?.type
    ).to.equal('STAR');
    expect(
      (hit as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal(undefined);
  });
});

// ---------------------------------------------------------------------------
// 9. Aggregated collections API
// ---------------------------------------------------------------------------

describe('Resolver — collections API', () => {
  it('aggregates airports in source order and annotates source metadata', async () => {
    const s1 = makeCollectionSource({
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBO', name: 'Toulouse Blagnac' },
        },
      ],
    });

    const s2 = makeCollectionSource({
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBD', name: 'Bordeaux Merignac' },
        },
      ],
    });

    const r = new Resolver().withSource('s1', s1).withSource('s2', s2);
    const rows = await r.collections.airports();

    expect(rows).to.have.length(2);
    const first = rows[0] as {
      properties?: { icao?: string; source?: string };
    };
    const second = rows[1] as {
      properties?: { icao?: string; source?: string };
    };

    expect(first.properties?.icao).to.equal('LFBO');
    expect(first.properties?.source).to.equal('s1');
    expect(second.properties?.icao).to.equal('LFBD');
    expect(second.properties?.source).to.equal('s2');
  });

  it('preserves existing source property and adds resolver_source', async () => {
    const s = makeCollectionSource({
      airways: [
        {
          type: 'Feature',
          properties: { name: 'UN858', source: 'ddr' },
        },
      ],
    });

    const r = new Resolver().withSource('custom', s);
    const rows = await r.collections.airways();
    const row = rows[0] as {
      properties?: { source?: string; resolver_source?: string; name?: string };
    };

    expect(row.properties?.name).to.equal('UN858');
    expect(row.properties?.source).to.equal('ddr');
    expect(row.properties?.resolver_source).to.equal('custom');
  });

  it('returns empty arrays for entities not exposed by attached sources', async () => {
    const r = new Resolver().withSource(
      'lookup',
      makeCollectionSource({ airports: [] })
    );

    expect(await r.collections.navaids()).to.deep.equal([]);
    expect(await r.collections.airways()).to.deep.equal([]);
    expect(await r.collections.airspaces()).to.deep.equal([]);
  });

  it('supports source filter to avoid aggregating all sources', async () => {
    const s1 = makeCollectionSource({
      airports: [{ type: 'Feature', properties: { icao: 'LFBO' } }],
    });
    const s2 = makeCollectionSource({
      airports: [{ type: 'Feature', properties: { icao: 'LFBD' } }],
    });

    const r = new Resolver().withSource('fr24', s1).withSource('arcgis', s2);
    const rows = await r.collections.airports({ source: 'fr24' });

    expect(rows).to.have.length(1);
    expect(
      (rows[0] as { properties?: { icao?: string } }).properties?.icao
    ).to.equal('LFBO');
  });

  it('supports query filtering on collection properties', async () => {
    const s = makeCollectionSource({
      airports: [
        {
          type: 'Feature',
          properties: { icao: 'LFBO', name: 'Toulouse Blagnac' },
        },
        {
          type: 'Feature',
          properties: { icao: 'LFBD', name: 'Bordeaux Merignac' },
        },
      ],
    });

    const r = new Resolver().withSource('s', s);
    const rows = await r.collections.airports({ query: 'toulouse' });

    expect(rows).to.have.length(1);
    expect(
      (rows[0] as { properties?: { icao?: string } }).properties?.icao
    ).to.equal('LFBO');
  });

  it('supports limit to cap output size', async () => {
    const s = makeCollectionSource({
      airports: [
        { type: 'Feature', properties: { icao: 'LFBO' } },
        { type: 'Feature', properties: { icao: 'LFBD' } },
        { type: 'Feature', properties: { icao: 'LFMN' } },
      ],
    });

    const r = new Resolver().withSource('s', s);
    const rows = await r.collections.airports({ limit: 2 });
    expect(rows).to.have.length(2);
  });

  it('supports type filter (SID/STAR/airway) on airways collections', async () => {
    const s = makeCollectionSource({
      airways: [
        {
          type: 'Feature',
          properties: {
            name: 'FISTO5A',
            route_class: 'DP',
            type: 'SID',
            airport: 'LFBO',
          },
        },
        {
          type: 'Feature',
          properties: {
            name: 'KEPER9E',
            route_class: 'AP',
            type: 'STAR',
            airport: 'LFPG',
          },
        },
        {
          type: 'Feature',
          properties: {
            name: 'UN858',
            route_class: 'AR',
            type: 'airway',
          },
        },
      ],
    });

    const r = new Resolver().withSource('ddr', s);
    const stars = await r.collections.airways({ type: 'STAR', query: 'LFPG' });
    expect(stars).to.have.length(1);
    expect(
      (stars[0] as { properties?: { name?: string } }).properties?.name
    ).to.equal('KEPER9E');
  });
});

// ---------------------------------------------------------------------------
// 10. near-based disambiguation
// ---------------------------------------------------------------------------

describe('Resolver — near disambiguation', () => {
  const kloSwiss = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [8.55, 47.46] },
    properties: { ident: 'KLO', name: 'KLO', kind: 'navaid', source: 'swiss' },
  };

  const kloUs = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-86.62, 39.15] },
    properties: { ident: 'KLO', name: 'KLO', kind: 'navaid', source: 'us' },
  };

  const zrhAirport = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [8.5492, 47.4647] },
    properties: { icao: 'LSZH', iata: 'ZRH', name: 'Zurich' },
  };

  it('resolve({navaid, near:[lon,lat]}) returns nearest candidate', async () => {
    const s1 = makeCollectionSource({ navaids: [kloUs] });
    const s2 = makeCollectionSource({ navaids: [kloSwiss] });
    const r = new Resolver().withSource('us', s1).withSource('swiss', s2);

    const hit = await r.resolve({ navaid: 'KLO', near: [8.5, 47.4] });
    expect(
      (hit as { properties?: { source?: string } })?.properties?.source
    ).to.equal('swiss');
  });

  it('resolve({navaid, near:string}) geocodes through Nominatim', async () => {
    const s1 = makeCollectionSource({ navaids: [kloUs, kloSwiss] });
    const r = new Resolver().withSource('mix', s1);

    const originalFetch = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return {
        ok: true,
        json: async () => [{ lon: 8.54, lat: 47.37 }],
      } as Response;
    }) as typeof fetch;

    try {
      const hit = await r.resolve({ navaid: 'KLO', near: 'Switzerland' });
      expect(calledUrl).to.include('nominatim.openstreetmap.org/search');
      expect(calledUrl).to.include('Switzerland');
      expect(
        (hit as { properties?: { source?: string } })?.properties?.source
      ).to.equal('swiss');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolve({navaid, near:feature}) accepts a feature from prior resolve()', async () => {
    const airportsSource = makeCollectionSource({ airports: [zrhAirport] });
    const navaidsSource = makeCollectionSource({ navaids: [kloUs, kloSwiss] });
    const r = new Resolver()
      .withSource('airports', airportsSource)
      .withSource('navaids', navaidsSource);

    const zrh = await r.resolve({ airport: 'Zurich' });
    const hit = await r.resolve({ navaid: 'KLO', near: zrh });

    expect(
      (hit as { properties?: { source?: string } })?.properties?.source
    ).to.equal('swiss');
  });

  it('near-based result is deterministic regardless of source order', async () => {
    const a = makeCollectionSource({ navaids: [kloUs] });
    const b = makeCollectionSource({ navaids: [kloSwiss] });

    const r1 = new Resolver().withSource('a', a).withSource('b', b);
    const r2 = new Resolver().withSource('b', b).withSource('a', a);

    const hit1 = await r1.resolve({ navaid: 'KLO', near: [8.5, 47.4] });
    const hit2 = await r2.resolve({ navaid: 'KLO', near: [8.5, 47.4] });

    expect(
      (hit1 as { geometry?: { coordinates?: number[] } })?.geometry?.coordinates
    ).to.deep.equal(
      (hit2 as { geometry?: { coordinates?: number[] } })?.geometry?.coordinates
    );
  });

  it('near accepts a promise of feature (e.g. near: resolver.resolve(...))', async () => {
    const airportsSource = makeCollectionSource({ airports: [zrhAirport] });
    const navaidsSource = makeCollectionSource({ navaids: [kloUs, kloSwiss] });
    const r = new Resolver()
      .withSource('airports', airportsSource)
      .withSource('navaids', navaidsSource);

    const nearPromise = r.resolve({ airport: 'Zurich' });
    const hit = await r.resolve({ navaid: 'KLO', near: nearPromise });
    expect(
      (hit as { properties?: { source?: string } })?.properties?.source
    ).to.equal('swiss');
  });

  it('prefers resolver source order in exact ties', async () => {
    const sameDdr = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [8.55, 47.46] },
      properties: { ident: 'KLO', name: 'KLO', source: 'ddr' },
    };
    const sameXplane = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [8.55, 47.46] },
      properties: { ident: 'KLO', name: 'KLO', source: 'earth_nav.dat' },
    };
    const r = new Resolver()
      .withSource('ddr', makeCollectionSource({ navaids: [sameDdr] }))
      .withSource('xplane', makeCollectionSource({ navaids: [sameXplane] }));

    const hit = await r.resolve({ navaid: 'KLO', near: [8.55, 47.46] });
    expect(
      (hit as { properties?: { resolver_source?: string } })?.properties
        ?.resolver_source
    ).to.equal('ddr');
  });

  it('near tie-break follows query.source ordering when provided', async () => {
    const sameDdr = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [8.55, 47.46] },
      properties: { ident: 'KLO', name: 'KLO', source: 'ddr' },
    };
    const sameXplane = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [8.55, 47.46] },
      properties: { ident: 'KLO', name: 'KLO', source: 'earth_nav.dat' },
    };
    const r = new Resolver()
      .withSource('xplane', makeCollectionSource({ navaids: [sameXplane] }))
      .withSource('ddr', makeCollectionSource({ navaids: [sameDdr] }));

    const hit = await r.resolve({
      navaid: 'KLO',
      near: [8.55, 47.46],
      source: ['ddr', 'xplane'],
    });
    expect(
      (hit as { properties?: { resolver_source?: string } })?.properties
        ?.resolver_source
    ).to.equal('ddr');
  });
});
