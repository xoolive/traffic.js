import json from '@rollup/plugin-json';
import bundleSize from 'rollup-plugin-bundle-size';
import serve from 'rollup-plugin-serve';
import typescript from 'rollup-plugin-typescript2';

import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const pkg = _require('./package.json');

/**
 * Rollup plugin that resolves `onnxruntime-web` to the pre-bundled browser
 * distribution (`ort.bundle.min.mjs`), which inlines the WASM binary as a
 * data URL so no extra `.wasm` files need to be served.
 */
function ortBrowserPlugin() {
  const path = _require('path');
  // Locate node_modules/onnxruntime-web by walking up from the resolved main
  // CJS entry.  Avoid require.resolve('onnxruntime-web/package.json') because
  // that subpath is blocked by the package exports map in newer Node versions.
  const ortMain = _require.resolve('onnxruntime-web');
  // ortMain is something like .../onnxruntime-web/dist/ort.node.min.js
  const ortRoot = path.resolve(path.dirname(ortMain), '..');
  const bundlePath = path.join(ortRoot, 'dist', 'ort.bundle.min.mjs');
  return {
    name: 'ort-browser',
    resolveId(id) {
      if (id === 'onnxruntime-web') return bundlePath;
      return null;
    },
  };
}

function onwarn(warning, defaultHandler) {
  if (warning.code !== 'CIRCULAR_DEPENDENCY') {
    defaultHandler(warning);
  }
}

const name = 'traffic';

// For the Node.js CJS build: all dependencies are external (loaded from node_modules)
const nodeExternal = [
  ...Object.keys(pkg.dependencies || {}).filter((d) => d !== '@turf/turf'),
  ...Object.keys(pkg.peerDependencies || {}),
];

// For the browser UMD builds: bundle onnxruntime-web (it cannot be loaded as a
// global in Observable/browser), keep the rest external as UMD globals.
const browserBundledDeps = new Set(['onnxruntime-web', 'osmtogeojson']);
const browserExternal = nodeExternal.filter((d) => !browserBundledDeps.has(d));

const thrustWasmRange = String(pkg.dependencies?.['thrust-wasm'] ?? '');
const thrustWasmVersion =
  thrustWasmRange.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/)?.[0] ?? '0.2.2';

let basePlugins = [
  json(),
  replace({
    preventAssignment: true,
    values: {
      'process.env.THRUST_WASM_DEFAULT_VERSION':
        JSON.stringify(thrustWasmVersion),
    },
  }),
  bundleSize(),
  typescript({
    typescript: require('typescript'),
    clean: true,
  }),
];

// Node plugin: prefers the "node" export condition so ort.node.min.mjs is used.
const nodePlugins = [...basePlugins, nodeResolve(), commonjs()];

// Browser plugin: ortBrowserPlugin() hard-wires onnxruntime-web to the
// pre-bundled ort.bundle.min.mjs (WASM inlined as a data URL).
// nodeResolve keeps modulesOnly:true so CJS-only @turf sub-packages that were
// previously excluded remain excluded.
const browserPlugins = [
  ortBrowserPlugin(),
  ...basePlugins,
  nodeResolve({ browser: true }),
  commonjs(),
];

if (process.env.SERVE) {
  browserPlugins.push(
    serve({
      open: false,
      host: 'localhost',
      port: 4000,
      contentBase: ['./dist'],
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  );
}

const globals = {
  arquero: 'aq',
  d3: 'd3',
  fflate: 'fflate',
  'simplify-js': 'simplify-js',
};

export default [
  // ── Node.js CJS build (traffic.node.js) ──────────────────────────────────
  // onnxruntime-web stays external; Node resolves it from node_modules at
  // runtime using the "node" export condition (ort.node.min.js).
  {
    input: 'src/index.ts',
    external: nodeExternal,
    plugins: nodePlugins,
    onwarn,
    output: [
      {
        file: pkg.main,
        format: 'cjs',
        name,
      },
    ],
  },

  // ── Browser UMD builds (traffic.js + traffic.min.js) ─────────────────────
  // onnxruntime-web is bundled in (nodeResolve picks the "browser" export
  // condition → ort.bundle.min.mjs, which has WASM inlined as a data URL).
  {
    input: 'src/index.ts',
    external: browserExternal,
    plugins: browserPlugins,
    onwarn,
    output: [
      { file: pkg.module, format: 'umd', name, globals },
      {
        file: pkg.unpkg,
        format: 'umd',
        sourcemap: true,
        plugins: [terser({ ecma: 2020 })],
        name,
        globals,
      },
    ],
  },
];
