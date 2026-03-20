# traffic.js

[![test suite](https://github.com/xoolive/traffic.js/actions/workflows/test.yml/badge.svg)](https://github.com/xoolive/traffic.js/actions/workflows/test.yml)

This **preliminary** Javascript library following the same declarative grammar as the Python [traffic](https://github.com/xoolive/traffic) library.

## Installation

In Node.js:

```sh
npm install traffic.js
```

In Observable:  
[https://observablehq.com/@xoolive/traffic-js](https://observablehq.com/@xoolive/traffic-js)

```js
import * as traffic from 'traffic.js';

const { Flight, Traffic } = traffic.core;
```

When loading from a local dev server, call `setEnv` once to register Observable
globals so that `table()` and `view()` work:

```js
t = require("http://localhost:4000/traffic.js").then(t => {
  t.env.setEnv({ Inputs, html, d3, Plot });
  return t;
})

// Render an Inputs.table for a Traffic object:
quickstart = await t.data.samples.quickstart();
quickstart.table();

// Render a map + metadata card (returns a Promise; Observable awaits it).
// Works with viewof so the cell's value is the Flight itself:
viewof belevingsvlucht = (await t.data.samples.belevingsvlucht()).view();
```

## Field 15 route resolution

Field 15 is the ICAO route string in a flight plan (the part between origin and
destination). `Resolver` parses it and expands airways into sequences of
geographic waypoints using whichever navigation databases you attach.

### Quick start (Observable)

**Step 1 — configure thrust-wasm** (once, in a preamble cell):

```js
// Production: no config needed — the library auto-loads from jsDelivr CDN.

// Development (local static server serving pkg/web/):
traffic.env.setThrustWasm({
  thrustModuleUrl: 'http://localhost:8002/web/thrust_wasm.js',
});
```

`setThrustWasm` affects every resolver and `parseField15` call in the notebook.
Call it before creating any resolver.

**Step 2 — load data sources** (can be done in parallel):

```js
// EUROCONTROL DDR — European airways, navaids, airports
ddr = await traffic.data.eurocontrol.createEurocontrolDdrResolver({
  archive: await FileAttachment('airac_2111.zip').arrayBuffer(),
});

// FAA NASR — US airways, navaids, airports
nasr = await traffic.data.faa.createNasrResolver({
  archiveUrl: 'https://your-server/nasr.zip',
});

// FAA ArcGIS — alternative US source (no archive needed, fetches lazily)
arcgis = await traffic.data.faa.createFaaArcgisResolver();
```

**Step 3 — build a `Resolver`** and attach sources in priority order:

```js
// European-first: DDR wins when both DDR and NASR know a waypoint
resolver = new traffic.data.Resolver().withDdr(ddr).withNasr(nasr);

// US-only:
resolver = new traffic.data.Resolver().withNasr(nasr);

// ArcGIS as secondary US fallback:
resolver = new traffic.data.Resolver()
  .withDdr(ddr)
  .withNasr(nasr)
  .withArcgis(arcgis);
```

**Step 4 — resolve a route**:

```js
route =
  'N0490F360 ELCOB6B ELCOB UT300 SENLO UN502 JSY DCT LIZAD DCT MOPAT ' +
  'DCT LUNIG DCT MOMIN DCT PIKIL/M084F380 NATD HOIST/N0490F380 N756C ' +
  'ANATI/N0441F340 DCT MIVAX DCT OBTEK DCT XORLO ROCKT2';

// Array of { start, end, name? } segment objects:
segments = resolver.enrichRoute(route);

// GeoJSON FeatureCollection of LineString features:
fc = await resolver.enrichRouteAsGeoJSON(route);

// Raw tokenisation (no nav-db needed):
tokens = await resolver.parseField15(route);
```

**Step 5 — visualise with Observable Plot**:

```js
Plot.plot({
  projection: { type: 'mercator', domain: fc },
  marks: [
    Plot.geo(fc, {
      stroke: (d) => d.properties.name ?? 'DCT',
      strokeWidth: 2,
      tip: true,
      title: (d) =>
        `${d.properties.start_name} → ${d.properties.end_name}` +
        (d.properties.name ? ` via ${d.properties.name}` : ' DCT'),
    }),
    Plot.dot(
      segments.flatMap((s) => [s.start, s.end]),
      { x: 'longitude', y: 'latitude', fill: 'kind', r: 3, tip: true }
    ),
  ],
});
```

### Navigation data collections

Each resolver also exposes its underlying navigation database as queryable
collections (Observable bracket-lookup pattern):

```js
// List all airports/navaids/airways/airspaces:
await ddr.airports.data();
await ddr.airways.data();

// Bracket lookup by code:
eham = await ddr.airports['EHAM'];
ut300 = await ddr.airways['UT300'];
lfbb = await ddr.airspaces['LFBB'];

// Search by partial name:
await ddr.navaids.search('JSY');
```

### FAA ArcGIS resolver

```js
arcgis = await traffic.data.faa.createFaaArcgisResolver();
klax = await arcgis.airports['KLAX'];
jfk = await arcgis.airports['KJFK'];
```

### Notes on thrust-wasm builds

The `web/` build of `thrust_wasm.js` must be used for dynamic `import()` in a
browser (Observable, Vite dev, plain `<script type="module">`). The bundler
target (`pkg/thrust_wasm.js`) uses a static `.wasm` import and will not work
when loaded via URL.

To serve locally:

```sh
# from the thrust-wasm pkg directory:
npx serve --cors -p 8002 /path/to/thrust/crates/thrust-wasm/pkg
# then in Observable: traffic.env.setThrustWasm({ thrustModuleUrl: "http://localhost:8002/web/thrust_wasm.js" })
```

## Aircraft information

Country flag, registration, and type are looked up via
[rs1090-wasm](https://github.com/xoolive/rs1090) if available. Loads lazily
and degrades silently to the raw `icao24` hex code when unavailable.

```js
import * as traffic from 'traffic.js';
const info = await traffic.data.aircraftInfo('484506');
// → { icao24: '484506', flag: '🇳🇱', registration: 'PH-TFK', typecode: 'B738', ... }
```

## FAA ArcGIS resolver (navigation collections only)

```js
import * as traffic from 'traffic.js';

const resolver = await traffic.data.faa.createFaaArcgisResolver();
const airports = await resolver.airports.data();
const klax = await resolver.airports['KLAX'];
```

`traffic.data.faa.createFaaArcgisResolver()` auto-loads `thrust-wasm`:

- Node / bundlers: from the installed npm dependency.
- Browser / Observable: from jsDelivr CDN, then unpkg fallback.

## Memo

```sh
npm run build       # build dist/
npm run docs        # generate TypeDoc site in docs/
npm run docs:serve  # generate + serve docs locally on http://localhost:3000
npm run serve       # build and serve dist/ on http://localhost:4000
npm test            # run test suite
npm publish         # publish to npm registry
```
