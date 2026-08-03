import osmtogeojson from 'osmtogeojson/index.js';

type JsonObject = Record<string, unknown>;

export type OsmTagFilter = boolean | string | number | ReadonlyArray<string>;

export interface AirportOsmFetchOptions {
  icao: string;
  tags?: Record<string, OsmTagFilter>;
  endpoint?: string;
  timeoutSeconds?: number;
  fetch?: typeof globalThis.fetch;
  cache?: boolean;
  cacheTtlMs?: number;
  cacheStorage?: 'memory' | 'localStorage' | 'both';
  sanitizeGeometry?: boolean;
  rewindRings?: boolean;
}

export interface OverpassResponse {
  elements?: unknown[];
  [key: string]: unknown;
}

const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_TAGS: Record<string, OsmTagFilter> = { aeroway: true };
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const memoryCache = new Map<
  string,
  { timestamp: number; value: GeoJSON.FeatureCollection }
>();

function toUpperIcao(icao: string): string {
  return String(icao).trim().toUpperCase();
}

function quoteOverpassString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function expandTagClause(key: string, value: OsmTagFilter): string {
  const safeKey = quoteOverpassString(key);
  if (value === true) {
    return `[${safeKey}]`;
  }
  if (typeof value === 'string') {
    return `[${safeKey}=${quoteOverpassString(value)}]`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `[${safeKey}=${value}]`;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return `[${safeKey}]`;
    }
    const regex = normalized
      .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    return `[${safeKey}~${quoteOverpassString(`^(${regex})$`)}]`;
  }
  return `[${safeKey}]`;
}

export function buildAirportOverpassQuery(options: {
  icao: string;
  tags?: Record<string, OsmTagFilter>;
  timeoutSeconds?: number;
}): string {
  const icao = toUpperIcao(options.icao);
  const timeout =
    typeof options.timeoutSeconds === 'number' &&
    Number.isFinite(options.timeoutSeconds)
      ? Math.max(1, Math.floor(options.timeoutSeconds))
      : 60;
  const tags = options.tags ?? DEFAULT_TAGS;

  const tagClauses = Object.entries(tags)
    .map(([key, value]) => expandTagClause(key, value))
    .join('');

  return [
    `[out:json][timeout:${timeout}];`,
    `area["icao"="${icao}"]->.airport;`,
    `(`,
    `  nwr${tagClauses}(area.airport);`,
    `);`,
    `out body;`,
    `>;`,
    `out skel qt;`,
  ].join('\n');
}

