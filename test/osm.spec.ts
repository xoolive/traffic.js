import { expect } from 'chai';

import { data } from '../src/index.js';

const {
  buildAirportOverpassQuery,
  fetchAirportOsmFeatures,
  extractOverpassErrorText,
  clearAirportOsmCache,
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
