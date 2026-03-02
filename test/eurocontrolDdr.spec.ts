import { describe, it } from 'mocha';
import { expect } from 'chai';

import {
  createEurocontrolDdrResolver,
  type EurocontrolDdrCore,
} from '../src/index.js';

function makeCore(archive: Uint8Array): EurocontrolDdrCore {
  const tag = String.fromCharCode(...archive.slice(0, 3));
  return {
    airports: () => [
      { code: 'EHAM', source: tag, latitude: 52.3086, longitude: 4.7639 },
    ],
    fixes: () => [
      { code: 'NARAK', source: tag, latitude: 43.2, longitude: 1.5 },
    ],
    navaids: () => [
      { code: 'TOU', source: tag, latitude: 43.6, longitude: 1.4 },
    ],
    airways: () => [
      {
        name: 'UM605',
        source: tag,
        points: [
          { latitude: 52.3, longitude: 4.7 },
          { latitude: 51.5, longitude: 2.0 },
        ],
      },
    ],
    resolve_airport: (code: string) =>
      code.toUpperCase() === 'EHAM'
        ? { code: 'EHAM', source: tag, latitude: 52.3086, longitude: 4.7639 }
        : null,
    resolve_fix: (code: string) =>
      code.toUpperCase() === 'NARAK'
        ? { code: 'NARAK', source: tag, latitude: 43.2, longitude: 1.5 }
        : null,
    resolve_navaid: (code: string) =>
      code.toUpperCase() === 'TOU'
        ? { code: 'TOU', source: tag, latitude: 43.6, longitude: 1.4 }
        : null,
    resolve_airway: (name: string) =>
      name.toUpperCase() === 'UM605'
        ? {
            name: 'UM605',
            source: tag,
            points: [
              { latitude: 52.3, longitude: 4.7 },
              { latitude: 51.5, longitude: 2.0 },
            ],
          }
        : null,
  };
}

describe('EUROCONTROL DDR resolver adapter', () => {
  it('provides collection API and bracket lookup from archive bytes', async () => {
    const archive = new Uint8Array([69, 78, 86, 95, 90, 73, 80]);
    const resolver = await createEurocontrolDdrResolver({
      archive,
      coreFactory: makeCore,
    });

    const airports = await resolver.airports.data();
    expect(airports.length).to.equal(1);
    expect((airports[0] as { type: string }).type).to.equal('Feature');
    expect(
      (airports[0] as { properties: Record<string, unknown> }).properties[
        'code'
      ]
    ).to.equal('EHAM');

    const eham = (await resolver.airports['EHAM']) as {
      type: string;
      geometry: { type: string; coordinates: [number, number] } | null;
      properties: Record<string, unknown>;
    };
    expect(eham.type).to.equal('Feature');
    expect(eham.geometry?.type).to.equal('Point');
    expect(eham.properties['code']).to.equal('EHAM');
    expect(eham.properties['source']).to.equal('ENV');

    const unknownAirport = await resolver.airports['ZZZZ'];
    expect(unknownAirport).to.equal(undefined);

    const matches = await resolver.airways.search('um6');
    expect(matches.length).to.equal(1);
  });

  it('supports archiveUrl fetch with progress callback', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const progress: number[] = [];
    const resolver = await createEurocontrolDdrResolver({
      archiveUrl: 'https://example.com/ddr.zip',
      fetchImpl: async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-length': '5' },
        }),
      coreFactory: makeCore,
      onArchiveProgress: (p) => {
        if (p.ratio !== null) {
          progress.push(p.ratio);
        }
      },
    });

    const fix = (await resolver.fixes['NARAK']) as {
      properties: Record<string, unknown>;
    };
    expect(fix.properties['code']).to.equal('NARAK');
    expect(progress.length).to.be.greaterThan(0);
    expect(progress[progress.length - 1]).to.equal(1);
  });
});
