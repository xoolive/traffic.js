import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';

/** @internal */
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

import { loadThrustWasmModule } from './thrustWasm.js';

export interface EurocontrolDdrCore {
  airports(): unknown[] | Promise<unknown[]>;
  navaids(): unknown[] | Promise<unknown[]>;
  airways(): unknown[] | Promise<unknown[]>;
  airspaces?(): unknown[] | Promise<unknown[]>;
  resolve_airport(code: string): unknown | null | Promise<unknown | null>;
  resolve_navaid(code: string): unknown | null | Promise<unknown | null>;
  resolve_airway(name: string): unknown | null | Promise<unknown | null>;
  resolve_airspace?(
    designator: string
  ): unknown | null | Promise<unknown | null>;
  /** Available when backed by a thrust-wasm EurocontrolResolver (v0.3+). */
  enrichRoute?(route: string): RouteSegment[];
}

// RouteSegment and related types are imported from field15.ts when available,
// but duplicated here as a local alias to avoid a circular dependency.
type RouteSegment = import('./field15.js').RouteSegment;
type RouteSegmentFeature = import('./field15.js').RouteSegmentFeature;

/** @internal */
interface ThrustWasmModule {
  default?: (input?: unknown) => Promise<unknown>;
  EurocontrolResolver: {
    fromDdrArchive(archive: Uint8Array): EurocontrolDdrCore;
  };
}

/** @internal */
type CoreFactory = (archive: Uint8Array) => EurocontrolDdrCore;

type EntityName = 'airports' | 'navaids' | 'airways' | 'airspaces';

const DDR_AIRWAY_SPLIT_GAP_NM = 1000;

export type EurocontrolResolverCollection<T> = {
  data(): Promise<T[]>;
  get(code: string): Promise<T | undefined>;
  search(text: string): Promise<T[]>;
} & Record<string, unknown>;

type CollectionTarget<T> = {
  _name: string;
  _listFn: () => Promise<T[]>;
  _resolveFn: (code: string) => Promise<T | null>;
  _cache: T[] | null;
  data(): Promise<T[]>;
  get(code: string): Promise<T | undefined>;
  search(text: string): Promise<T[]>;
};

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
  return { value: row };
}

function toPointGeometry(properties: Record<string, unknown>): GeoJsonGeometry {
  const latitude = Number(properties['latitude']);
  const longitude = Number(properties['longitude']);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { type: 'Point', coordinates: [longitude, latitude] };
  }
  return null;
}

function toLineStringGeometry(
  properties: Record<string, unknown>
): GeoJsonGeometry {
  const points = Array.isArray(properties['points'])
    ? (properties['points'] as Array<Record<string, unknown>>)
    : [];
  const coordinates = points
    .map((point) => {
      const latitude = Number(point?.latitude);
      const longitude = Number(point?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }
      return [longitude, latitude] as [number, number];
    })
    .filter((value): value is [number, number] => Array.isArray(value));
  if (coordinates.length >= 2) {
    return { type: 'LineString', coordinates };
  }
  return null;
}

