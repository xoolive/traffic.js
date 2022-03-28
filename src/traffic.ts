import { from, fromArrayBuffer, fromArrow, fromJSON, fromURL } from './data';

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

  *iterate(threshold = 600) {
    const map = this.data.groupby('icao24').objects({ grouped: true });
    for (const elt of map.values()) {
      for (const segment of Flight.from(elt as Object[]).split(threshold))
        yield segment;
    }
  }

  [Symbol.iterator]() {
    return this.iterate();
  }
}

export { Traffic };
