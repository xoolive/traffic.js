export const THRUST_WASM_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/thrust-wasm@latest/web/thrust_wasm.js',
  'https://unpkg.com/thrust-wasm@latest/web/thrust_wasm.js',
  'https://cdn.jsdelivr.net/npm/thrust-wasm@latest/esm/thrust_wasm.js',
  'https://unpkg.com/thrust-wasm@latest/esm/thrust_wasm.js',
] as const;

export interface LoadThrustWasmModuleOptions<TModule> {
  thrustModule?: TModule;
  thrustModuleUrl?: string;
  autoLoadThrustModule?: boolean;
  relativeFallback?: string;
}

export async function loadThrustWasmModule<TModule>(
  options: LoadThrustWasmModuleOptions<TModule>
): Promise<TModule | undefined> {
  if (options.thrustModule) {
    return options.thrustModule;
  }
  if (options.autoLoadThrustModule === false) {
    return undefined;
  }

  const maybeImport = async (
    specifier: string,
    resolveRelative: boolean
  ): Promise<TModule | undefined> => {
    try {
      const target = resolveRelative ? new URL(specifier, import.meta.url).toString() : specifier;
      return (await import(target)) as TModule;
    } catch {
      return undefined;
    }
  };

  if (options.thrustModuleUrl) {
    const isRelative =
      options.thrustModuleUrl.startsWith('./') ||
      options.thrustModuleUrl.startsWith('../') ||
      options.thrustModuleUrl.startsWith('/');
    return maybeImport(options.thrustModuleUrl, isRelative);
  }

  const isNode =
    typeof process !== 'undefined' &&
    typeof process.versions === 'object' &&
    !!process.versions?.node;

  if (isNode) {
    return (
      (await maybeImport('thrust-wasm/nodejs', false)) ??
      (await maybeImport('thrust-wasm', false)) ??
      (options.relativeFallback
        ? await maybeImport(options.relativeFallback, true)
        : undefined)
    );
  }

  const browserModule =
    (await maybeImport('thrust-wasm', false)) ??
    (await maybeImport('thrust-wasm/web', false));

  if (browserModule) {
    return browserModule;
  }

  for (const cdnUrl of THRUST_WASM_CDN_URLS) {
    const moduleFromCdn = await maybeImport(cdnUrl, false);
    if (moduleFromCdn) {
      return moduleFromCdn;
    }
  }

  if (options.relativeFallback) {
    return maybeImport(options.relativeFallback, true);
  }

  return undefined;
}