function toPolygonRing(raw: unknown): Array<[number, number]> {
  const points = Array.isArray(raw) ? raw : [];
  const ring = points
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) {
        return null;
      }
      const longitude = Number(pair[0]);
      const latitude = Number(pair[1]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }
      return [longitude, latitude] as [number, number];
    })
    .filter((value): value is [number, number] => Array.isArray(value));

  if (ring.length < 3) {
    return [];
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function toPolygonGeometry(
  properties: Record<string, unknown>
): GeoJsonGeometry {
  const layers = Array.isArray(properties['layers'])
    ? (properties['layers'] as Array<Record<string, unknown>>)
    : [];
  if (layers.length > 0) {
    const features = layers
      .map((layer) => layerGeometryToFeature(layer?.geometry))
      .filter(
        (value): value is Feature<Polygon | MultiPolygon> => value !== null
      );
    const merged = unionPolygons(features);
    if (!merged) {
      const fallback = combineAsMultiPolygon(features);
      if (fallback) {
        return fallback;
      }
    }
    if (merged) {
      if (merged.geometry.type === 'Polygon') {
        return {
          type: 'Polygon',
          coordinates: merged.geometry.coordinates as Array<
            Array<[number, number]>
          >,
        };
      }
      return {
        type: 'MultiPolygon',
        coordinates: merged.geometry.coordinates as Array<
          Array<Array<[number, number]>>
        >,
      };
    }
  }

  const features = layers
    .map((layer) => toPolygonRing(layer?.coordinates))
    .filter((ring) => ring.length >= 4)
    .map((ring) => turf.polygon([ring]) as Feature<Polygon | MultiPolygon>);

  if (features.length > 1) {
    const merged = unionPolygons(features);
    if (!merged) {
      const fallback = combineAsMultiPolygon(features);
      if (fallback) {
        return fallback;
      }
      return null;
    }

    if (merged.geometry.type === 'Polygon') {
      return {
        type: 'Polygon',
        coordinates: merged.geometry.coordinates as Array<
          Array<[number, number]>
        >,
      };
    }
    return {
      type: 'MultiPolygon',
      coordinates: merged.geometry.coordinates as Array<
        Array<Array<[number, number]>>
      >,
    };
  }

  if (features.length === 1) {
    return {
      type: 'Polygon',
      coordinates: features[0].geometry.coordinates as Array<
        Array<[number, number]>
      >,
    };
  }

  const fallbackRing = toPolygonRing(properties['coordinates']);
  if (fallbackRing.length >= 4) {
    return { type: 'Polygon', coordinates: [fallbackRing] };
  }
  return null;
}

function compactAirwayProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...properties };
  const points = Array.isArray(properties['points'])
    ? (properties['points'] as Array<Record<string, unknown>>)
    : [];

  const pointCodes = points
    .map((point) => {
      const raw = String(point?.raw_code ?? '').toUpperCase();
      const code = String(point?.code ?? '').toUpperCase();
      return raw.length > 0 ? raw : code;
    })
    .filter((value) => value.length > 0);

  out['points'] = pointCodes;

  return out;
}

function unionPolygons(
  features: Array<Feature<Polygon | MultiPolygon>>
): Feature<Polygon | MultiPolygon> | null {
  if (features.length === 0) {
    return null;
  }
  let merged = features[0];
  const failed: Array<Feature<Polygon | MultiPolygon>> = [];
  for (let idx = 1; idx < features.length; idx += 1) {
    try {
      const maybeUnion = turf.union(
        turf.featureCollection([merged, features[idx]])
      ) as Feature<Polygon | MultiPolygon> | null;
      if (maybeUnion) {
        merged = maybeUnion;
      } else {
        failed.push(features[idx]);
      }
    } catch {
      failed.push(features[idx]);
    }
  }
  if (failed.length === 0) {
    return merged;
  }
  // Some pairs failed to union topologically — fold them in as extra rings.
  const fallbackGeom = combineAsMultiPolygon([merged, ...failed]);
  if (!fallbackGeom) {
    return merged;
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: fallbackGeom,
  } as Feature<MultiPolygon>;
}

function geometriesEqual(
  left: Feature<Polygon | MultiPolygon>,
  right: Feature<Polygon | MultiPolygon>
): boolean {
  try {
    return turf.booleanEqual(left, right);
  } catch {
    return false;
  }
}

function layerGeometryToFeature(
  geometry: unknown
): Feature<Polygon | MultiPolygon> | null {
  if (!geometry || typeof geometry !== 'object') {
    return null;
  }
  const typed = geometry as { type?: unknown; coordinates?: unknown };
  if (typed.type === 'Polygon' && Array.isArray(typed.coordinates)) {
    return turf.polygon(typed.coordinates as Position[][]) as Feature<
      Polygon | MultiPolygon
    >;
  }
  if (typed.type === 'MultiPolygon' && Array.isArray(typed.coordinates)) {
    return turf.multiPolygon(typed.coordinates as Position[][][]) as Feature<
      Polygon | MultiPolygon
    >;
  }
  return null;
}

function combineAsMultiPolygon(
  features: Array<Feature<Polygon | MultiPolygon>>
): GeoJsonGeometry {
  if (features.length === 0) {
    return null;
  }
  const coordinates: Array<Array<Array<[number, number]>>> = [];
  for (const feature of features) {
    if (feature.geometry.type === 'Polygon') {
      coordinates.push(
        feature.geometry.coordinates as Array<Array<[number, number]>>
      );
    } else {
      coordinates.push(
        ...(feature.geometry.coordinates as Array<
          Array<Array<[number, number]>>
        >)
      );
    }
  }
  return { type: 'MultiPolygon', coordinates };
}

