type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

import { loadThrustWasmModule } from './thrustWasm.js';
import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';

export const FAA_ARCGIS_DATASETS = {
  airports: 'e747ab91a11045e8b3f8a3efd093d3b5_0',
  atsRoutes: 'acf64966af5f48a1a40fdbcb31238ba7_0',
  designatedPoints: '861043a88ff4486c97c3789e7dcdccc6_0',
  navaidComponents: 'c9254c171b6741d3a5e494860761443a_0',
  airspaceBoundary: '67885972e4e940b2aa6d74024901c561_0',
  classAirspace: 'c6a62360338e408cb1512366ad61559e_0',
  specialUseAirspace: 'dd0d1b726e504137ab3c41b21835d05b_0',
  routeAirspace: '8bf861bb9b414f4ea9f0ff2ca0f1a851_0',
  prohibitedAirspace: '354ee0c77484461198ebf728a2fca50c_0',
} as const;

type EntityName = 'airports' | 'fixes' | 'navaids' | 'airways' | 'airspaces';

function normalizeAirwayName(value: string): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const ENTITY_DATASETS: Record<EntityName, string[]> = {
  airports: [FAA_ARCGIS_DATASETS.airports],
  fixes: [FAA_ARCGIS_DATASETS.designatedPoints],
  navaids: [
    FAA_ARCGIS_DATASETS.designatedPoints,
    FAA_ARCGIS_DATASETS.navaidComponents,
  ],
  airways: [FAA_ARCGIS_DATASETS.atsRoutes],
  airspaces: [
    FAA_ARCGIS_DATASETS.airspaceBoundary,
    FAA_ARCGIS_DATASETS.classAirspace,
    FAA_ARCGIS_DATASETS.specialUseAirspace,
    FAA_ARCGIS_DATASETS.routeAirspace,
    FAA_ARCGIS_DATASETS.prohibitedAirspace,
  ],
};

const DATASET_FIELDS: Record<string, string[]> = {
  [FAA_ARCGIS_DATASETS.airports]: [
    'IDENT',
    'ICAO_ID',
    'LATITUDE',
    'LONGITUDE',
    'NAME',
    'STATE',
    'US_AREA',
  ],
  [FAA_ARCGIS_DATASETS.designatedPoints]: [
    'IDENT',
    'LATITUDE',
    'LONGITUDE',
    'TYPE_CODE',
    'REMARKS',
    'US_AREA',
    'STATE',
  ],
  [FAA_ARCGIS_DATASETS.navaidComponents]: [
    'IDENT',
    'LATITUDE',
    'LONGITUDE',
    'NAV_TYPE',
    'TYPE_CODE',
    'FREQUENCY',
    'NAME',
    'US_AREA',
  ],
  [FAA_ARCGIS_DATASETS.atsRoutes]: ['IDENT'],
  [FAA_ARCGIS_DATASETS.airspaceBoundary]: [
    'IDENT',
    'NAME',
    'TYPE_CODE',
    'LOWER_VAL',
    'UPPER_VAL',
  ],
  [FAA_ARCGIS_DATASETS.classAirspace]: [
    'IDENT',
    'NAME',
    'TYPE_CODE',
    'LOWER_VAL',
    'UPPER_VAL',
  ],
  [FAA_ARCGIS_DATASETS.specialUseAirspace]: [
    'IDENT',
    'NAME',
    'TYPE_CODE',
    'LOWER_VAL',
    'UPPER_VAL',
  ],
  [FAA_ARCGIS_DATASETS.routeAirspace]: [
    'IDENT',
    'NAME',
    'TYPE_CODE',
    'LOWER_VAL',
    'UPPER_VAL',
  ],
  [FAA_ARCGIS_DATASETS.prohibitedAirspace]: [
    'IDENT',
    'NAME',
    'TYPE_CODE',
    'LOWER_VAL',
    'UPPER_VAL',
  ],
};

export interface FaaArcgisDatasetProgress {
  datasetId: string;
  index: number;
  totalDatasets: number;
  loaded: number;
  total: number;
  ratio: number | null;
}

