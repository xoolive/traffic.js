import type {
  RouteEnricher,
  RouteSegment,
  RouteSegmentFeature,
  Field15Element,
} from './field15.js';
import { parseField15 } from './field15.js';
import { resolveAirportQuery } from './airportLookup.js';
import { fetchAirportOsmFeatures, type AirportOsmFetchOptions } from './osm.js';

export type ResolveQuery = {
  airport?: string;
  navaid?: string;
  fix?: string;
  airway?: string;
  SID?: string;
  STAR?: string;
  airspace?: string;
  near?: unknown;
  /** Restrict lookup to one source or redefine source priority order. */
  source?: string | string[];
};

export interface LookupSource {
  resolve?: (query: ResolveQuery) => unknown | Promise<unknown>;
  enrichRoute?: (route: string) => RouteSegment[];
}

export const NOMINATIM_SEARCH_URL =
  'https://nominatim.openstreetmap.org/search';

const NEAR_DISTANCE_TIE_EPSILON_KM = 15;

export interface CollectionQueryOptions {
  /** Maximum number of rows to return. */
  limit?: number;
  /** Text filter applied against properties/row values (case-insensitive). */
  query?: string;
  /** Restrict to one or more attached source names. */
  source?: string | string[];
  /** Exact match on row type (e.g. STAR, SID, airway). */
  type?: string;
}

type AirportCollection = {
  data?: () => unknown[] | Promise<unknown[]>;
};

type NamedCollection = {
  data?: () => unknown[] | Promise<unknown[]>;
  search?: (text: string) => unknown[] | Promise<unknown[]>;
};

type CollectionEntity = 'airports' | 'navaids' | 'airways' | 'airspaces';

type CollectionBearingSource = LookupSource & {
  airports?: NamedCollection;
  navaids?: NamedCollection;
  fixes?: NamedCollection;
  airways?: NamedCollection;
  airspaces?: NamedCollection;
};

type NearPoint = [number, number];

type Candidate = {
  row: unknown;
  sourceName: string;
  coordinates: [number, number];
  tieKey: string;
};

type SourceEntry = { name: string; source: LookupSource };

type SimpleResolvedPoint = {
  name: string;
  latitude: number;
  longitude: number;
  kind: string;
};