function compactAirspaceProperties(
  properties: Record<string, unknown>,
  includeGeometry = true
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...properties };
  const layers = Array.isArray(properties['layers'])
    ? (properties['layers'] as Array<Record<string, unknown>>)
    : [];
  if (layers.length === 0) {
    return out;
  }

  // When geometry is not needed, skip all turf work and return raw layers as-is.
  if (!includeGeometry) {
    out['raw_layers'] = layers;
    out['layers'] = layers.map(({ lower, upper }) => ({ lower, upper }));
    return out;
  }

  const parsedLayers = layers
    .map((layer) => {
      const ring = toPolygonRing(layer?.coordinates);
      if (ring.length < 4) {
        return null;
      }
      const lowerRaw = Number(layer?.lower);
      const upperRaw = Number(layer?.upper);
      const lower = Number.isNaN(lowerRaw) ? null : lowerRaw;
      const upper = Number.isNaN(upperRaw) ? null : upperRaw;
      return {
        lower,
        upper,
        feature: turf.polygon([ring]) as Feature<Polygon | MultiPolygon>,
      };
    })
    .filter(
      (
        value
      ): value is {
        lower: number | null;
        upper: number | null;
        feature: Feature<Polygon | MultiPolygon>;
      } => value !== null
    );

  const altitudes = Array.from(
    new Set(
      parsedLayers.flatMap((layer) =>
        [layer.lower, layer.upper].filter(
          (value): value is number => typeof value === 'number'
        )
      )
    )
  ).sort((a, b) => a - b);

  const mergedLayers: Array<Record<string, unknown>> = [];
  if (altitudes.length >= 2) {
    for (let idx = 0; idx < altitudes.length - 1; idx += 1) {
      const lower = altitudes[idx];
      const upper = altitudes[idx + 1];
      const covering = parsedLayers
        .filter(
          (layer) =>
            layer.lower !== null &&
            layer.upper !== null &&
            layer.lower <= lower &&
            layer.upper >= upper
        )
        .map((layer) => layer.feature);
      const merged = unionPolygons(covering);
      if (!merged) {
        const fallback = combineAsMultiPolygon(covering);
        if (!fallback) {
          continue;
        }
        mergedLayers.push({ lower, upper, geometry: fallback });
        continue;
      }

      const previous = mergedLayers[mergedLayers.length - 1] as
        | { lower?: number; upper?: number; geometry?: unknown }
        | undefined;
      const previousGeometry = previous
        ? layerGeometryToFeature(previous.geometry)
        : null;
      if (previousGeometry && geometriesEqual(previousGeometry, merged)) {
        if (previous) {
          previous.upper = upper;
        }
      } else {
        mergedLayers.push({ lower, upper, geometry: merged.geometry });
      }
    }
  } else {
    const merged = unionPolygons(parsedLayers.map((layer) => layer.feature));
    if (merged) {
      mergedLayers.push({
        lower: null,
        upper: null,
        geometry: merged.geometry,
      });
    }
  }

  out['raw_layers'] = layers;
  out['layers'] = mergedLayers.length > 0 ? mergedLayers : layers;
  return out;
}

