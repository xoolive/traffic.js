export const EARTH_NAV_URL =
  'https://raw.githubusercontent.com/xoolive/traffic/refs/heads/master/src/traffic/data/navdata/earth_nav.dat';

export const EARTH_FIX_URL =
  'https://raw.githubusercontent.com/xoolive/traffic/refs/heads/master/src/traffic/data/navdata/earth_fix.dat';

export const EARTH_AWY_URL =
  'https://raw.githubusercontent.com/xoolive/traffic/refs/heads/master/src/traffic/data/navdata/earth_awy.dat';

type ResolveQuery = {
  airport?: string;
  navaid?: string;
  fix?: string;
  airway?: string;
  airspace?: string;
};

type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

type ResolveResult =
  | {
      type: 'Feature';
      geometry: { type: 'Point'; coordinates: [number, number] };
      properties: Record<string, unknown>;
    }
  | {
      type: 'FeatureCollection';
      features: Array<{
        type: 'Feature';
        geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
        properties: Record<string, unknown>;
      }>;
    };

type BaseOptions = {
  url?: string;
  text?: string;
  fetchFn?: FetchLike;
};

export type CreateEarthNavResolverOptions = BaseOptions;
export type CreateEarthFixResolverOptions = BaseOptions;
export type CreateEarthAwyResolverOptions = BaseOptions;
export type CreateXplaneResolverOptions = {
  nav?: CreateEarthNavResolverOptions;
  fix?: CreateEarthFixResolverOptions;
  awy?: CreateEarthAwyResolverOptions;
};

type EarthNavRow = {
  ident: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation_ft: number;
  frequency: number;
  range_nm: number;
  variation: number;
  type: number;
  kind: string;
};

type EarthFixRow = {
  ident: string;
  latitude: number;
  longitude: number;
  kind: 'fix';
};

type EarthAwyPoint = {
  airway: string;
  seq: number;
  ident: string;
  latitude: number;
  longitude: number;
};

const DEFAULT_FETCH: FetchLike = async (input: string) => {
  const response = await fetch(input);
  return response;
};

async function loadText(
  options: BaseOptions,
  fallbackUrl: string,
  label: string
): Promise<string> {
  if (options.text !== undefined) {
    return options.text;
  }
  const url = options.url ?? fallbackUrl;
  const response = await (options.fetchFn ?? DEFAULT_FETCH)(url);
  if (!response.ok) {
    throw new Error(`${label} fetch failed: ${response.status}`);
  }
  return response.text();
}

function kindFromNavType(type: number): string {
  if (type === 2) return 'NDB';
  if (type === 3) return 'VOR';
  if (type === 12 || type === 13) return 'DME';
  if (type === 4) return 'ILS';
  if (type === 5) return 'LOC';
  if (type === 6) return 'GS';
  if (type === 7) return 'OM';
  if (type === 8) return 'MM';
  if (type === 9) return 'IM';
  return 'NAV';
}

function parseEarthNav(text: string): Map<string, EarthNavRow[]> {
  const byIdent = new Map<string, EarthNavRow[]>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line === '99' ||
      line.startsWith('I') ||
      line.startsWith('A')
    ) {
      continue;
    }

    const m = line.match(
      /^(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(\S+)\s*(.*)$/
    );
    if (!m) continue;

    const type = Number(m[1]);
    const latitude = Number(m[2]);
    const longitude = Number(m[3]);
    const elevation_ft = Number(m[4]);
    const frequencyRaw = Number(m[5]);
    const range_nm = Number(m[6]);
    const variation = Number(m[7]);
    const ident = String(m[8] ?? '').toUpperCase();
    const name = (m[9] ?? '').trim();

    if (!ident || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const row: EarthNavRow = {
      ident,
      name: name || ident,
      latitude,
      longitude,
      elevation_ft,
      frequency: frequencyRaw / 100,
      range_nm,
      variation,
      type,
      kind: kindFromNavType(type),
    };

    if (!byIdent.has(ident)) byIdent.set(ident, []);
    byIdent.get(ident)?.push(row);
  }

  return byIdent;
}