export function extractOverpassErrorText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const marker = doc.querySelector('strong');
      const paragraph = marker?.closest('p');
      if (paragraph?.textContent) {
        return paragraph.textContent.replace(/\s+/g, ' ').trim();
      }
      if (doc.body?.textContent) {
        return doc.body.textContent.replace(/\s+/g, ' ').trim();
      }
    } catch {
      // fall back to regex parser below
    }
  }

  const paragraphMatch = html.match(
    /<p>\s*<strong[^>]*>Error<\/strong>:\s*([\s\S]*?)<\/p>/i
  );
  if (paragraphMatch?.[1]) {
    return paragraphMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function sanitizeFeatureCollection(
  input: GeoJSON.FeatureCollection
): GeoJSON.FeatureCollection {
  const isValidLonLat = (lon: number, lat: number): boolean =>
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90;

  const sanitizeGeometry = (
    geometry: GeoJSON.Geometry | null
  ): GeoJSON.Geometry | null => {
    if (!geometry) {
      return null;
    }

    if (geometry.type === 'Point') {
      const [lon, lat] = geometry.coordinates;
      return isValidLonLat(lon, lat) ? geometry : null;
    }

    if (geometry.type === 'LineString') {
      const coordinates = geometry.coordinates.filter(([lon, lat]) =>
        isValidLonLat(lon, lat)
      );
      return coordinates.length >= 2
        ? ({ ...geometry, coordinates } as GeoJSON.LineString)
        : null;
    }

    if (geometry.type === 'Polygon') {
      const coordinates = geometry.coordinates
        .map((ring) => ring.filter(([lon, lat]) => isValidLonLat(lon, lat)))
        .filter((ring) => ring.length >= 4);
      return coordinates.length >= 1
        ? ({ ...geometry, coordinates } as GeoJSON.Polygon)
        : null;
    }

    if (geometry.type === 'MultiPolygon') {
      const coordinates = geometry.coordinates
        .map((polygon) =>
          polygon
            .map((ring) => ring.filter(([lon, lat]) => isValidLonLat(lon, lat)))
            .filter((ring) => ring.length >= 4)
        )
        .filter((polygon) => polygon.length >= 1);
      return coordinates.length >= 1
        ? ({ ...geometry, coordinates } as GeoJSON.MultiPolygon)
        : null;
    }

    return geometry;
  };

  const features = input.features
    .map((feature) => {
      const geometry = sanitizeGeometry(feature.geometry);
      if (!geometry) {
        return null;
      }
      return { ...feature, geometry };
    })
    .filter((feature): feature is GeoJSON.Feature => feature !== null);

  return { type: 'FeatureCollection', features };
}

function rewindGeoJSON<T extends GeoJSON.GeoJsonObject>(
  geojson: T,
  outerClockwise = true
): T {
  const rewindRing = (ring: number[][], clockwise: boolean): void => {
    let area = 0;
    let err = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const k = (ring[i][0] - ring[j][0]) * (ring[j][1] + ring[i][1]);
      const m = area + k;
      err += Math.abs(area) >= Math.abs(k) ? area - m + k : k - m + area;
      area = m;
    }
    if (area + err >= 0 !== clockwise) {
      ring.reverse();
    }
  };

  const rewindRings = (rings: number[][][]): void => {
    if (rings.length === 0) {
      return;
    }
    rewindRing(rings[0], outerClockwise);
    for (let i = 1; i < rings.length; i++) {
      rewindRing(rings[i], !outerClockwise);
    }
  };

  const walk = (obj: GeoJSON.GeoJsonObject | GeoJSON.Geometry | null): void => {
    if (!obj) {
      return;
    }
    if (obj.type === 'FeatureCollection') {
      const collection = obj as GeoJSON.FeatureCollection;
      for (const feature of collection.features) {
        walk(feature);
      }
      return;
    }
    if (obj.type === 'Feature') {
      const feature = obj as GeoJSON.Feature;
      walk(feature.geometry);
      return;
    }
    if (obj.type === 'GeometryCollection') {
      const collection = obj as GeoJSON.GeometryCollection;
      for (const geometry of collection.geometries) {
        walk(geometry);
      }
      return;
    }
    if (obj.type === 'Polygon') {
      const polygon = obj as GeoJSON.Polygon;
      rewindRings(polygon.coordinates as number[][][]);
      return;
    }
    if (obj.type === 'MultiPolygon') {
      const multiPolygon = obj as GeoJSON.MultiPolygon;
      for (const polygon of multiPolygon.coordinates as number[][][][]) {
        rewindRings(polygon);
      }
    }
  };

  walk(geojson);
  return geojson;
}

function cacheKeyFor(options: {
  icao: string;
  endpoint: string;
  tags: Record<string, OsmTagFilter>;
}): string {
  const tagsJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(options.tags).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  return `trafficjs:osm:${options.endpoint}:${toUpperIcao(
    options.icao
  )}:${tagsJson}`;
}

function getFromLocalStorage(
  key: string,
  ttlMs: number
): GeoJSON.FeatureCollection | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      timestamp?: number;
      value?: GeoJSON.FeatureCollection;
    };
    if (
      !parsed ||
      typeof parsed.timestamp !== 'number' ||
      !parsed.value ||
      Date.now() - parsed.timestamp > ttlMs
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function setToLocalStorage(
  key: string,
  value: GeoJSON.FeatureCollection
): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), value }));
  } catch {
    // ignore storage failures (quota/private mode)
  }
}