function greatCircleDistanceNm(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number
): number {
  const radiusNm = 3440.065;
  const phi1 = (latitude1 * Math.PI) / 180;
  const phi2 = (latitude2 * Math.PI) / 180;
  const deltaPhi = ((latitude2 - latitude1) * Math.PI) / 180;
  const deltaLambda = ((longitude2 - longitude1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * radiusNm * Math.asin(Math.min(1, Math.sqrt(a)));
}

function splitAirwayRecord(row: unknown): Array<Record<string, unknown>> {
  const properties = toProperties(row);
  const points = Array.isArray(properties['points'])
    ? (properties['points'] as Array<Record<string, unknown>>)
    : [];
  if (points.length <= 1) {
    return [properties];
  }

  const variants: Array<Array<Record<string, unknown>>> = [[points[0]]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];

    const previousLat = Number(previous?.latitude);
    const previousLon = Number(previous?.longitude);
    const currentLat = Number(current?.latitude);
    const currentLon = Number(current?.longitude);
    const hasCoords =
      Number.isFinite(previousLat) &&
      Number.isFinite(previousLon) &&
      Number.isFinite(currentLat) &&
      Number.isFinite(currentLon);
    const splitHere =
      hasCoords &&
      greatCircleDistanceNm(previousLat, previousLon, currentLat, currentLon) >=
        DDR_AIRWAY_SPLIT_GAP_NM;

    if (splitHere) {
      variants.push([current]);
    } else {
      variants[variants.length - 1].push(current);
    }
  }

  const filtered = variants.filter((variant) => variant.length >= 2);
  if (filtered.length <= 1) {
    return [properties];
  }

  return filtered.map((variant, index) => ({
    ...properties,
    points: variant,
    airway_variant: index + 1,
    airway_variant_count: filtered.length,
  }));
}

function toGeoJsonFeature(
  row: unknown,
  entity: EntityName,
  options?: { includeGeometry?: boolean }
): GeoJsonFeature {
  const includeGeometry = options?.includeGeometry ?? true;
  const baseProperties = toProperties(row);
  const properties =
    entity === 'airways'
      ? compactAirwayProperties(baseProperties)
      : entity === 'airspaces'
      ? compactAirspaceProperties(baseProperties, includeGeometry)
      : baseProperties;
  const geometry = !includeGeometry
    ? null
    : entity === 'airways'
    ? toLineStringGeometry(baseProperties)
    : entity === 'airspaces'
    ? toPolygonGeometry(properties)
    : toPointGeometry(properties);
  return {
    type: 'Feature',
    geometry,
    properties,
  };
}

function makeCollection<T>({
  name,
  listFn,
  resolveFn,
}: {
  name: string;
  listFn: () => Promise<T[]>;
  resolveFn: (code: string) => Promise<T | null>;
}): EurocontrolResolverCollection<T> {
  const target: CollectionTarget<T> = {
    _name: name,
    _listFn: listFn,
    _resolveFn: resolveFn,
    _cache: null,

    async data() {
      if (this._cache === null) {
        this._cache = await this._listFn();
      }
      return this._cache;
    },

    async get(code: string) {
      const out = await this._resolveFn(String(code ?? ''));
      return (out ?? undefined) as T | undefined;
    },

    async search(text: string) {
      const query = String(text ?? '').toUpperCase();
      const rows = await this.data();
      return rows.filter((row) =>
        Object.values(
          row &&
            typeof row === 'object' &&
            'properties' in (row as Record<string, unknown>)
            ? ((row as Record<string, unknown>)['properties'] as Record<
                string,
                unknown
              >)
            : (row as Record<string, unknown>)
        ).some((value) =>
          String(value ?? '')
            .toUpperCase()
            .includes(query)
        )
      );
    },
  };

  return new Proxy(target, {
    get(obj: CollectionTarget<T>, prop: string | symbol, receiver: unknown) {
      if (typeof prop === 'symbol') {
        return Reflect.get(obj, prop, receiver);
      }
      if (prop in obj) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as Function).bind(obj)
          : value;
      }
      return obj.get(prop);
    },
  }) as EurocontrolResolverCollection<T>;
}

function ensureFetch(fetchImpl?: FetchLike): FetchLike {
  if (typeof fetchImpl === 'function') {
    return fetchImpl;
  }
  if (typeof fetch === 'function') {
    return fetch.bind(globalThis);
  }
  throw new Error('fetch implementation is required');
}

function makeCoreFactory(options: {
  thrustModule?: ThrustWasmModule;
  coreFactory?: CoreFactory;
}): CoreFactory | null {
  if (options.coreFactory) {
    return options.coreFactory;
  }
  if (options.thrustModule) {
    return (archive) =>
      options.thrustModule!.EurocontrolResolver.fromDdrArchive(archive);
  }
  return null;
}

export interface EurocontrolDdrArchiveProgress {
  loaded: number;
  total: number;
  ratio: number | null;
}

