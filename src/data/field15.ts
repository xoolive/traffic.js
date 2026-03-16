import { loadThrustWasmModule } from './thrustWasm.js';
import type { LoadThrustWasmModuleOptions } from './thrustWasm.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A named waypoint token: `{ waypoint: "LACOU" }` */
export type Field15Waypoint = { waypoint: string };
/** An ICAO aerodrome token: `{ aerodrome: "LFPG" }` */
export type Field15Aerodrome = { aerodrome: string };
/** A lat/lon coordinate token: `{ coords: [lat, lon] }` */
export type Field15Coords = { coords: [number, number] };
/** A point-bearing-distance token */
export type Field15BearingDistance = {
  point_bearing_distance: {
    point: Field15Point;
    bearing: number;
    distance: number;
  };
};
/** Union of all point variants */
export type Field15Point =
  | Field15Waypoint
  | Field15Aerodrome
  | Field15Coords
  | Field15BearingDistance;

/** ATS airway connector: `{ airway: "UM184" }` */
export type Field15Airway = { airway: string };
/** Direct routing: `"DCT"` */
export type Field15Direct = 'DCT';
/** SID designator: `{ SID: "RANUX1A" }` */
export type Field15Sid = { SID: string };
/** STAR designator: `{ STAR: "LORNI1A" }` */
export type Field15Star = { STAR: string };
/** Flight rule / ATM indicators */
export type Field15Flag =
  | 'VFR'
  | 'IFR'
  | 'OAT'
  | 'GAT'
  | 'IFPSTOP'
  | 'IFPSTART';
/** Stay time token */
export type Field15Stay = { STAY: { minutes: number | null } };
/** NAT track: `{ NAT: "A" }` */
export type Field15Nat = { NAT: string };
/** PTS track: `{ PTS: "0" }` */
export type Field15Pts = { PTS: string };
/** Speed/altitude modifier: `{ speed?: ..., altitude?: ... }` */
export type Field15Modifier = {
  speed?: { kts: number } | { Mach: number } | { 'km/h': number };
  altitude?:
    | { FL: number }
    | { S: number }
    | { ft: number }
    | { m: number }
    | 'VFR';
  altitude_cruise_to?: Field15Modifier['altitude'];
  cruise_climb?: boolean;
};

/** Union of all field 15 token shapes */
export type Field15Element =
  | Field15Point
  | Field15Airway
  | Field15Direct
  | Field15Sid
  | Field15Star
  | Field15Flag
  | Field15Stay
  | Field15Nat
  | Field15Pts
  | Field15Modifier;

// ---------------------------------------------------------------------------
// Resolved segment types (output of enrichRoute)
// ---------------------------------------------------------------------------

/** A resolved geographic point within an enriched route segment */
export interface ResolvedRoutePoint {
  latitude: number;
  longitude: number;
  name?: string;
  kind?: string;
}

/** A segment of a resolved route: start → end with optional airway label */
export interface RouteSegment {
  start: ResolvedRoutePoint;
  end: ResolvedRoutePoint;
  /** Airway name (e.g. "UM184"), SID/STAR name, or undefined for DCT legs */
  name?: string;
}

/** GeoJSON LineString feature representing a single route segment */
export type RouteSegmentFeature = {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: Array<[number, number]>;
  };
  properties: {
    name: string | null;
    start_name: string | null;
    end_name: string | null;
    start_kind: string | null;
    end_kind: string | null;
  };
};

// ---------------------------------------------------------------------------
// Multi-source resolver types
// ---------------------------------------------------------------------------

/**
 * Any resolver that can enrich a field 15 route string.
 * Both `EurocontrolDdrResolverJS` and `NasrResolverJS` satisfy this interface.
 */
export interface RouteEnricher {
  enrichRoute(route: string): RouteSegment[];
}

// ---------------------------------------------------------------------------
// WASM module interface (minimal — only what field15 needs)
// ---------------------------------------------------------------------------

/** @internal */
interface ThrustWasmModule {
  default?: (input?: unknown) => Promise<unknown>;
  parseField15(route: string): Field15Element[];
  EurocontrolResolver: {
    fromDdrArchive(archive: Uint8Array): EurocontrolResolverWithField15;
    new (aixmFolder: unknown): EurocontrolResolverWithField15;
  };
}

