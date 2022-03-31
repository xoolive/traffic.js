import { from } from 'arquero';
import { escape } from 'arquero';
import * as d3 from 'd3';

import { Flight } from './flight';
import { TableMixin } from './data';
import { ColumnTable } from './types';

export class _Traffic implements Iterable<Flight> {
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

  *iterate(threshold = 600) {
    const map = this.data.groupby('icao24').objects({ grouped: true });
    for (const elt of map.values()) {
      const current_id = new Flight(from(elt as Object[]));
      for (const segment of current_id.split(threshold)) yield segment;
    }
  }

  [Symbol.iterator]() {
    return this.iterate();
  }
}

export const Traffic = TableMixin(_Traffic);
export type Traffic = InstanceType<typeof Traffic>;
