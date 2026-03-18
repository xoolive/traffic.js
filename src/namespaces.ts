/**
 * Namespace objects for convenient grouping in the Observable inspector.
 *
 * Flat named exports remain available for destructuring imports; these
 * namespace objects collect them into logical groups so that the inspector
 * shows a tidy hierarchy instead of a flat alphabetical list.
 */

import { setEnv } from './core/env.js';
import { setTrafficBaseUrl } from './core/holdingPattern.js';
import { setThrustWasm, getThrustWasmConfig } from './data/thrustWasm.js';
import { Flight } from './core/flight.js';
import { Traffic } from './core/traffic.js';
import { belevingsvlucht, quickstart } from './data/samples.js';
import { unwrapDegrees } from './core/holdingPattern.js';
import { make_date } from './core/time.js';
import { aircraftInfo } from './core/aircraft.js';
import { Resolver } from './data/resolver.js';
import { parseField15 } from './data/field15.js';
import { createNasrResolver, NasrResolverJS } from './data/nasr.js';
import {
  createEurocontrolDdrResolver,
  createEuroControlDdrResolver,
  fetchEurocontrolDdrArchive,
  EurocontrolDdrResolverJS,
} from './data/eurocontrolDdr.js';
import {
  createFaaArcgisResolver,
  fetchFaaArcgisCollections,
  faaArcgisDatasetUrl,
  FAA_ARCGIS_DATASETS,
  FaaArcgisResolverJS,
} from './data/faaArcgis.js';
import {
  createEarthNavResolver,
  createEarthFixResolver,
  createEarthAwyResolver,
  createXplaneResolver,
} from './data/xplane.js';
import {
  matchAirportQuery,
  resolveAirportQuery,
} from './data/airportLookup.js';
import { createFr24AirportResolver, FR24_AIRPORTS_URL } from './data/fr24.js';
import {
  buildAirspaceGeometry,
  validateGeometryNesting,
} from './core/airspace.js';

/** Core flight and geometry APIs. */
export const core = {
  /** Flight trajectory collection with analysis methods. */
  Flight,
  /** Multi-flight collection type with search/lookup helpers. */
  Traffic,
  /** Merge raw altitude-banded airspace layers into consolidated GeoJSON bands. */
  buildAirspaceGeometry,
  /** Validate GeoJSON coordinate nesting depth for Polygon/MultiPolygon. */
  validateGeometryNesting,
};

/** Observable / runtime environment setup. */
export const env = {
  /** Register Observable built-ins (Inputs, html, d3, Plot) for view() / table(). */
  setEnv,
  /** Tell traffic.js where it is served from (needed when loaded via require()). */
  setTrafficBaseUrl,
  /** Configure the thrust-wasm module location. */
  setThrustWasm,
  /** Return the current thrust-wasm configuration. */
  getThrustWasmConfig,
};

/** Bundled sample flight / traffic datasets. */
export const data = {
  /** Look up aircraft metadata (type, registration) by ICAO 24-bit address. */
  aircraftInfo,
  /** Bundled sample datasets. */
  samples: {
    /** Transavia 737 survey flight over the Netherlands, 2018-05-30 (one holding). */
    belevingsvlucht,
    /** Quick-start multi-flight Traffic collection. */
    quickstart,
  },

  /** Multi-source route resolver with priority and gap-filling logic. */
  Resolver,
  /** Parse a Field 15 route string into a structured token sequence. */
  parseField15,

  /** FAA route-resolution sources (NASR + ArcGIS). */
  faa: {
    /** Create a resolver backed by an FAA NASR 28-day cycle archive. */
    createNasrResolver,
    /** Low-level NASR resolver class. */
    NasrResolverJS,

    /** Create a resolver backed by the FAA ArcGIS REST API. */
    createFaaArcgisResolver,
    /** Fetch all FAA ArcGIS dataset collections. */
    fetchFaaArcgisCollections,
    /** Build a FAA ArcGIS dataset URL from a dataset ID. */
    faaArcgisDatasetUrl,
    /** Well-known FAA ArcGIS dataset IDs. */
    FAA_ARCGIS_DATASETS,
    /** Low-level FAA ArcGIS resolver class. */
    FaaArcgisResolverJS,
  },

  /** Eurocontrol DDR2 route-resolution sources. */
  eurocontrol: {
    /** Create a resolver backed by a Eurocontrol DDR2 AIRAC archive. */
    createEurocontrolDdrResolver,
    /** Alias for createEurocontrolDdrResolver (legacy capitalisation). */
    createEuroControlDdrResolver,
    /** Fetch and stream a Eurocontrol DDR2 archive with progress callbacks. */
    fetchEurocontrolDdrArchive,
    /** Low-level Eurocontrol DDR resolver class. */
    EurocontrolDdrResolverJS,
  },

  /** X-Plane navdata sources. */
  xplane: {
    /** Create a resolver that combines earth_nav/fix/awy sources. */
    createXplaneResolver,
    /** Create a resolver for earth_nav.dat navaids. */
    createEarthNavResolver,
    /** Create a resolver for earth_fix.dat fixes. */
    createEarthFixResolver,
    /** Create a resolver for earth_awy.dat airways. */
    createEarthAwyResolver,
  },

  /** Airport lookup helpers (ICAO/IATA/name matching). */
  airportLookup: {
    /** Return best airport row + match metadata. */
    matchAirportQuery,
    /** Return only the best matching airport row. */
    resolveAirportQuery,
  },

  /** FlightRadar24 airport source helper. */
  fr24: {
    /** CORS-restricted default endpoint. Prefer passing json/rows in browsers. */
    FR24_AIRPORTS_URL,
    /** Create a FR24 airport resolver (supports ICAO/IATA/name lookup). */
    createFr24AirportResolver,
  },
};

/** Analysis algorithms operating on Flight data. */
export const algorithms = {
  /**
   * Unwrap an array of degree values the same way `numpy.unwrap` does.
   * Used internally by holdingPattern detection; exposed for custom pipelines.
   */
  unwrapDegrees,
  /** Parse a millisecond epoch, ISO string, or Date into a Date. */
  make_date,
};
