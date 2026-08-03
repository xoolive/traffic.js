/**
 * Holding pattern detection using a pre-trained ONNX model.
 *
 * Algorithm mirrors the Python `MLHoldingDetection` class in
 * `traffic.algorithms.navigation.holding_pattern`.
 *
 * The model was trained on manually labelled holding patterns for trajectories
 * landing at European airports including London Heathrow.
 *
 * @module
 */

import * as ort from 'onnxruntime-web';

/** Options for {@link holdingPatterns}. */
export interface HoldingPatternOptions {
  /** Duration of each sliding window in milliseconds (default: 6 min). */
  duration?: number;
  /** Step between consecutive windows in milliseconds (default: 2 min). */
  step?: number;
  /** Minimum window duration to consider in milliseconds (default: 5 min). */
  threshold?: number;
  /** Number of points each window is resampled to (default: 30). */
  samples?: number;
  /**
   * Override the base URL (or filesystem path) from which the ONNX model
   * files and ORT WASM workers are loaded.  Accepts either a directory or a
   * full URL to `traffic.js` itself — the filename is stripped automatically.
   *
   * Only needed when the automatic location detection fails, e.g. when
   * traffic.js is loaded via RequireJS / Observable `require()` from a
   * localhost dev server.  In that case call
   * `traffic.setTrafficBaseUrl("http://localhost:8001/traffic.js")` once
   * before using `flight.holdingPattern()`.
   */
  modelPath?: string;
}

/**
 * Unwrap an array of degree values the same way `numpy.unwrap` does.
 *
 * Consecutive differences that exceed ±180° are corrected by adding/subtracting
 * 360°, accumulating the offset for all subsequent samples.
 */
export function unwrapDegrees(angles: number[]): number[] {
  if (angles.length === 0) return [];
  const out = new Array<number>(angles.length);
  out[0] = angles[0];
  let cumOffset = 0;
  for (let i = 1; i < angles.length; i++) {
    const raw = angles[i] - angles[i - 1];
    // Wrap raw difference to (-180, 180]
    const wrapped = ((((raw + 180) % 360) + 360) % 360) - 180;
    cumOffset += wrapped - raw;
    out[i] = angles[i] + cumOffset;
  }
  return out;
}

/**
 * Configure `ort.env.wasm.wasmPaths` so ORT fetches its worker files from the
 * correct location before the first `InferenceSession` is created.
 *
 * ## Why this is necessary
 *
 * `onnxruntime-web` is bundled into `traffic.js` (via `ort.bundle.min.mjs`).
 * The ORT bundle locates its two companion assets —
 * `ort-wasm-simd-threaded.jsep.mjs` (the pthread worker) and
 * `ort-wasm-simd-threaded.jsep.wasm` (the 24 MB WASM binary) — by resolving
 * them relative to `import.meta.url` **inside the ORT bundle code**.
 *
 * When rollup compiles the ORT bundle into `traffic.js` those `import.meta.url`
 * references get rewritten to a UMD shim that evaluates at runtime as:
 *
 * ```js
 * document.currentScript?.src
 *   ?? new URL('traffic.js', document.baseURI).href
 * ```
 *
 * `document.currentScript` is only non-null while a `<script>` tag is being
 * parsed synchronously.  When traffic.js is loaded **dynamically** — via
 * RequireJS / Observable's `require()` — the script tag is injected by the
 * loader and `currentScript` is already `null` by the time the module body
 * runs.  The fallback `new URL('traffic.js', document.baseURI)` then resolves
 * to the **page URL** (e.g. `https://observablehq.com/d/traffic.js`), not to
 * the dev-server origin, causing the WASM fetch to 404 and ORT to report
 * "no available backend found".
 *
 * Setting the `.wasm` entry in `ort.env.wasm.wasmPaths` **before** any session
 * is created overrides the binary's path while preserving the worker module
 * embedded in `ort.bundle.min.mjs`. This matters on hosts such as Observable,
 * whose CSP may reject a cross-origin dynamic import of the external `.mjs`.
 *
 * Safe to call multiple times — no-op after the first successful call.
 */
let _wasmPathsConfigured = false;
function configureOrtWasmPaths(baseDir: string): void {
  if (_wasmPathsConfigured) return;
  _wasmPathsConfigured = true;

  const wasm = pathJoin(baseDir, 'ort-wasm-simd-threaded.jsep.wasm');

  // Do not use a string prefix in browsers. In ORT, a prefix forces a dynamic
  // import of the external .mjs worker. The browser build uses
  // ort.bundle.min.mjs, which already embeds that worker; only its matching
  // WASM binary needs an explicit location. Keeping the worker embedded also
  // avoids CSP failures when traffic.js and its assets are cross-origin.
  //
  // The Node build keeps ORT external, so it still needs both files.
  ort.env.wasm.wasmPaths =
    typeof document === 'undefined'
      ? {
          mjs: pathJoin(baseDir, 'ort-wasm-simd-threaded.jsep.mjs'),
          wasm,
        }
      : { wasm };
}

