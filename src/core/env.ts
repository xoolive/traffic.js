/**
 * Observable environment registry.
 *
 * Call `setEnv({ Inputs, html, d3, Plot })` once after requiring the library
 * in an Observable notebook. After that, `flight.view()`, `flight.table()`,
 * and `traffic.table()` all work with no arguments.
 *
 * Example (Observable cell):
 *   t = require("traffic.js").then(t => { t.setEnv({Inputs, html, d3, Plot}); return t; })
 */

export interface TrafficEnv {
  Inputs?: {
    table: (data: unknown, options?: Record<string, unknown>) => HTMLElement;
  };
  html?: (...args: unknown[]) => HTMLElement;
  d3?: {
    utcFormat: (fmt: string) => (d: Date) => string;
  };
  Plot?: {
    geo: (...args: unknown[]) => unknown;
    plot: (options: Record<string, unknown>) => SVGElement;
  };
}

let _env: TrafficEnv = {};

export function setEnv(env: TrafficEnv): void {
  _env = { ..._env, ...env };
}

export function getEnv(): TrafficEnv {
  return _env;
}
