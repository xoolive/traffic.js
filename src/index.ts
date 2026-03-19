export type { TrafficInstance } from './core/traffic.js';
export type { TrafficEnv } from './core/env.js';
export type {
  HoldingPatternOptions,
  HoldingSegment,
} from './core/holdingPattern.js';
export type { timelike } from './core/time.js';
export type { AircraftInfo } from './core/aircraft.js';
export type { ColumnTable, Op, Struct } from './core/types.js';
export type { Entry } from './core/flight.js';
export type {
  ThrustWasmConfig,
  LoadThrustWasmModuleOptions,
} from './data/thrustWasm.js';
export type {
  FaaArcgisDatasetProgress,
  FaaArcgisDatasetLoaded,
  FaaArcgisCore,
  ResolverCollection,
  CreateFaaArcgisResolverOptions,
} from './data/faaArcgis.js';
export type {
  EurocontrolDdrCore,
  EurocontrolResolverCollection,
  EurocontrolDdrArchiveProgress,
  CreateEurocontrolDdrResolverOptions,
} from './data/eurocontrolDdr.js';
export type { FetchLike, CreateNasrResolverOptions } from './data/nasr.js';
export type {
  Field15Point,
  Field15Element,
  Field15Modifier,
  RouteSegment,
  RouteSegmentFeature,
  RouteEnricher,
  ParseField15Options,
  ResolvedRoutePoint,
} from './data/field15.js';
export type {
  ResolveQuery,
  LookupSource,
  CollectionQueryOptions,
} from './data/resolver.js';
export type {
  AirportQueryMatch,
  AirportQueryMatchKind,
} from './data/airportLookup.js';
export type {
  CreateFr24AirportResolverOptions,
  Fr24AirportRow,
} from './data/fr24.js';
export type {
  ProcedureRouteClass,
  ProcedureType,
  ParsedProcedureRoute,
} from './data/procedures.js';
export type {
  CreateEarthNavResolverOptions,
  CreateEarthFixResolverOptions,
  CreateEarthAwyResolverOptions,
  CreateXplaneResolverOptions,
} from './data/xplane.js';
export type {
  RawLayer,
  MergedLayer,
  AirspaceGeometryResult,
  GeoJsonGeometry,
  GeoJsonPolygon,
  GeoJsonMultiPolygon,
} from './core/airspace.js';

// ── Namespace objects (for Observable inspector grouping) ─────────────────────
export { env, core, data, algorithms } from './namespaces.js';
