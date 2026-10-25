// @chartwarden/x12-837-client — the DdeAccessProvider CONFORMANCE cases (ADR-0103 D3).
//
// Framework-free like ../clearinghouse/conformance: a case is `{ id, title, run(harness) }` and fails by throwing, so
// the same list runs under vitest, a live-sandbox smoke script or a CI job. A provider adapter is "done" only when
// EVERY case passes; the in-memory provider is the executable specification. The cases assert behaviour, never wire
// format. The harness supplies the provider under test plus a {@link DdeConformanceScript} that plays FISS.
import type { Page } from "../clearinghouse/types";
import type { X12WorkerResult } from "../types";
import {
  DDE,
  type DdeAccessProvider,
  type DdeContext,
  type DdeDisposition,
  type DdeOperation,
  type DdeOutcome,
  type DdeScope,
} from "./types";

export const DDE_DEFAULT_SCOPE: DdeScope = {
  organizationId: "org-conf",
  providerEntityId: "pe-conf",
  usage: "test",
};

/** An operator every provider under test must treat as having no DDE ID (the harness arranges it). */
export const DDE_UNENROLLED_OPERATOR = "op-not-enrolled";
const ENROLLED_OPERATOR = "op-enrolled";
/** A second operator the harness must treat as enrolled (a different person with their own DDE ID). */
export const DDE_SECOND_OPERATOR = "op-enrolled-2";

/** Drives the far side. Resolves once the state is in place. */
export interface DdeConformanceScript {
  fissAnswers(
    providerReference: string,
    disposition: DdeDisposition,
    reasonCodes: readonly string[],
    scope?: DdeScope,
  ): Promise<void>;
}

export interface DdeHarness {
  readonly provider: DdeAccessProvider;
  readonly script: DdeConformanceScript;
}

export interface DdeConformanceCase {
  readonly id: string;
  readonly title: string;
  run(h: DdeHarness): Promise<void>;
}

export const ctxFor = (
  scope: DdeScope = DDE_DEFAULT_SCOPE,
  operatorMembershipId = ENROLLED_OPERATOR,
): DdeContext => ({ ...scope, operatorMembershipId, correlationId: "corr-conf" });

export const operation = (
  controlNumber: string,
  idempotencyKey = `key-${controlNumber}`,
  x12 = `ISA*${controlNumber}~`,
): DdeOperation => ({
  kind: "rtp_correction",
  controlNumber,
  idempotencyKey,
  payload: { format: "x12", x12 },
});

