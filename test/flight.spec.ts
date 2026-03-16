import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { op } from 'arquero';
import * as d3 from 'd3';
import * as turf from '@turf/turf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { describe } from 'mocha';
import { expect, use } from 'chai';
import chai_datetime from 'chai-datetime';
import type { Op } from '../src/core/types.js';
import type { Flight as FlightType } from '../src/core/flight.js';

use(chai_datetime);

import { core } from '../src/index.js';

const { Flight } = core;

const data = readFileSync(
  join(__dirname, '..', 'data', 'belevingsvlucht.json.gz')
);
const flight = Flight.fromArrayBuffer(data.buffer) as FlightType;

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
    start: (f: FlightType) => f.start,
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

describe('Flight resample', () => {
  // Python (pandas): 18079  ← duration = 18078 s exactly, inclusive of start & stop
  const r1s = flight.resample(d3.timeSecond.every(1));
  it('resample 1s', () => {
    expect(r1s.entries().length).to.be.equal(18079);
  });
  // Python (pandas): 302  ← pandas resample('1min') starts from the start bin (15:21)
  // d3.scaleTime().ticks() snaps to clean minute boundaries (15:22 → 20:22) → 301
  // This is a known semantic difference: pandas includes the first open bin,
  // d3 ticks are aligned to clock boundaries.
  const r1m = flight.resample(d3.timeMinute.every(1));
  it('resample 1m', () => {
    expect(r1m.entries().length).to.be.equal(301);
  });
  it('resample n points — endpoints match start/stop (Python: pd.date_range(..., periods=n))', () => {
    const r2 = flight.resample(2);
    expect(r2.entries().length).to.be.equal(2);
    // endpoints must be exactly start and stop
    expect(r2.entries()[0].timestamp).to.be.equalTime(flight.start);
    expect(r2.entries()[1].timestamp).to.be.equalTime(flight.stop);
    expect(flight.resample(20).entries().length).to.be.equal(20);
    expect(flight.resample(200).entries().length).to.be.equal(200);
    expect(flight.resample(2000).entries().length).to.be.equal(2000);
  });
});

describe('Flight simplify', () => {
  // Python (full RDP, pyproj LCC): simplify(1e3)=150, simplify(1e2)=897
  // JS (full RDP=highQuality:true, d3 geoConicConformal): 149 / 903
  // Small differences (~1%) arise from the projection type (LCC vs ConicConformal);
  // both are conformal and scale to metres — exact match requires porting pyproj.
  it('length (full RDP, tolerance in metres)', () => {
    expect(flight.simplify(1e3).entries().length).to.be.equal(149);
    expect(flight.simplify(1e2).entries().length).to.be.equal(903);
  });
  it('simplify reduces point count', () => {
    const n = flight.entries().length;
    expect(flight.simplify(1e3).entries().length).to.be.lessThan(n);
    expect(flight.simplify(1e2).entries().length).to.be.lessThan(n);
    expect(flight.simplify(1e2).entries().length).to.be.greaterThan(
      flight.simplify(1e3).entries().length
    );
  });
});

describe('Flight intersects', () => {
  const netherlands = turf.bboxPolygon([3.08, 50.75, 7.23, 53.75]);
  const switzerland = turf.bboxPolygon([5.95, 45.81, 10.5, 47.81]);
  it('intersections', () => {
    expect(flight.intersects(netherlands)).to.be.true;
    expect(flight.intersects(switzerland)).to.be.false;
  });
});
