import { agg, escape, op } from 'arquero';

import { from, fromArrayBuffer, fromArrow, fromJSON, fromURL } from './data';
import { make_date, timelike } from './time';

import Table from 'arquero/dist/types/table/table';
import { Op } from 'arquero/dist/types/op/op';
import { Struct } from 'arquero/dist/types/table/transformable';

interface Entry {
  latitude: number;
  longitude: number;
  timestamp: Date;
}

interface RollupObj {
  [key: string]: string | Function | Op;
}

class Flight {
  data: Table;

  constructor(data: Table) {
    this.data = data;
  }

  static from(array: Array<Object>) {
    return new Flight(from(array));
  }
  static fromArrayBuffer(buf: ArrayBuffer) {
    return new Flight(fromArrayBuffer(buf));
  }
  static fromArrow(arrow: Array<Object>) {
    return new Flight(fromArrow(arrow));
  }
  static fromJSON(json_or_str: Array<Object> | Object | string) {
    return new Flight(fromJSON(json_or_str));
  }
  static async fromURL(url: string) {
    return new Flight(await fromURL(url));
  }

  entries = () => Array.from(this.data) as Array<Entry>;

  feature = (spec: RollupObj = {}) =>
    new Object({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: this.entries().map((elt) => [elt.longitude, elt.latitude]),
      },
      properties: this.rollup(spec),
    });

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
    const idxmax = enriched
      .derive({ diff_max: op.max('time_diff') })
      .filter((x: Struct) => x.diff_max === x.time_diff);

    const max_diff = idxmax.get('time_diff');
    const t0 = idxmax.get('timestamp');
    if (max_diff && max_diff > threshold) {
      const f1 = this.before(new Date(t0), true); // better be explicit
      const f2 = this.after(new Date(t0), false); // better be explicit
      for (const segment of f1.split(threshold)) {
        yield segment;
      }
      for (const segment of f2.split(threshold)) {
        yield segment;
      }
    } else {
      yield this as Flight;
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
}

export { Flight };
