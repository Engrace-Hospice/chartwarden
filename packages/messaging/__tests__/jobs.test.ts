import {
  type HashVerifySampleRow,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  type RetentionCandidate,
  buildDlqAuditRecord,
  createInMemoryHashVerifyPorts,
  planRetentionDestruction,
  runHashVerify,
} from "@wardenx/messaging";
// M36-T08 — messaging job processors + queue parameters (M36 spec §4.4 / §4.4.1 / §8.1.2).
//
// Accept: every §4.4 queue declares full §4.4.1 parameters with a `.dlq`; hash_verify partitions a
// sample into matched/mismatched/skipped and emits `m36.integrity.hash_mismatch` only on divergence
// (M36-F03); retention planning withholds legal-hold rows (M36-F10); a DLQ landing hashes its
// payload and opens `pending` (OPS-035 no silent drain).
import { describe, expect, it } from "vitest";

const RUN = "run_1";
const AT = "2026-06-15T04:00:00Z";

function row(id: string, storedHash: string, legalHold = false): HashVerifySampleRow {
  return { messageId: id, channelId: `c_${id}`, organizationId: "org_a", storedHash, legalHold };
}

describe("M36-T08 queue parameters (§4.4.1)", () => {
  it("declares all fourteen queues, each with a distinct DLQ", () => {
    const names = Object.values(MESSAGING_QUEUES);
    expect(names).toHaveLength(14);
    const dlqs = names.map((n) => MESSAGING_QUEUE_PARAMETERS[n].dlq);
    expect(new Set(dlqs).size).toBe(14);
    for (const n of names) {
      const p = MESSAGING_QUEUE_PARAMETERS[n];
      expect(p.name).toBe(n);
      expect(p.dlq).toBe(`${n}.dlq`);
      // hash_verify is deliberately one attempt (WP 1.9): a mismatch is deterministic, a retry only doubles audit rows.
      expect(p.attempts).toBeGreaterThanOrEqual(n === MESSAGING_QUEUES.hashVerify ? 1 : 2);
      expect(p.concurrency).toBeGreaterThanOrEqual(1);
    }
  });

  it("SOS voice is a high-priority, low-concurrency critical path (§4.4.1)", () => {
    const voice = MESSAGING_QUEUE_PARAMETERS["messaging.send_voice"];
    expect(voice.priority).toBe(10);
    expect(voice.concurrency).toBe(5);
  });
});

describe("M36-T08 runHashVerify (§8.1.2 / M36-F03)", () => {
  it("matches when the recomputed hash equals the stored hash — no mismatch emitted", async () => {
    const { ports, mismatches } = createInMemoryHashVerifyPorts({ recomputed: { m1: "h1" } });
    const result = await runHashVerify(RUN, AT, [row("m1", "h1")], ports);
    expect(result).toMatchObject({ scanned: 1, matched: 1, mismatched: 0 });
    expect(mismatches()).toHaveLength(0);
  });

  it("emits m36.integrity.hash_mismatch on divergence", async () => {
    const { ports, mismatches } = createInMemoryHashVerifyPorts({
      recomputed: { m1: "DIFFERENT" },
    });
    const result = await runHashVerify(RUN, AT, [row("m1", "h1")], ports);
    expect(result.mismatched).toBe(1);
    expect(mismatches()).toEqual([
      {
        messageId: "m1",
        channelId: "c_m1",
        organizationId: "org_a",
        storedHash: "h1",
        computedHash: "DIFFERENT",
        detectedAt: AT,
      },
    ]);
  });

  it("skips a destroyed-DEK row (offboarded tenant) without counting a mismatch", async () => {
    const { ports, mismatches } = createInMemoryHashVerifyPorts({ recomputed: { m1: null } });
    const result = await runHashVerify(RUN, AT, [row("m1", "h1")], ports);
    expect(result).toMatchObject({ skippedDeletedTenant: 1, mismatched: 0, matched: 0 });
    expect(mismatches()).toHaveLength(0);
  });

  it("defers legal-hold rows and keeps scanned = matched+mismatched+skipped (invariant)", async () => {
    const { ports } = createInMemoryHashVerifyPorts({
      recomputed: { ok: "h", bad: "x", gone: null },
    });
    const result = await runHashVerify(
      RUN,
      AT,
      [row("ok", "h"), row("bad", "h"), row("gone", "h"), row("held", "h", true)],
      ports,
    );
    expect(result.skippedLegalHold).toBe(1);
    expect(
      result.matched + result.mismatched + result.skippedDeletedTenant + result.skippedLegalHold,
    ).toBe(result.scanned);
    expect(result.scanned).toBe(4);
  });
});

describe("M36-T08 planRetentionDestruction (§4.4 / M36-F10)", () => {
  it("withholds legal-hold rows from destruction", () => {
    const candidates: RetentionCandidate[] = [
      {
        messageId: "m1",
        channelId: "c1",
        retentionClass: "care_related",
        windowEnd: AT,
        legalHold: false,
      },
      {
        messageId: "m2",
        channelId: "c1",
        retentionClass: "care_related",
        windowEnd: AT,
        legalHold: true,
      },
    ];
    const plan = planRetentionDestruction(candidates);
    expect(plan.toDestroy.map((c) => c.messageId)).toEqual(["m1"]);
    expect(plan.skippedLegalHold).toBe(1);
  });
});

describe("M36-T08 buildDlqAuditRecord (§4.4.1 / OPS-035)", () => {
  it("hashes the payload, never stores it verbatim, and opens pending", () => {
    const record = buildDlqAuditRecord({
      queue: "messaging.send_sms",
      jobId: "job_9",
      jobData: { to: "+15551234567", body: "secret" },
      failedAt: AT,
      finalError: "Twilio 21610",
    });
    expect(record.disposition).toBe("pending");
    expect(record.jobDataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("is deterministic for the same payload", () => {
    const landing = { queue: "q", jobId: "j", jobData: { a: 1 }, failedAt: AT, finalError: "e" };
    expect(buildDlqAuditRecord(landing).jobDataHash).toBe(buildDlqAuditRecord(landing).jobDataHash);
  });
});
