import json from '@rollup/plugin-json';
import bundleSize from 'rollup-plugin-bundle-size';
import serve from 'rollup-plugin-serve';
import typescript from 'rollup-plugin-typescript2';

import { nodeResolve } from '@rollup/plugin-node-resolve';
import { terser } from 'rollup-plugin-terser';

import pkg from './package.json';

function onwarn(warning, defaultHandler) {
  if (warning.code !== 'CIRCULAR_DEPENDENCY') {
    defaultHandler(warning);
  }
}

const name = 'traffic';
const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
];

let plugins = [
  json(),
  bundleSize(),
  nodeResolve({ modulesOnly: true }),
  typescript({
    typescript: require('typescript'),
    clean: true,
  }),
];

if (process.env.SERVE) {
  plugins = plugins.concat(
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
  '@turf/turf': 'turf',
};

export default [
  {
    input: 'src/index.ts',
    external,
    plugins,
    onwarn,
    output: [
      {
        file: pkg.main,
        format: 'cjs',
        name,
      },
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
