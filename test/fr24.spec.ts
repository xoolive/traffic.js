import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data } from '../src/index.js';

const { createFr24AirportResolver } = data.fr24;

describe('FR24 airport resolver', () => {
  const json = {
    rows: [
      {
        icao: 'LFBO',
        iata: 'TLS',
        name: 'Toulouse Blagnac',
        lat: 43.6293,
        lon: 1.363,
      },
      {
        icao: 'LFBD',
        iata: 'BOD',
        name: 'Bordeaux Merignac',
        lat: 44.8283,
        lon: -0.7156,
      },
    ],
  };

  it('resolves airport by ICAO, IATA, and name', async () => {
    const resolver = await createFr24AirportResolver({ json });

    const byIcao = await resolver.resolve({ airport: 'LFBO' });
    expect(byIcao?.properties.icao).to.equal('LFBO');

    const byIata = await resolver.resolve({ airport: 'TLS' });
    expect(byIata?.properties.icao).to.equal('LFBO');

    const byName = await resolver.resolve({ airport: 'toulouse blagnac' });
    expect(byName?.properties.iata).to.equal('TLS');
  });

  it('enrichRoute builds DCT airport segments from ICAO tokens', async () => {
    const resolver = await createFr24AirportResolver({ json });
    const segs = resolver.enrichRoute('LFBO DCT LFBD');

    expect(segs).to.have.length(1);
    expect(segs[0].start.name).to.equal('LFBO');
    expect(segs[0].start.latitude).to.equal(43.6293);
    expect(segs[0].start.longitude).to.equal(1.363);
    expect(segs[0].end.name).to.equal('LFBD');
    expect(segs[0].name).to.equal(undefined);
  });
});
