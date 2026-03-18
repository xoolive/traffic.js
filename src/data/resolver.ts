import type {
  RouteEnricher,
  RouteSegment,
  RouteSegmentFeature,
  Field15Element,
} from './field15.js';
import { parseField15 } from './field15.js';
import { resolveAirportQuery } from './airportLookup.js';

export type ResolveQuery = {
  airport?: string;
  navaid?: string;
  fix?: string;
  airway?: string;
  airspace?: string;
  near?: unknown;
};

export interface LookupSource {
  resolve?: (query: ResolveQuery) => unknown | Promise<unknown>;
  enrichRoute?: (route: string) => RouteSegment[];
}

export interface CollectionQueryOptions {
  /** Maximum number of rows to return. */
  limit?: number;
  /** Text filter applied against properties/row values (case-insensitive). */
  query?: string;
  /** Restrict to one or more attached source names. */
  source?: string | string[];
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
  airways?: NamedCollection;
  airspaces?: NamedCollection;
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
   * Requires thrust-wasm ≥ 0.3 and the datasets to be preloaded. Call
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
   * (thrust-wasm ≥ 0.3, after `preloadAll()`) implement `enrichRoute`.
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
          `FaaArcgisResolverJS requires thrust-wasm ≥ 0.3 and preloaded datasets — ` +
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
      query.airspace;
    if (!hasQuery) {
      throw new Error(
        'resolve: pass one of airport/navaid/fix/airway/airspace'
      );
    }

    for (const entry of this._sources) {
      const source = entry.source;
      if (typeof source.resolve === 'function') {
        try {
          const hit = await source.resolve(query);
          if (hit) return hit;
        } catch {
          // Source failed — skip it silently.
        }
      }

      if (query.airport) {
        const airports = await this._airportRowsFrom(source);
        if (airports.length > 0) {
          const hit = resolveAirportQuery(airports, query.airport);
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
}
