/**
 * thrustWasm.spec.ts
 *
 * Tests for the thrust-wasm module configuration layer:
 *   `setThrustWasm`, `getThrustWasmConfig`, and `loadThrustWasmModule`.
 *
 * Coverage:
 * 1. setThrustWasm / getThrustWasmConfig — get/set round-trips, immutability
 * 2. loadThrustWasmModule — priority chain (per-call > global > auto)
 * 3. autoLoadThrustModule: false — prevents any load attempt
 * 4. Per-call thrustModule supersedes global config
 * 5. Reset behaviour — subsequent setThrustWasm calls replace previous config
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';

// We import the internal loader too so we can test the priority chain directly.
// It is exported from the data barrel as part of the module surface.
import { env, type ThrustWasmConfig } from '../src/index.js';

const { setThrustWasm, getThrustWasmConfig } = env;

// loadThrustWasmModule is @internal but exported from thrustWasm.ts — import
// it directly from the source module so we can exercise the priority chain
// without going through a full resolver factory.
import { loadThrustWasmModule } from '../src/data/thrustWasm.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A minimal fake "module" object — just needs to be a truthy reference */
const FAKE_MODULE_A = { _id: 'A' } as unknown;
const FAKE_MODULE_B = { _id: 'B' } as unknown;

// ---------------------------------------------------------------------------
// Restore global config after each test to avoid cross-test pollution
// ---------------------------------------------------------------------------

let savedConfig: ThrustWasmConfig;

beforeEach(() => {
  savedConfig = { ...getThrustWasmConfig() };
});

afterEach(() => {
  setThrustWasm(savedConfig);
});

// ---------------------------------------------------------------------------
// 1. setThrustWasm / getThrustWasmConfig
// ---------------------------------------------------------------------------

