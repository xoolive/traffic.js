/**
 * Holding pattern detection tests.
 *
 * Expected result: belevingsvlucht contains exactly one holding pattern
 * between approximately 2018-05-30T15:43:52Z and 2018-05-30T15:53:51Z.
 *
 * We assert that at least one detected segment overlaps the known 15:45–15:50
 * window, and that the result exposes valid start/stop dates.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import type { Flight as FlightType } from '../src/core/flight.js';

import { core, algorithms } from '../src/index.js';

const { Flight } = core;
const { unwrapDegrees } = algorithms;

// ---------------------------------------------------------------------------
// Load flight data
// ---------------------------------------------------------------------------
const data = readFileSync(
  join(__dirname, '..', 'data', 'belevingsvlucht.json.gz')
);
const flight = Flight.fromArrayBuffer(data.buffer) as FlightType;

// ---------------------------------------------------------------------------
// unwrapDegrees unit tests
// ---------------------------------------------------------------------------
describe('unwrapDegrees', () => {
  it('returns empty array for empty input', () => {
    expect(unwrapDegrees([])).to.deep.equal([]);
  });

  it('preserves a single value', () => {
    expect(unwrapDegrees([45])).to.deep.equal([45]);
  });

  it('does not alter monotone increasing angles below 180°', () => {
    const angles = [0, 30, 60, 90, 120];
    expect(unwrapDegrees(angles)).to.deep.equal([0, 30, 60, 90, 120]);
  });

  it('unwraps a 359→1 crossing correctly', () => {
    const angles = [358, 359, 1, 3];
    const result = unwrapDegrees(angles);
    // After unwrapping: 358, 359, 361, 363
    expect(result[0]).to.equal(358);
    expect(result[1]).to.equal(359);
    expect(result[2]).to.be.closeTo(361, 1e-9);
    expect(result[3]).to.be.closeTo(363, 1e-9);
  });

  it('unwraps a 1→359 crossing (counter-clockwise) correctly', () => {
    const angles = [2, 1, 359, 357];
    const result = unwrapDegrees(angles);
    expect(result[0]).to.equal(2);
    expect(result[1]).to.equal(1);
    expect(result[2]).to.be.closeTo(-1, 1e-9);
    expect(result[3]).to.be.closeTo(-3, 1e-9);
  });
});

// ---------------------------------------------------------------------------
// slidingWindows unit tests
// ---------------------------------------------------------------------------
describe('Flight.slidingWindows', () => {
  // Use a 30-minute excerpt to keep the test fast
  const excerpt = flight.between(
    new Date('2018-05-30T15:40:00Z'),
    new Date('2018-05-30T16:10:00Z')
  );

  it('yields at least one window', () => {
    const windows = [...excerpt.slidingWindows()];
    expect(windows.length).to.be.greaterThan(0);
  });

  it('each window is a Flight with start/stop', () => {
    for (const win of excerpt.slidingWindows()) {
      expect(win.start).to.be.instanceOf(Date);
      expect(win.stop).to.be.instanceOf(Date);
      expect(win.stop.getTime()).to.be.greaterThan(win.start.getTime());
    }
  });

  it('window duration does not exceed requested duration', () => {
    const dur = 6 * 60 * 1000;
    for (const win of excerpt.slidingWindows(dur, 2 * 60 * 1000)) {
      expect(win.duration).to.be.at.most(dur + 1000); // allow 1s rounding
    }
  });
});

// ---------------------------------------------------------------------------
// withTrackUnwrapped unit tests
// ---------------------------------------------------------------------------
describe('Flight.withTrackUnwrapped', () => {
  const excerpt = flight.between(
    new Date('2018-05-30T15:40:00Z'),
    new Date('2018-05-30T16:10:00Z')
  );

  it('adds track_unwrapped column', () => {
    const enriched = excerpt.withTrackUnwrapped();
    const rows = enriched.data.objects() as Array<Record<string, unknown>>;
    expect(rows[0]).to.have.property('track_unwrapped');
  });

  it('first track_unwrapped equals first track', () => {
    const enriched = excerpt.withTrackUnwrapped();
    const rows = enriched.data.objects() as Array<Record<string, unknown>>;
    const first = rows[0];
    expect(first['track_unwrapped']).to.be.closeTo(
      first['track'] as number,
      1e-9
    );
  });
});

// ---------------------------------------------------------------------------
// holdingPattern integration test
// ---------------------------------------------------------------------------
describe('Flight.holdingPattern', () => {
  // Known holding: ~15:43:52Z → ~15:53:51Z
  const knownStart = new Date('2018-05-30T15:45:00Z');
  const knownStop = new Date('2018-05-30T15:50:00Z');

  let holds: FlightType[];

  before(async function () {
    // This runs ONNX inference for every sliding window — allow up to 60s.
    this.timeout(60_000);
    holds = [];
    for await (const hp of flight.holdingPattern()) {
      holds.push(hp);
    }
  });

  it('detects at least one holding pattern', () => {
    expect(holds.length).to.be.greaterThan(0);
  });

  it('detected segment overlaps the known 15:45–15:50 window', () => {
    const overlaps = holds.some(
      (hp) => hp.start <= knownStop && hp.stop >= knownStart
    );
    expect(overlaps, 'no segment overlaps 15:45–15:50').to.be.true;
  });

  it('each holding segment has valid start and stop', () => {
    for (const hp of holds) {
      expect(hp.start).to.be.instanceOf(Date);
      expect(hp.stop).to.be.instanceOf(Date);
      expect(+hp.stop).to.be.greaterThan(+hp.start);
    }
  });

  it('holding segment contains data rows', () => {
    for (const hp of holds) {
      expect(hp.data.numRows()).to.be.greaterThan(0);
    }
  });
});
