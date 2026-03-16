import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data, type FaaArcgisCore, type RouteSegment } from '../src/index.js';

const { FAA_ARCGIS_DATASETS, createFaaArcgisResolver } = data.faa;
const { Resolver } = data;

type FeatureCollection = {
  features: Array<{ properties?: Record<string, unknown>; geometry?: unknown }>;
};

function makeCore(collections: unknown[]): FaaArcgisCore {
  const allFeatures = (collections as FeatureCollection[])
    .flatMap((collection) => collection.features ?? [])
    .map((feature) => feature.properties ?? {});

  const airports = allFeatures.filter((row) => row['ICAO_ID']);
  const navaids = allFeatures.filter((row) => row['NAV_TYPE']);
  const fixes = allFeatures.filter((row) => row['TYPE_CODE'] === 'FIX');
  const airways = allFeatures.filter((row) => row['ROUTE_TYPE']);
  const airspaces = allFeatures.filter((row) => row['CLASS']);

  const byCode = (
    rows: Record<string, unknown>[],
    key: string,
    code: string
  ) => {
    const upper = code.toUpperCase();
    const match = rows.find(
      (row) => String(row[key] ?? '').toUpperCase() === upper
    );
    return match ?? null;
  };

  return {
    airports: () => airports,
    fixes: () => fixes,
    navaids: () => navaids,
    airways: () => airways,
    airspaces: () => airspaces,
    resolve_airport: (code: string) => byCode(airports, 'ICAO_ID', code),
    resolve_fix: (code: string) => byCode(fixes, 'IDENT', code),
    resolve_navaid: (code: string) => byCode(navaids, 'IDENT', code),
    resolve_airway: (name: string) => byCode(airways, 'IDENT', name),
    resolve_airspace: (name: string) => byCode(airspaces, 'IDENT', name),
  };
}

