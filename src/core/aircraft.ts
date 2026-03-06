/**
 * Lightweight aircraft information via rs1090-wasm.
 *
 * Loads the WASM module lazily on first call (singleton).
 * Works in Observable (web), Node, and browser bundles.
 *
 * Returns { icao24, registration?, country?, flag?, typecode? } or null.
 */

export interface AircraftInfo {
  icao24: string;
  registration?: string;
  country?: string;
  flag?: string;
  typecode?: string;
  category?: string;
}

type Rs1090Module = {
  aircraft_information: (icao24: string, registration?: string) => AircraftInfo;
};

let _rs1090: Rs1090Module | null = null;
let _loading: Promise<Rs1090Module | null> | null = null;

async function loadRs1090(): Promise<Rs1090Module | null> {
  if (_rs1090) return _rs1090;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      // Observable / browser: load via unpkg web target
      if (typeof window !== 'undefined') {
        // @ts-ignore — dynamic URL import, resolved at runtime in browser/Observable
        const mod = await import(/* @vite-ignore */ 'https://unpkg.com/rs1090-wasm/web/rs1090_wasm.js') as any;
        await mod.default('https://unpkg.com/rs1090-wasm/web/rs1090_wasm_bg.wasm');
        if (typeof mod.run === 'function') mod.run();
        _rs1090 = mod as Rs1090Module;
      } else {
        // Node.js: use the nodejs subpackage
        // @ts-ignore — optional peer dep, may not be installed
        const mod = await import('rs1090-wasm/nodejs') as any;
        _rs1090 = mod as Rs1090Module;
      }
      return _rs1090;
    } catch {
      // rs1090-wasm not available — silently degrade
      return null;
    }
  })();

  return _loading;
}

/** Lookup aircraft information for a given icao24 hex address. Returns null if unavailable. */
export async function aircraftInfo(icao24: string, registration?: string): Promise<AircraftInfo | null> {
  const mod = await loadRs1090();
  if (!mod) return null;
  try {
    return mod.aircraft_information(icao24, registration) ?? null;
  } catch {
    return null;
  }
}
