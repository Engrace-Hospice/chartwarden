import { describe, expect, it } from "vitest";
import { DEFERRED_CONSUMERS } from "../../../scripts/outbox-deferred-consumers";
// F-020 (#49) — the REAL bindings against the REAL boot catalog.
//
// `createOutboxDispatcher` validates this pairing already, and throws on a mismatch before
// `server.listen()`. It is constructed only when `DATABASE_PLATFORM_URL` is set, so no test, no local
// run and no CI job ever reached that validation — two independent mismatches accumulated in two
// modules and the only symptom was a backend that would not start in the documented production
// configuration:
//
//   error: outbox consumer 'm23.submission-request-enqueue' module 'm23' is not declared for
//          'm23.claim.submission_failed'
//   error: outbox event 'm25.edi.835_received' is catalogued record-only but has live consumer bindings
//
// The corpus-wide sweep lives in `scripts/check-outbox-bindings.ts` (`bun run arch:outbox-bindings`,
// in `arch:fitness`). This suite pins the two entries that were wrong plus the invariant itself, so
// the pairing is also proven by `bun run test` — the loop a developer actually runs.
import {
  type OutboxConsumerBinding,
  buildOutboxRoutingPlan,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog } from "../src/bootstrap/outbox-persister";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import { buildM23SubmissionRequestConsumer } from "../src/modules/23-billing-medicare/outbox-consumers/submit-requests";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/events-by-m25";
import { buildM25EdiReceivedConsumer } from "../src/modules/25-remittance/outbox-consumers/live-binding";

const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M25_OUTBOX_EVENTS]);

/** The real factories, built with the same throwaway deps the gate uses — the three fields under
 *  test depend on the PRESENCE of a dep, never its behaviour. */
const m23 = buildM23SubmissionRequestConsumer({
  enqueue: async () => {},
}) as unknown as OutboxConsumerBinding;
const m25 = buildM25EdiReceivedConsumer({
  postAdvice: async () => {},
} as never) as unknown as OutboxConsumerBinding;

describe("outbox binding ↔ boot catalog agreement (F-020)", () => {
  it("M23 declares itself as the consumer of its own submission_failed retry event", () => {
    // The catalog said `["m33"]`; the description says "the retry worker picks it up" and that retry
    // worker is M23's own `m23.submission-request-enqueue`.
    const entry = catalog.get("m23.claim.submission_failed");
    expect(entry?.declaredConsumers).toContain("m23");
    expect(m23.eventTypes).toContain("m23.claim.submission_failed");
  });

  it("m25.edi.835_received is not catalogued record-only — M25 consumes its own 835 receipt", () => {
    // `declaredConsumers: []` is the dispatcher's explicit "the row IS the durable record" contract.
    // An 835 receipt is not that: `m25.parse-and-post` drives the parse + transactional post.
    const entry = catalog.get("m25.edi.835_received");
    expect(entry?.declaredConsumers).toEqual(["m25"]);
    expect(m25.eventTypes).toEqual(["m25.edi.835_received"]);
  });

  it("builds a routing plan from the real bindings without throwing, and routes both events live", () => {
    const plan = buildOutboxRoutingPlan(catalog, [m23, m25]);
    expect(plan.live.get("m23.claim.submission_failed")).toContain(m23);
    expect(plan.live.get("m25.edi.835_received")).toContain(m25);
    // Record-only means delivery-to-nobody completes immediately; neither event may land there.
    expect(plan.recordOnly.has("m25.edi.835_received")).toBe(false);
    expect(plan.recordOnly.has("m23.claim.submission_failed")).toBe(false);
  });

  it("still fails closed: an undeclared module and a record-only event both refuse to bind", () => {
    // The guarantee the two fixes must not have loosened.
    const stray: OutboxConsumerBinding = {
      consumerName: "m36.stray",
      consumerModule: "m36",
      eventTypes: ["m25.edi.835_received"],
      async handle() {},
    };
    expect(() => buildOutboxRoutingPlan(catalog, [stray])).toThrow(/is not declared for/);

    const recordOnly = buildBootOutboxCatalog([
      M25_OUTBOX_EVENTS.map((e) =>
        e.eventName === "m25.edi.835_received" ? { ...e, declaredConsumers: [] } : e,
      ) as typeof M25_OUTBOX_EVENTS,
    ]);
    expect(() => buildOutboxRoutingPlan(recordOnly, [m25])).toThrow(/record-only/);
  });
});

// ── F-043 (#103): the deferral register's own invariants ───────────────────────────────────────────
//
// `check-outbox-bindings.ts` enforces the register against the live catalog and the live bindings —
// that is the corpus-wide sweep. These cases pin the properties that make the register a REGISTER and
// not a suppression list, in the loop a developer actually runs:
//
//   · every group carries a reason (an unexplained deferral is what the register exists to end);
//   · no (module, event) pair is listed twice, so the count means something;
//   · `unclassified` is enumerated rather than hidden — it is the standing finding, and a test that
//     asserted "none" would have to be edited every time one is honestly added, which is backwards.
describe("F-043 — the declared-but-unbound consumer register", () => {
  it("every group carries a non-empty reason and a non-empty event list", () => {
    for (const group of DEFERRED_CONSUMERS) {
      expect(group.reason.trim().length, `${group.module} has no reason`).toBeGreaterThan(0);
      expect(group.events.length, `${group.module} defers nothing`).toBeGreaterThan(0);
    }
  });

  it("lists each (module, event) pair exactly once", () => {
    const seen = new Set<string>();
    for (const group of DEFERRED_CONSUMERS) {
      for (const eventType of group.events) {
        const key = `${group.module}::${eventType}`;
        expect(seen.has(key), `${key} is listed twice`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("keeps every event name in the `mNN.` form the catalog uses", () => {
    for (const group of DEFERRED_CONSUMERS) {
      expect(group.module).toMatch(/^m\d+$/);
      for (const eventType of group.events) expect(eventType).toMatch(/^m\d+\./);
    }
  });

  it("reports how many pairs are deferred with no established reason", () => {
    // Not `toBe(0)`. An `unclassified` group is an honest admission that nobody has worked out why a
    // module is declared and unbound, and the gate prints it on every run. This case exists so the
    // number is visible in the unit loop too — and so a silent GROWTH in it is a diff, not a surprise.
    const unclassified = DEFERRED_CONSUMERS.filter((g) => g.kind === "unclassified");
    expect(unclassified.flatMap((g) => g.events)).toEqual([]);
  });
});
