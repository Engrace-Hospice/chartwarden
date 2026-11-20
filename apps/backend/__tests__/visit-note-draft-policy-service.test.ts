// ADR-0114 VN-D17 - the per-tenant visit-note draft switch: the absent-row default (off), the server-side enabled_at, the refusal to enable
// while the phrase corpus has not had its clinical review, and the explicit audit event. DB behaviour (RLS, the CHECK, the upsert against
// a real row, the audit trigger) is the live suite's; this proves the rules in the service.
import { CORPUS_CLINICAL_REVIEW } from "@chartwarden/narrative-vocab";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CORPUS_REVIEW_PENDING_CODE,
  DEFAULT_DRAFT_POLICY,
  DRAFT_POLICY_AUDIT_EVENT,
  isVisitNoteDraftEnabled,
  nextEnabledAt,
  putDraftPolicy,
  readDraftPolicy,
} from "../src/modules/08-encounters/drafting/policy-service";
import { createDbDraftRouteService } from "../src/modules/08-encounters/drafting/route-service";
import { fakeTx } from "./_closure-fake-tx";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-11-19T12:00:00.000Z");
const EARLIER = new Date("2026-11-10T08:00:00.000Z");
const APPROVED = { reviewer: "ADA", status: "approved" } as const;
const PENDING = { reviewer: "ADA", status: "pending" } as const;

const row = (enabled: boolean, enabledAt: Date | null) => ({ enabled, enabledAt });

describe("readDraftPolicy / isVisitNoteDraftEnabled", () => {
  it("an organization with no row is OFF with no instant", async () => {
    const { tx } = fakeTx([[]]);
    expect(await readDraftPolicy(tx, ORG)).toEqual({ enabled: false, enabledAt: null });
    expect(DEFAULT_DRAFT_POLICY).toEqual({ enabled: false, enabledAt: null });
  });

  it("returns the stored switch and instant", async () => {
    const { tx } = fakeTx([[row(true, EARLIER)]]);
    expect(await readDraftPolicy(tx, ORG)).toEqual({ enabled: true, enabledAt: EARLIER });
  });

  it("isVisitNoteDraftEnabled is false for an absent row and true only for an enabled one", async () => {
    expect(await isVisitNoteDraftEnabled(fakeTx([[]]).tx, ORG)).toBe(false);
    expect(await isVisitNoteDraftEnabled(fakeTx([[row(false, null)]]).tx, ORG)).toBe(false);
    expect(await isVisitNoteDraftEnabled(fakeTx([[row(true, EARLIER)]]).tx, ORG)).toBe(true);
  });
});

describe("nextEnabledAt", () => {
  const off = { enabled: false, enabledAt: null };
  const on = { enabled: true, enabledAt: EARLIER };

  it("stamps now when the switch moves off to on", () => {
    expect(nextEnabledAt(off, true, NOW)).toEqual(NOW);
    expect(nextEnabledAt(DEFAULT_DRAFT_POLICY, true, NOW)).toEqual(NOW);
  });

  it("keeps the original instant while the switch stays on (a repeated PUT is idempotent)", () => {
    expect(nextEnabledAt(on, true, NOW)).toEqual(EARLIER);
  });

  it("clears the instant when the switch goes off, and stays null while off", () => {
    expect(nextEnabledAt(on, false, NOW)).toBeNull();
    expect(nextEnabledAt(off, false, NOW)).toBeNull();
  });
});

