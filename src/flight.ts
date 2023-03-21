import * as turf from '@turf/turf';
import { agg, escape, from, op } from 'arquero';
import * as d3 from 'd3';

import { TableMixin } from './data';
import { make_date, timelike } from './time';
import { ColumnTable, Op, Struct } from './types';

interface Entry {
  latitude: number;
  longitude: number;
  timestamp: Date;
}

interface RollupObj {
  [key: string]: string | Function | Op;
}

interface WithTimestamp {
  timestamp: Date;
}

export class _Flight {
  data: ColumnTable;

  constructor(data: ColumnTable, time_fmt?: string) {
    this.data = data;
    if (time_fmt) {
      this.data = this.data.derive({
        // @ts-ignore
        timestamp: escape((d) => d3.timeParse(time_fmt)(d.timestamp)),
      });
    }
  }

  entries = () => Array.from(this.data) as Array<Entry>;

  feature = (spec: RollupObj = {}): turf.Feature | undefined => {
    const coords = this.entries()
      .filter((elt) => elt.longitude !== null)
      .map((elt) => [elt.longitude, elt.latitude]);
    return coords.length > 0
      ? turf.lineString(coords, this.rollup(spec))
      : undefined;
  };

  rollup = (spec: RollupObj = {}) => {
    return Object.fromEntries(
      Object.entries(spec).map((key_values) => {
        const [key, value] = key_values;
        if (typeof value === 'string') {
          // case: "start" (property) or "anything" for flight.anything()
          const result: any = (this as { [key: string]: any })[value];
          if (typeof result === 'function') {
            return [key, result()];
          } else {
            return [key, result];
          }
        }
        if (typeof value === 'function') {
          // case: (flight) => flight.anything()
          return [key, value(this)];
        }
        if (value?.toObject()?.func) {
          // case: aq.op
          const obj = this.data.rollup({ value }).object();
          return [key, (obj as { value: any }).value];
        }
        return [key, undefined];
      })
    );
  };

  *split(threshold = 600): Generator<Flight> {
    const enriched = this.data.orderby('timestamp').derive({
      time_diff: (d: Struct) => (d.timestamp - op.lag(d.timestamp)) / 1000 || 0,
    });
    const idx_max = enriched
      .derive({ diff_max: op.max('time_diff') })
      .filter((x: Struct) => x.diff_max === x.time_diff);

    const max_diff = idx_max.get('time_diff');
    const t0 = idx_max.get('timestamp');
    if (max_diff && max_diff > threshold) {
      const f1 = this.before(t0, true); // better be explicit
      const f2 = this.after(t0, false); // better be explicit
      for (const segment of f1.split(threshold)) {
        yield segment;
      }
      for (const segment of f2.split(threshold)) {
        yield segment;
      }
    } else {
      yield this;
    }
  }

  min = (feature: string) => agg(this.data, op.min(feature));
  max = (feature: string) => agg(this.data, op.max(feature));
  mean = (feature: string) => agg(this.data, op.mean(feature));
  median = (feature: string) => agg(this.data, op.median(feature));
  stdev = (feature: string) => agg(this.data, op.stdev(feature));

  get start(): Date {
    return this.min('timestamp');
  }
  get stop(): Date {
    return this.max('timestamp');
  }
  get duration(): number {
    return this.stop.getTime() - this.start.getTime();
  }
  get callsign(): string {
    return this.max('callsign');
  }
  get icao24(): string {
    return this.max('icao24');
  }

  before = (timestamp: timelike, strict: boolean = true) => {
    const compare = strict
      ? escape((elt: Entry) => elt.timestamp < make_date(timestamp))
      : escape((elt: Entry) => elt.timestamp <= make_date(timestamp));
    return new Flight(this.data.filter(compare));
  };
  after = (timestamp: timelike, strict: boolean = false) => {
    const compare = strict
      ? escape((elt: Entry) => elt.timestamp > make_date(timestamp))
      : escape((elt: Entry) => elt.timestamp >= make_date(timestamp));
    return new Flight(this.data.filter(compare));
  };
  between = (t1: timelike, t2: timelike) => this.after(t1).before(t2);

  filter = (feature: string) => {
    return new Flight(this.data.filter(feature));
  };

  resample = (rate = d3.timeSecond.every(1)) => {
    if (rate === null) {
      return this;
    }
    const objects = this.data.objects();

    // Construct the timescale
    const timestamp_range = d3
      .scaleTime() // 👉 scaleUtc??
      .domain([this.min('timestamp'), this.max('timestamp')])
      .ticks(rate);

    const interpolate = (ts: Date, a: WithTimestamp, b: WithTimestamp) => {
      const t = (+ts - +a.timestamp) / (+b.timestamp - +a.timestamp);
      return d3.interpolate(
        Object.assign({}, a, { timestamp: +a.timestamp }),
        b
      )(t);
    };

    const resampled_array = new Array();
    let i = 0;
    for (const t of timestamp_range) {
      // Identify timestamps with values before and after the timestamp
      while (objects[i].timestamp < t && objects[i + 1]?.timestamp <= t) ++i;
      if (objects[i + 1])
        resampled_array.push(
          interpolate(
            t,
            objects[i] as WithTimestamp,
            objects[i + 1] as WithTimestamp
          )
        );
    }

    // Return an object in the original class
    return new Flight(from(resampled_array)); // aq.from
  };

  intersects = (feature: turf.Feature) => {
    const flight_feature = this.feature();
    return (
      flight_feature !== undefined &&
      (turf.booleanContains(feature, flight_feature) ||
        turf.booleanCrosses(feature, flight_feature))
    );
  };
}

export const Flight = TableMixin(_Flight);
export type Flight = InstanceType<typeof Flight>;
