import { agg, escape, op } from 'arquero';

import { from, fromArrayBuffer, fromArrow, fromJSON, fromURL } from './data';
import { make_date, timelike } from './time';

import Table from 'arquero/dist/types/table/table';
import { Flight } from './flight';

class Traffic implements Iterable<Flight> {
  data: Table;

  constructor(data: Table) {
    this.data = data;
  }

  static from(array: Array<Object>) {
    return new Traffic(from(array));
  }
  static fromArrayBuffer(buf: ArrayBuffer) {
    return new Traffic(fromArrayBuffer(buf));
  }
  static fromArrow(arrow: Array<Object>) {
    return new Traffic(fromArrow(arrow));
  }
  static fromJSON(json_or_str: Array<Object> | Object | string) {
    return new Traffic(fromJSON(json_or_str));
  }
  static async fromURL(url: string) {
    return new Traffic(await fromURL(url));
  }

  *iterate() {
    const map = this.data.groupby('icao24').objects({ grouped: true });
    for (const elt of map.values()) {
      yield Flight.from(elt as Object[]);
    }
  }

  [Symbol.iterator]() {
    return this.iterate();
  }
}

export { Traffic };