describe("putDraftPolicy", () => {
  const base = {
    organizationId: ORG,
    actorMembershipId: MEMBERSHIP,
    audit: { organizationId: ORG, userId: "actor-user", correlationId: "draft-policy-put-1" },
    now: NOW,
    corpusReview: APPROVED,
  };

  it("enables: stamps enabled_at = now server-side and upserts under the acting member", async () => {
    const fake = fakeTx([[], [], []]);
    const result = await putDraftPolicy(fake.tx, { ...base, enabled: true });
    expect(result).toEqual({ enabled: true, enabledAt: NOW });
    expect(fake.insertedValues()[0]).toMatchObject({
      organizationId: ORG,
      enabled: true,
      enabledAt: NOW,
      changedByMembershipId: MEMBERSHIP,
    });
  });

  it("keeps the original instant on a repeated enable", async () => {
    const fake = fakeTx([[row(true, EARLIER)], [], []]);
    const result = await putDraftPolicy(fake.tx, { ...base, enabled: true });
    expect(result.enabledAt).toEqual(EARLIER);
  });

  it("disables: clears enabled_at and is allowed whatever the corpus review says", async () => {
    for (const corpusReview of [APPROVED, PENDING]) {
      const fake = fakeTx([[row(true, EARLIER)], [], []]);
      const result = await putDraftPolicy(fake.tx, { ...base, corpusReview, enabled: false });
      expect(result).toEqual({ enabled: false, enabledAt: null });
      expect(fake.insertedValues()[0]).toMatchObject({ enabled: false, enabledAt: null });
    }
  });

  it("refuses to enable while the corpus review is pending: a typed 409 CORPUS_REVIEW_PENDING, nothing read or written", async () => {
    const fake = fakeTx([]);
    const refusal = await putDraftPolicy(fake.tx, {
      ...base,
      corpusReview: PENDING,
      enabled: true,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ChartWardenError);
    expect(refusal).toMatchObject({ code: CORPUS_REVIEW_PENDING_CODE, statusCode: 409 });
    expect(CORPUS_REVIEW_PENDING_CODE).toBe("CORPUS_REVIEW_PENDING");
    expect(fake.queriesRun()).toBe(0);
    expect(fake.insertedValues()).toEqual([]);
  });

  // Skipped once the owner approves the corpus in its own commit: the refusal is then correctly gone.
  it.skipIf(CORPUS_CLINICAL_REVIEW.status === "approved")(
    "refuses to enable against the REAL corpus constant while it is pending (the default review)",
    async () => {
      const { corpusReview: _omit, ...withoutReview } = base;
      const fake = fakeTx([]);
      await expect(
        putDraftPolicy(fake.tx, { ...withoutReview, enabled: true }),
      ).rejects.toMatchObject({ code: CORPUS_REVIEW_PENDING_CODE, statusCode: 409 });
      expect(fake.insertedValues()).toEqual([]);
    },
  );

  it("writes the explicit warn-severity audit event on the same transaction: previous and new value only", async () => {
    const fake = fakeTx([[], [], []]);
    await putDraftPolicy(fake.tx, { ...base, enabled: true });
    const [, auditRow] = fake.insertedValues() as Record<string, unknown>[];
    expect(DRAFT_POLICY_AUDIT_EVENT).toBe("m8.encounter.draft_policy_changed");
    expect(auditRow).toMatchObject({
      eventType: DRAFT_POLICY_AUDIT_EVENT,
      resourceKind: "visit_note_draft_policy",
      resourceId: ORG,
      severity: "warn",
      outcome: "success",
      correlationId: "draft-policy-put-1",
      after: { previousEnabled: false, enabled: true, enabledAt: NOW.toISOString() },
    });
  });

  it("audits a disable with the previous value and a null instant", async () => {
    const fake = fakeTx([[row(true, EARLIER)], [], []]);
    await putDraftPolicy(fake.tx, { ...base, enabled: false });
    const [, auditRow] = fake.insertedValues() as { after: Record<string, unknown> }[];
    expect(auditRow?.after).toEqual({ previousEnabled: true, enabled: false, enabledAt: null });
  });
});

describe("createDbDraftRouteService (the wire view over the switch)", () => {
  const dbOver = (results: readonly (readonly unknown[])[]) => {
    const fake = fakeTx(results);
    return {
      fake,
      db: { transaction: async (fn: (tx: never) => unknown) => fn(fake.tx) } as never,
    };
  };
  const actor = { organizationId: ORG, userId: "actor-user", membershipId: MEMBERSHIP };
  const auditContext = { organizationId: ORG, userId: "actor-user", correlationId: "wire-1" };

  it("GET answers off with the corpus review state for an organization with no row", async () => {
    const { db } = dbOver([[]]);
    const service = createDbDraftRouteService({ db, corpusReview: PENDING });
    expect(await service.getPolicy(ORG)).toEqual({
      enabled: false,
      reviewStatus: "pending",
      reviewer: "ADA",
    });
  });

  it("PUT enables once the corpus is approved and answers the new switch with the approved review", async () => {
    const { db, fake } = dbOver([[], [], []]);
    const service = createDbDraftRouteService({ db, corpusReview: APPROVED, now: () => NOW });
    expect(await service.putPolicy(actor, { enabled: true }, auditContext)).toEqual({
      enabled: true,
      reviewStatus: "approved",
      reviewer: "ADA",
    });
    expect(fake.insertedValues()[0]).toMatchObject({ changedByMembershipId: MEMBERSHIP });
  });

  it("PUT is refused with CORPUS_REVIEW_PENDING while the corpus is pending, and writes nothing", async () => {
    const { db, fake } = dbOver([]);
    const service = createDbDraftRouteService({ db, corpusReview: PENDING });
    await expect(service.putPolicy(actor, { enabled: true }, auditContext)).rejects.toMatchObject({
      code: CORPUS_REVIEW_PENDING_CODE,
      statusCode: 409,
    });
    expect(fake.insertedValues()).toEqual([]);
  });
});
