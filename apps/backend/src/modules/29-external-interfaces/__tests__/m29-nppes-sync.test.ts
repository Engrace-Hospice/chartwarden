// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T07 NPPES sync unit tests (§4.4, W-XI-11/12).
// Every pure core + the injected-port orchestrator: Luhn validation, the public-API projection/classifier,
// the token-bucket rate limiter, the retry/backoff client, the cache field-level diff, and the sync
// orchestrator (happy path, A→D deactivation once-only, unchanged emits nothing, circuit breaker, the
// W-XI-12 platform-only trigger refusal).
import { describe, expect, it } from "vitest";
import { isValidNpi } from "../nppes/npi-validate";
import { type HttpFetchResponse, NppesClient } from "../nppes/nppes-client";
import type { NppesFetchPort } from "../nppes/nppes-client";
import { type CachedProviderView, decideCacheUpsert, toSnapshot } from "../nppes/provider-cache";
import type { CacheUpsertDecision, ProviderCachePort } from "../nppes/provider-cache";
import { RateLimiter } from "../nppes/rate-limiter";
import {
  type NppesApiResponse,
  classifyNppesResponse,
  primaryTaxonomyCode,
  projectProvider,
} from "../nppes/response-projection";
import type { NppesFetchResult, NppesIndividualProvider } from "../nppes/response-projection";
import type { NppesOutboxEvent, NppesOutboxSink } from "../nppes/sync-events";
import {
  NPPES_CIRCUIT_BREAKER_CONSECUTIVE_FAILURES,
  type NppesNpiSourcePort,
  NppesSyncOrchestrator,
  type NppesSyncRequest,
  type NppesSyncRunStorePort,
  NppesTenantTriggerRefusedError,
  type SyncRunCounts,
} from "../nppes/sync-orchestrator";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

const VALID_A = "1234567893"; // canonical valid CMS test NPI
const VALID_B = "1245319599";

function providerFound(npi: string, basicOver: Record<string, unknown> = {}): NppesApiResponse {
  return {
    result_count: 1,
    results: [
      {
        number: npi,
        enumeration_type: "NPI-1",
        basic: { first_name: "JANE", last_name: "DOE", credential: "MD", ...basicOver },
        taxonomies: [{ code: "207R00000X", desc: "Internal Medicine", primary: true }],
      },
    ],
  };
}

function mkProvider(over: Partial<NppesIndividualProvider> = {}): NppesIndividualProvider {
  return {
    npi: VALID_A,
    enumerationType: "NPI-1",
    status: "active",
    enumerationDate: "2010-01-01",
    lastUpdated: "2026-01-01",
    deactivationDate: null,
    deactivationReason: null,
    reactivationDate: null,
    basic: {
      firstName: "JANE",
      middleName: null,
      lastName: "DOE",
      credential: "MD",
      gender: "F",
      namePrefix: null,
      nameSuffix: null,
      soleProprietor: null,
    },
    addresses: [],
    taxonomies: [
      {
        code: "207R00000X",
        desc: "Internal Medicine",
        primary: true,
        state: null,
        licenseNumber: null,
      },
    ],
    identifiers: [],
    ...over,
  };
}

// ── Luhn NPI validation (§2.1) ───────────────────────────────────────────────────────────────────────

describe("isValidNpi — CMS Luhn mod-10", () => {
  it("accepts valid NPIs", () => {
    expect(isValidNpi(VALID_A)).toBe(true);
    expect(isValidNpi(VALID_B)).toBe(true);
  });
  it("rejects a bad check digit", () => {
    expect(isValidNpi("1234567890")).toBe(false);
    expect(isValidNpi("0000000000")).toBe(false);
  });
  it("rejects non-10-digit / non-numeric", () => {
    expect(isValidNpi("123")).toBe(false);
    expect(isValidNpi("12345678901")).toBe(false);
    expect(isValidNpi("123abc7893")).toBe(false);
    expect(isValidNpi("")).toBe(false);
  });
});

// ── response projection / classification (§2.1) ────────────────────────────────────────────────────────

