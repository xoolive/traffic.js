import { agg, escape, from, op } from 'arquero';
import * as d3 from 'd3';

import { TableMixin } from './table.js';
import { Flight } from './flight.js';
import { ColumnTable } from './types.js';
import { getEnv } from './env.js';

function flightMatchesText(flight: Flight, text: string): boolean {
  const query = text.toUpperCase();
  return (
    flight.callsign.toUpperCase().includes(query) ||
    flight.icao24.toUpperCase().includes(query)
  );
}

export class _Traffic implements Iterable<Flight> {
  [key: string]: unknown;
  data: ColumnTable;
  private _segmentsCache: Flight[] | null = null;

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

  private _segments(): Flight[] {
    if (this._segmentsCache === null) {
      this._segmentsCache = Array.from(this.iterate());
    }
    return this._segmentsCache;
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

  search = (text: string): Flight[] => {
    const query = String(text ?? '').trim();
    if (query.length === 0) {
      return this._segments();
    }
    return this._segments().filter((flight) =>
      flightMatchesText(flight, query)
    );
  };

  get = (code: string): Flight | undefined => {
    const upper = String(code ?? '').toUpperCase();
    return this._segments().find(
      (flight) =>
        flight.callsign.toUpperCase() === upper ||
        flight.icao24.toUpperCase() === upper
    );
  };

  /** Render an Inputs.table() for this traffic's raw data (requires setEnv). */
  table = (): HTMLElement => {
    const { Inputs, html, d3: d3env } = getEnv();
    if (!Inputs) throw new Error('traffic.js: call setEnv({Inputs, html, d3}) before using table()');
    const fmt = (d3env ?? d3).utcFormat('%Y-%m-%d %H:%M:%S');
    return Inputs.table(this.data, {
      columns: ['timestamp', 'icao24', 'callsign', 'latitude', 'longitude',
                'altitude', 'groundspeed', 'track', 'vertical_rate'],
      width: { timestamp: '20%' },
      sort: 'timestamp',
      layout: 'auto',
      format: {
        icao24:    (elt: string) => (html ?? (() => elt))`<code>${elt}</code>`,
        callsign:  (elt: string) => (html ?? (() => elt))`<code>${elt}</code>`,
        timestamp: (elt: Date)   => (html ?? (() => String(elt)))`<code>${fmt(elt)}</code>`,
      },
    });
  };
}

class Traffic extends TableMixin(_Traffic) {
  constructor(data: ColumnTable, time_fmt?: string) {
    super(data, time_fmt);
    return new Proxy(this, {
      get(obj: _Traffic, prop: string | symbol, receiver: unknown): unknown {
        if (typeof prop === 'symbol') {
          return Reflect.get(obj, prop, receiver);
        }
        if (prop in obj) {
          return Reflect.get(obj, prop, receiver);
        }
        return obj.get(prop);
      },
    }) as Traffic;
  }
}

export { Traffic };
export type TrafficInstance = InstanceType<typeof Traffic>;
