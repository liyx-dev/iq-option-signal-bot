// ============================================================
// DUKASCOPY — RETIRED
//
// The free freeserv.dukascopy.com JSON REST API used by the
// previous version of this provider is no longer operational
// (confirmed Aug 2026: 1495 consecutive failures, 0 successes
// ever recorded in provider_state). Dukascopy's current free
// data access is raw historical .bi5 tick files over a totally
// different binary protocol, not worth building against for a
// live 1-minute signal engine.
//
// Kept as a stub (rather than removing the import everywhere)
// so the fallback chain in data-orchestrator.js doesn't need to
// change shape, and so a future working endpoint can be dropped
// in here without touching any other file. It fails IMMEDIATELY
// with no network call, so it costs nothing in the fallback chain.
// ============================================================
export class DukascopyProvider {
  constructor(env, config) {
    this.config = config;
    this.name = "dukascopy";
  }

  async historical() {
    return { ok: false, error: "Dukascopy free API retired — provider disabled", latencyMs: 0 };
  }
}
