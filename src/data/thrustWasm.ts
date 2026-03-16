// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Global configuration for the thrust-wasm WebAssembly module.
 *
 * Pass to {@link setThrustWasm} once at startup. All resolver factories
 * (`createEurocontrolDdrResolver`, `createNasrResolver`, …) and the
 * standalone {@link parseField15} function read this config automatically —
 * no per-call options needed.
 *
 * ### Which build to serve
 *
 * Always use the **`web/`** or **`esm/`** build of thrust-wasm, not the
 * bundler target. The bundler target (`thrust_wasm.js` at the package root)
 * uses a static `import … from "./thrust_wasm_bg.wasm"` that cannot be
 * dynamically imported in a browser.
 *
 * The `web/` build (`pkg/web/thrust_wasm.js`) is self-contained: it fetches
 * the `.wasm` binary relative to itself and works with a plain static-file
 * server.
 *
 * @example
 * // Production — no config needed.
 * // The library auto-loads thrust-wasm@latest from jsDelivr CDN.
 *
 * @example
 * // Development — serve pkg/web/ locally (e.g. with `npx serve --cors -p 8002`):
 * traffic.setThrustWasm({ thrustModuleUrl: "http://localhost:8002/web/thrust_wasm.js" })
 *
 * @example
 * // Pre-load the module yourself (e.g. when you need to control timing):
 * const mod = await import("http://localhost:8002/web/thrust_wasm.js")
 * await mod.default()   // init the WASM binary before handing it in
 * traffic.setThrustWasm({ thrustModule: mod })
 */
export interface ThrustWasmConfig {
  /**
   * A pre-loaded, already-initialised thrust-wasm module object.
   * Takes priority over `thrustModuleUrl` and the auto-load fallback.
   */
  thrustModule?: unknown;
  /**
   * URL of a `thrust_wasm.js` file from the `web/` or `esm/` build.
   * The module is imported lazily on first use and cached for the lifetime
   * of the page.
   */
  thrustModuleUrl?: string;
}

let _config: ThrustWasmConfig = {};

/**
 * Configure the thrust-wasm WebAssembly module for the entire traffic.js library.
 *
 * Call this **once** before creating any resolver or calling `parseField15`.
 * Subsequent calls replace the previous configuration entirely.
 *
 * In production you typically do not need to call this — the library will
 * auto-load `thrust-wasm@latest` from the jsDelivr CDN. Call it only when
 * you need to pin a specific version or serve the module from a local dev
 * server.
 *
 * @example
 * // Observable notebook preamble — dev mode:
 * traffic.setThrustWasm({ thrustModuleUrl: "http://localhost:8002/web/thrust_wasm.js" })
 *
 * // Everything else just works with no extra options:
 * ddr  = await traffic.createEurocontrolDdrResolver({ archive: … })
 * nasr = await traffic.createNasrResolver({ archiveUrl: "…/nasr.zip" })
 * tokens = await traffic.parseField15("LFPG DCT LACOU UM184 VEBIT DCT LFLL")
 */
export function setThrustWasm(config: ThrustWasmConfig): void {
  _config = { ...config };
}

/**
 * Return the current global thrust-wasm configuration.
 * @internal
 */
export function getThrustWasmConfig(): ThrustWasmConfig {
  return _config;
}

// ---------------------------------------------------------------------------
// CDN fallback URLs — web/ build, compatible with dynamic import()
// ---------------------------------------------------------------------------

/** @internal */
export const THRUST_WASM_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/thrust-wasm@latest/web/thrust_wasm.js',
  'https://unpkg.com/thrust-wasm@latest/web/thrust_wasm.js',
] as const;

// ---------------------------------------------------------------------------
// Per-call options (override the global config for a single resolver call)
// ---------------------------------------------------------------------------

/**
 * Per-call thrust-wasm module overrides.
 *
 * These options are accepted by every resolver factory and by `parseField15`.
 * They take priority over the global config set via {@link setThrustWasm} but
 * are otherwise identical in semantics.
 *
 * Prefer {@link setThrustWasm} for notebook-wide configuration; use these
 * options only when you need to load a different build for a single resolver.
 */
export interface LoadThrustWasmModuleOptions<TModule> {
  /** Override: use this pre-loaded module object for this call only. */
  thrustModule?: TModule;
  /** Override: load from this URL for this call only. */
  thrustModuleUrl?: string;
  /**
   * Set to `false` to prevent any auto-loading attempt.
   * The call returns `undefined` instead of trying the CDN.
   * Useful in test environments where no network is available.
   */
  autoLoadThrustModule?: boolean;
  /** @internal Node.js-only fallback path relative to this source file. */
  relativeFallback?: string;
}

// ---------------------------------------------------------------------------
// Loader (internal)
// ---------------------------------------------------------------------------

/**
 * Resolve and return the thrust-wasm module, following this priority chain:
 *
 * 1. `options.thrustModule`    — per-call pre-loaded object
 * 2. `options.thrustModuleUrl` — per-call URL (throws on failure)
 * 3. Global `setThrustWasm({ thrustModule })` — process-wide pre-loaded object
 * 4. Global `setThrustWasm({ thrustModuleUrl })` — process-wide URL (throws on failure)
 * 5. Auto-load: Node.js → `thrust-wasm/nodejs`; browser → jsDelivr → unpkg
 *
 * Returns `undefined` only when `autoLoadThrustModule === false`.
 *
 * @internal
 */
export async function loadThrustWasmModule<TModule>(
  options: LoadThrustWasmModuleOptions<TModule> = {}
): Promise<TModule | undefined> {
  // 1. Explicit per-call module
  if (options.thrustModule) {
    return options.thrustModule as TModule;
  }

  if (options.autoLoadThrustModule === false) {
    return undefined;
  }

  const importUrl = async (url: string, label: string): Promise<TModule> => {
    try {
      return (await import(/* @vite-ignore */ url)) as TModule;
    } catch (err) {
      throw new Error(
        `Failed to load thrust-wasm module from ${label} "${url}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const tryImport = async (url: string): Promise<TModule | undefined> => {
    try {
      return (await import(/* @vite-ignore */ url)) as TModule;
    } catch {
      return undefined;
    }
  };

  // 2. Explicit per-call URL
  if (options.thrustModuleUrl) {
    return importUrl(options.thrustModuleUrl, 'thrustModuleUrl');
  }

  // 3. Global config
  if (_config.thrustModule) {
    return _config.thrustModule as TModule;
  }
  if (_config.thrustModuleUrl) {
    return importUrl(
      _config.thrustModuleUrl,
      'setThrustWasm({ thrustModuleUrl })'
    );
  }

  // 4. Auto-load fallback.
  const isNode =
    typeof process !== 'undefined' &&
    typeof process.versions === 'object' &&
    !!process.versions?.node;

  if (isNode) {
    return (
      (await tryImport('thrust-wasm/nodejs')) ??
      (await tryImport('thrust-wasm')) ??
      (options.relativeFallback
        ? await tryImport(
            new URL(options.relativeFallback, import.meta.url).toString()
          )
        : undefined)
    );
  }

  for (const url of THRUST_WASM_CDN_URLS) {
    const mod = await tryImport(url);
    if (mod) {
      return mod;
    }
  }

  if (options.relativeFallback) {
    return await tryImport(
      new URL(options.relativeFallback, import.meta.url).toString()
    );
  }

  return undefined;
}