export type ResolverAirportOsmOptions = Omit<AirportOsmFetchOptions, 'icao'> & {
  icao?: string;
  airport?: string;
  source?: string | string[];
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * A multi-source ICAO field 15 route resolver.
 *
 * Attach one or more navigation data sources (EUROCONTROL DDR, FAA NASR,
 * FAA ArcGIS, or any custom enricher) and resolve a filed route string into
 * a sequence of geographic segments.
 *
 * Sources are tried in the order they are attached. For each airway segment,
 * the first source that can expand the entry→exit pair wins. When multiple
 * sources resolve the same pair, the higher-priority source is kept.
 *
 * This mirrors the Python `traffic` `Resolver` pattern.
 *
 * @example
 * ```js
 * // Observable — set up once in a preamble cell:
 * traffic.setThrustWasm({ thrustModuleUrl: "http://localhost:8002/web/thrust_wasm.js" })
 *
 * // Load sources (can be done in parallel):
 * [ddr, nasr] = await Promise.all([
 *   traffic.createEurocontrolDdrResolver({ archive: await FileAttachment("ddr.zip").arrayBuffer() }),
 *   traffic.createNasrResolver({ archiveUrl: "https://example.com/nasr.zip" }),
 * ])
 *
 * // Build the resolver:
 * resolver = new traffic.Resolver().withDdr(ddr).withNasr(nasr)
 *
 * // Resolve a route:
 * route = "N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LIZAD DCT LFPG"
 * segments = resolver.enrichRoute(route)
 * fc       = resolver.enrichRouteAsGeoJSON(route)
 * tokens   = await resolver.parseField15(route)
 * ```
 */
export class Resolver {
  private _sources: Array<{ name: string; source: LookupSource }> = [];

  /**
   * Aggregated collection accessors across attached sources.
   *
   * Each accessor concatenates rows from all compatible sources in source
   * priority order and annotates items with source metadata.
   */
  readonly collections = {
    airports: async (options?: CollectionQueryOptions) =>
      this._collectFromSources('airports', options),
    navaids: async (options?: CollectionQueryOptions) =>
      this._collectFromSources('navaids', options),
    airways: async (options?: CollectionQueryOptions) =>
      this._collectFromSources('airways', options),
    airspaces: async (options?: CollectionQueryOptions) =>
      this._collectFromSources('airspaces', options),
  };

  // -------------------------------------------------------------------------
  // Builder methods — each returns `this` for chaining
  // -------------------------------------------------------------------------

  /**
   * Attach a EUROCONTROL DDR resolver as a navigation source.
   *
   * DDR data covers European airways, navaids, and airports. Attach this
   * first if your routes are primarily European.
   *
   * @param ddr - An `EurocontrolDdrResolverJS` instance from
   *   {@link createEurocontrolDdrResolver}.
   */
  withDdr(ddr: RouteEnricher): this {
    return this.withSource('ddr', ddr);
  }

  /**
   * Attach a FAA NASR resolver as a navigation source.
   *
   * NASR data covers US airways, navaids, and airports. Attach this for
   * routes that cross US airspace.
   *
   * @param nasr - A `NasrResolverJS` instance from {@link createNasrResolver}.
   */
  withNasr(nasr: RouteEnricher): this {
    return this.withSource('nasr', nasr);
  }

  /**
   * Attach a FAA ArcGIS resolver as a navigation source.
   *
   * ArcGIS data is an alternative US source with different coverage than NASR.
   *
   * Requires thrust-wasm ≥ 0.2.2 and the datasets to be preloaded. Call
   * `await arcgis.preloadAll()` (or construct with `{ eager: true }`) before
   * passing the resolver to this method.
   *
   * @param arcgis - A `FaaArcgisResolverJS` instance from
   *   {@link createFaaArcgisResolver}.
   */
  withArcgis(arcgis: RouteEnricher): this {
    return this.withSource('arcgis', arcgis);
  }

  /**
   * Attach any custom source as a navigation source.
   *
   * A source may implement either of:
   * - `resolve(query)` for lookup use-cases (airport/navaid/fix/airway)
   * - `enrichRoute(route)` for field-15 route expansion
   *
   * `EurocontrolDdrResolverJS`, `NasrResolverJS`, and `FaaArcgisResolverJS`
   * (thrust-wasm ≥ 0.2.2, after `preloadAll()`) implement `enrichRoute`.
   *
   * @param name - A label for this source (used for debugging only).
   * @param source - Any object with at least `resolve()` or `enrichRoute()`.
   * @throws If neither `source.resolve` nor `source.enrichRoute` is a function.
   *
   * @example
   * ```js
   * // Lookup-only source
   * resolver.withSource('airports', {
   *   resolve: (query) => (query.airport === 'LFBO' ? feature : null),
   * })
   *
   * // Route-enrichment source
   * resolver.withSource('ddr', {
   *   enrichRoute: (route) => ddr.enrichRoute(route),
   * })
   * ```
   */
  withSource(name: string, source: LookupSource): this {
    const hasResolve = typeof source?.resolve === 'function';
    const hasEnrichRoute = typeof source?.enrichRoute === 'function';
    if (!hasResolve && !hasEnrichRoute) {
      throw new Error(
        `Source "${name}" must implement resolve() or enrichRoute(). ` +
          `FaaArcgisResolverJS requires thrust-wasm ≥ 0.2.2 and preloaded datasets — ` +
          `call await arcgis.preloadAll() before passing it to withArcgis().`
      );
    }
    this._sources.push({ name, source });
    return this;
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Parse a raw ICAO field 15 route string into structured tokens.
   *
   * This is a pure tokeniser — no navigation database is required.
   * It calls the global {@link parseField15} function using whichever
   * thrust-wasm module was configured via {@link setThrustWasm}.
   *
   * @example
   * ```js
   * tokens = await resolver.parseField15("LFPG DCT LACOU UM184 VEBIT DCT LFLL")
   * // [{ aerodrome: "LFPG" }, "DCT", { waypoint: "LACOU" }, ...]
   * ```
   */
  async parseField15(route: string): Promise<Field15Element[]> {
    return parseField15(route);
  }

  /**
   * Convenience wrapper around `fetchAirportOsmFeatures`.
   *
   * Pass either an explicit `icao`, or an `airport` query resolvable through
   * attached sources.
   */
  async fetchAirportOsmFeatures(
    options: ResolverAirportOsmOptions
  ): Promise<GeoJSON.FeatureCollection> {
    const icao =
      options.icao ??
      (await this._resolveAirportIcaoFromQuery(
        options.airport,
        options.source
      ));
    if (!icao) {
      throw new Error(
        'fetchAirportOsmFeatures: pass options.icao or options.airport that resolves to an airport with an ICAO code'
      );
    }

    return fetchAirportOsmFeatures({ ...options, icao });
  }

  /**
   * Resolve a lookup query against attached sources.
   *
   * Resolution order follows source attachment order.
   * For airport queries, if `source.resolve()` returns no hit, a fallback
   * fuzzy matcher is applied on `source.airports.data()` when available.
   */
  async resolve(query: ResolveQuery): Promise<unknown | null> {
    const hasQuery =
      query.airport ||
      query.navaid ||
      query.fix ||
      query.airway ||
      query.SID ||
      query.STAR ||
      query.airspace;
    if (!hasQuery) {
      throw new Error(
        'resolve: pass one of airport/navaid/fix/airway/SID/STAR/airspace'
      );
    }

    const sourceEntries = this._resolveSourceEntries(query.source);

    if (query.near !== undefined) {
      const nearPoint = await this._resolveNearPoint(query.near);
      if (nearPoint) {
        const nearest = await this._resolveNearestCandidate(
          query,
          nearPoint,
          sourceEntries
        );
        if (nearest) {
          return nearest;
        }
      }
    }

    for (const entry of sourceEntries) {
      const source = entry.source;

      if (typeof source.resolve === 'function') {
        try {
          const hit = await source.resolve(query);
          if (hit && this._matchesResolveIntent(hit, query)) return hit;
        } catch {
          // Source failed — skip it silently.
        }
      }

      const airportOnlyQuery =
        !!query.airport &&
        !query.navaid &&
        !query.fix &&
        !query.airway &&
        !query.SID &&
        !query.STAR &&
        !query.airspace;

      if (airportOnlyQuery && query.airport) {
        const airportQuery = query.airport;
        const airports = await this._airportRowsFrom(source);
        if (airports.length > 0) {
          const hit = resolveAirportQuery(airports, airportQuery);
          if (hit) return hit;
        }
      }
    }

    return null;
  }

  /** Alias for resolve(), for notebook ergonomics. */
  async get(query: ResolveQuery): Promise<unknown | null> {
    return this.resolve(query);
  }

  /**
   * Resolve a raw ICAO field 15 route string into geographic segments.
   *
   * Each attached source independently resolves the full route. Results are
   * merged: the first source that resolves a given entry→exit pair wins.
   * Segments that no source can resolve are silently dropped.
   *
   * Returns an array of `{ start, end, name? }` objects where `start` and
   * `end` are `{ latitude, longitude, name?, kind? }`.
   *
   * @throws If no sources have been attached.
   *
   * @example
   * ```js
   * segments = resolver.enrichRoute(
   *   "N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LFPG"
   * )
   * for (const seg of segments) {
   *   console.log(seg.start.name, "→", seg.end.name, "via", seg.name ?? "DCT")
   * }
   * ```
   */
  enrichRoute(route: string): RouteSegment[] {
    if (this._sources.length === 0) {
      throw new Error(
        'Resolver has no sources. ' +
          'Call .withDdr(), .withNasr(), or .withSource() before enrichRoute().'
      );
    }

    const enrichSources = this._sources.filter(
      (entry): entry is { name: string; source: RouteEnricher } =>
        typeof entry.source.enrichRoute === 'function'
    );

    if (enrichSources.length === 0) {
      throw new Error(
        'Resolver has no enrich-capable sources. ' +
          'Attach at least one source implementing enrichRoute(route).'
      );
    }

    if (enrichSources.length === 1) {
      return enrichSources[0].source.enrichRoute(route);
    }

    // Collect all segments from all sources tagged with source priority.
    const allSegments: Array<RouteSegment & { _pri: number }> = [];
    for (let i = 0; i < enrichSources.length; i++) {
      try {
        for (const seg of enrichSources[i].source.enrichRoute(route)) {
          allSegments.push({ ...seg, _pri: i });
        }
      } catch {
        // Source failed — skip it silently.
      }
    }

    // Merge: deduplicate by (start_name|end_name) key, keeping lowest _pri.
    // Priority is tracked in a parallel array to avoid stripping _pri from merged objects.
    const seen = new Map<string, number>(); // key → index in merged
    const merged: RouteSegment[] = [];
    const mergedPri: number[] = []; // parallel: priority of the segment at merged[i]

    for (const seg of allSegments) {
      const sk =
        seg.start.name ?? `${seg.start.latitude},${seg.start.longitude}`;
      const ek = seg.end.name ?? `${seg.end.latitude},${seg.end.longitude}`;
      const key = `${sk}|${ek}`;

      const existingIdx = seen.get(key);
      if (existingIdx === undefined) {
        seen.set(key, merged.length);
        const { _pri: _, ...clean } = seg;
        merged.push(clean);
        mergedPri.push(seg._pri);
      } else {
        // Replace only if the new source has strictly higher priority (lower index)
        // AND adds an airway name where the existing entry has none.
        const existingPri = mergedPri[existingIdx];
        const existing = merged[existingIdx];
        if (
          seg._pri < existingPri &&
          seg.name !== undefined &&
          existing.name === undefined
        ) {
          const { _pri: _, ...clean } = seg;
          merged[existingIdx] = clean;
          mergedPri[existingIdx] = seg._pri;
        }
      }
    }

    return merged;
  }

  /**
   * Resolve a route and return the result as a GeoJSON `FeatureCollection`
   * of `LineString` features — one feature per route segment.
   *
   * Each feature's `properties` contains:
   * - `name` — airway designator (e.g. `"UT300"`) or `null` for DCT legs
   * - `start_name`, `end_name` — waypoint/navaid/aerodrome codes
   * - `start_kind`, `end_kind` — point type: `"airport"`, `"fix"`, `"navaid"`,
   *   `"coords"`, …
   *
   * Coordinates follow the GeoJSON convention: `[longitude, latitude]`.
   *
   * @example
   * ```js
   * fc = resolver.enrichRouteAsGeoJSON(
   *   "N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LFPG"
   * )
   * // Use with Observable Plot, Leaflet, deck.gl, …
   * Plot.plot({
   *   projection: { type: "mercator", … },
   *   marks: [
   *     Plot.geo(fc, { stroke: d => d.properties.name ?? "DCT", tip: true }),
   *   ]
   * })
   * ```
   */
  async enrichRouteAsGeoJSON(route: string): Promise<{
    type: 'FeatureCollection';
    features: RouteSegmentFeature[];
  }> {
    try {
      return await this.enrichRouteAsGeoJSONMultiSource(route);
    } catch {
      const segments = this.enrichRoute(route);
      return this._segmentsToGeoJSON(segments);
    }
  }

  /**
   * Async multi-source route enrichment that can split unresolved segments
   * using point lookups across all attached sources.
   */
  async enrichRouteAsGeoJSONMultiSource(route: string): Promise<{
    type: 'FeatureCollection';
    features: RouteSegmentFeature[];
  }> {
    const base = this.enrichRoute(route);
    const refined = await this._refineUnresolvedWithTokenEdges(route, base);
    return this._segmentsToGeoJSON(refined);
  }

  private _segmentsToGeoJSON(segments: RouteSegment[]): {
    type: 'FeatureCollection';
    features: RouteSegmentFeature[];
  } {
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

  private async _refineUnresolvedWithTokenEdges(
    route: string,
    base: RouteSegment[]
  ): Promise<RouteSegment[]> {
    const tokenEdges = await this._buildTokenEdges(route);
    if (tokenEdges.length === 0) {
      return base;
    }

    const out: RouteSegment[] = [];
    for (const seg of base) {
      if (
        seg.segment_type !== 'unresolved' ||
        !seg.start.name ||
        !seg.end.name
      ) {
        out.push(seg);
        continue;
      }

      const replacement = this._findTokenSubpath(
        tokenEdges,
        seg.start.name,
        seg.end.name
      );
      if (!replacement || replacement.length <= 1) {
        out.push(seg);
        continue;
      }

      out.push(...replacement);
    }
    return out;
  }

  private _findTokenSubpath(
    tokenEdges: RouteSegment[],
    startName: string,
    endName: string
  ): RouteSegment[] | null {
    const start = startName.toUpperCase();
    const end = endName.toUpperCase();

    for (let i = 0; i < tokenEdges.length; i++) {
      if ((tokenEdges[i].start.name ?? '').toUpperCase() !== start) {
        continue;
      }
      const candidate: RouteSegment[] = [];
      for (let j = i; j < tokenEdges.length; j++) {
        const current = tokenEdges[j];
        if (
          candidate.length > 0 &&
          (candidate[candidate.length - 1].end.name ?? '') !==
            (current.start.name ?? '')
        ) {
          break;
        }
        candidate.push(current);
        if ((current.end.name ?? '').toUpperCase() === end) {
          return candidate;
        }
      }
    }
    return null;
  }

  private async _buildTokenEdges(route: string): Promise<RouteSegment[]> {
    const elements = await this.parseField15(route);
    const edges: RouteSegment[] = [];
    let last: SimpleResolvedPoint | null = null;
    let connectorName: string | undefined;
    let connectorType: string | undefined;

    for (const element of elements) {
      const point = await this._resolveField15Point(element, last);
      if (point) {
        if (last) {
          const name =
            connectorType === 'dct'
              ? undefined
              : connectorName ?? (connectorType === 'NAT' ? 'NAT' : undefined);
          const connector =
            connectorType === 'dct' ? 'DCT' : connectorName ?? name ?? null;
          edges.push({
            start: {
              name: last.name,
              latitude: last.latitude,
              longitude: last.longitude,
              kind: last.kind,
            },
            end: {
              name: point.name,
              latitude: point.latitude,
              longitude: point.longitude,
              kind: point.kind,
            },
            name,
            segment_type: connectorType ?? 'unresolved',
            connector: connector ?? undefined,
          });
        }
        last = point;
        connectorName = undefined;
        connectorType = undefined;
        continue;
      }

      if (element === 'DCT') {
        connectorName = undefined;
        connectorType = 'dct';
        continue;
      }
      if (!element || typeof element !== 'object') {
        continue;
      }

      const record = element as Record<string, unknown>;
      if (typeof record.airway === 'string') {
        connectorName = record.airway;
        connectorType = 'unresolved';
      } else if (typeof record.NAT === 'string') {
        connectorName = record.NAT;
        connectorType = 'NAT';
      } else if (typeof record.PTS === 'string') {
        connectorName = record.PTS;
        connectorType = 'PTS';
      } else if (typeof record.SID === 'string') {
        connectorName = record.SID;
        connectorType = 'SID';
      } else if (typeof record.STAR === 'string') {
        connectorName = record.STAR;
        connectorType = 'STAR';
      }
    }
    return edges;
  }

  private async _resolveField15Point(
    element: Field15Element,
    nearPoint?: SimpleResolvedPoint | null
  ): Promise<SimpleResolvedPoint | null> {
    if (!element || typeof element !== 'object') {
      return null;
    }
    const record = element as Record<string, unknown>;

    if (Array.isArray(record.coords) && record.coords.length >= 2) {
      const lat = Number(record.coords[0]);
      const lon = Number(record.coords[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return {
          name: `${lat.toFixed(4)},${lon.toFixed(4)}`,
          latitude: lat,
          longitude: lon,
          kind: 'coords',
        };
      }
      return null;
    }

    const codeRaw =
      typeof record.waypoint === 'string'
        ? record.waypoint
        : typeof record.aerodrome === 'string'
        ? record.aerodrome
        : null;
    if (!codeRaw) {
      return null;
    }

    const code = codeRaw.split('/')[0].trim().toUpperCase();
    if (!code) {
      return null;
    }

    const near = nearPoint
      ? ([nearPoint.longitude, nearPoint.latitude] as [number, number])
      : undefined;

    const primary =
      typeof record.aerodrome === 'string'
        ? await this.resolve({ airport: code, near })
        : await this.resolve({ navaid: code, near });
    const fallback =
      primary ??
      (await this.resolve({ fix: code, near })) ??
      (await this.resolve({ airport: code, near }));

    if (!fallback || typeof fallback !== 'object') {
      return null;
    }
    const maybeFeature = fallback as {
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const coords = maybeFeature.geometry?.coordinates;
    if (
      !Array.isArray(coords) ||
      coords.length < 2 ||
      !Number.isFinite(Number(coords[0])) ||
      !Number.isFinite(Number(coords[1]))
    ) {
      return null;
    }

    return {
      name: code,
      longitude: Number(coords[0]),
      latitude: Number(coords[1]),
      kind: String(maybeFeature.properties?.kind ?? 'point'),
    };
  }

  /**
   * Extract endpoint points from a route GeoJSON FeatureCollection.
   *
   * The output is a Point FeatureCollection suitable for waypoint markers/labels.
   * Points are deduplicated by default using `ident + lon + lat`.
   */
  extractRoutePointsAsGeoJSON(
    routeGeoJSON: { features?: RouteSegmentFeature[] },
    options: { dedupe?: boolean } = {}
  ): {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: { type: 'Point'; coordinates: [number, number] };
      properties: { ident: string; kind: string | null };
    }>;
  } {
    const dedupe = options.dedupe !== false;
    const out: Array<{
      type: 'Feature';
      geometry: { type: 'Point'; coordinates: [number, number] };
      properties: { ident: string; kind: string | null };
    }> = [];
    const seen = new Set<string>();

    const pushPoint = (
      ident: string | null,
      kind: string | null,
      coordinates: [number, number] | undefined
    ): void => {
      if (!ident || !coordinates) {
        return;
      }
      const key = `${ident}|${coordinates[0]}|${coordinates[1]}`;
      if (dedupe && seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties: { ident, kind },
      });
    };

    const features = Array.isArray(routeGeoJSON.features)
      ? routeGeoJSON.features
      : [];
    for (const feature of features) {
      if (feature?.geometry?.type !== 'LineString') {
        continue;
      }
      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) {
        continue;
      }
      const start = coords[0] as [number, number] | undefined;
      const end = coords[coords.length - 1] as [number, number] | undefined;
      pushPoint(
        feature.properties.start_name,
        feature.properties.start_kind,
        start
      );
      pushPoint(feature.properties.end_name, feature.properties.end_kind, end);
    }

    return { type: 'FeatureCollection', features: out };
  }

  /**
   * Convenience helper: enrich route and return endpoint points as GeoJSON.
   */
  async enrichRoutePointsAsGeoJSON(
    route: string,
    options: { dedupe?: boolean } = {}
  ): Promise<ReturnType<Resolver['extractRoutePointsAsGeoJSON']>> {
    return this.extractRoutePointsAsGeoJSON(
      await this.enrichRouteAsGeoJSON(route),
      options
    );
  }

  private async _airportRowsFrom(source: LookupSource): Promise<unknown[]> {
    const collection = (source as { airports?: AirportCollection }).airports;
    if (!collection || typeof collection.data !== 'function') {
      return [];
    }
    try {
      const rows = await collection.data();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private async _resolveAirportIcaoFromQuery(
    airport: string | undefined,
    source: string | string[] | undefined
  ): Promise<string | null> {
    if (!airport || !airport.trim()) {
      return null;
    }

    const hit = await this.resolve({ airport, source });
    if (!hit || typeof hit !== 'object') {
      return null;
    }

    const props = this._rowProperties(hit);
    const raw = props.icao ?? props.code;
    if (typeof raw !== 'string') {
      return null;
    }
    const icao = raw.trim().toUpperCase();
    return icao.length > 0 ? icao : null;
  }

  private async _collectFromSources(
    entity: CollectionEntity,
    options?: CollectionQueryOptions
  ): Promise<unknown[]> {
    const limit =
      typeof options?.limit === 'number' && Number.isFinite(options.limit)
        ? Math.max(0, Math.floor(options.limit))
        : Number.POSITIVE_INFINITY;
    const query = String(options?.query ?? '').trim();
    const sourceFilter = this._normalizeSourceFilter(options?.source);
    const typeFilter = String(options?.type ?? '')
      .trim()
      .toUpperCase();

    const out: unknown[] = [];

    for (const entry of this._sources) {
      if (sourceFilter && !sourceFilter.has(entry.name)) {
        continue;
      }

      const source = entry.source as CollectionBearingSource;
      const collection = source[entity];
      if (!collection || typeof collection.data !== 'function') {
        continue;
      }

      try {
        const rows = await this._readCollectionRows(collection, query);
        if (!Array.isArray(rows)) {
          continue;
        }
        for (const row of rows) {
          if (typeFilter && !this._matchesCollectionType(row, typeFilter)) {
            continue;
          }
          if (query && !this._matchesCollectionQuery(row, query)) {
            continue;
          }
          out.push(this._annotateCollectionRow(row, entry.name));
          if (out.length >= limit) {
            return out;
          }
        }
      } catch {
        // Source failed — skip it silently.
      }
    }

    return out;
  }

  private _annotateCollectionRow(row: unknown, sourceName: string): unknown {
    if (!row || typeof row !== 'object') {
      return row;
    }

    const obj = row as Record<string, unknown>;
    const properties = obj.properties;

    if (properties && typeof properties === 'object') {
      const props = properties as Record<string, unknown>;
      return {
        ...obj,
        properties: {
          ...props,
          source: props.source ?? sourceName,
          resolver_source: sourceName,
        },
      };
    }

    return {
      ...obj,
      source: obj.source ?? sourceName,
      resolver_source: sourceName,
    };
  }

  private _normalizeSourceFilter(
    source: CollectionQueryOptions['source']
  ): Set<string> | null {
    if (source == null) return null;
    const values = Array.isArray(source) ? source : [source];
    const cleaned = values
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);
    return cleaned.length > 0 ? new Set(cleaned) : null;
  }

  private _resolveSourceEntries(source?: string | string[]): SourceEntry[] {
    if (source == null) {
      return this._sources;
    }

    const wanted = Array.isArray(source) ? source : [source];
    const out: SourceEntry[] = [];
    const seen = new Set<string>();

    for (const nameValue of wanted) {
      const name = String(nameValue ?? '').trim();
      if (!name || seen.has(name)) continue;
      const found = this._sources.find((entry) => entry.name === name);
      if (!found) continue;
      out.push(found);
      seen.add(name);
    }

    return out;
  }

  private async _readCollectionRows(
    collection: NamedCollection,
    query: string
  ): Promise<unknown[]> {
    if (query && typeof collection.search === 'function') {
      const rows = await collection.search(query);
      if (Array.isArray(rows)) {
        return rows;
      }
    }
    if (typeof collection.data !== 'function') {
      return [];
    }
    const rows = await collection.data();
    return Array.isArray(rows) ? rows : [];
  }

  private _matchesCollectionQuery(row: unknown, query: string): boolean {
    const q = query.toUpperCase();
    if (!q) return true;
    const values = Object.values(
      row &&
        typeof row === 'object' &&
        'properties' in (row as Record<string, unknown>)
        ? (((row as Record<string, unknown>).properties ?? {}) as Record<
            string,
            unknown
          >)
        : ((row ?? {}) as Record<string, unknown>)
    );
    return values.some((value) =>
      String(value ?? '')
        .toUpperCase()
        .includes(q)
    );
  }

  private _matchesCollectionType(row: unknown, wantedType: string): boolean {
    const props = this._rowProperties(row);
    const type = String(props.type ?? '')
      .trim()
      .toUpperCase();
    if (type) {
      return type === wantedType;
    }

    const routeClass = String(props.route_class ?? props.ROUTE_TYPE ?? '')
      .trim()
      .toUpperCase();
    if (wantedType === 'SID') return routeClass === 'DP';
    if (wantedType === 'STAR') return routeClass === 'AP';
    if (wantedType === 'AIRWAY') return routeClass === 'AR';
    return false;
  }

  private async _resolveNearestCandidate(
    query: ResolveQuery,
    nearPoint: NearPoint,
    sourceEntries: SourceEntry[]
  ): Promise<unknown | null> {
    const candidates = await this._collectNearCandidates(query, sourceEntries);
    if (candidates.length === 0) {
      return null;
    }

    let best = candidates[0];
    let bestDistance = this._distanceKm(best.coordinates, nearPoint);

    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[i];
      const distance = this._distanceKm(candidate.coordinates, nearPoint);
      if (distance < bestDistance - NEAR_DISTANCE_TIE_EPSILON_KM) {
        best = candidate;
        bestDistance = distance;
      } else if (
        Math.abs(distance - bestDistance) <= NEAR_DISTANCE_TIE_EPSILON_KM &&
        candidate.tieKey < best.tieKey
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }

    return this._annotateCollectionRow(best.row, best.sourceName);
  }

  private async _collectNearCandidates(
    query: ResolveQuery,
    sourceEntries: SourceEntry[]
  ): Promise<Candidate[]> {
    const queryKey =
      query.airport ??
      query.navaid ??
      query.fix ??
      query.airway ??
      query.airspace;
    const wanted = String(queryKey ?? '')
      .trim()
      .toUpperCase();
    if (!wanted) {
      return [];
    }

    const entity = query.airport
      ? 'airports'
      : query.navaid
      ? 'navaids'
      : query.fix
      ? 'fixes'
      : null;
    if (!entity) {
      return [];
    }

    const out: Candidate[] = [];
    for (
      let sourceIndex = 0;
      sourceIndex < sourceEntries.length;
      sourceIndex++
    ) {
      const entry = sourceEntries[sourceIndex];
      const source = entry.source as CollectionBearingSource;
      const collections: NamedCollection[] = [];
      if (entity === 'fixes') {
        if (source.fixes) collections.push(source.fixes);
        if (source.navaids) collections.push(source.navaids);
      } else {
        const collection = source[entity];
        if (collection) collections.push(collection);
      }

      for (const collection of collections) {
        if (typeof collection.data !== 'function') continue;
        try {
          const rows = await collection.data();
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            if (!this._matchesResolveKey(row, query, wanted)) continue;
            const coords = this._extractPointCoordinates(row);
            if (!coords) continue;
            out.push({
              row,
              sourceName: entry.name,
              coordinates: coords,
              tieKey: `${String(sourceIndex).padStart(4, '0')}|${coords[0]}|${
                coords[1]
              }|${this._rowIdentityKey(row)}|${entry.name}`,
            });
          }
        } catch {
          // Source failed — skip silently.
        }
      }
    }

    return out;
  }

  private _matchesResolveKey(
    row: unknown,
    query: ResolveQuery,
    wanted: string
  ): boolean {
    const props = this._rowProperties(row);
    const values = (keys: string[]) =>
      keys
        .map((key) =>
          String(props[key] ?? '')
            .trim()
            .toUpperCase()
        )
        .filter((value) => value.length > 0);

    if (query.airport) {
      const codes = values([
        'icao',
        'icao_code',
        'ident',
        'code',
        'iata',
        'iata_code',
      ]);
      return codes.includes(wanted);
    }

    if (query.navaid || query.fix) {
      const codes = values(['ident', 'name', 'code', 'raw_code']);
      return codes.includes(wanted);
    }

    return false;
  }

  private _extractPointCoordinates(row: unknown): [number, number] | null {
    const obj = (row ?? {}) as Record<string, unknown>;
    const geometry = obj.geometry as Record<string, unknown> | undefined;
    if (geometry && geometry.type === 'Point') {
      const coordinates = geometry.coordinates;
      if (
        Array.isArray(coordinates) &&
        coordinates.length >= 2 &&
        Number.isFinite(Number(coordinates[0])) &&
        Number.isFinite(Number(coordinates[1]))
      ) {
        return [Number(coordinates[0]), Number(coordinates[1])];
      }
    }

    const props = this._rowProperties(row);
    const lon = Number(
      props.longitude ?? props.lon ?? props.lng ?? props.LONGITUDE ?? props.x
    );
    const lat = Number(
      props.latitude ?? props.lat ?? props.LATITUDE ?? props.y
    );
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      return [lon, lat];
    }
    return null;
  }

  private _rowProperties(row: unknown): Record<string, unknown> {
    const obj = (row ?? {}) as Record<string, unknown>;
    const properties = obj.properties;
    if (properties && typeof properties === 'object') {
      return properties as Record<string, unknown>;
    }
    return obj;
  }

  private _rowIdentityKey(row: unknown): string {
    const props = this._rowProperties(row);
    return [
      String(props.ident ?? ''),
      String(props.code ?? ''),
      String(props.name ?? ''),
      String(props.icao ?? ''),
      String(props.iata ?? ''),
    ]
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value.length > 0)
      .join('|');
  }

  private _matchesResolveIntent(row: unknown, query: ResolveQuery): boolean {
    if (!row || typeof row !== 'object') {
      return true;
    }

    const props = this._rowProperties(row);
    const type = String(props.type ?? '')
      .trim()
      .toUpperCase();
    const routeClass = String(props.route_class ?? props.ROUTE_TYPE ?? '')
      .trim()
      .toUpperCase();

    if (query.SID) {
      if (type === 'SID' || routeClass === 'DP') {
        return true;
      }
      const wanted = query.SID.trim().toUpperCase();
      const id = [props.name, props.ident, props.code]
        .map((value) =>
          String(value ?? '')
            .trim()
            .toUpperCase()
        )
        .find((value) => value.length > 0);
      return id === wanted;
    }

    if (query.STAR) {
      if (type === 'STAR' || routeClass === 'AP') {
        return true;
      }
      const wanted = query.STAR.trim().toUpperCase();
      const id = [props.name, props.ident, props.code]
        .map((value) =>
          String(value ?? '')
            .trim()
            .toUpperCase()
        )
        .find((value) => value.length > 0);
      return id === wanted;
    }

    return true;
  }

  private _distanceKm(a: NearPoint, b: NearPoint): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h =
      sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  private async _resolveNearPoint(near: unknown): Promise<NearPoint | null> {
    if (
      near &&
      typeof near === 'object' &&
      'then' in (near as Record<string, unknown>) &&
      typeof (near as { then?: unknown }).then === 'function'
    ) {
      try {
        const awaited = await (near as Promise<unknown>);
        return this._resolveNearPoint(awaited);
      } catch {
        return null;
      }
    }

    if (Array.isArray(near) && near.length >= 2) {
      const lon = Number(near[0]);
      const lat = Number(near[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        return [lon, lat];
      }
    }

    const featureCoords = this._extractPointCoordinates(near);
    if (featureCoords) {
      return featureCoords;
    }

    if (typeof near === 'string' && near.trim().length > 0) {
      const local = await this.resolve({ airport: near.trim() });
      const localCoords = this._extractPointCoordinates(local);
      if (localCoords) {
        return localCoords;
      }
      return this._geocodeNearString(near.trim());
    }

    return null;
  }

  private async _geocodeNearString(text: string): Promise<NearPoint | null> {
    const url = new URL(NOMINATIM_SEARCH_URL);
    url.searchParams.set('q', text);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        return null;
      }
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      const first = Array.isArray(rows) ? rows[0] : null;
      if (!first) return null;
      const lon = Number(first.lon ?? first.longitude);
      const lat = Number(first.lat ?? first.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return null;
      }
      return [lon, lat];
    } catch {
      return null;
    }
  }
}