function must<T>(r: X12WorkerResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: expected ok, got ${r.degraded.code}`);
  return r.data;
}
function expectCode(r: X12WorkerResult<unknown>, code: string, what: string): void {
  if (r.ok) throw new Error(`${what}: expected ${code}, got ok`);
  if (r.degraded.code !== code)
    throw new Error(`${what}: expected ${code}, got ${r.degraded.code}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const OTHER_ORG: DdeScope = { ...DDE_DEFAULT_SCOPE, organizationId: "org-other" };
const OTHER_PE: DdeScope = { ...DDE_DEFAULT_SCOPE, providerEntityId: "pe-other" };
const PRODUCTION: DdeScope = { ...DDE_DEFAULT_SCOPE, usage: "production" };

export const DDE_CONFORMANCE_CASES: readonly DdeConformanceCase[] = [
  {
    id: "D1",
    title: "submit returns a receipt that is not a replay",
    run: async ({ provider }) => {
      const r = must(await provider.submitOperation(ctxFor(), operation("cn-d1")), "submit");
      assert(
        !r.replayed && r.controlNumber === "cn-d1" && r.providerReference !== "",
        "bad receipt",
      );
    },
  },
  {
    id: "D2",
    title: "the same key and identical operation replays the original receipt",
    run: async ({ provider }) => {
      const a = must(await provider.submitOperation(ctxFor(), operation("cn-d2")), "first");
      const b = must(await provider.submitOperation(ctxFor(), operation("cn-d2")), "second");
      assert(b.replayed && b.providerReference === a.providerReference, "not a replay");
    },
  },
  {
    id: "D3",
    title: "the same key with a different operation is an idempotency conflict",
    run: async ({ provider }) => {
      must(
        await provider.submitOperation(ctxFor(), operation("cn-d3", "key-d3", "ISA*A~")),
        "first",
      );
      expectCode(
        await provider.submitOperation(ctxFor(), operation("cn-d3", "key-d3", "ISA*B~")),
        DDE.IDEMPOTENCY_CONFLICT,
        "conflict",
      );
    },
  },
  {
    id: "D4",
    title: "an operator with no DDE ID is refused and nothing is recorded",
    run: async ({ provider }) => {
      const op = operation("cn-d4");
      expectCode(
        await provider.submitOperation(ctxFor(DDE_DEFAULT_SCOPE, DDE_UNENROLLED_OPERATOR), op),
        DDE.OPERATOR_NOT_ENROLLED,
        "unenrolled",
      );
      const ok = must(await provider.submitOperation(ctxFor(), op), "enrolled retry");
      assert(!ok.replayed, "the refused attempt left state behind");
    },
  },
  {
    id: "D5",
    title: "a malformed operation is refused before send",
    run: async ({ provider }) => {
      expectCode(
        await provider.submitOperation(ctxFor(), operation("cn-d5", "key-d5", "")),
        DDE.INVALID_REQUEST,
        "empty payload",
      );
    },
  },
  {
    id: "D6",
    title: "state is isolated by organization, provider entity and usage",
    run: async ({ provider }) => {
      const a = must(await provider.submitOperation(ctxFor(), operation("cn-d6")), "base");
      for (const scope of [OTHER_ORG, OTHER_PE, PRODUCTION]) {
        const b = must(await provider.submitOperation(ctxFor(scope), operation("cn-d6")), "other");
        assert(!b.replayed, "another scope replayed this scope's key");
        const s = must(
          await provider.fetchOperationStatus(ctxFor(scope), a.providerReference),
          "status",
        );
        assert(s.state === "not_found", "another scope saw this scope's operation");
      }
    },
  },
  {
    id: "D7",
    title: "an unknown reference is not_found",
    run: async ({ provider }) => {
      const s = must(await provider.fetchOperationStatus(ctxFor(), "ref-unknown"), "status");
      assert(s.state === "not_found" && s.latest === null, "unknown reference found");
    },
  },
  {
    id: "D8",
    title: "an outcome updates status and carries FISS's own date and codes",
    run: async ({ provider, script }) => {
      const r = must(await provider.submitOperation(ctxFor(), operation("cn-d8")), "submit");
      assert(
        must(await provider.fetchOperationStatus(ctxFor(), r.providerReference), "s1").state ===
          "received",
        "not received",
      );
      await script.fissAnswers(r.providerReference, "returned", ["B9997"]);
      const s = must(await provider.fetchOperationStatus(ctxFor(), r.providerReference), "s2");
      assert(s.state === "returned" && s.latest?.reasonCodes.join() === "B9997", "outcome missing");
      assert(Number.isFinite(Date.parse(s.latest?.occurredAt ?? "")), "no FISS date");
    },
  },
  {
    id: "D9",
    title: "outcomes page in a resumable chain, each event once",
    run: async ({ provider, script }) => {
      const refs: string[] = [];
      for (const n of ["cn-d9a", "cn-d9b", "cn-d9c"]) {
        const r = must(await provider.submitOperation(ctxFor(OTHER_PE), operation(n)), "submit");
        await script.fissAnswers(r.providerReference, "accepted", [], OTHER_PE);
        refs.push(r.providerReference);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const page: Page<DdeOutcome> = must(
          await provider.fetchOutcomes(ctxFor(OTHER_PE), cursor),
          "page",
        );
        seen.push(...page.items.map((o) => o.eventId));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      assert(
        new Set(seen).size === seen.length && seen.length === refs.length,
        "duplicate or missing",
      );
      const tail = must(await provider.fetchOutcomes(ctxFor(OTHER_PE), cursor), "resume");
      assert(tail.items.length === 0, "resuming at the end re-delivered events");
    },
  },
  {
    id: "D10",
    title: "an operator with no DDE ID is refused on reads too",
    run: async ({ provider }) => {
      const stranger = ctxFor(DDE_DEFAULT_SCOPE, DDE_UNENROLLED_OPERATOR);
      expectCode(
        await provider.fetchOutcomes(stranger, null),
        DDE.OPERATOR_NOT_ENROLLED,
        "outcomes",
      );
      expectCode(
        await provider.fetchOperationStatus(stranger, "ref-any"),
        DDE.OPERATOR_NOT_ENROLLED,
        "status",
      );
    },
  },
  {
    id: "D11",
    title: "the same key from a different operator is a conflict, never a replay",
    run: async ({ provider }) => {
      must(await provider.submitOperation(ctxFor(), operation("cn-d11")), "first operator");
      expectCode(
        await provider.submitOperation(
          ctxFor(DDE_DEFAULT_SCOPE, DDE_SECOND_OPERATOR),
          operation("cn-d11"),
        ),
        DDE.IDEMPOTENCY_CONFLICT,
        "second operator",
      );
    },
  },
  {
    id: "D12",
    title: "the outcome feed is isolated by organization, provider entity and usage",
    run: async ({ provider, script }) => {
      const r = must(await provider.submitOperation(ctxFor(), operation("cn-d12")), "submit");
      await script.fissAnswers(r.providerReference, "accepted", []);
      assert(
        must(await provider.fetchOutcomes(ctxFor(), null), "own").items.length === 1,
        "own feed empty",
      );
      for (const scope of [OTHER_ORG, OTHER_PE, PRODUCTION]) {
        const page = must(await provider.fetchOutcomes(ctxFor(scope), null), "other");
        assert(page.items.length === 0, "another scope saw this scope's outcome");
      }
    },
  },
  {
    id: "D13",
    title: "a malformed cursor is refused and a saved cursor is repeatable",
    run: async ({ provider, script }) => {
      expectCode(
        await provider.fetchOutcomes(ctxFor(), "not-a-cursor"),
        DDE.INVALID_REQUEST,
        "malformed cursor",
      );
      for (const n of ["cn-d13a", "cn-d13b", "cn-d13c"]) {
        const r = must(await provider.submitOperation(ctxFor(OTHER_ORG), operation(n)), "submit");
        await script.fissAnswers(r.providerReference, "accepted", [], OTHER_ORG);
      }
      const first = must(await provider.fetchOutcomes(ctxFor(OTHER_ORG), null), "first");
      const a = must(await provider.fetchOutcomes(ctxFor(OTHER_ORG), first.nextCursor), "resume a");
      const b = must(await provider.fetchOutcomes(ctxFor(OTHER_ORG), first.nextCursor), "resume b");
      const ids = (p: Page<DdeOutcome>): string => p.items.map((o) => o.eventId).join();
      assert(ids(a) === ids(b), "a saved cursor was not repeatable");
      assert(
        first.items.length + a.items.length === 3 && !a.hasMore,
        "resume lost or repeated events",
      );
    },
  },
];

export interface DdeConformanceOutcome {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly error?: string;
}

/** Runs every case against a fresh harness each (so cases never share state). */
export async function runDdeConformance(
  makeHarness: () => DdeHarness | Promise<DdeHarness>,
): Promise<readonly DdeConformanceOutcome[]> {
  const out: DdeConformanceOutcome[] = [];
  for (const c of DDE_CONFORMANCE_CASES) {
    try {
      await c.run(await makeHarness());
      out.push({ id: c.id, title: c.title, passed: true });
    } catch (e) {
      out.push({ id: c.id, title: c.title, passed: false, error: (e as Error).message });
    }
  }
  return out;
}
