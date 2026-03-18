import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data } from '../src/index.js';

const { matchAirportQuery, resolveAirportQuery } = data.airportLookup;

describe('airport lookup helpers', () => {
  const rows = [
    { properties: { icao: 'LFBO', iata: 'TLS', name: 'Toulouse Blagnac' } },
    { properties: { icao: 'LFBD', iata: 'BOD', name: 'Bordeaux Merignac' } },
  ];

  it('prefers exact ICAO over all other matches', () => {
    const match = matchAirportQuery(rows, 'LFBO');
    expect(match?.kind).to.equal('icao_exact');
    expect(
      (match?.row as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('LFBO');
  });

  it('returns exact IATA match when ICAO does not match', () => {
    const match = matchAirportQuery(rows, 'TLS');
    expect(match?.kind).to.equal('iata_exact');
    expect(
      (match?.row as { properties?: { icao?: string } })?.properties?.icao
    ).to.equal('LFBO');
  });

  it('returns case-insensitive name match', () => {
    const row = resolveAirportQuery(rows, 'toulouse blagnac');
    expect(
      (row as { properties?: { iata?: string } })?.properties?.iata
    ).to.equal('TLS');
  });

  it('returns null for empty query', () => {
    expect(resolveAirportQuery(rows, '')).to.equal(null);
  });
});