/**
 * Load an ONNX model.  Before the first session is created, configures ORT's
 * WASM paths so workers are fetched from the right location.
 */
async function loadSession(
  modelFilePath: string,
  baseDir: string
): Promise<ort.InferenceSession> {
  configureOrtWasmPaths(baseDir);
  return ort.InferenceSession.create(modelFilePath);
}

// ---------------------------------------------------------------------------
// Lazy singleton sessions
// ---------------------------------------------------------------------------

let _scalerSession: ort.InferenceSession | null = null;
let _classifierSession: ort.InferenceSession | null = null;
let _modelPath: string | null = null;

/** Module-level base URL override, set by {@link setTrafficBaseUrl}. */
let _trafficBaseUrl: string | null = null;

/**
 * Tell traffic.js where it is being served from.
 *
 * ## When you need this
 *
 * `traffic.js` bundles `onnxruntime-web` and serves two companion files from
 * the same directory: `ort-wasm-simd-threaded.jsep.mjs` (pthread worker) and
 * `ort-wasm-simd-threaded.jsep.wasm` (24 MB WASM binary).  Normally their
 * location is inferred automatically from `import.meta.url`.
 *
 * However, when `traffic.js` is loaded **dynamically** — via Observable's
 * `require()`, RequireJS, or any other async loader — `document.currentScript`
 * is `null` by the time the module body executes.  Rollup's UMD shim for
 * `import.meta.url` then falls back to `new URL('traffic.js', document.baseURI)`,
 * which resolves to the **current page's origin** rather than the server
 * hosting the assets.  ORT tries to fetch its worker files from the wrong
 * domain, fails, and throws "no available backend found".
 *
 * Calling `setTrafficBaseUrl` once — before `flight.holdingPattern()` — tells
 * ORT the correct prefix so all asset fetches go to the right place.
 *
 * ## Usage
 *
 * Pass the full URL to `traffic.js` itself (the trailing filename is stripped
 * automatically) or just the directory:
 *
 * ```js
 * // Observable notebook cell — dev server on :8001
 * t = require("http://localhost:8001/traffic.js").then(t => {
 *   t.setTrafficBaseUrl("http://localhost:8001/traffic.js");
 *   t.setEnv({ Inputs, html, d3, Plot });
 *   return t;
 * })
 * ```
 *
 * When traffic.js is served via a plain `<script>` tag this call is **not**
 * needed — `document.currentScript.src` is available and the location is
 * detected automatically.
 *
 * @param url Full URL to `traffic.js` (or its containing directory).
 */
export function setTrafficBaseUrl(url: string): void {
  // Strip filename if a full file URL was passed.
  _trafficBaseUrl = url.replace(/\/[^/]+\.js$/, '');
  // Invalidate cached sessions so they are recreated with the new WASM path.
  _scalerSession = null;
  _classifierSession = null;
  _modelPath = null;
  _wasmPathsConfigured = false;
}

interface Dirs {
  /** Directory/URL-base containing scaler.onnx and classifier.onnx. */
  modelDir: string;
  /**
   * Directory/URL-base containing traffic.js and the ORT worker assets
   * (ort-wasm-simd-threaded.jsep.mjs / .wasm).
   */
  wasmDir: string;
}

/**
 * Derive both the model directory and the ORT WASM directory.
 *
 * Resolution order:
 * 1. `_trafficBaseUrl` set by {@link setTrafficBaseUrl}
 * 2. `import.meta.url` (works in Node.js and when loaded via `<script>` tag)
 * 3. Scan `document.scripts` for a `<script src>` ending in `traffic.js`
 *    (last-resort browser fallback)
 *
 * - **ts-node ESM (tests):** url = `file:///…/src/core/holdingPattern.ts`
 *   → modelDir = `…/data`, wasmDir = `…/node_modules/onnxruntime-web/dist`
 * - **Node.js CJS bundle:** url = `file:///…/dist/traffic.node.js`
 *   → modelDir = `…/dist`, wasmDir = `…/dist`
 * - **Browser UMD via `<script>` or `setTrafficBaseUrl`:**
 *   → modelDir = `https://…/dist`, wasmDir = `https://…/dist`
 */
