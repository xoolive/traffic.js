import { loadThrustWasmModule } from './thrustWasm.js';
import type { LoadThrustWasmModuleOptions } from './thrustWasm.js';
import type { RouteSegment, RouteSegmentFeature } from './field15.js';

// ---------------------------------------------------------------------------
// WASM module interface
// ---------------------------------------------------------------------------

/** @internal */
interface ThrustWasmModule {
  default?: (input?: unknown) => Promise<unknown>;
  NasrResolver: new (zipBytes: Uint8Array) => NasrResolverCore;
}

/** @internal */
interface NasrResolverCore {
  airports(): unknown;
  navaids(): unknown;
  fixes(): unknown;
  airways(): unknown;
  airspaces(): unknown;
  resolve_airport(code: string): unknown;
  resolve_navaid(code: string): unknown;
  resolve_fix(code: string): unknown;
  resolve_airway(name: string): unknown;
  resolve_airspace(designator: string): unknown;
  enrichRoute(route: string): RouteSegment[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface CreateNasrResolverOptions
  extends LoadThrustWasmModuleOptions<ThrustWasmModule> {
  /** Pre-loaded NASR ZIP bytes. Either this or `nasrUrl` is required. */
  archive?: Uint8Array | ArrayBuffer;
  /** URL to fetch the NASR ZIP from if `archive` is not provided. */
  archiveUrl?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// NasrResolverJS
// ---------------------------------------------------------------------------

/**
 * JavaScript wrapper around the WASM `NasrResolver`.
 *
 * Exposes FAA NASR navigation data (airports, navaids, fixes, airways, airspaces)
 * and field 15 route enrichment via `enrichRoute` / `enrichRouteAsGeoJSON`.
 */
export class NasrResolverJS {
  private _core: NasrResolverCore;

  constructor(core: NasrResolverCore) {
    this._core = core;
  }

  // -------------------------------------------------------------------------
  // Route enrichment (field 15)
  // -------------------------------------------------------------------------

  /**
   * Parse and resolve a raw ICAO field 15 route string into geographic segments
   * using FAA NASR navigation data.
   *
   * Returns `{ start, end, name? }` objects where `start`/`end` are
   * `{ latitude, longitude, name?, kind? }`.
   */
  enrichRoute(route: string): RouteSegment[] {
    return this._core.enrichRoute(route);
  }

  /**
   * Resolve a field 15 route and return a GeoJSON FeatureCollection of
   * LineString features (one per segment).
   */
  enrichRouteAsGeoJSON(route: string): {
    type: 'FeatureCollection';
    features: RouteSegmentFeature[];
  } {
    const segments = this.enrichRoute(route);
    const features: RouteSegmentFeature[] = segments.map((seg) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [seg.start.longitude, seg.start.latitude],
          [seg.end.longitude, seg.end.latitude],
        ],
      },
      properties: {
        name: seg.name ?? null,
        start_name: seg.start.name ?? null,
        end_name: seg.end.name ?? null,
        start_kind: seg.start.kind ?? null,
        end_kind: seg.end.kind ?? null,
      },
    }));
    return { type: 'FeatureCollection', features };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

async function fetchNasrArchive(options: {
  archiveUrl: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<Uint8Array> {
  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(options.archiveUrl, {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch NASR archive: ${response.status} ${response.statusText}`
    );
  }
  if (!options.onProgress) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    options.onProgress(loaded, total);
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * Create a `NasrResolverJS` from a NASR ZIP archive.
 *
 * @example
 * ```js
 * // In Observable:
 * nasrResolver = createNasrResolver({ archiveUrl: "https://your-server/nasr.zip" })
 * ```
 */
export async function createNasrResolver(
  options: CreateNasrResolverOptions = {}
): Promise<NasrResolverJS> {
  const wasm = await loadThrustWasmModule<ThrustWasmModule>(options);
  if (!wasm) {
    throw new Error(
      'thrust-wasm module could not be loaded. ' +
        'Pass thrustModule or thrustModuleUrl in options, or ensure thrust-wasm is installed.'
    );
  }

  if (wasm.default) {
    await wasm.default();
  }

  let archive: Uint8Array;
  if (options.archive) {
    archive =
      options.archive instanceof Uint8Array
        ? options.archive
        : new Uint8Array(options.archive);
  } else if (options.archiveUrl) {
    archive = await fetchNasrArchive({
      archiveUrl: options.archiveUrl,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  } else {
    throw new Error('archive or archiveUrl is required for NASR resolver');
  }

  const core = new wasm.NasrResolver(archive);
  return new NasrResolverJS(core);
}