describe("classifyNppesResponse", () => {
  it("empty result set → not_found", () => {
    expect(classifyNppesResponse(VALID_A, { result_count: 0, results: [] }).kind).toBe("not_found");
    expect(classifyNppesResponse(VALID_A, {}).kind).toBe("not_found");
  });
  it("NPI-2 → organization_skipped", () => {
    const resp: NppesApiResponse = {
      result_count: 1,
      results: [{ number: VALID_A, enumeration_type: "NPI-2" }],
    };
    expect(classifyNppesResponse(VALID_A, resp).kind).toBe("organization_skipped");
  });
  it("active NPI-1 → found with projected fields", () => {
    const res = classifyNppesResponse(VALID_A, providerFound(VALID_A));
    expect(res.kind).toBe("found");
    if (res.kind !== "found") throw new Error("unreachable");
    expect(res.provider.basic.lastName).toBe("DOE");
    expect(res.provider.status).toBe("active");
    expect(primaryTaxonomyCode(res.provider)).toBe("207R00000X");
  });
  it("status D → deactivated", () => {
    const resp: NppesApiResponse = {
      result_count: 1,
      results: [
        {
          number: VALID_A,
          enumeration_type: "NPI-1",
          basic: {
            first_name: "JANE",
            last_name: "DOE",
            status: "D",
            deactivation_reason: "DEATH",
            deactivation_date: "2026-06-01",
          },
        },
      ],
    };
    const res = classifyNppesResponse(VALID_A, resp);
    expect(res.kind).toBe("deactivated");
    if (res.kind !== "deactivated") throw new Error("unreachable");
    expect(res.provider.deactivationReason).toBe("DEATH");
  });
  it("projectProvider defends against missing sub-objects", () => {
    const p = projectProvider(VALID_A, { number: VALID_A, enumeration_type: "NPI-1" });
    expect(p.basic.firstName).toBe("");
    expect(p.addresses).toEqual([]);
    expect(p.status).toBe("active");
  });
});

// ── rate limiter (§2.3) ───────────────────────────────────────────────────────────────────────────────

describe("RateLimiter token bucket", () => {
  it("consumes burst without sleeping, then throttles at rps", async () => {
    let clock = 1_000;
    const slept: number[] = [];
    const limiter = new RateLimiter({
      rps: 4,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms; // fake sleep advances the clock so a token refills
      },
    });
    for (let i = 0; i < 4; i++) await limiter.acquire(); // burst = capacity 4
    expect(slept).toHaveLength(0);
    await limiter.acquire(); // 5th must wait for a refill
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(250); // 1 token / (4/1000 per ms) = 250ms
  });
});

// ── client retry / backoff (§2.2) ─────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown): HttpFetchResponse {
  return { status: 200, ok: true, json: async () => body };
}
function statusResponse(status: number): HttpFetchResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => ({}) };
}

