import { Flight } from '../src';
import * as test from 'tape';

import * as fs from 'fs';
import * as path from 'path';

test('load file', function (t) {
  t.plan(1);

  let data = fs.readFileSync(path.join(__dirname, 'belevingsvlucht.json.gz'));
  const flight = Flight.fromArrayBuffer(data.buffer);

  t.equal(flight.callsign, 'TRA011');
});
