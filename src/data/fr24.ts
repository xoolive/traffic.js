import type { FetchLike } from './nasr.js';
import { resolveAirportQuery } from './airportLookup.js';
import type { RouteSegment } from './field15.js';

export const FR24_AIRPORTS_URL =
  'https://www.flightradar24.com/_json/airports.php';

export interface Fr24AirportRow {
  icao: string;
  iata: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface CreateFr24AirportResolverOptions {
  /** Raw rows from FR24 (or equivalent shape). */
  rows?: unknown[];
  /** JSON payload that contains rows (e.g. { rows: [...] }). */
  json?: unknown;
  /** URL to fetch JSON payload from (defaults to FR24 endpoint). */
  url?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

type GeoJsonPointFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    icao: string;
    iata: string;
    name: string;
    latitude: number;
    longitude: number;
    kind: 'airport';
    source: 'fr24';
  };
};

function parseRows(input: unknown): Fr24AirportRow[] {
  const list = Array.isArray(input)
    ? input
    : Array.isArray((input as { rows?: unknown[] })?.rows)
      ? ((input as { rows?: unknown[] }).rows as unknown[])
      : [];

  return list
    .map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const icao = String(row.icao ?? row.icao_code ?? row.ident ?? '')
        .trim()
        .toUpperCase();
      const iata = String(row.iata ?? row.iata_code ?? '')
        .trim()
        .toUpperCase();
      const latitude = Number(row.lat ?? row.latitude);
      const longitude = Number(row.lon ?? row.lng ?? row.longitude);
      const name = String(row.name ?? icao).trim() || icao;

      if (!icao || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      return {
        icao,
        iata,
        name,
        latitude,
        longitude,
      } satisfies Fr24AirportRow;
    })
    .filter((row): row is Fr24AirportRow => row !== null);
}

function rowToFeature(row: Fr24AirportRow): GeoJsonPointFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
    properties: {
      icao: row.icao,
      iata: row.iata,
      name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      kind: 'airport',
      source: 'fr24',
    },
  };
}

export class Fr24AirportResolverJS {
  private _rows: Fr24AirportRow[];
  private _features: GeoJsonPointFeature[];
  private _byIcao: Map<string, Fr24AirportRow>;

  constructor(rows: Fr24AirportRow[]) {
    this._rows = rows;
    this._features = rows.map(rowToFeature);
    this._byIcao = new Map(rows.map((row) => [row.icao, row]));
  }

  airports = {
    data: async () => this._features,
    get: async (codeOrName: string) => {
      const out = resolveAirportQuery(this._features, codeOrName);
      return out ?? undefined;
    },
    search: async (text: string) => {
      const q = String(text ?? '')
        .trim()
        .toLowerCase();
      if (!q) return this._features;
      return this._features.filter((feature) => {
        const p = feature.properties;
        return (
          p.icao.toLowerCase().includes(q) ||
          p.iata.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q)
        );
      });
    },
  };

  async resolve(query: {
    airport?: string;
  }): Promise<GeoJsonPointFeature | null> {
    if (!query.airport) return null;
    return resolveAirportQuery(this._features, query.airport);
  }

  enrichRoute(route: string): RouteSegment[] {
    const tokens = String(route ?? '')
      .toUpperCase()
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);

    const points = tokens
      .filter((token) => /^[A-Z]{4}$/.test(token) && this._byIcao.has(token))
      .map((token) => this._byIcao.get(token) as Fr24AirportRow);

    const segments: RouteSegment[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      if (start.icao === end.icao) continue;
      segments.push({
        start: {
          latitude: start.latitude,
          longitude: start.longitude,
          name: start.icao,
          kind: 'airport',
        },
        end: {
          latitude: end.latitude,
          longitude: end.longitude,
          name: end.icao,
          kind: 'airport',
        },
        name: undefined,
      });
    }

    return segments;
  }
}

export async function createFr24AirportResolver(
  options: CreateFr24AirportResolverOptions = {}
): Promise<Fr24AirportResolverJS> {
  if (options.rows) {
    return new Fr24AirportResolverJS(parseRows(options.rows));
  }

  if (options.json) {
    return new Fr24AirportResolverJS(parseRows(options.json));
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? FR24_AIRPORTS_URL;
  const response = await fetchImpl(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch FR24 airport data: ${response.status} ${response.statusText}`
    );
  }
  const json = await response.json();
  return new Fr24AirportResolverJS(parseRows(json));
}
