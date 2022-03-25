import { agg, escape, op } from 'arquero';

import { from, fromArrayBuffer, fromArrow, fromJSON, fromURL } from './data';
import { make_date, timelike } from './time';

import Table from 'arquero/dist/types/table/table';

interface Entry {
  latitude: number;
  longitude: number;
  timestamp: Date;
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

  feature = () =>
    new Object({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: (Array(...this.data) as Array<Entry>).map((elt) => [
          elt.longitude,
          elt.latitude,
        ]),
      },
    });

  min = (feature: string) => agg(this.data, op.min(feature));
  max = (feature: string) => agg(this.data, op.max(feature));

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
