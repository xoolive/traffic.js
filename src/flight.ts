import { agg, escape, op } from 'arquero';

import { from, fromArrayBuffer, fromArrow, fromJSON, fromURL } from './data';
import { make_date, timelike } from './time';

import Table from 'arquero/dist/types/table/table';
import { Op } from 'arquero/dist/types/op/op';

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

  before = (timestamp: timelike, { strict: boolean } = { strict: true }) =>
    new Flight(
      this.data.filter(
        escape((elt: Entry) => elt.timestamp < make_date(timestamp))
      )
    );
  after = (timestamp: timelike, { strict: boolean } = { strict: false }) =>
    new Flight(
      this.data.filter(
        escape((elt: Entry) => elt.timestamp >= make_date(timestamp))
      )
    );
  between = (t1: timelike, t2: timelike) => this.after(t1).before(t2);
}

export { Flight };