function parseEarthFix(text: string): Map<string, EarthFixRow[]> {
  const byIdent = new Map<string, EarthFixRow[]>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line === '99' ||
      line.startsWith('I') ||
      line.startsWith('A')
    ) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;

    const latitude = Number(parts[0]);
    const longitude = Number(parts[1]);
    const ident = String(parts[parts.length - 1] ?? '').toUpperCase();

    if (!ident || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const row: EarthFixRow = { ident, latitude, longitude, kind: 'fix' };
    if (!byIdent.has(ident)) byIdent.set(ident, []);
    byIdent.get(ident)?.push(row);
  }

  return byIdent;
}

function parseEarthAwy(text: string): Map<string, EarthAwyPoint[]> {
  const byAirway = new Map<string, EarthAwyPoint[]>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line === '99' ||
      line.startsWith('I') ||
      line.startsWith('A ')
    ) {
      continue;
    }

    const m = line.match(
      /^([A-Z0-9]+)\s+(\d+)\s+([A-Z0-9_]+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/
    );
    if (!m) continue;

    const airway = m[1].toUpperCase();
    const seq = Number(m[2]);
    const ident = m[3].toUpperCase();
    const latitude = Number(m[4]);
    const longitude = Number(m[5]);

    if (
      !Number.isFinite(seq) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      continue;
    }

    if (!byAirway.has(airway)) byAirway.set(airway, []);
    byAirway.get(airway)?.push({ airway, seq, ident, latitude, longitude });
  }

  for (const points of byAirway.values()) {
    points.sort((a, b) => a.seq - b.seq);
  }

  return byAirway;
}

export class EarthNavResolverJS {
  constructor(private readonly byIdent: Map<string, EarthNavRow[]>) {}

  navaids = {
    data: async () =>
      Array.from(this.byIdent.values())
        .flat()
        .map((row) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [row.longitude, row.latitude] as [number, number],
          },
          properties: {
            ident: row.ident,
            name: row.name,
            latitude: row.latitude,
            longitude: row.longitude,
            elevation_ft: row.elevation_ft,
            frequency: row.frequency,
            range_nm: row.range_nm,
            variation: row.variation,
            type: row.type,
            kind: row.kind,
            source: 'earth_nav.dat',
          },
        })),
  };

  async resolve(query: ResolveQuery): Promise<ResolveResult | null> {
    const code = String(query?.navaid ?? query?.fix ?? '').toUpperCase();
    if (!code) return null;

    const row = this.byIdent.get(code)?.[0];
    if (!row) return null;

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
      properties: {
        ident: row.ident,
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
        elevation_ft: row.elevation_ft,
        frequency: row.frequency,
        range_nm: row.range_nm,
        variation: row.variation,
        type: row.type,
        kind: row.kind,
        source: 'earth_nav.dat',
      },
    };
  }

  enrichRoute(_route: string): [] {
    return [];
  }
}

export class EarthFixResolverJS {
  constructor(private readonly byIdent: Map<string, EarthFixRow[]>) {}

  fixes = {
    data: async () =>
      Array.from(this.byIdent.values())
        .flat()
        .map((row) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [row.longitude, row.latitude] as [number, number],
          },
          properties: {
            ident: row.ident,
            name: row.ident,
            latitude: row.latitude,
            longitude: row.longitude,
            kind: row.kind,
            source: 'earth_fix.dat',
          },
        })),
  };

  async resolve(query: ResolveQuery): Promise<ResolveResult | null> {
    const code = String(query?.fix ?? query?.navaid ?? '').toUpperCase();
    if (!code) return null;

    const row = this.byIdent.get(code)?.[0];
    if (!row) return null;

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
      properties: {
        ident: row.ident,
        name: row.ident,
        latitude: row.latitude,
        longitude: row.longitude,
        kind: row.kind,
        source: 'earth_fix.dat',
      },
    };
  }

  enrichRoute(_route: string): [] {
    return [];
  }
}

