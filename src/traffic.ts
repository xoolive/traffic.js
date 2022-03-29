import { Flight } from './flight';
import { TableMixin } from './data';

import Table from 'arquero/dist/types/table/table';

export class _Traffic extends TableMixin(Object) implements Iterable<Flight> {
  data: Table;

  constructor(data: Table) {
    super();
    this.data = data;
  }

  *iterate(threshold = 600) {
    const map = this.data.groupby('icao24').objects({ grouped: true });
    for (const elt of map.values()) {
      const current_id = Flight.from(elt as Object[]) as Flight;
      for (const segment of current_id.split(threshold)) yield segment;
    }
  }

  [Symbol.iterator]() {
    return this.iterate();
  }
}

export const Traffic = TableMixin(_Traffic);
export type Traffic = InstanceType<typeof Traffic>;