describe("NppesClient", () => {
  it("Luhn-invalid NPI short-circuits without a request", async () => {
    let calls = 0;
    const client = new NppesClient({
      fetch: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    const res = await client.fetchByNpi("0000000000");
    expect(res.kind).toBe("invalid_format");
    expect(calls).toBe(0);
  });

  it("429 then 429 then 200 → found after backoff (3 calls)", async () => {
    const seq = [statusResponse(429), statusResponse(429), jsonResponse(providerFound(VALID_A))];
    let i = 0;
    const client = new NppesClient({
      fetch: async () => seq[i++] ?? statusResponse(500),
      sleep: async () => undefined,
    });
    const res = await client.fetchByNpi(VALID_A);
    expect(res.kind).toBe("found");
    expect(i).toBe(3);
  });

  it("exhausts retries on persistent 429 → throws", async () => {
    const client = new NppesClient({
      fetch: async () => statusResponse(429),
      maxRetries: 3,
      sleep: async () => undefined,
    });
    await expect(client.fetchByNpi(VALID_A)).rejects.toThrow(/rate_limited/);
  });

  it("5xx is retried; a final 5xx throws server_error", async () => {
    const client = new NppesClient({
      fetch: async () => statusResponse(503),
      maxRetries: 1,
      sleep: async () => undefined,
    });
    await expect(client.fetchByNpi(VALID_A)).rejects.toThrow(/server_error/);
  });
});

// ── cache diff (§4.7.1) ───────────────────────────────────────────────────────────────────────────────

describe("decideCacheUpsert", () => {
  it("no prior row → inserted", () => {
    const d = decideCacheUpsert(null, mkProvider());
    expect(d.action).toBe("inserted");
    expect(d.priorStatus).toBeNull();
  });
  it("identical row → unchanged, no changed fields", () => {
    const existing: CachedProviderView = {
      status: "active",
      firstName: "JANE",
      lastName: "DOE",
      credential: "MD",
      specialtyTaxonomy: "207R00000X",
      deactivationDate: null,
      deactivationReason: null,
    };
    expect(decideCacheUpsert(existing, mkProvider()).action).toBe("unchanged");
  });
  it("name change → updated with the M40-syncable field name", () => {
    const existing: CachedProviderView = {
      status: "active",
      firstName: "JANE",
      lastName: "SMITH",
      credential: "MD",
      specialtyTaxonomy: "207R00000X",
      deactivationDate: null,
      deactivationReason: null,
    };
    const d = decideCacheUpsert(existing, mkProvider());
    expect(d.action).toBe("updated");
    expect(d.changedFields).toContain("lastName");
  });
  it("toSnapshot exposes the four M40-syncable fields", () => {
    expect(toSnapshot(mkProvider())).toEqual({
      firstName: "JANE",
      lastName: "DOE",
      credentials: "MD",
      specialtyTaxonomy: "207R00000X",
    });
  });
});

// ── orchestrator (§4.4, W-XI-11/12) ───────────────────────────────────────────────────────────────────

class FakeOutbox implements NppesOutboxSink {
  readonly events: NppesOutboxEvent[] = [];
  async publish(event: NppesOutboxEvent): Promise<void> {
    this.events.push(event);
  }
  names(): string[] {
    return this.events.map((e) => e.name);
  }
}

class FakeCache implements ProviderCachePort {
  constructor(private readonly store = new Map<string, CachedProviderView>()) {}
  seed(npi: string, view: CachedProviderView): void {
    this.store.set(npi, view);
  }
  async upsert(provider: NppesIndividualProvider, _fetchedAt: Date): Promise<CacheUpsertDecision> {
    const existing = this.store.get(provider.npi) ?? null;
    const decision = decideCacheUpsert(existing, provider);
    this.store.set(provider.npi, {
      status: provider.status,
      firstName: provider.basic.firstName,
      lastName: provider.basic.lastName,
      credential: provider.basic.credential,
      specialtyTaxonomy: primaryTaxonomyCode(provider),
      deactivationDate: provider.deactivationDate,
      deactivationReason: provider.deactivationReason,
    });
    return decision;
  }
}

class FakeRunStore implements NppesSyncRunStorePort {
  status: "in_progress" | "completed" | "failed" = "in_progress";
  error: string | null = null;
  counts: SyncRunCounts | null = null;
  async open(): Promise<void> {
    this.status = "in_progress";
  }
  async updateCounts(_id: string, counts: SyncRunCounts): Promise<void> {
    this.counts = counts;
  }
  async markComplete(_id: string, counts: SyncRunCounts): Promise<void> {
    this.status = "completed";
    this.counts = counts;
  }
  async markFailed(_id: string, error: string, counts: SyncRunCounts): Promise<void> {
    this.status = "failed";
    this.error = error;
    this.counts = counts;
  }
}

function fixedClock(): () => Date {
  return () => new Date("2026-08-02T02:30:00.000Z");
}

function mkOrchestrator(opts: {
  npis: string[];
  fetcher: NppesFetchPort;
  cache?: FakeCache;
  outbox?: FakeOutbox;
  runStore?: FakeRunStore;
}) {
  const npiSource: NppesNpiSourcePort = { collectDistinctNpis: async () => opts.npis };
  const outbox = opts.outbox ?? new FakeOutbox();
  const cache = opts.cache ?? new FakeCache();
  const runStore = opts.runStore ?? new FakeRunStore();
  let n = 0;
  const orch = new NppesSyncOrchestrator({
    npiSource,
    fetcher: opts.fetcher,
    cache,
    runStore,
    outbox,
    now: fixedClock(),
    newSyncRunId: () => `run_${++n}`,
  });
  return { orch, outbox, cache, runStore };
}

const nightly: NppesSyncRequest = {
  kind: "daily_incremental",
  triggeredBy: "platform_cron",
  triggerScope: "platform",
  triggeredByMembershipId: null,
};

describe("NppesSyncOrchestrator", () => {
  it("W-XI-11 happy path: fetch → upsert → per-provider + run events", async () => {
    const results: Record<string, NppesFetchResult> = {
      [VALID_A]: { kind: "found", provider: mkProvider({ npi: VALID_A }) },
      [VALID_B]: {
        kind: "found",
        provider: mkProvider({ npi: VALID_B, basic: mkProvider().basic }),
      },
    };
    const { orch, outbox } = mkOrchestrator({
      npis: [VALID_A, VALID_B],
      fetcher: { fetchByNpi: async (npi) => results[npi]! },
    });
    const res = await orch.run(nightly);
    expect(res.status).toBe("completed");
    expect(res.providersUpdated).toBe(2);
    expect(outbox.names().filter((n) => n === "m29.nppes.provider_synced")).toHaveLength(2);
    expect(outbox.names()).toContain("m29.nppes.sync_run.started");
    expect(outbox.names()).toContain("m29.nppes.sync_run.completed");
  });

  it("A→D flip emits provider_deactivated exactly once", async () => {
    const cache = new FakeCache();
    cache.seed(VALID_A, {
      status: "active",
      firstName: "JANE",
      lastName: "DOE",
      credential: "MD",
      specialtyTaxonomy: "207R00000X",
      deactivationDate: null,
      deactivationReason: null,
    });
    const deactivated = mkProvider({
      status: "deactivated",
      deactivationDate: "2026-06-01",
      deactivationReason: "DEATH",
    });
    const { orch, outbox } = mkOrchestrator({
      npis: [VALID_A],
      cache,
      fetcher: { fetchByNpi: async () => ({ kind: "deactivated", provider: deactivated }) },
    });
    const res = await orch.run(nightly);
    expect(res.deactivations).toBe(1);
    const evt = outbox.events.find((e) => e.name === "m29.nppes.provider_deactivated");
    expect(evt?.payload).toMatchObject({ npi: VALID_A, deactivationReason: "DEATH" });
  });

  it("already-deactivated provider → NO duplicate deactivation event, no sync event", async () => {
    const cache = new FakeCache();
    cache.seed(VALID_A, {
      status: "deactivated",
      firstName: "JANE",
      lastName: "DOE",
      credential: "MD",
      specialtyTaxonomy: "207R00000X",
      deactivationDate: "2026-06-01",
      deactivationReason: "DEATH",
    });
    const deactivated = mkProvider({
      status: "deactivated",
      deactivationDate: "2026-06-01",
      deactivationReason: "DEATH",
    });
    const { orch, outbox } = mkOrchestrator({
      npis: [VALID_A],
      cache,
      fetcher: { fetchByNpi: async () => ({ kind: "deactivated", provider: deactivated }) },
    });
    await orch.run(nightly);
    expect(outbox.events.find((e) => e.name === "m29.nppes.provider_deactivated")).toBeUndefined();
    expect(outbox.events.find((e) => e.name === "m29.nppes.provider_synced")).toBeUndefined();
  });

  it("unchanged provider emits no provider_synced event", async () => {
    const cache = new FakeCache();
    cache.seed(VALID_A, {
      status: "active",
      firstName: "JANE",
      lastName: "DOE",
      credential: "MD",
      specialtyTaxonomy: "207R00000X",
      deactivationDate: null,
      deactivationReason: null,
    });
    const { orch, outbox } = mkOrchestrator({
      npis: [VALID_A],
      cache,
      fetcher: { fetchByNpi: async () => ({ kind: "found", provider: mkProvider() }) },
    });
    await orch.run(nightly);
    expect(outbox.events.find((e) => e.name === "m29.nppes.provider_synced")).toBeUndefined();
  });

  it("not_found / organization / invalid are tallied, not synced", async () => {
    const map: Record<string, NppesFetchResult> = {
      a: { kind: "not_found", npi: "a" },
      b: { kind: "organization_skipped", npi: "b" },
      c: { kind: "invalid_format", npi: "c" },
    };
    const { orch, outbox } = mkOrchestrator({
      npis: ["a", "b", "c"],
      fetcher: { fetchByNpi: async (npi) => map[npi]! },
    });
    const res = await orch.run(nightly);
    expect(res.providersNotFound).toBe(1);
    expect(res.providersOrganization).toBe(1);
    expect(res.providersInvalid).toBe(1);
    expect(outbox.names().filter((n) => n === "m29.nppes.provider_synced")).toHaveLength(0);
  });

  it("circuit breaker trips after 50 consecutive failures → run failed", async () => {
    const npis = Array.from({ length: 100 }, (_, i) => `npi_${i}`);
    const { orch, runStore } = mkOrchestrator({
      npis,
      fetcher: {
        fetchByNpi: async () => {
          throw new Error("boom");
        },
      },
    });
    const res = await orch.run(nightly);
    expect(res.status).toBe("failed");
    expect(res.errors).toBe(NPPES_CIRCUIT_BREAKER_CONSECUTIVE_FAILURES);
    expect(runStore.status).toBe("failed");
    expect(runStore.error).toMatch(/circuit_breaker_50_consecutive_failures/);
  });

  it("W-XI-12: a tenant-scoped trigger is refused before any store write", async () => {
    const runStore = new FakeRunStore();
    const { orch } = mkOrchestrator({
      npis: [VALID_A],
      runStore,
      fetcher: { fetchByNpi: async () => ({ kind: "found", provider: mkProvider() }) },
    });
    await expect(
      orch.run({ ...nightly, triggerScope: "tenant", triggeredBy: "platform_admin" }),
    ).rejects.toBeInstanceOf(NppesTenantTriggerRefusedError);
    expect(runStore.status).toBe("in_progress"); // never opened
  });
});
