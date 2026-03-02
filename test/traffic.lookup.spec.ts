import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { describe, it } from 'mocha';
import { expect } from 'chai';

import { Flight, Traffic } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const data = readFileSync(join(__dirname, '..', 'data', 'quickstart.json.gz'));
const quickstart = Traffic.fromArrayBuffer(data.buffer) as Traffic;

describe('Traffic search and bracket lookup', function () {
  this.timeout(20000);

  it('search returns matching callsigns', () => {
    const matches = quickstart.search('AFR');
    expect(matches.length).to.be.greaterThan(0);
    expect(matches.some((flight) => flight.callsign.startsWith('AFR'))).to.be
      .true;
  });

  it('supports bracket lookup by callsign', () => {
    const flight = quickstart['TAR722'] as Flight | undefined;
    expect(flight).to.not.equal(undefined);
    expect(flight!.callsign).to.equal('TAR722');
  });
});