describe('FAA ArcGIS resolver adapter', () => {
  it('provides Observable-style collection API and lazy loading', async () => {
    const called: string[] = [];

    const fixtures: Record<string, FeatureCollection> = {
      [FAA_ARCGIS_DATASETS.airports]: {
        features: [
          {
            properties: {
              IDENT: 'KLAX',
              ICAO_ID: 'KLAX',
              NAME: 'Los Angeles',
              LATITUDE: 33.9425,
              LONGITUDE: -118.4081,
            },
          },
        ],
      },
      [FAA_ARCGIS_DATASETS.designatedPoints]: {
        features: [{ properties: { IDENT: 'LAX', TYPE_CODE: 'FIX' } }],
      },
      [FAA_ARCGIS_DATASETS.navaidComponents]: {
        features: [{ properties: { IDENT: 'LAX', NAV_TYPE: 'VOR' } }],
      },
    };

    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      const datasetId = url.split('/').pop()!.replace('.geojson', '');
      called.push(datasetId);
      const payload = fixtures[datasetId] ?? { features: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const resolver = await createFaaArcgisResolver({
      coreFactory: makeCore,
      fetchImpl,
      datasetIds: [
        FAA_ARCGIS_DATASETS.airports,
        FAA_ARCGIS_DATASETS.designatedPoints,
        FAA_ARCGIS_DATASETS.navaidComponents,
      ],
    });

    const airports = await resolver.airports.data();
    expect(airports.length).to.equal(1);
    expect(called).to.deep.equal([FAA_ARCGIS_DATASETS.airports]);

    const klax = (await resolver.airports['KLAX']) as {
      type: string;
      geometry: { type: string; coordinates: [number, number] };
      properties: Record<string, unknown>;
    };
    expect(klax.type).to.equal('Feature');
    expect(klax.geometry.type).to.equal('Point');
    expect(klax.properties['ICAO_ID']).to.equal('KLAX');

    const unknownAirport = await resolver.airports['ZZZZ'];
    expect(unknownAirport).to.equal(undefined);

    const matches = await resolver.navaids.search('lax');
    expect(matches.length).to.equal(1);
    expect(called).to.deep.equal([
      FAA_ARCGIS_DATASETS.airports,
      FAA_ARCGIS_DATASETS.designatedPoints,
      FAA_ARCGIS_DATASETS.navaidComponents,
    ]);
  });

  it('resolves airway endpoint codes after fix/navpoint datasets load', async () => {
    const fixtures: Record<string, FeatureCollection> = {
      [FAA_ARCGIS_DATASETS.designatedPoints]: {
        features: [
          {
            properties: {
              GLOBAL_ID: 'START-GID',
              IDENT: 'LANNA',
              TYPE_CODE: 'FIX',
            },
          },
          {
            properties: {
              GLOBAL_ID: 'END-GID',
              IDENT: 'MOL',
              TYPE_CODE: 'FIX',
            },
          },
        ],
      },
      [FAA_ARCGIS_DATASETS.atsRoutes]: {
        features: [
          {
            properties: {
              IDENT: 'J48',
              ROUTE_TYPE: 'AR',
              STARTPT_ID: 'START-GID',
              ENDPT_ID: 'END-GID',
            },
            geometry: {
              type: 'LineString',
              coordinates: [
                [-75.0, 40.5],
                [-76.0, 40.0],
                [-79.1, 37.9],
              ],
            },
          },
        ],
      },
    };

    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const datasetId = String(input).split('/').pop()!.replace('.geojson', '');
      const payload = fixtures[datasetId] ?? { features: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const resolver = await createFaaArcgisResolver({
      coreFactory: makeCore,
      fetchImpl,
      datasetIds: [
        FAA_ARCGIS_DATASETS.designatedPoints,
        FAA_ARCGIS_DATASETS.atsRoutes,
      ],
    });

    await resolver.fixes.data();
    const j48 = (await resolver.airways['J48']) as {
      type: string;
      geometry: { type: string; coordinates: Array<[number, number]> };
      properties: { points: string[]; route_class?: string };
    };

    expect(j48.type).to.equal('Feature');
    expect(j48.geometry.type).to.equal('LineString');
    expect(j48.properties.points[0]).to.equal('LANNA');
    expect(j48.properties.points[j48.properties.points.length - 1]).to.equal(
      'MOL'
    );
    expect(j48.properties.route_class).to.equal('AR');
  });
});

// ---------------------------------------------------------------------------
// FaaArcgisResolverJS — enrichRoute / enrichRouteAsGeoJSON
// ---------------------------------------------------------------------------

describe('FAA ArcGIS resolver — enrichRoute', () => {
  /** Build a core that also exposes enrichRoute (simulating thrust-wasm ≥ 0.3) */
  function makeCoreWithEnrichRoute(segs: RouteSegment[]): FaaArcgisCore {
    return {
      airports: () => [],
      fixes: () => [],
      navaids: () => [],
      airways: () => [],
      airspaces: () => [],
      resolve_airport: () => null,
      resolve_fix: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => null,
      resolve_airspace: () => null,
      enrichRoute: (_route: string) => [...segs],
    };
  }

  const SEG: RouteSegment = {
    start: { name: 'HAPIE', latitude: 40.63, longitude: -73.78, kind: 'fix' },
    end: { name: 'WHALE', latitude: 42.0, longitude: -70.0, kind: 'fix' },
    name: 'J49',
  };

  it('enrichRoute delegates to core.enrichRoute when core has the method', async () => {
    const resolver = await createFaaArcgisResolver({
      core: makeCoreWithEnrichRoute([SEG]),
    });
    const segs = resolver.enrichRoute('HAPIE J49 WHALE');
    expect(segs).to.have.length(1);
    expect(segs[0].name).to.equal('J49');
    expect(segs[0].start.name).to.equal('HAPIE');
  });

  it('enrichRoute throws when core lacks the method (older WASM build)', async () => {
    const resolver = await createFaaArcgisResolver({
      core: makeCore([]), // makeCore does not define enrichRoute
    });
    expect(() => resolver.enrichRoute('HAPIE J49 WHALE')).to.throw(
      /enrichRoute is unavailable|requires thrust-wasm/i
    );
  });

  it('enrichRoute throws when datasets are not yet loaded (no core)', async () => {
    // Use a minimal fetchImpl so the resolver is created without data loaded
    const neverFetch = async (): Promise<Response> =>
      new Response('{}', { status: 200 });
    const resolver = await createFaaArcgisResolver({
      coreFactory: makeCore,
      fetchImpl: neverFetch,
    });
    // _core is null at this point (no datasets loaded yet)
    expect(() => resolver.enrichRoute('any route')).to.throw(/preload/i);
  });

  it('FaaArcgisResolverJS with enrichRoute-capable core passes Resolver.withArcgis', async () => {
    // The key check: with enrichRoute present, withArcgis no longer throws
    const resolver = await createFaaArcgisResolver({
      core: makeCoreWithEnrichRoute([SEG]),
    });
    expect(() => new Resolver().withArcgis(resolver)).not.to.throw();
  });

  it('enrichRouteAsGeoJSON returns a FeatureCollection from ArcGIS segments', async () => {
    const resolver = await createFaaArcgisResolver({
      core: makeCoreWithEnrichRoute([SEG]),
    });
    const fc = resolver.enrichRouteAsGeoJSON('HAPIE J49 WHALE');
    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.have.length(1);
    const f = fc.features[0];
    expect(f.geometry.type).to.equal('LineString');
    expect(f.properties.name).to.equal('J49');
    // GeoJSON: [longitude, latitude]
    expect(f.geometry.coordinates[0][0]).to.be.closeTo(-73.78, 0.01);
    expect(f.geometry.coordinates[0][1]).to.be.closeTo(40.63, 0.01);
  });
});