export async function fetchAirportOsmFeatures(
  options: AirportOsmFetchOptions
): Promise<GeoJSON.FeatureCollection> {
  const icao = toUpperIcao(options.icao);
  if (!icao) {
    return { type: 'FeatureCollection', features: [] };
  }

  const endpoint = options.endpoint ?? DEFAULT_OVERPASS_ENDPOINT;
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('No fetch implementation available for Overpass query.');
  }

  const tags = options.tags ?? DEFAULT_TAGS;
  const cacheEnabled = options.cache !== false;
  const cacheStorage = options.cacheStorage ?? 'both';
  const cacheTtlMs =
    typeof options.cacheTtlMs === 'number' &&
    Number.isFinite(options.cacheTtlMs)
      ? Math.max(0, Math.floor(options.cacheTtlMs))
      : DEFAULT_CACHE_TTL_MS;
  const key = cacheKeyFor({ icao, endpoint, tags });

  if (cacheEnabled) {
    const memory = memoryCache.get(key);
    if (memory && Date.now() - memory.timestamp <= cacheTtlMs) {
      return memory.value;
    }
    if (cacheStorage === 'localStorage' || cacheStorage === 'both') {
      const stored = getFromLocalStorage(key, cacheTtlMs);
      if (stored) {
        memoryCache.set(key, { timestamp: Date.now(), value: stored });
        return stored;
      }
    }
  }

  const query = buildAirportOverpassQuery({
    icao,
    tags,
    timeoutSeconds: options.timeoutSeconds,
  });

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: new URLSearchParams({ data: query }),
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().startsWith('<')
      ? extractOverpassErrorText(text)
      : text.trim();
    throw new Error(
      `Overpass HTTP ${response.status} ${response.statusText}: ${detail}`
    );
  }

  let parsed: OverpassResponse;
  try {
    parsed = JSON.parse(text) as OverpassResponse;
  } catch (error) {
    throw new Error(
      `Overpass returned non-JSON response: ${String(error)}\n${text.slice(
        0,
        1200
      )}`
    );
  }

  let features = osmtogeojson(
    parsed as JsonObject
  ) as GeoJSON.FeatureCollection;
  if (options.sanitizeGeometry !== false) {
    features = sanitizeFeatureCollection(features);
  }
  if (options.rewindRings !== false) {
    features = rewindGeoJSON(features, true);
  }

  if (cacheEnabled) {
    memoryCache.set(key, { timestamp: Date.now(), value: features });
    if (cacheStorage === 'localStorage' || cacheStorage === 'both') {
      setToLocalStorage(key, features);
    }
  }

  return features;
}