function defaultDirs(): Dirs | null {
  // 1. Explicit override.
  if (_trafficBaseUrl !== null) {
    return { modelDir: _trafficBaseUrl, wasmDir: _trafficBaseUrl };
  }

  try {
    const url = import.meta.url;
    // Guard against rollup's broken UMD shim: if the URL contains the
    // Observable/notebook page origin instead of a known traffic.js suffix,
    // fall through to the document.scripts scan below.
    const looksValid =
      url &&
      (url.startsWith('file:') ||
        url.endsWith('/traffic.js') ||
        url.endsWith('/traffic.min.js') ||
        url.endsWith('/traffic.node.js'));

    if (looksValid) {
      const fileDir = url.replace(/\/[^/]+$/, '');

      if (fileDir.startsWith('file:')) {
        const fsDir = fileDir.replace(/^file:\/\//, '');
        const isTsNode = fsDir.includes('/src/core');
        if (isTsNode) {
          const srcRoot = fsDir.replace(/\/src\/core$/, '');
          return {
            modelDir: srcRoot + '/data',
            wasmDir: srcRoot + '/node_modules/onnxruntime-web/dist',
          };
        }
        return { modelDir: fsDir, wasmDir: fsDir };
      }

      return { modelDir: fileDir, wasmDir: fileDir };
    }
  } catch {
    // import.meta.url unavailable — fall through.
  }

  // 3. Scan document.scripts (browser fallback for RequireJS / dynamic loads).
  if (typeof document !== 'undefined' && document.scripts) {
    for (let i = document.scripts.length - 1; i >= 0; i--) {
      const src = document.scripts[i].src;
      if (
        src &&
        (src.endsWith('/traffic.js') || src.endsWith('/traffic.min.js'))
      ) {
        const dir = src.replace(/\/[^/]+$/, '');
        return { modelDir: dir, wasmDir: dir };
      }
    }
  }

  return null;
}

async function getSessions(
  modelPath?: string
): Promise<[ort.InferenceSession, ort.InferenceSession]> {
  const dirs = defaultDirs();
  const modelDir = modelPath ?? dirs?.modelDir ?? null;
  if (modelDir === null) {
    throw new Error(
      'traffic.js: could not determine ONNX model directory from import.meta.url. ' +
        'Pass modelPath explicitly via flight.holdingPattern({ modelPath: "..." }).'
    );
  }
  // wasmDir falls back to modelDir when dirs could not be resolved (e.g.
  // modelPath was supplied manually without a dirs result).
  const wasmDir = dirs?.wasmDir ?? modelDir;

  if (
    _scalerSession === null ||
    _classifierSession === null ||
    modelDir !== _modelPath
  ) {
    _modelPath = modelDir;
    _scalerSession = await loadSession(
      pathJoin(modelDir, 'scaler.onnx'),
      wasmDir
    );
    _classifierSession = await loadSession(
      pathJoin(modelDir, 'classifier.onnx'),
      wasmDir
    );
  }
  return [_scalerSession, _classifierSession];
}

/**
 * Join a base path/URL with a filename.
 * Works for both file-system paths (Node.js) and URL bases (browser).
 */
function pathJoin(base: string, file: string): string {
  // URL: ends with "/" or contains "://"
  if (base.includes('://') || base.endsWith('/')) {
    return base.replace(/\/?$/, '/') + file;
  }
  // File-system path: use "/" separator (works on all platforms in Node.js)
  return base + '/' + file;
}

// ---------------------------------------------------------------------------
// Public API (operates on raw row arrays — Flight imports this)
// ---------------------------------------------------------------------------

/** A single detected holding pattern, as start/stop timestamps. */
export interface HoldingSegment {
  start: Date;
  stop: Date;
}

/**
 * Detect holding patterns in a sequence of flight rows.
 *
 * Rows must have at least `timestamp` (Date) and `track` (number, degrees).
 * The function mirrors the Python `MLHoldingDetection.apply` algorithm exactly:
 *
 * 1. Slide a window of `duration` ms over the flight with `step` ms overlap.
 * 2. Skip windows shorter than `threshold`.
 * 3. Resample each window to `samples` equidistant-in-time points.
 * 4. Compute `track_unwrapped − track_unwrapped[0]` → shape `[1, samples]`.
 * 5. Run through StandardScaler ONNX → MLP classifier ONNX.
 * 6. If prediction rounds to 1: merge with previous segment if contiguous,
 *    otherwise yield the previous segment and start a new one.
 * 7. Yield the final accumulated segment if any.
 *
 * @param rows - Flight rows sorted by timestamp.
 * @param opts - Detection options.
 */
export async function* holdingPatterns(
  rows: Array<Record<string, unknown>>,
  opts: HoldingPatternOptions = {}
): AsyncGenerator<HoldingSegment> {
  const duration = opts.duration ?? 6 * 60 * 1000;
  const step = opts.step ?? 2 * 60 * 1000;
  const threshold = opts.threshold ?? 5 * 60 * 1000;
  const samples = opts.samples ?? 30;

  const [scalerSess, classifierSess] = await getSessions(opts.modelPath);

  const scalerInputName = scalerSess.inputNames[0];
  const classifierInputName = classifierSess.inputNames[0];

  // Sort rows by timestamp once
  const sorted = [...rows].sort(
    (a, b) => +(a.timestamp as Date) - +(b.timestamp as Date)
  );

  if (sorted.length < 2) return;

  const tStart = +(sorted[0].timestamp as Date);
  const tEnd = +(sorted[sorted.length - 1].timestamp as Date);

  let accStart: Date | null = null;
  let accStop: Date | null = null;

  for (let t = tStart; t + duration <= tEnd + 1; t += step) {
    const winStart = t;
    const winEnd = t + duration;

    // Slice the window
    const win = sorted.filter(
      (r) =>
        +(r.timestamp as Date) >= winStart && +(r.timestamp as Date) <= winEnd
    );

    if (win.length < 2) continue;

    const wDuration =
      +(win[win.length - 1].timestamp as Date) - +(win[0].timestamp as Date);
    if (wDuration < threshold) continue;

    // Resample to `samples` equidistant points
    const resampled = resampleRows(win, samples);
    if (resampled === null) continue;

    // Extract track column; skip if any null
    const tracks = resampled.map((r) => r.track as number | null);
    if (tracks.some((v) => v === null || v === undefined || isNaN(v as number)))
      continue;

    // Compute track_unwrapped and subtract first value (feature engineering)
    const unwrapped = unwrapDegrees(tracks as number[]);
    const features = unwrapped.map((v) => v - unwrapped[0]);

    // Build Float32 tensor [1, samples]
    const inputTensor = new ort.Tensor('float32', new Float32Array(features), [
      1,
      samples,
    ]);

    // Scaler
    const scalerOut = await scalerSess.run({ [scalerInputName]: inputTensor });
    const scaled = scalerOut[scalerSess.outputNames[0]];

    // Classifier
    const classifierOut = await classifierSess.run({
      [classifierInputName]: scaled,
    });
    const pred = classifierOut[classifierSess.outputNames[0]]
      .data as Float32Array;
    const isHolding = Math.round(pred[0]) === 1;

    if (isHolding) {
      const wStartDate = win[0].timestamp as Date;
      const wStopDate = win[win.length - 1].timestamp as Date;

      if (accStart === null) {
        accStart = wStartDate;
        accStop = wStopDate;
      } else if (accStop !== null && +wStartDate <= +accStop) {
        // Contiguous — extend the accumulated segment
        accStop = wStopDate;
      } else {
        // Gap — yield current and start fresh
        yield { start: accStart, stop: accStop! };
        accStart = wStartDate;
        accStop = wStopDate;
      }
    }
  }

  if (accStart !== null) {
    yield { start: accStart, stop: accStop! };
  }
}

// ---------------------------------------------------------------------------
// Internal: resample rows to exactly n equidistant-in-time points
// ---------------------------------------------------------------------------

/**
 * Resample an array of rows to exactly `n` points using linear interpolation.
 * Returns `null` if there are fewer than 2 rows.
 */
function resampleRows(
  rows: Array<Record<string, unknown>>,
  n: number
): Array<Record<string, unknown>> | null {
  if (rows.length < 2) return null;
  const t0 = +(rows[0].timestamp as Date);
  const t1 = +(rows[rows.length - 1].timestamp as Date);
  if (t1 === t0) return null;

  const step = (t1 - t0) / (n - 1);
  const result: Array<Record<string, unknown>> = [];

  let i = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * step;

    // Advance i so rows[i].timestamp <= t < rows[i+1].timestamp
    while (i + 1 < rows.length - 1 && +(rows[i + 1].timestamp as Date) <= t)
      i++;

    const a = rows[i];
    const b = rows[Math.min(i + 1, rows.length - 1)];
    const ta = +(a.timestamp as Date);
    const tb = +(b.timestamp as Date);
    const frac = tb === ta ? 0 : (t - ta) / (tb - ta);

    const interpolated: Record<string, unknown> = {};
    for (const key of Object.keys(a)) {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') {
        interpolated[key] = av + (bv - av) * frac;
      } else {
        interpolated[key] = av;
      }
    }
    interpolated['timestamp'] = new Date(t);
    result.push(interpolated);
  }

  return result;
}