export class EarthAwyResolverJS {
  constructor(private readonly byAirway: Map<string, EarthAwyPoint[]>) {}

  airways = {
    data: async () => {
      const out: Array<{
        type: 'Feature';
        geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
        properties: Record<string, unknown>;
      }> = [];

      for (const [name, points] of this.byAirway.entries()) {
        for (let i = 0; i < points.length - 1; i++) {
          const start = points[i];
          const end = points[i + 1];
          out.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [start.longitude, start.latitude],
                [end.longitude, end.latitude],
              ],
            },
            properties: {
              name,
              source: 'earth_awy.dat',
              start_name: start.ident,
              end_name: end.ident,
              start_seq: start.seq,
              end_seq: end.seq,
              kind: 'airway',
            },
          });
        }
      }

      return out;
    },
  };

  async resolve(query: ResolveQuery): Promise<ResolveResult | null> {
    const name = String(query?.airway ?? '').toUpperCase();
    if (!name) return null;

    const points = this.byAirway.get(name);
    if (!points || points.length < 2) return null;

    const features = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      features.push({
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [start.longitude, start.latitude] as [number, number],
            [end.longitude, end.latitude] as [number, number],
          ],
        },
        properties: {
          name,
          source: 'earth_awy.dat',
          start_name: start.ident,
          end_name: end.ident,
          start_seq: start.seq,
          end_seq: end.seq,
          kind: 'airway',
        },
      });
    }

    return { type: 'FeatureCollection', features };
  }

  enrichRoute(_route: string): [] {
    return [];
  }
}

export class XPlaneResolverJS {
  constructor(
    public readonly nav: EarthNavResolverJS,
    public readonly fix: EarthFixResolverJS,
    public readonly awy: EarthAwyResolverJS
  ) {}

  navaids = this.nav.navaids;
  fixes = this.fix.fixes;
  airways = this.awy.airways;

  async resolve(query: ResolveQuery): Promise<ResolveResult | null> {
    if (query.airway) {
      return this.awy.resolve(query);
    }

    if (query.navaid) {
      const fromNav = await this.nav.resolve(query);
      if (fromNav) return fromNav;
      return this.fix.resolve({ fix: query.navaid });
    }

    if (query.fix) {
      const fromFix = await this.fix.resolve(query);
      if (fromFix) return fromFix;
      return this.nav.resolve({ navaid: query.fix });
    }

    return null;
  }

  enrichRoute(_route: string): [] {
    return [];
  }
}

export async function createEarthNavResolver(
  options: CreateEarthNavResolverOptions = {}
): Promise<EarthNavResolverJS> {
  const text = await loadText(options, EARTH_NAV_URL, 'earth_nav.dat');
  return new EarthNavResolverJS(parseEarthNav(text));
}

export async function createEarthFixResolver(
  options: CreateEarthFixResolverOptions = {}
): Promise<EarthFixResolverJS> {
  const text = await loadText(options, EARTH_FIX_URL, 'earth_fix.dat');
  return new EarthFixResolverJS(parseEarthFix(text));
}

export async function createEarthAwyResolver(
  options: CreateEarthAwyResolverOptions = {}
): Promise<EarthAwyResolverJS> {
  const text = await loadText(options, EARTH_AWY_URL, 'earth_awy.dat');
  return new EarthAwyResolverJS(parseEarthAwy(text));
}

export async function createXplaneResolver(
  options: CreateXplaneResolverOptions = {}
): Promise<XPlaneResolverJS> {
  const [nav, fix, awy] = await Promise.all([
    createEarthNavResolver(options.nav),
    createEarthFixResolver(options.fix),
    createEarthAwyResolver(options.awy),
  ]);
  return new XPlaneResolverJS(nav, fix, awy);
}