export function clearAirportOsmCache(icao?: string): void {
  if (!icao) {
    memoryCache.clear();
    return;
  }

  const upper = toUpperIcao(icao);
  for (const key of memoryCache.keys()) {
    if (key.includes(`:${upper}:`)) {
      memoryCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// General (non-airport) OSM queries and the `airmark=beacon` navaid source
// ---------------------------------------------------------------------------
//
// `fetchAirportOsmFeatures` above is deliberately airport-scoped
// (`area["icao"=…]`). Navaid resolution needs broader scoping — a bounding
// box or an `around` radius about a reference point — so the helpers below
// generalise the query builder and the fetch/cache/sanitize/rewind pipeline.
//
// `airmark=beacon` nodes are OSM's radio navigation beacons (VOR, DME, NDB,
// ILS loc/gs, OM/MM/IM). See https://wiki.openstreetmap.org/wiki/Tag:airmark%3Dbeacon

/** An area scope: either a set of area tags or an OSM relation id. */
export type OsmAreaSpec =
  { tags: Record<string, OsmTagFilter> } | { relation: number };

export interface OsmFeatureFetchOptions {
  /** Tag filters. Defaults to `{ airmark: 'beacon' }` for beacon helpers. */
  tags?: Record<string, OsmTagFilter>;
  /** Area scope (area tags, or an OSM relation id via `map_to_area`). */
  area?: OsmAreaSpec;
  /** Bounding box `[west, south, east, north]`. */
  bounds?: [number, number, number, number];
  /** Restrict to elements within `radius_m` of `[lat, lon]`. */
  around?: [number, number, number];
  endpoint?: string;
  timeoutSeconds?: number;
  fetch?: typeof globalThis.fetch;
  cache?: boolean;
  cacheTtlMs?: number;
  cacheStorage?: 'memory' | 'localStorage' | 'both';
  sanitizeGeometry?: boolean;
  rewindRings?: boolean;
}

/**
 * Build an Overpass QL string for a general (node) OSM query.
 *
 * Scopes are combined as: an optional `[bbox]`, an optional area
 * (`area[...]` or `rel(id);map_to_area;`), tag filters, and an optional
 * `(around:radius,lat,lon)`. With no scope at all the query is global.
 */
export function buildOsmQuery(options: {
  tags?: Record<string, OsmTagFilter>;
  area?: OsmAreaSpec;
  bounds?: [number, number, number, number];
  around?: [number, number, number];
  timeoutSeconds?: number;
}): string {
  const timeout =
    typeof options.timeoutSeconds === 'number' &&
    Number.isFinite(options.timeoutSeconds)
      ? Math.max(1, Math.floor(options.timeoutSeconds))
      : 60;
  const tags = options.tags ?? {};
  const tagClauses = Object.entries(tags)
    .map(([key, value]) => expandTagClause(key, value))
    .join('');

  const lines: string[] = [`[out:json][timeout:${timeout}];`];

  if (options.bounds) {
    const [west, south, east, north] = options.bounds;
    lines[0] = `[out:json][timeout:${timeout}][bbox:${south},${west},${north},${east}];`;
  }

  let areaRef = '';
  if (options.area) {
    if ('relation' in options.area) {
      lines.push(`rel(id:${options.area.relation});map_to_area;->.searchArea;`);
    } else {
      const areaClauses = Object.entries(options.area.tags)
        .map(([key, value]) => expandTagClause(key, value))
        .join('');
      lines.push(`area${areaClauses}->.searchArea;`);
    }
    areaRef = '(area.searchArea)';
  }

  let aroundRef = '';
  if (options.around) {
    const [radius, lat, lon] = options.around;
    aroundRef = `(around:${radius},${lat},${lon})`;
  }

  lines.push(`node${tagClauses}${areaRef}${aroundRef};out;`);
  return lines.join('\n');
}

function generalCacheKeyFor(options: {
  endpoint: string;
  tags: Record<string, OsmTagFilter>;
  area?: OsmAreaSpec;
  bounds?: [number, number, number, number];
  around?: [number, number, number];
}): string {
  const tagsJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(options.tags).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  const scopeJson = JSON.stringify({
    area: options.area ?? null,
    bounds: options.bounds ?? null,
    around: options.around ?? null,
  });
  return `trafficjs:osm:general:${options.endpoint}:${scopeJson}:${tagsJson}`;
}

/**
 * Fetch arbitrary OSM nodes and return them as a GeoJSON FeatureCollection.
 *
 * Mirrors {@link fetchAirportOsmFeatures} (same cache, sanitize/rewind and
 * Overpass error handling) but with general area/bounds/around scoping.
 */
export async function fetchOsmFeatures(
  options: OsmFeatureFetchOptions
): Promise<GeoJSON.FeatureCollection> {
  const endpoint = options.endpoint ?? DEFAULT_OVERPASS_ENDPOINT;
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('No fetch implementation available for Overpass query.');
  }
  const tags = options.tags ?? {};
  const cacheEnabled = options.cache !== false;
  const cacheStorage = options.cacheStorage ?? 'both';
  const cacheTtlMs =
    typeof options.cacheTtlMs === 'number' &&
    Number.isFinite(options.cacheTtlMs)
      ? Math.max(0, Math.floor(options.cacheTtlMs))
      : DEFAULT_CACHE_TTL_MS;

  const key = generalCacheKeyFor({
    endpoint,
    tags,
    area: options.area,
    bounds: options.bounds,
    around: options.around,
  });

  if (cacheEnabled) {
    const memory = memoryCache.get(key);
    if (memory && Date.now() - memory.timestamp <= cacheTtlMs) {
      return memory.value;
    }
    if (cacheStorage === 'localStorage' || cacheStorage === 'both') {
      const stored = getFromLocalStorage(key, cacheTtlMs);
      if (stored) {
        memoryCache.set(key, { timestamp: Date.now(), value: stored });
        return stored;
      }
    }
  }

  const query = buildOsmQuery({
    tags,
    area: options.area,
    bounds: options.bounds,
    around: options.around,
    timeoutSeconds: options.timeoutSeconds,
  });

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().startsWith('<')
      ? extractOverpassErrorText(text)
      : text.trim();
    throw new Error(
      `Overpass HTTP ${response.status} ${response.statusText}: ${detail}`
    );
  }

  let parsed: OverpassResponse;
  try {
    parsed = JSON.parse(text) as OverpassResponse;
  } catch (error) {
    throw new Error(
      `Overpass returned non-JSON response: ${String(error)}\n${text.slice(
        0,
        1200
      )}`
    );
  }

  let features = osmtogeojson(
    parsed as JsonObject
  ) as GeoJSON.FeatureCollection;
  if (options.sanitizeGeometry !== false) {
    features = sanitizeFeatureCollection(features);
  }
  if (options.rewindRings !== false) {
    features = rewindGeoJSON(features, true);
  }

  if (cacheEnabled) {
    memoryCache.set(key, { timestamp: Date.now(), value: features });
    if (cacheStorage === 'localStorage' || cacheStorage === 'both') {
      setToLocalStorage(key, features);
    }
  }
  return features;
}

/**
 * Normalise a raw OSM `beacon:type` (+ `localizer`/`glideslope`) into the
 * traffic navaid taxonomy. Mirrors the Python `OSMBeaconsProvider`.
 */
export function normaliseBeaconType(
  beaconType: string | undefined,
  localizer: boolean,
  glideslope: boolean
): string {
  const t = String(beaconType ?? '')
    .trim()
    .toUpperCase();
  if (t === 'NDB') return 'NDB';
  if (t === 'VOR' || t === 'DVOR') return 'VOR';
  if (t === 'DVOR/DME' || t === 'DME') return 'DME';
  if (t === 'OM') return 'OM';
  if (t === 'MM') return 'MM';
  if (t === 'IM') return 'IM';
  if (t === 'ILS') {
    if (glideslope) return 'GS';
    if (localizer) return 'LOC';
    return 'ILS';
  }
  return t;
}

/** A structured radio navigation beacon parsed from an `airmark=beacon` node. */
export interface BeaconRecord {
  code: string;
  navaidType: string;
  beaconType: string;
  latitude: number;
  longitude: number;
  frequency: number | null;
  name: string | null;
  source: 'osm';
}

function featureToBeacon(
  feature: GeoJSON.Feature<GeoJSON.Point>
): BeaconRecord | null {
  const tags = (feature.properties ?? {}) as Record<string, unknown>;
  if (tags.airmark !== 'beacon') return null;
  const [lon, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const beaconType = String(tags['beacon:type'] ?? '');
  const localizer = tags.localizer === 'yes';
  const glideslope = tags.glideslope === 'yes';
  const navaidType = normaliseBeaconType(beaconType, localizer, glideslope);

  const code = String(tags['beacon:code'] ?? tags.name ?? tags.ref ?? '')
    .trim()
    .toUpperCase();
  const freqRaw = tags['beacon:frequency'];
  const frequency =
    typeof freqRaw === 'number'
      ? freqRaw
      : typeof freqRaw === 'string' && freqRaw.trim() !== ''
        ? Number(freqRaw)
        : null;

  return {
    code,
    navaidType,
    beaconType: beaconType.toUpperCase(),
    latitude: lat,
    longitude: lon,
    frequency: Number.isFinite(frequency as number)
      ? (frequency as number)
      : null,
    name: typeof tags.name === 'string' ? tags.name : null,
    source: 'osm',
  };
}

export interface OsmBeaconsFetchOptions extends Omit<
  OsmFeatureFetchOptions,
  'tags'
> {}

/**
 * Fetch `airmark=beacon` nodes and return them as normalised beacon records.
 *
 * This is the general-scoping counterpart to the `airmark: 'beacon'` tag one
 * can already pass to {@link fetchAirportOsmFeatures}; it adds
 * around/bounds/area scoping and taxonomy normalisation.
 */
export async function fetchOsmBeacons(
  options: OsmBeaconsFetchOptions = {}
): Promise<BeaconRecord[]> {
  const features = await fetchOsmFeatures({
    ...options,
    tags: { airmark: 'beacon' },
  });
  const out: BeaconRecord[] = [];
  for (const feature of features.features) {
    if (feature.geometry?.type !== 'Point') continue;
    const beacon = featureToBeacon(feature as GeoJSON.Feature<GeoJSON.Point>);
    if (beacon) out.push(beacon);
  }
  return out;
}

/**
 * A {@link LookupSource} backed by OSM `airmark=beacon` nodes.
 *
 * Construct with a **fixed scope** (`area`, `bounds`, or `around`): the
 * beacon set is fetched once (cached like any OSM query) and then used for
 * `resolve({navaid})` and the `navaids` collection. This keeps OSM
 * area-scoped and lazy — there is no global pull — and matches how traffic.js
 * attaches opt-in sources (`resolver.withOsmBeacons(...)`).
 */
export interface OsmBeaconsSourceOptions extends OsmBeaconsFetchOptions {
  /** Source label exposed to the resolver (default `'osm'`). */
  sourceName?: string;
}

export class OsmBeaconsSource {
  private _options: OsmBeaconsSourceOptions;
  private _beacons: BeaconRecord[] | null = null;
  readonly sourceName: string;

  constructor(options: OsmBeaconsSourceOptions = {}) {
    this._options = options;
    this.sourceName = options.sourceName ?? 'osm';
  }

  /** Fetch (and memoise) the scoped beacon set. */
  async beacons(): Promise<BeaconRecord[]> {
    if (this._beacons === null) {
      this._beacons = await fetchOsmBeacons(this._options);
    }
    return this._beacons;
  }

  /** Resolver collection accessor (rows with extractable coordinates). */
  readonly navaids = {
    data: async (): Promise<BeaconRecord[]> => this.beacons(),
    search: (text: string): BeaconRecord[] | Promise<BeaconRecord[]> => {
      const wanted = String(text ?? '')
        .trim()
        .toUpperCase();
      return this.beacons().then((rows) =>
        rows.filter(
          (r) =>
            r.code === wanted || String(r.name ?? '').toUpperCase() === wanted
        )
      );
    },
  };

  /** Resolve a navaid/fix code within the scoped beacon set. */
  async resolve(query: {
    navaid?: string;
    fix?: string;
  }): Promise<GeoJSON.Feature<GeoJSON.Point> | null> {
    const code = String(query?.navaid ?? query?.fix ?? '')
      .trim()
      .toUpperCase();
    if (!code) return null;

    const rows = await this.beacons();
    const hit = rows.find(
      (r) => r.code === code || String(r.name ?? '').toUpperCase() === code
    );
    if (!hit) return null;

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [hit.longitude, hit.latitude] },
      properties: {
        ident: hit.code,
        name: hit.name ?? hit.code,
        latitude: hit.latitude,
        longitude: hit.longitude,
        type: hit.navaidType,
        beacon_type: hit.beaconType,
        kind: 'navaid',
        source: this.sourceName,
        ...(hit.frequency !== null ? { frequency: hit.frequency } : {}),
      },
    };
  }
}