/** @internal */
interface EurocontrolResolverWithField15 {
  enrichRoute(route: string): RouteSegment[];
  // The full resolver interface methods are also present but not listed here
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure tokenizer — no resolver needed
// ---------------------------------------------------------------------------

export interface ParseField15Options
  extends LoadThrustWasmModuleOptions<ThrustWasmModule> {}

/**
 * Parse a raw ICAO field 15 route string into a structured token array.
 *
 * This is a pure, stateless operation — no navigation database is required.
 * It tokenises the route string according to ICAO Doc 4444 Annex 2 rules and
 * returns one JavaScript object per token.
 *
 * @example
 * ```ts
 * const tokens = await parseField15("LFPG DCT LACOU UM184 VEBIT DCT LFLL");
 * // [
 * //   { aerodrome: "LFPG" },
 * //   "DCT",
 * //   { waypoint: "LACOU" },
 * //   { airway: "UM184" },
 * //   { waypoint: "VEBIT" },
 * //   "DCT",
 * //   { aerodrome: "LFLL" },
 * // ]
 * ```
 */
export async function parseField15(
  route: string,
  options: ParseField15Options = {}
): Promise<Field15Element[]> {
  const wasm = await loadThrustWasmModule<ThrustWasmModule>(options);
  if (!wasm) {
    throw new Error(
      'thrust-wasm module could not be loaded. ' +
        'Call setThrustWasm({ thrustModuleUrl }) before using parseField15, ' +
        'or pass thrustModuleUrl in options.'
    );
  }
  if (wasm.default) {
    await wasm.default();
  }
  return wasm.parseField15(route);
}

// ---------------------------------------------------------------------------
// Route enrichment — requires EurocontrolResolver
// ---------------------------------------------------------------------------

/**
 * @deprecated since 0.0.9 — use {@link Resolver} with {@link createEurocontrolDdrResolver} instead.
 *
 * ```ts
 * // Deprecated:
 * const r = await Field15Resolver.fromAixm(aixmFiles)
 *
 * // Replacement:
 * import { createEurocontrolDdrResolver, Resolver } from 'traffic.js'
 * const ddr = await createEurocontrolDdrResolver({ archive: aixmFiles })
 * const r = new Resolver().withDdr(ddr)
 * ```
 *
 * `Field15Resolver` will be removed in version 0.1.0.
 */
export interface Field15ResolverOptions
  extends LoadThrustWasmModuleOptions<ThrustWasmModule> {}

/**
 * @deprecated since 0.0.9 — use {@link Resolver} with {@link createEurocontrolDdrResolver} instead.
 *
 * A field 15 route enrichment helper that wraps an `EurocontrolResolver` instance.
 *
 * Resolves each waypoint, navaid, aerodrome, and airway token in a field 15 route
 * string to geographic coordinates using the resolver's navigation database.
 *
 * Obtain an instance by calling `Field15Resolver.fromResolver(resolver)` where
 * `resolver` is an existing `EurocontrolDdrResolverJS` or a raw WASM
 * `EurocontrolResolver` instance.
 *
 * **Migration:** Replace `Field15Resolver` with `Resolver.withDdr()`:
 * ```ts
 * const ddr = await createEurocontrolDdrResolver({ archive: aixmFiles })
 * const resolver = new Resolver().withDdr(ddr)
 * const segments = resolver.enrichRoute("LFPG DCT LACOU UM184 VEBIT DCT LFLL")
 * ```
 */
export class Field15Resolver {
  private _core: EurocontrolResolverWithField15;

  private constructor(core: EurocontrolResolverWithField15) {
    this._core = core;
  }

  /**
   * Wrap an existing WASM EurocontrolResolver (or any object with an `enrichRoute` method).
   * @deprecated Use `new Resolver().withDdr(ddr)` instead.
   */
  static fromResolver(core: EurocontrolResolverWithField15): Field15Resolver {
    return new Field15Resolver(core);
  }

  /**
   * Load a `Field15Resolver` backed by an AIXM data set (map of filename → bytes).
   *
   * @param aixmFiles - A `Record<string, Uint8Array>` mapping BASELINE zip filenames
   *   (e.g. `"AirportHeliport.BASELINE.zip"`) to their contents.
   * @deprecated Use `createEurocontrolDdrResolver({ archive: aixmFiles })` and `new Resolver().withDdr(ddr)` instead.
   */
  static async fromAixm(
    aixmFiles: Record<string, Uint8Array>,
    options: Field15ResolverOptions = {}
  ): Promise<Field15Resolver> {
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
    const core = new wasm.EurocontrolResolver(aixmFiles);
    return new Field15Resolver(core as EurocontrolResolverWithField15);
  }

  /**
   * Resolve a raw ICAO field 15 route string into a sequence of geographic segments.
   *
   * Returns a list of `RouteSegment` objects. Each segment has `start` and `end`
   * points (with `latitude`, `longitude`, and optionally `name` and `kind`) and an
   * optional `name` for the connecting airway.
   *
   * @example
   * ```ts
   * const segments = resolver.enrichRoute("LFPG DCT LACOU UM184 VEBIT DCT LFLL");
   * for (const seg of segments) {
   *   console.log(seg.start.name, "->", seg.end.name, "via", seg.name ?? "DCT");
   * }
   * ```
   */
  enrichRoute(route: string): RouteSegment[] {
    return this._core.enrichRoute(route);
  }

  /**
   * Resolve a route and return the result as a GeoJSON FeatureCollection of
   * LineString features — one feature per route segment.
   *
   * Each feature's `properties` contains:
   * - `name` — airway name or `null` for DCT legs
   * - `start_name`, `end_name` — waypoint names
   * - `start_kind`, `end_kind` — point kind (`"airport"`, `"navaid"`, `"fix"`, `"coords"`, …)
   *
   * @example
   * ```ts
   * const fc = resolver.enrichRouteAsGeoJSON("LFPG DCT LACOU UM184 VEBIT DCT LFLL");
   * // Use with d3, Leaflet, deck.gl, etc.
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
}
