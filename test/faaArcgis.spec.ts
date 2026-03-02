import { describe, it } from 'mocha';
import { expect } from 'chai';

import {
  FAA_ARCGIS_DATASETS,
  createFaaArcgisResolver,
  type FaaArcgisCore,
} from '../src/index.js';

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

  const byCode = (rows: Record<string, unknown>[], key: string, code: string) => {
    const upper = code.toUpperCase();
    const match = rows.find((row) => String(row[key] ?? '').toUpperCase() === upper);
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
      datasetIds: [FAA_ARCGIS_DATASETS.designatedPoints, FAA_ARCGIS_DATASETS.atsRoutes],
    });

    await resolver.fixes.data();
    const j48 = (await resolver.airways['J48']) as {
      type: string;
      geometry: { type: string; coordinates: Array<[number, number]> };
      properties: { points: Array<{ code: string; raw_code: string }> };
    };

    expect(j48.type).to.equal('Feature');
    expect(j48.geometry.type).to.equal('LineString');
    expect(j48.properties.points[0].code).to.equal('LANNA');
    expect(j48.properties.points[0].raw_code).to.equal('LANNA');
    expect(j48.properties.points[j48.properties.points.length - 1].code).to.equal('MOL');
    expect(j48.properties.points[j48.properties.points.length - 1].raw_code).to.equal('MOL');
  });
});
