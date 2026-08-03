import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data, type EurocontrolDdrCore } from '../src/index.js';

const { createEurocontrolDdrResolver } = data.eurocontrol;

function makeCore(archive: Uint8Array): EurocontrolDdrCore {
  const tag = String.fromCharCode(...archive.slice(0, 3));
  return {
    airports: () => [
      { code: 'EHAM', source: tag, latitude: 52.3086, longitude: 4.7639 },
    ],
    navaids: () => [
      { code: 'NARAK', source: tag, latitude: 43.2, longitude: 1.5 },
      { code: 'TOU', source: tag, latitude: 43.6, longitude: 1.4 },
    ],
    airways: () => [
      {
        name: 'UM605',
        source: tag,
        route_class: 'AR',
        points: [
          { code: 'DTY', raw_code: 'DTY', latitude: 52.3, longitude: 4.7 },
          { code: 'BIBAX', raw_code: 'BIBAX', latitude: 51.5, longitude: 2.0 },
        ],
      },
      {
        name: 'FISTO5ALFBO',
        source: tag,
        route_class: 'DP',
        points: [
          { code: 'FISTO', raw_code: 'FISTO', latitude: 43.5, longitude: 1.2 },
          { code: 'LFBO', raw_code: 'LFBO', latitude: 43.63, longitude: 1.37 },
        ],
      },
    ],
    airspaces: () => [
      {
        designator: 'LFBBCTA',
        name: 'BORDEAUX CTA',
        type_: 'SECTOR',
        lower: 245,
        upper: 660,
        coordinates: [
          [1.0, 44.0],
          [2.0, 44.5],
          [2.5, 45.0],
        ],
        source: tag,
      },
    ],
    resolve_airport: (code: string) =>
      code.toUpperCase() === 'EHAM'
        ? { code: 'EHAM', source: tag, latitude: 52.3086, longitude: 4.7639 }
        : null,
    resolve_navaid: (code: string) =>
      code.toUpperCase() === 'TOU'
        ? { code: 'TOU', source: tag, latitude: 43.6, longitude: 1.4 }
        : code.toUpperCase() === 'NARAK'
          ? { code: 'NARAK', source: tag, latitude: 43.2, longitude: 1.5 }
          : null,
    resolve_airway: (name: string) =>
      name.toUpperCase() === 'UM605'
        ? {
            name: 'UM605',
            source: tag,
            route_class: 'AR',
            points: [
              { code: 'DTY', raw_code: 'DTY', latitude: 52.3, longitude: 4.7 },
              {
                code: 'BIBAX',
                raw_code: 'BIBAX',
                latitude: 51.5,
                longitude: 2.0,
              },
            ],
          }
        : name.toUpperCase() === 'FISTO5ALFBO'
          ? {
              name: 'FISTO5ALFBO',
              source: tag,
              route_class: 'DP',
              points: [
                {
                  code: 'FISTO',
                  raw_code: 'FISTO',
                  latitude: 43.5,
                  longitude: 1.2,
                },
                {
                  code: 'LFBO',
                  raw_code: 'LFBO',
                  latitude: 43.63,
                  longitude: 1.37,
                },
              ],
            }
          : null,
    resolve_sid: (name: string) =>
      name.toUpperCase() === 'FISTO5A'
        ? {
            name: 'FISTO5ALFBO',
            source: tag,
            route_class: 'DP',
            points: [
              {
                code: 'FISTO',
                raw_code: 'FISTO',
                latitude: 43.5,
                longitude: 1.2,
              },
              {
                code: 'LFBO',
                raw_code: 'LFBO',
                latitude: 43.63,
                longitude: 1.37,
              },
            ],
          }
        : null,
    resolve_star: (name: string) =>
      name.toUpperCase() === 'KEPER9E'
        ? {
            name: 'KEPER9ELFBO',
            source: tag,
            route_class: 'AP',
            points: [
              {
                code: 'KEPER',
                raw_code: 'KEPER',
                latitude: 44.2,
                longitude: 2.1,
              },
              {
                code: 'LFBO',
                raw_code: 'LFBO',
                latitude: 43.63,
                longitude: 1.37,
              },
            ],
          }
        : null,
    resolve_airspace: (designator: string) =>
      designator.toUpperCase() === 'LFBBCTA'
        ? {
            designator: 'LFBBCTA',
            name: 'BORDEAUX CTA',
            type_: 'SECTOR',
            lower: 245,
            upper: 660,
            coordinates: [
              [1.0, 44.0],
              [2.0, 44.5],
              [2.5, 45.0],
            ],
            source: tag,
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
    const um605 = (await resolver.airways['UM605']) as {
      properties: { points: string[]; route_class?: string };
    };
    expect(um605.properties.points).to.deep.equal(['DTY', 'BIBAX']);
    expect(um605.properties.route_class).to.equal('AR');

    const fisto = (await resolver.airways['FISTO5ALFBO']) as {
      properties: {
        route_class?: string;
        name?: string;
        airport?: string;
        type?: string;
      };
    };
    expect(fisto.properties.route_class).to.equal('DP');
    expect(fisto.properties.name).to.equal('FISTO5A');
    expect(fisto.properties.type).to.equal('SID');
    expect(fisto.properties.airport).to.equal('LFBO');

    const sid = (await resolver.resolve({
      SID: 'FISTO5A',
      airport: 'LFBO',
    })) as {
      properties: { name?: string; type?: string };
    };
    expect(sid.properties.name).to.equal('FISTO5A');
    expect(sid.properties.type).to.equal('SID');

    const airspaceRows = (await resolver.airspaces.data()) as Array<{
      geometry: unknown;
    }>;
    expect(airspaceRows[0].geometry).to.equal(null);

    const airspace = (await resolver.airspaces['LFBBCTA']) as {
      geometry: { type: string; coordinates: unknown } | null;
      properties: Record<string, unknown>;
    };
    expect(airspace.geometry).to.deep.equal({
      type: 'Polygon',
      coordinates: [
        [
          [1, 44],
          [2, 44.5],
          [2.5, 45],
          [1, 44],
        ],
      ],
    });
    expect(airspace.properties['designator']).to.equal('LFBBCTA');
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

    const fix = (await resolver.navaids['NARAK']) as {
      properties: Record<string, unknown>;
    };
    expect(fix.properties['code']).to.equal('NARAK');
    expect(progress.length).to.be.greaterThan(0);
    expect(progress[progress.length - 1]).to.equal(1);
  });

  it('splits very large airway gaps on adapter output', async () => {
    const core: EurocontrolDdrCore = {
      airports: () => [],
      navaids: () => [],
      airways: () => [
        {
          name: 'A10',
          source: 'DDR',
          route_class: 'AR',
          points: [
            { code: 'YJQ', raw_code: 'YJQ', latitude: 10, longitude: 10 },
            { code: 'MITEK', raw_code: 'MITEK', latitude: 10, longitude: 11 },
            { code: '*PR13', raw_code: '*PR13', latitude: 10, longitude: 12 },
            { code: 'SIT', raw_code: 'SIT', latitude: 55, longitude: 120 },
            { code: 'PAXIS', raw_code: 'PAXIS', latitude: 55, longitude: 121 },
          ],
        },
      ],
      airspaces: () => [],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => ({
        name: 'A10',
        source: 'DDR',
        route_class: 'AR',
        points: [
          { code: 'YJQ', raw_code: 'YJQ', latitude: 10, longitude: 10 },
          { code: 'MITEK', raw_code: 'MITEK', latitude: 10, longitude: 11 },
          { code: '*PR13', raw_code: '*PR13', latitude: 10, longitude: 12 },
          { code: 'SIT', raw_code: 'SIT', latitude: 55, longitude: 120 },
          { code: 'PAXIS', raw_code: 'PAXIS', latitude: 55, longitude: 121 },
        ],
      }),
      resolve_airspace: () => null,
    };

    const resolver = await createEurocontrolDdrResolver({ core });

    const rows = (await resolver.airways.data()) as Array<{
      properties: { points: string[]; airway_variant_count?: number };
    }>;
    expect(rows.length).to.equal(2);
    expect(rows[0].properties.points).to.deep.equal(['YJQ', 'MITEK', '*PR13']);
    expect(rows[1].properties.points).to.deep.equal(['SIT', 'PAXIS']);
    expect(rows[0].properties.airway_variant_count).to.equal(2);

    const a10 = (await resolver.airways['A10']) as {
      properties: { points: string[] };
    };
    expect(a10.properties.points).to.deep.equal(['YJQ', 'MITEK', '*PR13']);
  });

  it('warns once when airway lookup is ambiguous', async () => {
    const core: EurocontrolDdrCore = {
      airports: () => [],
      navaids: () => [],
      airways: () => [],
      airspaces: () => [],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => ({
        name: 'A10',
        source: 'DDR',
        route_class: 'AR',
        points: [
          { code: 'YJQ', raw_code: 'YJQ', latitude: 10, longitude: 10 },
          { code: 'MITEK', raw_code: 'MITEK', latitude: 10, longitude: 11 },
          { code: '*PR13', raw_code: '*PR13', latitude: 10, longitude: 12 },
          { code: 'SIT', raw_code: 'SIT', latitude: 55, longitude: 120 },
          { code: 'PAXIS', raw_code: 'PAXIS', latitude: 55, longitude: 121 },
        ],
      }),
      resolve_airspace: () => null,
    };

    const resolver = await createEurocontrolDdrResolver({ core });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await resolver.airways['A10'];
      await resolver.airways['A10'];
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).to.equal(1);
    expect(warnings[0]).to.include("airway 'A10' has 2 variants");
  });

  it('gracefully handles older cores without airspace methods', async () => {
    const core = {
      airports: () => [],
      navaids: () => [],
      airways: () => [],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => null,
    } as EurocontrolDdrCore;

    const resolver = await createEurocontrolDdrResolver({ core });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      const result = await resolver.resolve({ airspace: 'LFBBCTA' });
      expect(result).to.equal(undefined);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).to.equal(1);
    expect(warnings[0]).to.include('EUROCONTROL airspace API is unavailable');
  });

  it('unions layered airspace geometry for display', async () => {
    const layered = {
      designator: 'LFBBCTA',
      name: 'BORDEAUX U/ACC',
      type_: 'AUA',
      source: 'DDR',
      layers: [
        {
          lower: 195,
          upper: 295,
          coordinates: [
            [1, 44],
            [2, 44],
            [2, 45],
            [1, 45],
          ],
        },
        {
          lower: 295,
          upper: 365,
          coordinates: [
            [1.5, 44.5],
            [2.5, 44.5],
            [2.5, 45.5],
            [1.5, 45.5],
          ],
        },
      ],
    };

    const core: EurocontrolDdrCore = {
      airports: () => [],
      navaids: () => [],
      airways: () => [],
      airspaces: () => [layered],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => null,
      resolve_airspace: () => layered,
    };

    const resolver = await createEurocontrolDdrResolver({ core });
    const lfbb = (await resolver.airspaces['LFBBCTA']) as {
      geometry: { type: string; coordinates: unknown } | null;
      properties: {
        layers?: Array<{
          geometry?: { type?: string; coordinates?: unknown };
        }>;
      };
    };
    expect(lfbb.geometry?.type).to.equal('Polygon');
    expect(Array.isArray(lfbb.properties.layers)).to.equal(true);
    expect(lfbb.properties.layers?.length).to.equal(2);
    expect(lfbb.properties.layers?.[0].geometry?.type).to.equal('Polygon');
    expect(
      Array.isArray(
        (
          lfbb.properties.layers?.[0].geometry?.coordinates as
            unknown[] | undefined
        )?.[0]
      )
    ).to.equal(true);
  });

  it('applies altitude-slice merge like traffic unary_union_with_alt', async () => {
    const layered = {
      designator: 'TESTCTA',
      name: 'TEST CTA',
      type_: 'CTA',
      source: 'DDR',
      layers: [
        {
          lower: 100,
          upper: 200,
          coordinates: [
            [1, 44],
            [2, 44],
            [2, 45],
            [1, 45],
          ],
        },
        {
          lower: 200,
          upper: 300,
          coordinates: [
            [1, 44],
            [2, 44],
            [2, 45],
            [1, 45],
          ],
        },
      ],
    };

    const core: EurocontrolDdrCore = {
      airports: () => [],
      navaids: () => [],
      airways: () => [],
      airspaces: () => [layered],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => null,
      resolve_airspace: () => layered,
    };

    const resolver = await createEurocontrolDdrResolver({ core });
    const feature = (await resolver.airspaces['TESTCTA']) as {
      properties: {
        layers?: Array<{ lower: number; upper: number }>;
      };
    };
    expect(feature.properties.layers?.length).to.equal(1);
    expect(feature.properties.layers?.[0].lower).to.equal(100);
    expect(feature.properties.layers?.[0].upper).to.equal(300);
  });

  it('matches NM-style LFBB layer bands after consolidation', async () => {
    const bdx = {
      designator: 'LFBBBDX',
      name: 'BORDEAUX TOTAL',
      type_: 'CS',
      source: 'DDR',
      layers: [
        {
          lower: 145,
          upper: 195,
          coordinates: [
            [1, 44],
            [2, 44],
            [2, 45],
            [1, 45],
          ],
        },
        {
          lower: 145,
          upper: 195,
          coordinates: [
            [1.5, 44.2],
            [2.4, 44.2],
            [2.4, 45.1],
            [1.5, 45.1],
          ],
        },
        {
          lower: 195,
          upper: 265,
          coordinates: [
            [0.5, 43.8],
            [2.8, 43.8],
            [2.8, 45.3],
            [0.5, 45.3],
          ],
        },
        {
          lower: 265,
          upper: Number.POSITIVE_INFINITY,
          coordinates: [
            [0.2, 43.5],
            [3, 43.5],
            [3, 45.6],
            [0.2, 45.6],
          ],
        },
      ],
    };

    const rl = {
      designator: 'LFBBRL',
      name: 'BORDEAUX RL',
      type_: 'ES',
      source: 'DDR',
      layers: [
        {
          lower: 195,
          upper: Number.POSITIVE_INFINITY,
          coordinates: [
            [-1.7, 44.4],
            [2.4, 44.4],
            [2.4, 47.1],
            [-1.7, 47.1],
          ],
        },
      ],
    };

    const r1 = {
      designator: 'LFBBR1',
      name: 'BORDEAUX R1',
      type_: 'ES',
      source: 'DDR',
      layers: [
        {
          lower: 195,
          upper: 295,
          coordinates: [
            [-1.7, 44.4],
            [1.1, 44.4],
            [1.1, 47.0],
            [-1.7, 47.0],
          ],
        },
      ],
    };

    const byDesignator: Record<string, unknown> = {
      LFBBBDX: bdx,
      LFBBRL: rl,
      LFBBR1: r1,
    };

    const core: EurocontrolDdrCore = {
      airports: () => [],
      navaids: () => [],
      airways: () => [],
      airspaces: () => [bdx, rl, r1],
      resolve_airport: () => null,
      resolve_navaid: () => null,
      resolve_airway: () => null,
      resolve_airspace: (designator: string) =>
        byDesignator[designator] ?? null,
    };

    const resolver = await createEurocontrolDdrResolver({ core });

    const bands = async (code: string): Promise<Array<[number, number]>> => {
      const feature = (await resolver.resolve({ airspace: code })) as {
        properties: {
          layers?: Array<{ lower?: number; upper?: number }>;
        };
      };
      return (feature.properties.layers ?? [])
        .map(
          (layer) =>
            [Number(layer.lower), Number(layer.upper)] as [number, number]
        )
        .sort((a, b) => a[0] - b[0]);
    };

    expect(await bands('LFBBBDX')).to.deep.equal([
      [145, 195],
      [195, 265],
      [265, Number.POSITIVE_INFINITY],
    ]);
    expect(await bands('LFBBRL')).to.deep.equal([
      [195, Number.POSITIVE_INFINITY],
    ]);
    expect(await bands('LFBBR1')).to.deep.equal([[195, 295]]);
  });
});
