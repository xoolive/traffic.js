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