export async function fetchEurocontrolDdrArchive(options: {
  archiveUrl: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (progress: EurocontrolDdrArchiveProgress) => void;
}): Promise<Uint8Array> {
  const fetchImpl = ensureFetch(options.fetchImpl);
  const response = await fetchImpl(options.archiveUrl, {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch EUROCONTROL DDR archive: ${response.status} ${response.statusText}`
    );
  }
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const total = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      options.onProgress?.({
        loaded,
        total,
        ratio: total > 0 ? loaded / total : null,
      });
    }
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class EurocontrolDdrResolverJS {
  private _core: EurocontrolDdrCore;
  private _warnedAmbiguousAirways: Set<string>;
  private _warnedMissingAirspaceApi: boolean;

  airports: EurocontrolResolverCollection<unknown>;
  navaids: EurocontrolResolverCollection<unknown>;
  airways: EurocontrolResolverCollection<unknown>;
  airspaces: EurocontrolResolverCollection<unknown>;

  constructor(core: EurocontrolDdrCore) {
    this._core = core;
    this._warnedAmbiguousAirways = new Set();
    this._warnedMissingAirspaceApi = false;

    this.airports = makeCollection({
      name: 'airports',
      listFn: async () =>
        Promise.resolve(this._core.airports()).then((rows) =>
          rows.map((row) => toGeoJsonFeature(row, 'airports'))
        ),
      resolveFn: async (code: string) =>
        Promise.resolve(this._core.resolve_airport(code)).then((row) =>
          row == null ? null : toGeoJsonFeature(row, 'airports')
        ),
    });

    this.navaids = makeCollection({
      name: 'navaids',
      listFn: async () =>
        Promise.resolve(this._core.navaids()).then((rows) =>
          rows.map((row) => toGeoJsonFeature(row, 'navaids'))
        ),
      resolveFn: async (code: string) =>
        Promise.resolve(this._core.resolve_navaid(code)).then((row) =>
          row == null ? null : toGeoJsonFeature(row, 'navaids')
        ),
    });

    this.airways = makeCollection({
      name: 'airways',
      listFn: async () =>
        Promise.resolve(this._core.airways()).then((rows) =>
          rows
            .flatMap((row) => splitAirwayRecord(row))
            .map((row) => toGeoJsonFeature(row, 'airways'))
        ),
      resolveFn: async (code: string) =>
        Promise.resolve(this._core.resolve_airway(code)).then((row) =>
          row == null
            ? null
            : (() => {
                const variants = splitAirwayRecord(row);
                if (variants.length > 1) {
                  const airwayName = String(code ?? '').toUpperCase();
                  if (!this._warnedAmbiguousAirways.has(airwayName)) {
                    this._warnedAmbiguousAirways.add(airwayName);
                    console.warn(
                      `[traffic.js] airway '${airwayName}' has ${variants.length} variants; bracket lookup returns the first one. Use airways.data() and filter by properties.name to access all variants.`
                    );
                  }
                }
                return toGeoJsonFeature(variants[0] ?? row, 'airways');
              })()
        ),
    });

    this.airspaces = makeCollection({
      name: 'airspaces',
      listFn: async () =>
        (typeof this._core.airspaces === 'function'
          ? Promise.resolve(this._core.airspaces())
          : Promise.resolve([])
        ).then((rows) =>
          rows.map((row) =>
            toGeoJsonFeature(row, 'airspaces', { includeGeometry: false })
          )
        ),
      resolveFn: async (code: string) =>
        (typeof this._core.resolve_airspace === 'function'
          ? Promise.resolve(this._core.resolve_airspace(code))
          : Promise.resolve(null)
        ).then((row) =>
          row == null ? null : toGeoJsonFeature(row, 'airspaces')
        ),
    });
  }

  async resolve(query: {
    airport?: string;
    navaid?: string;
    fix?: string;
    airway?: string;
    airspace?: string;
  }): Promise<unknown> {
    if (query.airport) {
      return this.airports.get(query.airport);
    }
    if (query.navaid) {
      return this.navaids.get(query.navaid);
    }
    if (query.fix) {
      return this.navaids.get(query.fix);
    }
    if (query.airway) {
      return this.airways.get(query.airway);
    }
    if (query.airspace) {
      if (
        typeof this._core.airspaces !== 'function' ||
        typeof this._core.resolve_airspace !== 'function'
      ) {
        if (!this._warnedMissingAirspaceApi) {
          this._warnedMissingAirspaceApi = true;
          console.warn(
            '[traffic.js] EUROCONTROL airspace API is unavailable in the loaded thrust-wasm build; upgrade thrust-wasm to use resolve({ airspace }).'
          );
        }
      }
      return this.airspaces.get(query.airspace);
    }
    throw new Error('resolve: pass one of airport/navaid/fix/airway/airspace');
  }

  /**
   * Parse and resolve a raw ICAO field 15 route string into geographic segments.
   *
   * Returns an array of `{ start, end, name? }` objects. Each point has
   * `{ latitude, longitude, name?, kind? }`.
   *
   * Requires thrust-wasm ≥ 0.3 (the `enrichRoute` method on EurocontrolResolver).
   * Throws if the loaded WASM build does not expose `enrichRoute`.
   */
  enrichRoute(route: string): RouteSegment[] {
    if (typeof this._core.enrichRoute !== 'function') {
      throw new Error(
        '[traffic.js] enrichRoute is unavailable in the loaded thrust-wasm build. ' +
          'Upgrade thrust-wasm to a version that exposes EurocontrolResolver.enrichRoute.'
      );
    }
    return this._core.enrichRoute(route);
  }

  /**
   * Parse and resolve a field 15 route string, returning a GeoJSON FeatureCollection
   * of LineString features — one per route segment.
   *
   * Each feature's `properties` contains:
   * - `name` — airway name or `null` for DCT legs
   * - `start_name`, `end_name` — waypoint names
   * - `start_kind`, `end_kind` — point kind (`"airport"`, `"navaid"`, `"fix"`, …)
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

export interface CreateEurocontrolDdrResolverOptions {
  wasmModule?: unknown;
  thrustModule?: ThrustWasmModule;
  thrustModuleUrl?: string;
  autoLoadThrustModule?: boolean;
  coreFactory?: CoreFactory;
  core?: EurocontrolDdrCore;
  archive?: Uint8Array | ArrayBuffer;
  archiveUrl?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onArchiveProgress?: (progress: EurocontrolDdrArchiveProgress) => void;
}

function ensureArchiveBytes(archive: Uint8Array | ArrayBuffer): Uint8Array {
  return archive instanceof Uint8Array ? archive : new Uint8Array(archive);
}

async function maybeLoadThrustModule(
  options: CreateEurocontrolDdrResolverOptions
): Promise<ThrustWasmModule | undefined> {
  return loadThrustWasmModule<ThrustWasmModule>(options);
}

export async function createEurocontrolDdrResolver(
  options: CreateEurocontrolDdrResolverOptions = {}
): Promise<EurocontrolDdrResolverJS> {
  if (options.core) {
    return new EurocontrolDdrResolverJS(options.core);
  }

  const shouldLoadThrustModule =
    !options.coreFactory ||
    !!options.thrustModule ||
    !!options.thrustModuleUrl ||
    options.autoLoadThrustModule === true;

  const thrustModule = shouldLoadThrustModule
    ? await maybeLoadThrustModule(options)
    : undefined;

  if (thrustModule?.default) {
    if (typeof options.wasmModule === 'undefined') {
      await thrustModule.default();
    } else {
      await thrustModule.default({ module_or_path: options.wasmModule });
    }
  }

  const coreFactory = makeCoreFactory({
    thrustModule,
    coreFactory: options.coreFactory,
  });

  if (!coreFactory) {
    throw new Error(
      'thrustModule or coreFactory is required to build EUROCONTROL DDR resolver'
    );
  }

  let archive: Uint8Array | undefined;
  if (options.archive) {
    archive = ensureArchiveBytes(options.archive);
  } else if (options.archiveUrl) {
    archive = await fetchEurocontrolDdrArchive({
      archiveUrl: options.archiveUrl,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onProgress: options.onArchiveProgress,
    });
  }

  if (!archive) {
    throw new Error(
      'archive or archiveUrl is required for EUROCONTROL DDR resolver'
    );
  }

  return new EurocontrolDdrResolverJS(coreFactory(archive));
}

export const createEuroControlDdrResolver = createEurocontrolDdrResolver;
