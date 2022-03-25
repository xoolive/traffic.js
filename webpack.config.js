import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  mode: 'development',
  entry: './src/index.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'traffic.js',
    path: path.resolve(__dirname, 'dist'),
    library: { type: 'umd', name: 'traffic' },
  },
  /*experiments: {
    asyncWebAssembly: true,
  },*/
};

export default config;
