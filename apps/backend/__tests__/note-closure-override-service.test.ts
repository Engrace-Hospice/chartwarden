// ADR-0113 D7 — the supervisor override of the closure block: who may be overridden, by whom, for how long, what "active" means, what
// the reason may contain and where it is recorded. Cross-tenant isolation, the append-only grant, the DB triggers and the audit events
// actually landing are the live suite's (real RLS). The evaluator is mocked here: its own tests cover the verdicts.
import {
  ChartWardenError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberClosureEvaluation } from "../src/modules/08-encounters/closure/closure-reader";
import { evaluateMemberClosure } from "../src/modules/08-encounters/closure/closure-reader";
import {
  CLOSURE_OVERRIDE_AUDIT_EVENT,
  CLOSURE_OVERRIDE_REVOKED_AUDIT_EVENT,
  NOTE_CLOSURE_GRANTOR_BLOCKED_CODE,
  NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE,
  NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE,
  findActiveOverride,
  grantClosureOverride,
  isOverrideActive,
  revokeClosureOverride,
} from "../src/modules/08-encounters/closure/override-service";
import { fakeTx } from "./_closure-fake-tx";

vi.mock("../src/modules/08-encounters/closure/closure-reader", () => ({
  evaluateMemberClosure: vi.fn(),
}));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const SUBJECT = "00000000-0000-4000-8000-0000000000b1";
const SUPERVISOR = "00000000-0000-4000-8000-0000000000b2";
const OVERRIDE_ID = "00000000-0000-4000-8000-0000000000d1";
const OTHER_OVERRIDE_ID = "00000000-0000-4000-8000-0000000000d2";
const OLDEST_NOTE = "00000000-0000-4000-8000-0000000000e1";
const SITE = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const GOOD_REASON =
  "Clinician was on a long hospice admission visit and cannot finish the note now.";
// Synthetic identifiers only (compliance/synthetic-identifiers.json): an SSN with area 900 and a listed MBI.
const SSN_SHAPED = "900-12-3456";
const MBI_SHAPED = "1EG4TE5MK73";

const AUDIT = { organizationId: ORG, userId: "user-1", correlationId: "corr-1" };

const grantArgs = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  subjectMembershipId: SUBJECT,
  grantedByMembershipId: SUPERVISOR,
  obligationKind: "visit_note" as const,
  reason: GOOD_REASON,
  locationIds: null,
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

const evaluation = (
  verdict: MemberClosureEvaluation["verdict"],
  encounterId: string | null = null,
): MemberClosureEvaluation => ({ verdict, encounterId }) as unknown as MemberClosureEvaluation;

/** Answer the evaluator per clinician: the grantor's verdict, then the subject's (clear / blocked on the oldest note by default). */
function evaluatorSays(grantor: MemberClosureEvaluation, subject: MemberClosureEvaluation) {
  vi.mocked(evaluateMemberClosure).mockImplementation(async (_tx, input) =>
    input.membershipId === SUPERVISOR ? grantor : subject,
  );
}
const GRANTOR_CLEAR = evaluation("clear");
const SUBJECT_BLOCKED = evaluation("blocked", OLDEST_NOTE);

const failureOf = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (error: unknown) => error,
  );

beforeEach(() => {
  vi.mocked(evaluateMemberClosure).mockReset();
  evaluatorSays(GRANTOR_CLEAR, SUBJECT_BLOCKED);
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

  it("names the audit events in the m8 namespace the action catalog owns", () => {
    expect(CLOSURE_OVERRIDE_AUDIT_EVENT).toBe("m8.encounter.closure_override_granted");
    expect(CLOSURE_OVERRIDE_REVOKED_AUDIT_EVENT).toBe("m8.encounter.closure_override_revoked");
  });

  it("carries the screened reason as the audit event's context.justification, and only there", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs());
    const auditRow = fake.insertedValues()[1] as Record<string, unknown>;
    expect(auditRow.context).toEqual({ justification: GOOD_REASON });
    // the change snapshot stays ids and instants: no free text rides in `after`
    expect(JSON.stringify(auditRow.after)).not.toContain("hospice admission");
  });

  it("audits the trimmed reason, the same text it stores", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs({ reason: `  ${GOOD_REASON}  ` }));
    const [grant, auditRow] = fake.insertedValues() as Record<string, unknown>[];
    expect(grant).toMatchObject({ reason: GOOD_REASON });
    expect((auditRow as { context: unknown }).context).toEqual({ justification: GOOD_REASON });
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

