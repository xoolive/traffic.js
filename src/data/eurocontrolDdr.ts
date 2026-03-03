type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

import { loadThrustWasmModule } from './thrustWasm.js';

export interface EurocontrolDdrCore {
  airports(): unknown[] | Promise<unknown[]>;
  fixes(): unknown[] | Promise<unknown[]>;
  navaids(): unknown[] | Promise<unknown[]>;
  airways(): unknown[] | Promise<unknown[]>;
  resolve_airport(code: string): unknown | null | Promise<unknown | null>;
  resolve_fix(code: string): unknown | null | Promise<unknown | null>;
  resolve_navaid(code: string): unknown | null | Promise<unknown | null>;
  resolve_airway(name: string): unknown | null | Promise<unknown | null>;
}

interface ThrustWasmModule {
  default?: (input?: unknown) => Promise<unknown>;
  EurocontrolResolver: {
    fromDdrArchive(archive: Uint8Array): EurocontrolDdrCore;
  };
}

type CoreFactory = (archive: Uint8Array) => EurocontrolDdrCore;

type EntityName = 'airports' | 'fixes' | 'navaids' | 'airways';

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

function toGeoJsonFeature(row: unknown, entity: EntityName): GeoJsonFeature {
  const baseProperties = toProperties(row);
  const properties =
    entity === 'airways'
      ? compactAirwayProperties(baseProperties)
      : baseProperties;
  const geometry =
    entity === 'airways'
      ? toLineStringGeometry(baseProperties)
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

  airports: EurocontrolResolverCollection<unknown>;
  fixes: EurocontrolResolverCollection<unknown>;
  navaids: EurocontrolResolverCollection<unknown>;
  airways: EurocontrolResolverCollection<unknown>;

  constructor(core: EurocontrolDdrCore) {
    this._core = core;

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

    this.fixes = makeCollection({
      name: 'fixes',
      listFn: async () =>
        Promise.resolve(this._core.fixes()).then((rows) =>
          rows.map((row) => toGeoJsonFeature(row, 'fixes'))
        ),
      resolveFn: async (code: string) =>
        Promise.resolve(this._core.resolve_fix(code)).then((row) =>
          row == null ? null : toGeoJsonFeature(row, 'fixes')
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
          rows.map((row) => toGeoJsonFeature(row, 'airways'))
        ),
      resolveFn: async (code: string) =>
        Promise.resolve(this._core.resolve_airway(code)).then((row) =>
          row == null ? null : toGeoJsonFeature(row, 'airways')
        ),
    });
  }

  async resolve(query: {
    airport?: string;
    navaid?: string;
    fix?: string;
    airway?: string;
  }): Promise<unknown> {
    if (query.airport) {
      return this.airports.get(query.airport);
    }
    if (query.navaid) {
      return this.navaids.get(query.navaid);
    }
    if (query.fix) {
      return this.fixes.get(query.fix);
    }
    if (query.airway) {
      return this.airways.get(query.airway);
    }
    throw new Error('resolve: pass one of airport/navaid/fix/airway');
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
