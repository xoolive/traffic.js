import { expect } from 'chai';

import { data } from '../src/index.js';

const {
  buildAirportOverpassQuery,
  fetchAirportOsmFeatures,
  extractOverpassErrorText,
  clearAirportOsmCache,
  buildOsmQuery,
  fetchOsmBeacons,
  normaliseBeaconType,
  OsmBeaconsSource,
} = data.osm;

describe('OSM airport infrastructure helpers', () => {
  afterEach(() => {
    clearAirportOsmCache();
  });

  it('builds an ICAO-area Overpass query with custom tags', () => {
    const query = buildAirportOverpassQuery({
      icao: 'lfpg',
      tags: { aeroway: ['runway', 'taxiway'], airmark: 'beacon' },
    });

    expect(query).to.contain('area["icao"="LFPG"]->.airport;');
    expect(query).to.contain(
      'nwr["aeroway"~"^(runway|taxiway)$"]["airmark"="beacon"](area.airport);'
    );
  });

  it('caches responses by airport ICAO', async () => {
    let calls = 0;
    const fetchStub = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            elements: [
              {
                type: 'node',
                id: 1,
                lat: 43.6,
                lon: 1.4,
                tags: { aeroway: 'parking_position', ref: 'A01' },
              },
            ],
          }),
      };
    };

    const first = await fetchAirportOsmFeatures({
      icao: 'LFBO',
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      cacheStorage: 'memory',
    });
    const second = await fetchAirportOsmFeatures({
      icao: 'LFBO',
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      cacheStorage: 'memory',
    });

    expect(first.features.length).to.equal(1);
    expect(second.features.length).to.equal(1);
    expect(calls).to.equal(1);
  });

  it('extracts concise error details from Overpass HTML payload', () => {
    const html = `
      <html><body>
        <p><strong style="color:#FF0000">Error</strong>: runtime error: rate_limited. Please check /api/status.</p>
      </body></html>
    `;
    const message = extractOverpassErrorText(html);
    expect(message).to.contain('runtime error: rate_limited');
  });

  it('resolver convenience method resolves airport query then fetches OSM', async () => {
    const resolver = new data.Resolver().withSource('fr24', {
      resolve: async (query: { airport?: string }) =>
        query.airport
          ? {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [2.55, 49.0] },
              properties: { icao: 'LFPG', name: 'CDG' },
            }
          : null,
    });

    const fetchStub = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 49.01,
              lon: 2.56,
              tags: { airmark: 'beacon' },
            },
          ],
        }),
    });

    const fc = await resolver.fetchAirportOsmFeatures({
      airport: 'cdg',
      tags: { airmark: 'beacon' },
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      cacheStorage: 'memory',
    });

    expect(fc.type).to.equal('FeatureCollection');
    expect(fc.features).to.have.length(1);
    expect(fc.features[0].properties?.airmark).to.equal('beacon');
  });
});

describe('OSM airmark=beacon navaid source', () => {
  afterEach(() => {
    clearAirportOsmCache();
  });

  it('normalises beacon:type to the traffic taxonomy', () => {
    expect(normaliseBeaconType('VOR', false, false)).to.equal('VOR');
    expect(normaliseBeaconType('dvor', false, false)).to.equal('VOR');
    expect(normaliseBeaconType('DVOR/DME', false, false)).to.equal('DME');
    expect(normaliseBeaconType('NDB', false, false)).to.equal('NDB');
    expect(normaliseBeaconType('ILS', false, false)).to.equal('ILS');
    expect(normaliseBeaconType('ILS', true, false)).to.equal('LOC');
    expect(normaliseBeaconType('ILS', false, true)).to.equal('GS');
    expect(normaliseBeaconType('MM', false, false)).to.equal('MM');
  });

  it('builds a general (node) Overpass query with around/bounds/area scopes', () => {
    expect(buildOsmQuery({ tags: { airmark: 'beacon' } })).to.contain(
      'node["airmark"="beacon"];out;'
    );

    const around = buildOsmQuery({
      tags: { airmark: 'beacon' },
      around: [200000, 49.0, 2.35],
    });
    expect(around).to.contain('(around:200000,49,2.35)');

    const bbox = buildOsmQuery({
      tags: { airmark: 'beacon' },
      bounds: [1.0, 43.0, 2.0, 44.0],
    });
    expect(bbox).to.contain('[bbox:43,1,44,2];');

    const area = buildOsmQuery({
      tags: { airmark: 'beacon' },
      area: { relation: 1403916 },
    });
    expect(area).to.contain('rel(id:1403916);map_to_area;->.searchArea;');
    expect(area).to.contain('(area.searchArea)');
  });

  it('fetchOsmBeacons normalises taxonomy from Overpass nodes', async () => {
    const fetchStub = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 48.99,
              lon: 2.36,
              tags: {
                airmark: 'beacon',
                'beacon:type': 'VOR',
                'beacon:code': 'ORS',
                'beacon:frequency': '113.8',
                name: 'ORME-LES-VILLIERS',
              },
            },
            {
              type: 'node',
              id: 2,
              lat: 49.0,
              lon: 2.4,
              tags: {
                airmark: 'beacon',
                'beacon:type': 'ILS',
                localizer: 'yes',
                name: 'LFPG 26L',
              },
            },
            { type: 'way', id: 3, nodes: [1, 2], tags: {} },
          ],
        }),
    });

    const beacons = await fetchOsmBeacons({
      around: [50000, 49.0, 2.4],
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      cacheStorage: 'memory',
    });

    expect(beacons).to.have.length(2); // the way is ignored
    expect(beacons[0].code).to.equal('ORS');
    expect(beacons[0].navaidType).to.equal('VOR');
    expect(beacons[0].frequency).to.equal(113.8);
    expect(beacons[1].navaidType).to.equal('LOC'); // ILS + localizer
  });

  it('OsmBeaconsSource resolves a beacon code within a scope', async () => {
    const fetchStub = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 48.99,
              lon: 2.36,
              tags: {
                airmark: 'beacon',
                'beacon:type': 'VOR',
                'beacon:code': 'ORS',
                'beacon:frequency': '113.8',
              },
            },
          ],
        }),
    });

    const source = new OsmBeaconsSource({
      around: [200000, 49.0, 2.35],
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      cacheStorage: 'memory',
    });
    const hit = await source.resolve({ navaid: 'ors' });
    expect(hit).to.not.be.null;
    expect(hit?.geometry.type).to.equal('Point');
    expect(hit?.properties?.type).to.equal('VOR');
    expect(hit?.properties?.source).to.equal('osm');

    const miss = await source.resolve({ navaid: 'NOPE' });
    expect(miss).to.be.null;
  });

  it('resolver.withOsmBeacons attaches a scoped beacon source', async () => {
    const fetchStub = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 48.99,
              lon: 2.36,
              tags: {
                airmark: 'beacon',
                'beacon:type': 'VOR',
                'beacon:code': 'ORS',
              },
            },
          ],
        }),
    });

    const resolver = new data.Resolver().withOsmBeacons({
      area: { tags: { icao: 'LFPG' } },
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      cacheStorage: 'memory',
    });

    const hit = await resolver.resolve({ navaid: 'ors' });
    expect(hit).to.not.be.null;
    expect((hit as GeoJSON.Feature).properties?.source).to.equal('osm');
  });
});