describe("grantClosureOverride: the reason is screened for patient identifiers", () => {
  it.each([
    ["an SSN", `Clinician is with a patient whose number is ${SSN_SHAPED} and cannot finish.`],
    ["an MBI", `Clinician is with a patient whose Medicare id is ${MBI_SHAPED} and cannot finish.`],
  ])(
    "refuses a reason that holds %s: 422 on the reason field, nothing written, value not echoed",
    async (_label, reason) => {
      const fake = fakeTx([]);
      const failure = (await failureOf(
        grantClosureOverride(fake.tx, grantArgs({ reason })),
      )) as ValidationError;
      expect(failure).toBeInstanceOf(ValidationError);
      expect(failure.statusCode).toBe(422);
      expect(failure.details).toHaveLength(1);
      expect(failure.details?.[0]).toMatchObject({
        field: "reason",
        code: "EVIDENCE_LOOKS_LIKE_PHI",
      });
      const rendered = JSON.stringify([failure.message, failure.details]);
      expect(rendered).not.toContain(SSN_SHAPED);
      expect(rendered).not.toContain(MBI_SHAPED);
      // refused before any IO: no membership read, no evaluator call, no insert, no audit event
      expect(fake.queriesRun()).toBe(0);
      expect(vi.mocked(evaluateMemberClosure)).not.toHaveBeenCalled();
    },
  );

  it("screens the reason as stored (trimmed), so padding cannot hide an identifier", async () => {
    const fake = fakeTx([]);
    const padded = `${" ".repeat(5)}${"a".repeat(40)} ${SSN_SHAPED}${" ".repeat(5)}`;
    await expect(
      grantClosureOverride(fake.tx, grantArgs({ reason: padded })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fake.queriesRun()).toBe(0);
  });

  it("lets ordinary prose and ticket-style numbers through", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(
      fake.tx,
      grantArgs({
        reason:
          "Admission visit ran four hours; ticket 4821 covers the extra travel to the rural site.",
      }),
    );
    expect(fake.insertedValues()).toHaveLength(2);
  });
});