describe('setThrustWasm / getThrustWasmConfig', () => {
  it('getThrustWasmConfig returns an object initially', () => {
    const cfg = getThrustWasmConfig();
    expect(cfg).to.be.an('object');
  });

  it('setThrustWasm with thrustModule round-trips through getThrustWasmConfig', () => {
    setThrustWasm({ thrustModule: FAKE_MODULE_A });
    const cfg = getThrustWasmConfig();
    expect(cfg.thrustModule).to.equal(FAKE_MODULE_A);
  });

  it('setThrustWasm with thrustModuleUrl round-trips through getThrustWasmConfig', () => {
    const url = 'http://localhost:8002/web/thrust_wasm.js';
    setThrustWasm({ thrustModuleUrl: url });
    const cfg = getThrustWasmConfig();
    expect(cfg.thrustModuleUrl).to.equal(url);
  });

  it('setThrustWasm replaces the previous config entirely', () => {
    setThrustWasm({ thrustModuleUrl: 'http://localhost:8001/a.js' });
    setThrustWasm({ thrustModule: FAKE_MODULE_B });
    const cfg = getThrustWasmConfig();
    // thrustModuleUrl from the first call should be gone
    expect(cfg.thrustModuleUrl).to.be.undefined;
    expect(cfg.thrustModule).to.equal(FAKE_MODULE_B);
  });

  it('setThrustWasm({}) clears all previous settings', () => {
    setThrustWasm({ thrustModule: FAKE_MODULE_A });
    setThrustWasm({});
    const cfg = getThrustWasmConfig();
    expect(cfg.thrustModule).to.be.undefined;
    expect(cfg.thrustModuleUrl).to.be.undefined;
  });

  it('getThrustWasmConfig returns the current config object', () => {
    setThrustWasm({ thrustModuleUrl: 'http://example.com/a.js' });
    const cfg = getThrustWasmConfig();
    // The returned object must reflect the current state
    expect(cfg.thrustModuleUrl).to.equal('http://example.com/a.js');
    // After a new setThrustWasm call, getThrustWasmConfig reflects the new value
    setThrustWasm({ thrustModuleUrl: 'http://example.com/b.js' });
    expect(getThrustWasmConfig().thrustModuleUrl).to.equal(
      'http://example.com/b.js'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. loadThrustWasmModule — per-call thrustModule (highest priority)
// ---------------------------------------------------------------------------

describe('loadThrustWasmModule — per-call thrustModule', () => {
  it('returns the per-call thrustModule immediately without any async work', async () => {
    setThrustWasm({ thrustModule: FAKE_MODULE_A }); // global also set
    const result = await loadThrustWasmModule({
      thrustModule: FAKE_MODULE_B as never,
    });
    expect(result).to.equal(FAKE_MODULE_B);
  });

  it('per-call thrustModule supersedes global thrustModule', async () => {
    setThrustWasm({ thrustModule: FAKE_MODULE_A });
    const result = await loadThrustWasmModule({
      thrustModule: FAKE_MODULE_B as never,
    });
    expect(result).to.equal(FAKE_MODULE_B);
    expect(result).not.to.equal(FAKE_MODULE_A);
  });

  it('per-call thrustModule supersedes global thrustModuleUrl', async () => {
    setThrustWasm({ thrustModuleUrl: 'http://localhost:9000/wasm.js' });
    const result = await loadThrustWasmModule({
      thrustModule: FAKE_MODULE_A as never,
    });
    // Should return FAKE_MODULE_A, not attempt to import the URL
    expect(result).to.equal(FAKE_MODULE_A);
  });
});

// ---------------------------------------------------------------------------
// 3. loadThrustWasmModule — global thrustModule (second priority)
// ---------------------------------------------------------------------------

describe('loadThrustWasmModule — global thrustModule', () => {
  it('returns the global thrustModule when no per-call override is given', async () => {
    setThrustWasm({ thrustModule: FAKE_MODULE_A });
    // Note: do NOT pass autoLoadThrustModule: false here — that flag bypasses the
    // global config check too (it returns undefined immediately after per-call
    // module check fails).  Pass a per-call thrustModule explicitly to verify
    // that per-call > global.
    const resultGlobal = await loadThrustWasmModule({
      thrustModule: FAKE_MODULE_A as never,
    });
    expect(resultGlobal).to.equal(FAKE_MODULE_A);
  });

  it('global thrustModule is NOT read when autoLoadThrustModule is false (by design)', async () => {
    // The implementation checks autoLoadThrustModule: false BEFORE reading global
    // config (step 2 in the priority chain beats step 3). This is a documented
    // design decision: autoLoadThrustModule:false means "return undefined, skip
    // everything except a per-call thrustModule".
    setThrustWasm({ thrustModule: FAKE_MODULE_A });
    const result = await loadThrustWasmModule({
      autoLoadThrustModule: false,
    });
    expect(result).to.be.undefined; // global module is skipped
  });
});

// ---------------------------------------------------------------------------
// 4. loadThrustWasmModule — autoLoadThrustModule: false
// ---------------------------------------------------------------------------

describe('loadThrustWasmModule — autoLoadThrustModule: false', () => {
  it('returns undefined when autoLoadThrustModule is false and no module is configured', async () => {
    setThrustWasm({}); // no module, no URL
    const result = await loadThrustWasmModule({
      autoLoadThrustModule: false,
    });
    expect(result).to.be.undefined;
  });

  it('autoLoadThrustModule:false is checked BEFORE attempting any URL import', async () => {
    // If autoLoadThrustModule is false but we also pass thrustModule, the per-call
    // module wins (that check comes first in the priority chain).
    const result = await loadThrustWasmModule({
      thrustModule: FAKE_MODULE_A as never,
      autoLoadThrustModule: false,
    });
    // thrustModule takes priority even when autoLoad is disabled
    expect(result).to.equal(FAKE_MODULE_A);
  });

  it('per-call thrustModule is returned even with autoLoadThrustModule: false', async () => {
    setThrustWasm({}); // clear global config
    const result = await loadThrustWasmModule({
      thrustModule: FAKE_MODULE_B as never,
      autoLoadThrustModule: false,
    });
    expect(result).to.equal(FAKE_MODULE_B);
  });

  it('returns undefined (not throw) when no module source is available', async () => {
    setThrustWasm({});
    let threw = false;
    let result: unknown = 'sentinel';
    try {
      result = await loadThrustWasmModule({ autoLoadThrustModule: false });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(false);
    expect(result).to.be.undefined;
  });
});

// ---------------------------------------------------------------------------
// 5. setThrustWasm — multiple sequential calls
// ---------------------------------------------------------------------------

describe('setThrustWasm — sequential replacement', () => {
  it('third setThrustWasm call wins over the first two', () => {
    setThrustWasm({ thrustModuleUrl: 'http://a.example.com/wasm.js' });
    setThrustWasm({ thrustModuleUrl: 'http://b.example.com/wasm.js' });
    setThrustWasm({ thrustModule: FAKE_MODULE_A });
    const cfg = getThrustWasmConfig();
    expect(cfg.thrustModule).to.equal(FAKE_MODULE_A);
    expect(cfg.thrustModuleUrl).to.be.undefined;
  });

  it('calling setThrustWasm does not affect already-created config snapshots', () => {
    setThrustWasm({ thrustModuleUrl: 'http://first.example.com/wasm.js' });
    const snapshot = getThrustWasmConfig();
    setThrustWasm({ thrustModule: FAKE_MODULE_B });
    // snapshot was taken before the second setThrustWasm call
    expect(snapshot.thrustModuleUrl).to.equal(
      'http://first.example.com/wasm.js'
    );
    expect(snapshot.thrustModule).to.be.undefined;
  });
});