export interface FaaArcgisDatasetLoaded {
  datasetId: string;
  index: number;
  totalDatasets: number;
  featureCount: number;
}

export interface FaaArcgisCore {
  airports(): unknown[] | Promise<unknown[]>;
  fixes(): unknown[] | Promise<unknown[]>;
  navaids(): unknown[] | Promise<unknown[]>;
  airways(): unknown[] | Promise<unknown[]>;
  airspaces(): unknown[] | Promise<unknown[]>;
  resolve_airport(code: string): unknown | null | Promise<unknown | null>;
  resolve_fix(code: string): unknown | null | Promise<unknown | null>;
  resolve_navaid(code: string): unknown | null | Promise<unknown | null>;
  resolve_airway(name: string): unknown | null | Promise<unknown | null>;
  resolve_airspace(name: string): unknown | null | Promise<unknown | null>;
}

interface ThrustWasmModule {
  default?: (input?: unknown) => Promise<unknown>;
  FaaArcgisResolver: new (collections: unknown[]) => FaaArcgisCore;
}

type CoreFactory = (collections: unknown[]) => FaaArcgisCore;

export type ResolverCollection<T> = {
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
  const latitude = Number(properties['latitude'] ?? properties['LATITUDE']);
  const longitude = Number(properties['longitude'] ?? properties['LONGITUDE']);
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
  const routeClass = String(
    out['route_class'] ?? out['ROUTE_TYPE'] ?? ''
  ).trim();
  if (routeClass.length > 0) {
    out['route_class'] = routeClass.toUpperCase();
  }

  return out;
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
}): ResolverCollection<T> {
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
  }) as ResolverCollection<T>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compactFeatureProperties(
  properties: unknown,
  datasetId: string
): Record<string, unknown> {
  const fields = DATASET_FIELDS[datasetId] ?? [];
  const source = (properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) {
      out[field] = source[field];
    }
  }
  return out;
}

function compactCollectionForWasm(
  collection: unknown,
  datasetId: string
): unknown {
  const source = collection as { type?: string; features?: unknown[] };
  const features = Array.isArray(source.features) ? source.features : [];

  const keepGeometry =
    datasetId === FAA_ARCGIS_DATASETS.atsRoutes ||
    datasetId === FAA_ARCGIS_DATASETS.airspaceBoundary ||
    datasetId === FAA_ARCGIS_DATASETS.classAirspace ||
    datasetId === FAA_ARCGIS_DATASETS.specialUseAirspace ||
    datasetId === FAA_ARCGIS_DATASETS.routeAirspace ||
    datasetId === FAA_ARCGIS_DATASETS.prohibitedAirspace;

  const compactedFeatures = features.map((feature) => {
    const typed = feature as { properties?: unknown; geometry?: unknown };
    return {
      type: 'Feature',
      properties: compactFeatureProperties(typed.properties, datasetId),
      geometry: keepGeometry ? typed.geometry ?? null : null,
    };
  });

  return {
    type: source.type ?? 'FeatureCollection',
    features: compactedFeatures,
  };
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
    return (collections) =>
      new options.thrustModule!.FaaArcgisResolver(collections);
  }
  return null;
}

export function faaArcgisDatasetUrl(datasetId: string): string {
  return `https://opendata.arcgis.com/datasets/${datasetId}.geojson`;
}