describe("grantClosureOverride: who may be released, and by whom", () => {
  it("refuses a grantor who is blocked themselves: 403 NOTE_CLOSURE_GRANTOR_BLOCKED, nothing written", async () => {
    evaluatorSays(evaluation("blocked", OLDEST_NOTE), SUBJECT_BLOCKED);
    const fake = fakeTx([[{ id: SUBJECT }]]);
    const failure = (await failureOf(
      grantClosureOverride(fake.tx, grantArgs()),
    )) as ChartWardenError;
    expect(failure).toBeInstanceOf(ChartWardenError);
    expect([failure.code, failure.statusCode]).toEqual([NOTE_CLOSURE_GRANTOR_BLOCKED_CODE, 403]);
    expect(failure.message).toBe("Close your own overdue notes before releasing someone else.");
    expect(fake.insertedValues()).toHaveLength(0);
  });

  it.each(["clear", "warn"] as const)(
    "lets a grantor whose verdict is %s grant (overridden degrades to warn)",
    async (verdict) => {
      evaluatorSays(evaluation(verdict), SUBJECT_BLOCKED);
      const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
      await expect(grantClosureOverride(fake.tx, grantArgs())).resolves.toMatchObject({
        id: OVERRIDE_ID,
      });
    },
  );

  it.each(["clear", "warn"] as const)(
    "refuses a clinician whose verdict is %s: 409 NOTE_CLOSURE_SUBJECT_NOT_BLOCKED",
    async (verdict) => {
      evaluatorSays(GRANTOR_CLEAR, evaluation(verdict, OLDEST_NOTE));
      const fake = fakeTx([[{ id: SUBJECT }]]);
      const failure = (await failureOf(
        grantClosureOverride(fake.tx, grantArgs()),
      )) as ChartWardenError;
      expect([failure.code, failure.statusCode]).toEqual([
        NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE,
        409,
      ]);
      expect(failure.message).toBe(
        "This clinician is not blocked right now, so there is nothing to lift.",
      );
      expect(fake.insertedValues()).toHaveLength(0);
    },
  );

  it("refuses a blocked verdict with no oldest note (nothing to scope against) as not blocked", async () => {
    evaluatorSays(GRANTOR_CLEAR, evaluation("blocked", null));
    const fake = fakeTx([[{ id: SUBJECT }]]);
    const failure = (await failureOf(
      grantClosureOverride(fake.tx, grantArgs()),
    )) as ChartWardenError;
    expect(failure.code).toBe(NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE);
  });

  it("asks the grantor's question first: a blocked grantor hears about themselves even when the clinician is not blocked", async () => {
    evaluatorSays(evaluation("blocked", OLDEST_NOTE), evaluation("clear"));
    const fake = fakeTx([[{ id: SUBJECT }]]);
    const failure = (await failureOf(
      grantClosureOverride(fake.tx, grantArgs()),
    )) as ChartWardenError;
    expect(failure.code).toBe(NOTE_CLOSURE_GRANTOR_BLOCKED_CODE);
  });

  it("asks the clinician's question before the scope's: an unblocked clinician is 409 even outside the sites", async () => {
    evaluatorSays(GRANTOR_CLEAR, evaluation("clear"));
    const fake = fakeTx([[{ id: SUBJECT }]]);
    const failure = (await failureOf(
      grantClosureOverride(fake.tx, grantArgs({ locationIds: [SITE] })),
    )) as ChartWardenError;
    expect(failure.code).toBe(NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE);
    expect(fake.queriesRun()).toBe(1); // the membership read only: no scope query
  });

  it("evaluates both clinicians in this organization at the grant's clock", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs());
    const calls = vi.mocked(evaluateMemberClosure).mock.calls.map(([, input]) => input);
    expect(calls).toEqual([
      { organizationId: ORG, membershipId: SUPERVISOR, now: NOW },
      { organizationId: ORG, membershipId: SUBJECT, now: NOW },
    ]);
  });

  it("an org-wide grantor needs no scope query", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs({ locationIds: null }));
    expect(fake.queriesRun()).toBe(3); // membership, insert, audit
  });

  it("a site-scoped grantor is refused when the oldest note is outside their sites: 403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], []]);
    const failure = (await failureOf(
      grantClosureOverride(fake.tx, grantArgs({ locationIds: [SITE] })),
    )) as ChartWardenError;
    expect([failure.code, failure.statusCode]).toEqual([
      NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE,
      403,
    ]);
    expect(failure.message).toBe("That clinician's note is outside your sites.");
    expect(fake.insertedValues()).toHaveLength(0);
  });

  it("a site-scoped grantor may release a clinician whose oldest note is in their sites", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [{ id: OLDEST_NOTE }], [overrideRow()], []]);
    await expect(
      grantClosureOverride(fake.tx, grantArgs({ locationIds: [SITE] })),
    ).resolves.toMatchObject({ id: OVERRIDE_ID });
  });

  it("scopes the oldest note by the board's predicate: this organization, this note, their sites OR no site", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], [{ id: OLDEST_NOTE }], [overrideRow()], []]);
    await grantClosureOverride(fake.tx, grantArgs({ locationIds: [SITE] }));
    const where = fake.calls.filter((c) => c.op === "where")[1]?.args[0] as SQL;
    const query = new PgDialect().sqlToQuery(where);
    expect(query.sql).toMatch(/"location_id" in \(\$\d+\) or "encounter"\."location_id" is null/i);
    expect(query.params).toEqual(expect.arrayContaining([ORG, OLDEST_NOTE, SITE]));
  });

  it("a grantor with no sites at all is out of scope for every note, a note with no site included (fail closed)", async () => {
    const fake = fakeTx([[{ id: SUBJECT }], []]);
    const failure = (await failureOf(
      grantClosureOverride(fake.tx, grantArgs({ locationIds: [] })),
    )) as ChartWardenError;
    expect(failure.code).toBe(NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE);
    const where = fake.calls.filter((c) => c.op === "where")[1]?.args[0] as SQL;
    expect(new PgDialect().sqlToQuery(where).sql).toContain("false");
  });
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
    audit: AUDIT,
    now: NOW,
  };
  const revokedRow = overrideRow({ revokedAt: NOW });

  it("stamps only the two revocation columns and returns the row the UPDATE returned", async () => {
    // select existing, update returning, audit insert, other-grants lookup
    const fake = fakeTx([[overrideRow()], [revokedRow], [], []]);
    const result = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(Object.keys(fake.updatedSets()[0] as object).sort()).toEqual([
      "revokedAt",
      "revokedByMembershipId",
    ]);
    expect(fake.updatedSets()[0]).toEqual({ revokedAt: NOW, revokedByMembershipId: SUPERVISOR });
    expect(result.override.revokedAt).toEqual(NOW);
    expect(result.remainingActiveUntil).toBeNull();
  });

  it("writes m8.encounter.closure_override_revoked in the same transaction: ids and instants, never the reason", async () => {
    const fake = fakeTx([[overrideRow()], [revokedRow], [], []]);
    await revokeClosureOverride(fake.tx, revokeArgs);
    const [auditRow] = fake.insertedValues() as Record<string, unknown>[];
    expect(auditRow).toMatchObject({
      eventType: CLOSURE_OVERRIDE_REVOKED_AUDIT_EVENT,
      resourceKind: "documentation_obligation_override",
      resourceId: OVERRIDE_ID,
      severity: "warn",
      outcome: "success",
      retentionClass: "compliance",
      after: {
        overrideId: OVERRIDE_ID,
        subjectMembershipId: SUBJECT,
        grantedByMembershipId: SUPERVISOR,
        revokedByMembershipId: SUPERVISOR,
        obligationKind: "visit_note",
        revokedAt: NOW.toISOString(),
      },
    });
    expect(JSON.stringify(auditRow)).not.toMatch(/reason|justification/i);
    expect((auditRow as { context: unknown }).context).toEqual({}); // the real audit() defaults it; nothing free-text rides here
  });

  it("is idempotent: revoking an already revoked override writes nothing, no event included", async () => {
    const earlier = new Date(NOW.getTime() - HOUR_MS);
    const fake = fakeTx([[overrideRow({ revokedAt: earlier })], []]);
    const result = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(result.override.revokedAt).toEqual(earlier);
    expect(fake.updatedSets()).toHaveLength(0);
    expect(fake.insertedValues()).toHaveLength(0);
  });

  it("returns the row as stored, and writes no event, when its UPDATE matched nothing (a concurrent revoke won)", async () => {
    const winner = new Date(NOW.getTime() - 1_000);
    // select existing (looked open), update matched no row, re-read (revoked by the winner), other-grants lookup
    const fake = fakeTx([[overrideRow()], [], [overrideRow({ revokedAt: winner })], []]);
    const result = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(result.override.revokedAt).toEqual(winner);
    expect(fake.insertedValues()).toHaveLength(0);
  });

  it("answers not found when the row vanishes between the read and a lost UPDATE", async () => {
    const fake = fakeTx([[overrideRow()], [], []]);
    await expect(revokeClosureOverride(fake.tx, revokeArgs)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers not found for an override outside the organization", async () => {
    const fake = fakeTx([[]]);
    await expect(revokeClosureOverride(fake.tx, revokeArgs)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports the latest expiry of ANOTHER active grant for the same clinician (revoking one does not re-block them)", async () => {
    const stillActive = {
      expiresAt: new Date(NOW.getTime() + 2 * HOUR_MS),
      revokedAt: null,
    };
    const fake = fakeTx([[overrideRow()], [revokedRow], [], [stillActive]]);
    const result = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(result.remainingActiveUntil).toEqual(stillActive.expiresAt);
    // the lookup excludes the grant just revoked, and is scoped to this organization, clinician and kind
    const lookupWhere = fake.calls.filter((c) => c.op === "where").at(-1)?.args[0] as SQL;
    const query = new PgDialect().sqlToQuery(lookupWhere);
    expect(query.sql).toMatch(/"id" <> \$\d+/);
    expect(query.params).toEqual(expect.arrayContaining([ORG, SUBJECT, "visit_note", OVERRIDE_ID]));
  });

  it("ignores another grant that has already expired", async () => {
    const expired = { expiresAt: new Date(NOW.getTime() - 1), revokedAt: null };
    const fake = fakeTx([[overrideRow()], [revokedRow], [], [expired]]);
    const result = await revokeClosureOverride(fake.tx, revokeArgs);
    expect(result.remainingActiveUntil).toBeNull();
  });

  it("reports the remaining grant on an idempotent repeat too", async () => {
    const stillActive = { expiresAt: new Date(NOW.getTime() + HOUR_MS), revokedAt: null };
    const fake = fakeTx([[overrideRow({ revokedAt: NOW })], [stillActive]]);
    const result = await revokeClosureOverride(fake.tx, {
      ...revokeArgs,
      overrideId: OTHER_OVERRIDE_ID,
    });
    expect(result.remainingActiveUntil).toEqual(stillActive.expiresAt);
  });
});
