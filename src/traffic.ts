import { agg, escape, from, op } from 'arquero';
import * as d3 from 'd3';

import { TableMixin } from './data';
import { Flight } from './flight';
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

  filter = (feature: string) => {
    return new Traffic(this.data.filter(feature));
  };
}

export const Traffic = TableMixin(_Traffic);
export type Traffic = InstanceType<typeof Traffic>;
