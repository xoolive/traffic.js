export type ProcedureRouteClass = 'DP' | 'AP';
export type ProcedureType = 'SID' | 'STAR' | 'airway';

export interface ParsedProcedureRoute {
  procedure: string;
  airport: string;
  routeClass: ProcedureRouteClass;
  procedureType: ProcedureType;
}

export function parseProcedureRouteName(
  name: string,
  routeClass?: string
): ParsedProcedureRoute | null {
  const normalizedClass = String(routeClass ?? '')
    .trim()
    .toUpperCase();
  if (normalizedClass !== 'DP' && normalizedClass !== 'AP') {
    return null;
  }

  const normalizedName = String(name ?? '')
    .trim()
    .toUpperCase();
  if (!normalizedName) {
    return null;
  }

  const withSeparator = normalizedName.match(/^([A-Z0-9]+)[\s_-]+([A-Z]{4})$/);
  if (withSeparator) {
    return {
      procedure: withSeparator[1],
      airport: withSeparator[2],
      routeClass: normalizedClass,
      procedureType: normalizedClass === 'DP' ? 'SID' : 'STAR',
    };
  }

  const compact = normalizedName.match(/^([A-Z0-9]{2,})([A-Z]{4})$/);
  if (!compact) {
    return null;
  }

  return {
    procedure: compact[1],
    airport: compact[2],
    routeClass: normalizedClass,
    procedureType: normalizedClass === 'DP' ? 'SID' : 'STAR',
  };
}

export function normalizeProcedureProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...properties };

  const routeClass = String(out['route_class'] ?? out['ROUTE_TYPE'] ?? '')
    .trim()
    .toUpperCase();
  if (routeClass.length > 0) {
    out['route_class'] = routeClass;
  }

  if (routeClass === 'AR') {
    out['type'] = 'airway';
  }

  const baseName = String(out['name'] ?? out['identifier'] ?? '').trim();
  if (!baseName) {
    return out;
  }

  const parsed = parseProcedureRouteName(baseName, routeClass);
  if (!parsed) {
    return out;
  }

  out['procedure'] = parsed.procedure;
  out['airport'] = parsed.airport;
  out['route_class'] = parsed.routeClass;
  out['type'] = parsed.procedureType;
  out['raw_name'] = out['name'] ?? out['identifier'] ?? parsed.procedure;
  out['name'] = parsed.procedure;
  delete out['procedure'];
  delete out['procedure_type'];
  return out;
}

export function normalizeProcedureFeature<T extends { properties?: unknown }>(
  feature: T
): T {
  if (!feature || typeof feature !== 'object') {
    return feature;
  }
  const properties = (feature as { properties?: unknown }).properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return feature;
  }
  return {
    ...feature,
    properties: normalizeProcedureProperties(
      properties as Record<string, unknown>
    ),
  };
}
