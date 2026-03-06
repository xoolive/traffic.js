import * as turf from '@turf/turf';
import type { Feature } from 'geojson';
import { agg, escape, from, op } from 'arquero';
import * as d3 from 'd3';
import { GeoProjection } from 'd3';
import simplify from 'simplify-js';

import { TableMixin } from './table.js';
import { make_date, timelike } from './time.js';
import { ColumnTable, Op, Struct } from './types.js';
import { getEnv } from './env.js';
import { aircraftInfo } from './aircraft.js';

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

  feature = (spec: RollupObj = {}): Feature | undefined => {
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

  compute_xy = (projection: GeoProjection | null = null) => {
    if (projection === null) {
      const lat_min = this.min('latitude');
      const lat_max = this.max('latitude');
      const lon_min = this.min('longitude');
      const lon_max = this.max('longitude');
      projection = d3
        .geoConicConformal()
        .rotate([-(lon_min + lon_max) / 2, -(lat_min + lat_max) / 2])
        .center([(lon_min + lon_max) / 2, (lat_min + lat_max) / 2])
        .parallels([lat_min, lat_max])
        .scale(1)
        .translate([0, 0]);
      const dist_reference = d3.geoDistance(
        [lon_min, lat_min],
        [lon_max, lat_max]
      );
      const x1 = projection([lon_min, lat_min]) as [number, number];
      const x2 = projection([lon_max, lat_max]) as [number, number];
      const dist_euclide = Math.sqrt(
        (x2[0] - x1[0]) ** 2 + (x2[1] - x1[1]) ** 2
      );
      const scale = (6371000 * dist_reference) / dist_euclide;
      projection.scale(scale);
    }
    const data = this.entries()
      .map(
        (e) =>
          new Object({
            xy: (projection as d3.GeoProjection)([e.longitude, e.latitude]),
            ...e,
          })
      )
      .map(
        // @ts-ignore
        (e) => new Object({ x: e.xy[0], y: e.xy[1], ...e })
      );
    return new Flight(from(data));
  };

  simplify = (tolerance: number) => {
    // highQuality=true: use full Ramer-Douglas-Peucker (no radial-distance pre-filter).
    // Without it, simplify-js drops points that are within `tolerance` of the
    // *previous kept point* before the RDP pass — matching Python's behaviour requires
    // the pure RDP mode.
    // @ts-ignore
    const data_simplify = simplify(
      this.compute_xy().entries(),
      tolerance,
      true
    );
    return new Flight(from(data_simplify));
  };

  resample = (
    rate: number | d3.TimeInterval | null = d3.timeSecond.every(1)
  ) => {
    if (rate === null) {
      return this;
    }

    const objects = this.data.objects() as Struct[];
    const t0 = this.min('timestamp') as Date;
    const t1 = this.max('timestamp') as Date;

    let timestamp_range: Date[];

    if (typeof rate === 'number') {
      // Integer mode: n evenly spaced timestamps from start to stop inclusive,
      // matching Python's pd.date_range(start, stop, periods=n) semantics.
      const n = rate;
      const step = (+t1 - +t0) / (n - 1);
      timestamp_range = Array.from(
        { length: n },
        (_, i) => new Date(+t0 + i * step)
      );
    } else {
      // TimeInterval mode: snap to clean interval boundaries via d3.scaleTime().ticks().
      timestamp_range = d3
        .scaleTime()
        .domain([t0, t1])
        .ticks(rate as d3.TimeInterval);
    }

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
      // Advance i so that objects[i] <= t < objects[i+1]
      while (objects[i + 1] && +objects[i + 1].timestamp <= +t) ++i;
      if (i + 1 < objects.length) {
        resampled_array.push(
          interpolate(
            t,
            objects[i] as WithTimestamp,
            objects[i + 1] as WithTimestamp
          )
        );
      } else if (+t === +(objects[i] as WithTimestamp).timestamp) {
        // Exactly at the last point (t === stop) — include it
        resampled_array.push(objects[i]);
      }
    }

    // Return an object in the original class
    return new Flight(from(resampled_array));
  };

  intersects = (feature: Feature) => {
    const flight_feature = this.feature();
    return (
      flight_feature !== undefined &&
      (turf.booleanContains(feature, flight_feature) ||
        turf.booleanCrosses(feature, flight_feature))
    );
  };

  /** Render an Inputs.table() for this flight's data (requires setEnv). */
  table = (): HTMLElement => {
    const { Inputs, html, d3: d3env } = getEnv();
    if (!Inputs)
      throw new Error(
        'traffic.js: call setEnv({Inputs, html, d3}) before using table()'
      );
    const fmt = (d3env ?? d3).utcFormat('%Y-%m-%d %H:%M:%S');
    return Inputs.table(this.data, {
      columns: [
        'timestamp',
        'icao24',
        'callsign',
        'latitude',
        'longitude',
        'altitude',
        'groundspeed',
        'track',
        'vertical_rate',
      ],
      width: { timestamp: '20%' },
      sort: 'timestamp',
      layout: 'auto',
      format: {
        icao24: (elt: string) => (html ?? (() => elt))`<code>${elt}</code>`,
        callsign: (elt: string) => (html ?? (() => elt))`<code>${elt}</code>`,
        timestamp: (elt: Date) =>
          (html ?? (() => String(elt)))`<code>${fmt(elt)}</code>`,
      },
    });
  };

  /**
   * Render a map + metadata card for this flight (requires setEnv).
   * Returns a Promise<HTMLElement> with `.value = this` so `viewof` works in Observable.
   * Aircraft info (flag, registration) is looked up asynchronously via rs1090-wasm.
   */
  view = async (
    options: { simplify?: number; graticule?: number } = {}
  ): Promise<HTMLElement> => {
    const { html, d3: d3env, Plot } = getEnv();
    if (!html || !Plot)
      throw new Error(
        'traffic.js: call setEnv({html, d3, Plot}) before using view()'
      );
    const d3e = d3env ?? d3;

    const { graticule = 0 } = options;
    const width = 300;
    const feat = this.feature({}) as any;

    const minlat = this.min('latitude');
    const maxlat = this.max('latitude');
    const minlon = this.min('longitude');
    const maxlon = this.max('longitude');

    const projection = (d3e as any)
      .geoAzimuthalEqualArea()
      .rotate([-(minlon + maxlon) / 2, -(minlat + maxlat) / 2])
      .translate([width / 2, width / 2])
      .fitExtent(
        [
          [0, 0],
          [width, width],
        ],
        feat
      )
      .clipExtent([
        [0, 0],
        [width, width],
      ]);

    const marks: unknown[] = [Plot.geo(feat, { stroke: '#66cc99' })];
    if (graticule) {
      marks.push(
        Plot.geo((d3e as any).geoGraticule().step([graticule, graticule])(), {
          strokeWidth: 0.25,
        })
      );
    }
    const map = Plot.plot({ width, height: width, projection, marks });

    const tf = (d3e as any).utcFormat('%Y-%m-%dT%H:%M:%SZ');
    const tdf = (d3e as any).utcFormat('%H hours %M minutes %S seconds');
    const sr = (d3e as any).format('.0f')(
      (d3e as any).mean(
        (d3e as any)
          .pairs(this.data.array('timestamp'))
          .map((pair: [Date, Date]) => +pair[1] - +pair[0])
      ) / 1000
    );

    // Look up aircraft info — fails silently if rs1090-wasm not available
    const info = await aircraftInfo(this.icao24);

    // Build aircraft node as a real DOM span — htl doesn't support
    // { innerHTML } in data position; inserting a node is always safe.
    const aircraftNode = document.createElement('span');
    if (info) {
      // Format: <code>484506</code> · 🇫🇷 F-ABCD (A320)
      const flag = info.flag ?? '';
      const reg = info.registration ?? '';
      const type = info.typecode ? ` (${info.typecode})` : '';
      const mid = [flag, reg].filter(Boolean).join(' ');
      aircraftNode.innerHTML =
        `<code>${this.icao24}</code>` +
        (mid ? ` · ${mid}${type}` : type ? ` · ${type}` : '');
    } else {
      aircraftNode.innerHTML = `<code>${this.icao24}</code>`;
    }

    const el = html`<div>
      <h4>Flight</h4>
      <ul>
        <li><b>callsign:</b> <code>${this.callsign}</code></li>
        <li><b>aircraft:</b> ${aircraftNode}</li>
        <li><b>start:</b> <code>${tf(this.start)}</code></li>
        <li><b>stop:</b> <code>${tf(this.stop)}</code></li>
        <li>
          <b>duration:</b> ${tdf(this.stop.getTime() - this.start.getTime())}
        </li>
        <li><b>sampling rate:</b> ${sr} second(s)</li>
      </ul>
      ${map}
    </div>` as HTMLElement & { value: unknown };
    el.value = this;
    return el;
  };
}

export const Flight = TableMixin(_Flight);
export type Flight = InstanceType<typeof Flight>;
