import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data } from '../src/index.js';

const {
  createEarthNavResolver,
  createEarthFixResolver,
  createEarthAwyResolver,
  createXplaneResolver,
} = data.xplane;

describe('xplane loaders', () => {
  it('createEarthNavResolver parses nav rows and ignores malformed lines', async () => {
    const resolver = await createEarthNavResolver({
      text: [
        '2  43.86094722 -066.04370556 000120  230 025    0.0 AC   PLEASANT LAKE YARMOUTH NDB',
        '3  43.53908333 -005.93052778 000000 11420 025    0.0 TOU  TOULOUSE VOR DME',
        'this is malformed',
      ].join('\n'),
    });

    const tou = await resolver.resolve({ navaid: 'tou' });
    expect(tou?.type).to.equal('Feature');
    expect(tou?.properties.ident).to.equal('TOU');
    expect(tou?.properties.kind).to.equal('VOR');
    expect(tou?.properties.frequency).to.equal(114.2);

    const none = await resolver.resolve({ navaid: 'XXXX' });
    expect(none).to.equal(null);
    expect(resolver.enrichRoute('TOU DCT AC')).to.deep.equal([]);
  });

  it('createEarthFixResolver parses fix rows and resolves by fix ident', async () => {
    const resolver = await createEarthFixResolver({
      text: [
        '43.12345678 -001.23456789 FIX01',
        '-12.00000000 100.00000000 FIXA2',
        'bad row',
      ].join('\n'),
    });

    const fix = await resolver.resolve({ fix: 'fix01' });
    expect(fix?.type).to.equal('Feature');
    expect(fix?.properties.ident).to.equal('FIX01');
    expect(fix?.properties.kind).to.equal('fix');

    const none = await resolver.resolve({ fix: 'NONE' });
    expect(none).to.equal(null);
    expect(resolver.enrichRoute('FIX01 DCT FIXA2')).to.deep.equal([]);
  });

  it('createEarthAwyResolver parses airway rows and returns a LineString feature', async () => {
    const resolver = await createEarthAwyResolver({
      text: [
        'A1 003 KEC 33.447742 135.794494',
        'A1 001 HCE 33.114350 139.788483',
        'A1 002 KARTA 33.193211 138.972397',
        'bad row',
      ].join('\n'),
    });

    const airway = await resolver.resolve({ airway: 'a1' });
    expect(airway?.type).to.equal('Feature');
    if (airway?.type !== 'Feature') {
      throw new Error('expected Feature');
    }

    expect(airway.geometry.type).to.equal('LineString');
    if (airway.geometry.type !== 'LineString') {
      throw new Error('expected LineString');
    }

    expect(airway.geometry.coordinates).to.have.length(3);
    expect(airway.properties.name).to.equal('A1');
    expect(airway.properties.points).to.deep.equal(['HCE', 'KARTA', 'KEC']);
  });

  it('createEarthAwyResolver returns first variant for disjoint airways', async () => {
    const resolver = await createEarthAwyResolver({
      text: [
        'A2 001 AAA 10.0000 20.0000',
        'A2 002 BBB 11.0000 21.0000',
        'A2 010 CCC 30.0000 40.0000',
        'A2 011 DDD 31.0000 41.0000',
      ].join('\n'),
    });

    const airway = await resolver.resolve({ airway: 'A2' });
    expect(airway?.type).to.equal('Feature');
    if (airway?.type !== 'Feature') {
      throw new Error('expected Feature');
    }
    expect(airway.geometry.type).to.equal('LineString');
    if (airway.geometry.type !== 'LineString') {
      throw new Error('expected LineString');
    }
    expect(airway.geometry.coordinates).to.have.length(2);
    expect(airway.properties.points).to.deep.equal(['AAA', 'BBB']);
    expect(airway.properties.airway_variant).to.equal(1);
    expect(airway.properties.airway_variant_count).to.equal(2);

    const none = await resolver.resolve({ airway: 'ZZZ' });
    expect(none).to.equal(null);
    expect(resolver.enrichRoute('HCE A1 KEC')).to.deep.equal([]);
  });

  it('createXplaneResolver combines nav/fix/awy into one source', async () => {
    const resolver = await createXplaneResolver({
      nav: {
        text: '3  43.53908333 -005.93052778 000000 11420 025    0.0 TOU  TOULOUSE VOR DME',
      },
      fix: {
        text: '43.12345678 -001.23456789 FIX01',
      },
      awy: {
        text: [
          'A1 001 HCE 33.114350 139.788483',
          'A1 002 KARTA 33.193211 138.972397',
        ].join('\n'),
      },
    });

    const navaid = await resolver.resolve({ navaid: 'TOU' });
    expect(navaid?.type).to.equal('Feature');
    expect(navaid?.properties.ident).to.equal('TOU');

    const fix = await resolver.resolve({ fix: 'FIX01' });
    expect(fix?.type).to.equal('Feature');
    expect(fix?.properties.ident).to.equal('FIX01');

    const airway = await resolver.resolve({ airway: 'A1' });
    expect(airway?.type).to.equal('Feature');

    expect(resolver.enrichRoute('TOU DCT FIX01')).to.deep.equal([]);
  });
});
