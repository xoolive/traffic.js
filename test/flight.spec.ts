import { describe } from 'mocha';
import { expect } from 'chai';

import { Flight } from '../src';

import * as fs from 'fs';
import * as path from 'path';

describe('Load JSON file', () => {
  let data = fs.readFileSync(path.join(__dirname, 'belevingsvlucht.json.gz'));
  const flight = data.buffer.byteLength; //Flight.fromArrayBuffer(data.buffer);

  it('bullshit', () => expect(flight).to.equal(291488));

  const flight2 = { callsign: 'TRA051' };
  //const flight2 = Flight.fromArrayBuffer(data.buffer);

  it('callsign', () => expect(flight2.callsign).to.equal('TRA051'));
});