async function fetchCollection(
  datasetId: string,
  options: {
    fetchImpl: FetchLike;
    signal?: AbortSignal;
    onProgress?: (
      progress: Omit<
        FaaArcgisDatasetProgress,
        'datasetId' | 'index' | 'totalDatasets'
      >
    ) => void;
  }
): Promise<unknown> {
  const response = await options.fetchImpl(faaArcgisDatasetUrl(datasetId), {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch FAA ArcGIS dataset ${datasetId}: ${response.status} ${response.statusText}`
    );
  }
  if (!response.body) {
    return response.json();
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
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function fetchFaaArcgisCollections(
  options: {
    datasetIds?: string[];
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    onDatasetProgress?: (progress: FaaArcgisDatasetProgress) => void;
    onCollection?: (loaded: FaaArcgisDatasetLoaded) => void;
  } = {}
): Promise<unknown[]> {
  const fetchImpl = ensureFetch(options.fetchImpl);
  const datasetIds = options.datasetIds ?? Object.values(FAA_ARCGIS_DATASETS);

  const collections: unknown[] = [];
  for (let index = 0; index < datasetIds.length; index += 1) {
    const datasetId = datasetIds[index];
    const collection = await fetchCollection(datasetId, {
      fetchImpl,
      signal: options.signal,
      onProgress: ({ loaded, total, ratio }) =>
        options.onDatasetProgress?.({
          datasetId,
          index,
          totalDatasets: datasetIds.length,
          loaded,
          total,
          ratio,
        }),
    });
    const features = (collection as { features?: unknown[] }).features;
    options.onCollection?.({
      datasetId,
      index,
      totalDatasets: datasetIds.length,
      featureCount: Array.isArray(features) ? features.length : 0,
    });
    collections.push(collection);
  }

  return collections;
}

export class FaaArcgisResolverJS {
  private _core: FaaArcgisCore | null;
  private _coreFactory: CoreFactory | null;
  private _externalCore: boolean;
  private _fetchImpl: FetchLike;
  private _signal: AbortSignal | undefined;
  private _onDatasetProgress:
    | ((progress: FaaArcgisDatasetProgress) => void)
    | undefined;
  private _onCollection: ((loaded: FaaArcgisDatasetLoaded) => void) | undefined;
  private _collectionsByDatasetId: Map<string, unknown>;
  private _datasetFetchPromiseById: Map<string, Promise<void>>;
  private _entityCoreByName: Map<EntityName, FaaArcgisCore>;
  private _entityCorePromiseByName: Map<EntityName, Promise<FaaArcgisCore>>;
  private _airwayQuickCache: Map<string, unknown | null>;
  private _enabledDatasetIds: string[];

  airports: ResolverCollection<unknown>;
  fixes: ResolverCollection<unknown>;
  navaids: ResolverCollection<unknown>;
  airways: ResolverCollection<unknown>;
  airspaces: ResolverCollection<unknown>;

  constructor(
    options: {
      core?: FaaArcgisCore | null;
      coreFactory?: CoreFactory | null;
      externalCore?: boolean;
      enabledDatasetIds?: string[];
      fetchImpl?: FetchLike;
      signal?: AbortSignal;
      onDatasetProgress?: (progress: FaaArcgisDatasetProgress) => void;
      onCollection?: (loaded: FaaArcgisDatasetLoaded) => void;
    } = {}
  ) {
    this._core = options.core ?? null;
    this._coreFactory = options.coreFactory ?? null;
    this._externalCore = options.externalCore ?? false;
    this._fetchImpl = ensureFetch(options.fetchImpl);
    this._signal = options.signal;
    this._onDatasetProgress = options.onDatasetProgress;
    this._onCollection = options.onCollection;
    this._collectionsByDatasetId = new Map();
    this._datasetFetchPromiseById = new Map();
    this._entityCoreByName = new Map();
    this._entityCorePromiseByName = new Map();
    this._airwayQuickCache = new Map();
    this._enabledDatasetIds = unique(
      options.enabledDatasetIds?.length
        ? options.enabledDatasetIds
        : Object.values(FAA_ARCGIS_DATASETS)
    );

    this.airports = makeCollection({
      name: 'airports',
      listFn: async () => {
        const core = await this._ensureEntityCore('airports');
        return this._coreListFrom(core, 'airports');
      },
      resolveFn: async (code: string) => {
        const core = await this._ensureEntityCore('airports');
        return this._coreResolveFrom(core, 'airport', code);
      },
    });

    this.fixes = makeCollection({
      name: 'fixes',
      listFn: async () => {
        const core = await this._ensureEntityCore('fixes');
        return this._coreListFrom(core, 'fixes');
      },
      resolveFn: async (code: string) => {
        const core = await this._ensureEntityCore('fixes');
        return this._coreResolveFrom(core, 'fix', code);
      },
    });

    this.navaids = makeCollection({
      name: 'navaids',
      listFn: async () => {
        const core = await this._ensureEntityCore('navaids');
        return this._coreListFrom(core, 'navaids');
      },
      resolveFn: async (code: string) => {
        const core = await this._ensureEntityCore('navaids');
        return this._coreResolveFrom(core, 'navaid', code);
      },
    });

    this.airways = makeCollection({
      name: 'airways',
      listFn: async () => {
        const core = await this._ensureEntityCore('airways');
        return this._coreListFrom(core, 'airways');
      },
      resolveFn: async (code: string) => {
        const quick = await this._resolveAirwayFast(code);
        if (quick) {
          return quick;
        }
        const core = await this._ensureEntityCore('airways');
        return this._coreResolveFrom(core, 'airway', code);
      },
    });

    this.airspaces = makeCollection({
      name: 'airspaces',
      listFn: async () => {
        const core = await this._ensureEntityCore('airspaces');
        const rows = await this._coreListFrom(core, 'airspaces');
        return rows.map((row) =>
          toGeoJsonFeature(row, 'airspaces', { includeGeometry: false })
        );
      },
      resolveFn: async (code: string) => {
        const core = await this._ensureEntityCore('airspaces');
        return this._coreResolveFrom(core, 'airspace', code);
      },
    });
  }

  static async fromArcgis(
    options: CreateFaaArcgisResolverOptions = {}
  ): Promise<FaaArcgisResolverJS> {
    return createFaaArcgisResolver(options);
  }

  async preloadAll(): Promise<FaaArcgisResolverJS> {
    await this._ensureEntity(null);
    await this._ensureEntityCore('airports');
    await this._ensureEntityCore('fixes');
    await this._ensureEntityCore('navaids');
    await this._ensureEntityCore('airways');
    await this._ensureEntityCore('airspaces');
    return this;
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
      return this.fixes.get(query.fix);
    }
    if (query.airway) {
      return this.airways.get(query.airway);
    }
    if (query.airspace) {
      return this.airspaces.get(query.airspace);
    }
    throw new Error('resolve: pass one of airport/navaid/fix/airway/airspace');
  }

  private _datasetsFor(entity: EntityName | null): string[] {
    if (entity === null) {
      return this._enabledDatasetIds;
    }
    const required = ENTITY_DATASETS[entity] ?? [];
    return required.filter((datasetId) =>
      this._enabledDatasetIds.includes(datasetId)
    );
  }

  private _requireCoreFactory(): CoreFactory {
    if (!this._coreFactory) {
      throw new Error(
        'A coreFactory or thrustModule is required when no prebuilt core is provided'
      );
    }
    return this._coreFactory;
  }

  private async _ensureEntityCore(entity: EntityName): Promise<FaaArcgisCore> {
    if (this._externalCore && this._core) {
      return this._core;
    }

    const existing = this._entityCoreByName.get(entity);
    if (existing) {
      return existing;
    }

    const inFlight = this._entityCorePromiseByName.get(entity);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      await this._ensureEntity(entity);
      const factory = this._requireCoreFactory();
      const collections = this._datasetsFor(entity)
        .filter((datasetId) => this._collectionsByDatasetId.has(datasetId))
        .map((datasetId) => {
          const raw = this._collectionsByDatasetId.get(datasetId) as unknown;
          return compactCollectionForWasm(raw, datasetId);
        });

      const core = factory(collections);
      this._entityCoreByName.set(entity, core);
      return core;
    })();

    this._entityCorePromiseByName.set(entity, promise);
    try {
      return await promise;
    } finally {
      this._entityCorePromiseByName.delete(entity);
    }
  }

  private async _ensureEntity(entity: EntityName | null): Promise<void> {
    if (this._externalCore && this._core) {
      return;
    }

    const wanted = this._datasetsFor(entity);
    const allReady = wanted.every((datasetId) =>
      this._collectionsByDatasetId.has(datasetId)
    );
    if (this._core && allReady) {
      return;
    }

    let changed = this._core === null;
    for (let index = 0; index < wanted.length; index += 1) {
      const datasetId = wanted[index];
      if (this._collectionsByDatasetId.has(datasetId)) {
        continue;
      }

      let fetchPromise = this._datasetFetchPromiseById.get(datasetId);
      if (!fetchPromise) {
        fetchPromise = (async () => {
          const collection = await fetchCollection(datasetId, {
            fetchImpl: this._fetchImpl,
            signal: this._signal,
            onProgress: ({ loaded, total, ratio }) =>
              this._onDatasetProgress?.({
                datasetId,
                index,
                totalDatasets: wanted.length,
                loaded,
                total,
                ratio,
              }),
          });

          this._collectionsByDatasetId.set(datasetId, collection);
          const features = (collection as { features?: unknown[] }).features;
          this._onCollection?.({
            datasetId,
            index,
            totalDatasets: wanted.length,
            featureCount: Array.isArray(features) ? features.length : 0,
          });
        })();
        this._datasetFetchPromiseById.set(datasetId, fetchPromise);
      }

      try {
        await fetchPromise;
      } finally {
        this._datasetFetchPromiseById.delete(datasetId);
      }
      changed = true;
    }

    if (changed) {
      this._entityCoreByName.clear();
      this._entityCorePromiseByName.clear();
      this._airwayQuickCache.clear();
      this._core = null;
    }
  }

  private async _resolveAirwayFast(code: string): Promise<unknown | null> {
    const key = normalizeAirwayName(code);
    if (key.length === 0) {
      return null;
    }
    if (this._airwayQuickCache.has(key)) {
      return this._airwayQuickCache.get(key) ?? null;
    }

    await this._ensureEntity('airways');
    const collection = this._collectionsByDatasetId.get(
      FAA_ARCGIS_DATASETS.atsRoutes
    ) as { features?: unknown[] } | undefined;
    const features = Array.isArray(collection?.features)
      ? collection!.features
      : [];

    const pointIdToIdent = new Map<string, string>();
    for (const loaded of this._collectionsByDatasetId.values()) {
      const loadedFeatures = (loaded as { features?: unknown[] }).features;
      if (!Array.isArray(loadedFeatures)) {
        continue;
      }
      for (const f of loadedFeatures) {
        const p =
          (f as { properties?: Record<string, unknown> }).properties ?? {};
        const gid = String(p.GLOBAL_ID ?? '').toUpperCase();
        const ident = String(p.IDENT ?? '').toUpperCase();
        if (gid && ident) {
          pointIdToIdent.set(gid, ident);
        }
      }
    }

    const points: Array<{
      code: string;
      raw_code: string;
      kind: string;
      latitude: number;
      longitude: number;
    }> = [];
    let routeClass: string | undefined;

    for (const feature of features) {
      const typed = feature as {
        properties?: Record<string, unknown>;
        geometry?: { type?: string; coordinates?: unknown[] };
      };
      const ident = String(typed.properties?.IDENT ?? '').toUpperCase();
      if (normalizeAirwayName(ident) !== key) {
        continue;
      }

      const featureRouteClass = String(
        typed.properties?.ROUTE_TYPE ?? typed.properties?.route_class ?? ''
      )
        .trim()
        .toUpperCase();
      if (!routeClass && featureRouteClass.length > 0) {
        routeClass = featureRouteClass;
      }

      if (
        typed.geometry?.type !== 'LineString' ||
        !Array.isArray(typed.geometry.coordinates)
      ) {
        continue;
      }

      const startId = String(typed.properties?.STARTPT_ID ?? '').toUpperCase();
      const endId = String(typed.properties?.ENDPT_ID ?? '').toUpperCase();
      const startCode = pointIdToIdent.get(startId) ?? startId;
      const endCode = pointIdToIdent.get(endId) ?? endId;
      const total = typed.geometry.coordinates.length;

      for (let idx = 0; idx < total; idx += 1) {
        const coordinate = typed.geometry.coordinates[idx];
        const pair = coordinate as unknown[];
        const lon = Number(pair?.[0]);
        const lat = Number(pair?.[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          continue;
        }

        const rawCode =
          idx === 0 ? startCode : idx + 1 === total ? endCode : '';
        const pointCode = rawCode.length > 0 ? rawCode : `${lat},${lon}`;

        const last = points[points.length - 1];
        if (
          last &&
          last.latitude === lat &&
          last.longitude === lon &&
          (last.raw_code || '') === rawCode
        ) {
          continue;
        }
        points.push({
          code: pointCode,
          raw_code: rawCode,
          kind: 'point',
          latitude: lat,
          longitude: lon,
        });
      }
    }

    if (points.length === 0) {
      this._airwayQuickCache.set(key, null);
      return null;
    }

    const record = {
      name: String(code).toUpperCase(),
      source: 'faa_arcgis',
      route_class: routeClass,
      points,
    };
    const feature = toGeoJsonFeature(record, 'airways');
    this._airwayQuickCache.set(key, feature);
    return feature;
  }

  private async _coreListFrom(
    core: FaaArcgisCore,
    method: EntityName
  ): Promise<unknown[]> {
    const value = core[method]();
    const rows = await Promise.resolve(value);
    if (method === 'airspaces') {
      return rows;
    }
    return rows.map((row) => toGeoJsonFeature(row, method));
  }

  private async _coreResolveFrom(
    core: FaaArcgisCore,
    kind: 'airport' | 'fix' | 'navaid' | 'airway' | 'airspace',
    code: string
  ): Promise<unknown | null> {
    const resolverMethod =
      core[
        `resolve_${kind}` as
          | 'resolve_airport'
          | 'resolve_fix'
          | 'resolve_navaid'
          | 'resolve_airway'
          | 'resolve_airspace'
      ];
    const value = resolverMethod.call(core, code);
    const row = await Promise.resolve(value);
    if (row == null) {
      return null;
    }
    if (kind === 'airspace') {
      return row;
    }
    const entity: EntityName =
      kind === 'airport'
        ? 'airports'
        : kind === 'fix'
        ? 'fixes'
        : kind === 'navaid'
        ? 'navaids'
        : 'airways';
    return toGeoJsonFeature(row, entity);
  }
}

export interface CreateFaaArcgisResolverOptions {
  wasmModule?: unknown;
  thrustModule?: ThrustWasmModule;
  thrustModuleUrl?: string;
  autoLoadThrustModule?: boolean;
  coreFactory?: CoreFactory;
  core?: FaaArcgisCore;
  collections?: unknown[];
  datasetIds?: string[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  eager?: boolean;
  onDatasetProgress?: (progress: FaaArcgisDatasetProgress) => void;
  onCollection?: (loaded: FaaArcgisDatasetLoaded) => void;
}

async function maybeLoadThrustModule(
  options: CreateFaaArcgisResolverOptions
): Promise<ThrustWasmModule | undefined> {
  return loadThrustWasmModule<ThrustWasmModule>(options);
}

export async function createFaaArcgisResolver(
  options: CreateFaaArcgisResolverOptions = {}
): Promise<FaaArcgisResolverJS> {
  if (options.core) {
    return new FaaArcgisResolverJS({
      core: options.core,
      externalCore: true,
      enabledDatasetIds: options.datasetIds,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onDatasetProgress: options.onDatasetProgress,
      onCollection: options.onCollection,
    });
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

  if (options.collections) {
    if (!coreFactory) {
      throw new Error(
        'coreFactory or thrustModule is required when passing collections'
      );
    }
    return new FaaArcgisResolverJS({
      core: coreFactory(options.collections),
      coreFactory,
      externalCore: true,
      enabledDatasetIds: options.datasetIds,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onDatasetProgress: options.onDatasetProgress,
      onCollection: options.onCollection,
    });
  }

  if (!coreFactory) {
    throw new Error(
      'thrustModule or coreFactory is required to build FAA ArcGIS resolver'
    );
  }

  const resolver = new FaaArcgisResolverJS({
    core: null,
    coreFactory,
    enabledDatasetIds: options.datasetIds,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    onDatasetProgress: options.onDatasetProgress,
    onCollection: options.onCollection,
  });

  if (options.eager) {
    await resolver.preloadAll();
  }
  return resolver;
}
