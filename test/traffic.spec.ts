import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { describe } from 'mocha';
import { expect, use } from 'chai';
import chai_datetime from 'chai-datetime';

use(chai_datetime);

import { Traffic } from '../src';

const data = readFileSync(join(__dirname, '..', 'data', 'quickstart.json.gz'));
const quickstart = Traffic.fromArrayBuffer(data.buffer) as Traffic;

describe('Traffic iteration', () => {
  const flight_array = Array.from(quickstart);
  it('iteration length', () => expect(flight_array.length).to.be.equal(238));
});
