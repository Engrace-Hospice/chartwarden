// ADR-0113 D7 — the supervisor override of the closure block: who may be overridden, for how long, and what "active" means.
// Cross-tenant isolation, the append-only grant and the audit event actually landing are the live suite's (real RLS).
import { ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CLOSURE_OVERRIDE_AUDIT_EVENT,
  findActiveOverride,
  grantClosureOverride,
  isOverrideActive,
  revokeClosureOverride,
} from "../src/modules/08-encounters/closure/override-service";
import { fakeTx } from "./_closure-fake-tx";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const SUBJECT = "00000000-0000-4000-8000-0000000000b1";
const SUPERVISOR = "00000000-0000-4000-8000-0000000000b2";
const OVERRIDE_ID = "00000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const GOOD_REASON =
  "Clinician was on a long hospice admission visit and cannot finish the note now.";

const AUDIT = { organizationId: ORG, userId: "user-1", correlationId: "corr-1" };

const grantArgs = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  subjectMembershipId: SUBJECT,
  grantedByMembershipId: SUPERVISOR,
  obligationKind: "visit_note" as const,
  reason: GOOD_REASON,
  audit: AUDIT,
  now: NOW,
  ...over,
});

const overrideRow = (over: Record<string, unknown> = {}) => ({
  id: OVERRIDE_ID,
  subjectMembershipId: SUBJECT,
  grantedByMembershipId: SUPERVISOR,
  obligationKind: "visit_note",
  grantedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 4 * HOUR_MS),
  revokedAt: null,
  ...over,
});

describe("grantClosureOverride", () => {
  it("grants 4 hours by default, inserts the grant and writes the explicit audit event", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    const view = await grantClosureOverride(fake.tx, grantArgs());
    expect(view.id).toBe(OVERRIDE_ID);
    const [grant, auditRow] = fake.insertedValues() as Record<string, unknown>[];
    expect(grant).toMatchObject({
      organizationId: ORG,
      subjectMembershipId: SUBJECT,
      grantedByMembershipId: SUPERVISOR,
      obligationKind: "visit_note",
      grantedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 4 * HOUR_MS),
    });
    expect(auditRow).toMatchObject({
      eventType: CLOSURE_OVERRIDE_AUDIT_EVENT,
      resourceKind: "documentation_obligation_override",
      resourceId: OVERRIDE_ID,
      severity: "warn",
      outcome: "success",
    });
  });

  it("names the audit event in the m8 namespace the action catalog owns", () => {
    expect(CLOSURE_OVERRIDE_AUDIT_EVENT).toBe("m8.encounter.closure_override_granted");
  });

  it("never copies the free-text reason into the audit event", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs());
    const auditRow = fake.insertedValues()[1];
    expect(JSON.stringify(auditRow)).not.toContain("hospice admission");
  });

  it("honours a longer window up to the 24 hour cap", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs({ hours: 24 }));
    expect(fake.insertedValues()[0]).toMatchObject({
      expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
    });
  });

  it.each([0, -1, 25, 1.5, Number.NaN])(
    "refuses %s hours (1..24) and writes nothing",
    async (hours) => {
      const fake = fakeTx([]);
      await expect(grantClosureOverride(fake.tx, grantArgs({ hours }))).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fake.queriesRun()).toBe(0);
    },
  );

  it("refuses a reason under 40 characters, counting trimmed characters", async () => {
    for (const reason of ["too short", `${"x".repeat(39)}   `, `   ${"y".repeat(39)}`]) {
      const fake = fakeTx([]);
      await expect(grantClosureOverride(fake.tx, grantArgs({ reason }))).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fake.queriesRun()).toBe(0);
    }
  });

  it("accepts a reason of exactly 40 characters and stores it trimmed", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs({ reason: `  ${"z".repeat(40)}  ` }));
    expect(fake.insertedValues()[0]).toMatchObject({ reason: "z".repeat(40) });
  });

  it("refuses a supervisor overriding themselves before any query", async () => {
    const fake = fakeTx([]);
    await expect(
      grantClosureOverride(fake.tx, grantArgs({ subjectMembershipId: SUPERVISOR })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.queriesRun()).toBe(0);
  });

  it("refuses a subject who is not an active member of the organization", async () => {
    const fake = fakeTx([[]]);
    await expect(grantClosureOverride(fake.tx, grantArgs())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fake.insertedValues()).toHaveLength(0);
  });

  it.each(["hope_window", "cti", "face_to_face"] as const)(
    "refuses the reserved kind %s in slice 1",
    async (obligationKind) => {
      const fake = fakeTx([]);
      await expect(
        grantClosureOverride(fake.tx, grantArgs({ obligationKind })),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fake.queriesRun()).toBe(0);
    },
  );
});

describe("isOverrideActive / findActiveOverride", () => {
  it("is active strictly before expiry and while unrevoked", () => {
    expect(isOverrideActive(overrideRow(), NOW)).toBe(true);
    const justBefore = new Date(NOW.getTime() + 4 * HOUR_MS - 1);
    expect(isOverrideActive(overrideRow(), justBefore)).toBe(true);
  });

  it("is not active at or after expires_at", () => {
    const expiry = new Date(NOW.getTime() + 4 * HOUR_MS);
    expect(isOverrideActive(overrideRow(), expiry)).toBe(false);
    expect(isOverrideActive(overrideRow(), new Date(expiry.getTime() + 1))).toBe(false);
  });

  it("is not active once revoked", () => {
    expect(isOverrideActive(overrideRow({ revokedAt: NOW }), NOW)).toBe(false);
  });

  it("returns the active override for the clinician and kind", async () => {
    const fake = fakeTx([[overrideRow()]]);
    const found = await findActiveOverride(fake.tx, ORG, SUBJECT, "visit_note", NOW);
    expect(found?.id).toBe(OVERRIDE_ID);
    expect(found?.expiresAt).toEqual(new Date(NOW.getTime() + 4 * HOUR_MS));
  });

  it("returns null when there is none, or the newest one has expired or been revoked", async () => {
    const expired = overrideRow({ expiresAt: new Date(NOW.getTime() - 1) });
    for (const rows of [[], [expired], [overrideRow({ revokedAt: NOW })]]) {
      const fake = fakeTx([rows]);
      expect(await findActiveOverride(fake.tx, ORG, SUBJECT, "visit_note", NOW)).toBeNull();
    }
  });
});

describe("revokeClosureOverride", () => {
  const revokeArgs = {
    organizationId: ORG,
    overrideId: OVERRIDE_ID,
    revokedByMembershipId: SUPERVISOR,
    now: NOW,
  };

  it("stamps only the two revocation columns", async () => {
    const fake = fakeTx([[overrideRow()], []]);
    const view = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(Object.keys(fake.updatedSets()[0] as object).sort()).toEqual([
      "revokedAt",
      "revokedByMembershipId",
    ]);
    expect(fake.updatedSets()[0]).toEqual({ revokedAt: NOW, revokedByMembershipId: SUPERVISOR });
    expect(view.revokedAt).toEqual(NOW);
  });

  it("is idempotent: revoking an already revoked override writes nothing", async () => {
    const earlier = new Date(NOW.getTime() - HOUR_MS);
    const fake = fakeTx([[overrideRow({ revokedAt: earlier })]]);
    const view = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(view.revokedAt).toEqual(earlier);
    expect(fake.updatedSets()).toHaveLength(0);
  });

  it("answers not found for an override outside the organization", async () => {
    const fake = fakeTx([[]]);
    await expect(revokeClosureOverride(fake.tx, revokeArgs)).rejects.toBeInstanceOf(NotFoundError);
  });
});
