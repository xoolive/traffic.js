import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { op } from 'arquero';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { describe } from 'mocha';
import { expect, use } from 'chai';
import chai_datetime from 'chai-datetime';

use(chai_datetime);

import { Flight } from '../src';
import { Op } from '../src/types';

const data = readFileSync(
  join(__dirname, '..', 'data', 'belevingsvlucht.json.gz')
);
const flight = Flight.fromArrayBuffer(data.buffer) as Flight;

describe('Flight properties', () => {
  it('callsign', () => expect(flight.callsign).to.be.equal('TRA051'));
  it('icao24', () => expect(flight.icao24).to.be.equal('484506'));

  const start = new Date('2018-05-30T15:21:38Z');
  it('start', () => expect(flight.start).to.be.equalTime(start));

  const stop = new Date('2018-05-30T20:22:56Z');
  it('stop', () => expect(flight.stop).to.be.equalTime(stop));

  it('duration', () => expect(flight.duration).to.be.greaterThan(5 * 3600000));
});

describe('Flight functions', () => {
  const t0 = new Date('2018-05-30T18:00:00Z');

  const flight_before = flight.before(t0);
  it('before', () => expect(flight_before.duration).to.be.below(3 * 3600000));

  const flight_after = flight.after(t0);
  it('after', () => expect(flight_after.duration).to.be.below(3 * 3600000));

  const t1 = new Date('2018-05-30T19:00:00Z');
  const flight_between = flight.between(t0, t1);
  it('between strict', () =>
    expect(flight_between.duration).to.be.equal(3599000));

  const flight_chain = flight.before(t1, false).after(t0, false);
  it('between included', () =>
    expect(flight_chain.duration).to.be.equal(3600000));
});

describe('Flight rollup', () => {
  const stats = flight.rollup({
    start: (f: Flight) => f.start,
    callsign: 'callsign',
    icao24: 'icao24',
    alt_max: op.max('altitude') as unknown as Op,
  });
  it('attribute', () => {
    expect(stats.callsign).to.be.equal('TRA051');
    expect(stats.icao24).to.be.equal('484506');
  });
  it('function', () => {
    expect(stats.start).to.be.equalTime(new Date('2018-05-30T15:21:38Z'));
  });
  it('arquero op', () => {
    expect(stats.alt_max).to.be.greaterThan(10000);
  });
});
