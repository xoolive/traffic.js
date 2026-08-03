export type AirportQueryMatchKind =
  'icao_exact' | 'iata_exact' | 'name_exact' | 'name_prefix' | 'name_contains';

export interface AirportQueryMatch<T = unknown> {
  row: T;
  kind: AirportQueryMatchKind;
  score: number;
}

type Dict = Record<string, unknown>;

const ICAO_KEYS = ['icao', 'icao_code', 'code', 'ident'];
const IATA_KEYS = ['iata', 'iata_code'];
const NAME_KEYS = ['name', 'airport_name', 'title'];

function toProps(row: unknown): Dict {
  if (!row || typeof row !== 'object') return {};
  const obj = row as Dict;
  const props = obj.properties;
  if (props && typeof props === 'object') {
    return props as Dict;
  }
  return obj;
}

function firstString(props: Dict, keys: string[]): string {
  for (const key of keys) {
    const value = props[key];
    if (value != null && String(value).trim().length > 0) {
      return String(value).trim();
    }
  }
  return '';
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function rowSortKey(row: unknown): string {
  const props = toProps(row);
  const icao = normalizeCode(firstString(props, ICAO_KEYS));
  const iata = normalizeCode(firstString(props, IATA_KEYS));
  const name = normalizeText(firstString(props, NAME_KEYS));
  return `${icao}|${iata}|${name}`;
}

export function matchAirportQuery<T = unknown>(
  rows: T[],
  query: string
): AirportQueryMatch<T> | null {
  const qRaw = String(query ?? '').trim();
  if (qRaw.length === 0) return null;

  const qCode = normalizeCode(qRaw);
  const qText = normalizeText(qRaw);

  const candidates: Array<AirportQueryMatch<T> & { idx: number; key: string }> =
    [];

  rows.forEach((row, idx) => {
    const props = toProps(row);
    const icao = normalizeCode(firstString(props, ICAO_KEYS));
    const iata = normalizeCode(firstString(props, IATA_KEYS));
    const name = normalizeText(firstString(props, NAME_KEYS));

    if (!icao && !iata && !name) return;

    if (icao && icao === qCode) {
      candidates.push({
        row,
        kind: 'icao_exact',
        score: 0,
        idx,
        key: rowSortKey(row),
      });
      return;
    }

    if (iata && iata === qCode) {
      candidates.push({
        row,
        kind: 'iata_exact',
        score: 1,
        idx,
        key: rowSortKey(row),
      });
      return;
    }

    if (name && qText.length > 0) {
      if (name === qText) {
        candidates.push({
          row,
          kind: 'name_exact',
          score: 2,
          idx,
          key: rowSortKey(row),
        });
        return;
      }

      if (name.startsWith(qText)) {
        candidates.push({
          row,
          kind: 'name_prefix',
          score: 3,
          idx,
          key: rowSortKey(row),
        });
        return;
      }

      if (name.includes(qText)) {
        candidates.push({
          row,
          kind: 'name_contains',
          score: 4,
          idx,
          key: rowSortKey(row),
        });
      }
    }
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.idx - b.idx;
  });

  const best = candidates[0];
  return { row: best.row, kind: best.kind, score: best.score };
}

export function resolveAirportQuery<T = unknown>(
  rows: T[],
  query: string
): T | null {
  return matchAirportQuery(rows, query)?.row ?? null;
}
