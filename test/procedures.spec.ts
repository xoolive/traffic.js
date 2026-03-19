import { describe, it } from 'mocha';
import { expect } from 'chai';

import { data } from '../src/index.js';

const {
  parseProcedureRouteName,
  normalizeProcedureProperties,
  normalizeProcedureFeature,
} = data.procedures;

describe('procedure normalization', () => {
  it('parses DDR-style SID name with trailing airport ICAO', () => {
    const parsed = parseProcedureRouteName('FISTO5ALFBO', 'DP');
    expect(parsed).to.deep.equal({
      procedure: 'FISTO5A',
      airport: 'LFBO',
      routeClass: 'DP',
      procedureType: 'SID',
    });
  });

  it('parses DDR-style STAR name with trailing airport ICAO', () => {
    const parsed = parseProcedureRouteName('LMG6A LFBO', 'AP');
    expect(parsed).to.deep.equal({
      procedure: 'LMG6A',
      airport: 'LFBO',
      routeClass: 'AP',
      procedureType: 'STAR',
    });
  });

  it('does not parse non-procedure route classes', () => {
    const parsed = parseProcedureRouteName('UN858', 'ENR');
    expect(parsed).to.equal(null);
  });

  it('normalizes properties with name/type/airport fields', () => {
    const props = normalizeProcedureProperties({
      name: 'FISTO5ALFBO',
      route_class: 'dp',
    });

    expect(props.route_class).to.equal('DP');
    expect(props.type).to.equal('SID');
    expect(props.name).to.equal('FISTO5A');
    expect(props.airport).to.equal('LFBO');
    expect(props.raw_name).to.equal('FISTO5ALFBO');
    expect(props.procedure).to.equal(undefined);
  });

  it('normalizes feature properties through helper', () => {
    const feature = normalizeProcedureFeature({
      type: 'Feature',
      geometry: null,
      properties: {
        name: 'FISTO5ALFBO',
        ROUTE_TYPE: 'DP',
      },
    });

    const props = (feature as { properties: Record<string, unknown> })
      .properties;
    expect(props.route_class).to.equal('DP');
    expect(props.type).to.equal('SID');
    expect(props.name).to.equal('FISTO5A');
    expect(props.airport).to.equal('LFBO');
  });

  it('sets type=airway for AR route_class', () => {
    const props = normalizeProcedureProperties({
      name: 'UN858',
      route_class: 'AR',
    });
    expect(props.type).to.equal('airway');
    expect(props.name).to.equal('UN858');
  });
});
