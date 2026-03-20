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
  resolve_sid?(name: string): unknown;
  resolve_star?(name: string): unknown;
  resolve_airspace(designator: string): unknown;
  procedures?(): unknown;
  enrichRoute(route: string): RouteSegment[];
}

type GeoJsonGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: Array<[number, number]> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }
  | {
      type: 'MultiPolygon';
      coordinates: Array<Array<Array<[number, number]>>>;
    }
  | null;

type GeoJsonFeature = {
  type: 'Feature';
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
};

function toProperties(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row as Record<string, unknown>;
  }
  return {};
}

function coerceNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toGeometry(
  entity: string,
  row: Record<string, unknown>
): GeoJsonGeometry {
  const lon = coerceNum(row.longitude ?? row.lon ?? row.lng);
  const lat = coerceNum(row.latitude ?? row.lat);

  if (entity === 'airways' || entity === 'procedures') {
    const points = Array.isArray(row.points)
      ? (row.points as Array<Record<string, unknown>>)
      : [];
    const coordinates = points
      .map((p) => {
        const plon = coerceNum(p.longitude ?? p.lon ?? p.lng);
        const plat = coerceNum(p.latitude ?? p.lat);
        return plon == null || plat == null
          ? null
          : ([plon, plat] as [number, number]);
      })
      .filter((v): v is [number, number] => v != null);

    if (coordinates.length >= 2) {
      return { type: 'LineString', coordinates };
    }
  }

  if (lon != null && lat != null) {
    return { type: 'Point', coordinates: [lon, lat] };
  }

  return null;
}

function toGeoJsonFeature(row: unknown, entity: string): GeoJsonFeature {
  const properties = toProperties(row);
  return {
    type: 'Feature',
    geometry: toGeometry(entity, properties),
    properties,
  };
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
  /** AIRAC code in YYCC format (e.g. "2602"). */
  airac?: string;
  /** Date used to infer AIRAC cycle (Date or ISO yyyy-mm-dd). */
  date?: Date | string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

const NASR_BASE_URL = 'https://nfdc.faa.gov/webContent/28DaySub';
const AIRAC_EPOCH_UTC_MS = Date.UTC(1998, 0, 29);
const DAY_MS = 24 * 60 * 60 * 1000;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function utcDate(y: number, m1: number, d: number): Date {
  return new Date(Date.UTC(y, m1 - 1, d));
}

function parseDateInput(input: Date | string): Date {
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) {
      throw new Error('date must be a valid Date');
    }
    return new Date(
      Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate())
    );
  }
  const raw = String(input ?? '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return utcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const dt = new Date(raw);
  if (!Number.isFinite(dt.getTime())) {
    throw new Error(`invalid date: ${raw}`);
  }
  return new Date(
    Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
  );
}

function dayOfYear0Utc(date: Date): number {
  const jan1 = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - jan1) / DAY_MS);
}

function airacYearEpochUtc(year: number): Date {
  const beg = Date.UTC(year, 0, 1);
  const extraDays = mod(Math.floor((beg - AIRAC_EPOCH_UTC_MS) / DAY_MS), 28);
  return new Date(beg - (extraDays - 28) * DAY_MS);
}

export function airacCodeFromDate(input: Date | string): string {
  const date = parseDateInput(input);
  const deltaDays = Math.floor((date.getTime() - AIRAC_EPOCH_UTC_MS) / DAY_MS);
  const serial = Math.floor(deltaDays / 28);
  const effective = new Date(AIRAC_EPOCH_UTC_MS + serial * 28 * DAY_MS);
  const ordinal = Math.floor(dayOfYear0Utc(effective) / 28) + 1;
  const yy = effective.getUTCFullYear() % 100;
  return `${String(yy).padStart(2, '0')}${String(ordinal).padStart(2, '0')}`;
}

export function effectiveDateFromAiracCode(airac: string): Date {
  const code = String(airac ?? '').trim();
  if (!/^\d{4}$/.test(code)) {
    throw new Error('airac must be in YYCC format, e.g. 2602');
  }
  const yy = Number(code.slice(0, 2));
  const cycle = Number(code.slice(2, 4));
  if (cycle < 1 || cycle > 14) {
    throw new Error('AIRAC cycle number must be between 01 and 14');
  }
  const year = 2000 + yy;
  const yearEpoch = airacYearEpochUtc(year).getTime();
  const effective = new Date(yearEpoch + (cycle - 1) * 28 * DAY_MS);
  if (airacCodeFromDate(effective) !== code) {
    throw new Error(
      `AIRAC mismatch for calculated start date: ${effective
        .toISOString()
        .slice(0, 10)}`
    );
  }
  return effective;
}

function formatDateYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function nasrZipUrlFromAiracCode(airac: string): string {
  const effective = effectiveDateFromAiracCode(airac);
  return `${NASR_BASE_URL}/28DaySubscription_Effective_${formatDateYmd(
    effective
  )}.zip`;
}

export function nasrZipUrlFromDate(input: Date | string): string {
  const code = airacCodeFromDate(input);
  return nasrZipUrlFromAiracCode(code);
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

  async resolve(query: {
    airport?: string;
    navaid?: string;
    fix?: string;
    airway?: string;
    SID?: string;
    STAR?: string;
    airspace?: string;
  }): Promise<unknown> {
    if (query.SID) {
      if (typeof this._core.resolve_sid !== 'function') {
        return null;
      }
      const row = await Promise.resolve(this._core.resolve_sid(query.SID));
      return row == null ? null : toGeoJsonFeature(row, 'procedures');
    }
    if (query.STAR) {
      if (typeof this._core.resolve_star !== 'function') {
        return null;
      }
      const row = await Promise.resolve(this._core.resolve_star(query.STAR));
      return row == null ? null : toGeoJsonFeature(row, 'procedures');
    }
    if (query.airport) {
      const row = await Promise.resolve(
        this._core.resolve_airport(query.airport)
      );
      return row == null ? null : toGeoJsonFeature(row, 'airports');
    }
    if (query.navaid) {
      const row = await Promise.resolve(
        this._core.resolve_navaid(query.navaid)
      );
      return row == null ? null : toGeoJsonFeature(row, 'navaids');
    }
    if (query.fix) {
      const row = await Promise.resolve(this._core.resolve_fix(query.fix));
      return row == null ? null : toGeoJsonFeature(row, 'fixes');
    }
    if (query.airway) {
      const row = await Promise.resolve(
        this._core.resolve_airway(query.airway)
      );
      return row == null ? null : toGeoJsonFeature(row, 'airways');
    }
    if (query.airspace) {
      const row = await Promise.resolve(
        this._core.resolve_airspace(query.airspace)
      );
      return row == null ? null : toGeoJsonFeature(row, 'airspaces');
    }
    throw new Error(
      'resolve: pass one of airport/navaid/fix/airway/SID/STAR/airspace'
    );
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
        segment_type: seg.segment_type ?? null,
        connector:
          seg.connector ??
          (seg.segment_type === 'dct' ? 'DCT' : seg.name ?? null),
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
  } else if (options.airac) {
    archive = await fetchNasrArchive({
      archiveUrl: nasrZipUrlFromAiracCode(options.airac),
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  } else if (options.date) {
    archive = await fetchNasrArchive({
      archiveUrl: nasrZipUrlFromDate(options.date),
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  } else {
    throw new Error(
      'archive, archiveUrl, airac, or date is required for NASR resolver'
    );
  }

  const core = new wasm.NasrResolver(archive);
  return new NasrResolverJS(core);
}
