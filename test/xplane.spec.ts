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

  it('createEarthAwyResolver parses airway rows and returns sorted segments', async () => {
    const resolver = await createEarthAwyResolver({
      text: [
        'A1 003 KEC 33.447742 135.794494',
        'A1 001 HCE 33.114350 139.788483',
        'A1 002 KARTA 33.193211 138.972397',
        'bad row',
      ].join('\n'),
    });

    const airway = await resolver.resolve({ airway: 'a1' });
    expect(airway?.type).to.equal('FeatureCollection');
    if (airway?.type !== 'FeatureCollection') {
      throw new Error('expected FeatureCollection');
    }

    expect(airway.features).to.have.length(2);
    expect(airway.features[0].properties.start_name).to.equal('HCE');
    expect(airway.features[0].properties.end_name).to.equal('KARTA');
    expect(airway.features[1].properties.start_name).to.equal('KARTA');
    expect(airway.features[1].properties.end_name).to.equal('KEC');

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
    expect(airway?.type).to.equal('FeatureCollection');

    expect(resolver.enrichRoute('TOU DCT FIX01')).to.deep.equal([]);
  });
});
