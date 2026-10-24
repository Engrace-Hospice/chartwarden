/**
 * M25 leadership medical-review report, milestone 9a-2 (hospice ADR/TPE/QIC PRD, milestone 9) - LIVE Postgres as the
 * NOBYPASSRLS `chartwarden_app` role, through the real service and the real route. No table, no model, no outbox event.
 *
 * Proves what the pure suites cannot: a seeded fixture produces EXACT figures for every section (ADRs, denials by reason /
 * month / closure, appeals by tier and outcome, reopenings, TPE, audits, playbook coverage) and the change against the
 * previous equal period; a window with no data reads as zeros and nulls, never an invented rate; another tenant's rows are
 * invisible and this tenant's are invisible to it; a provider-entity scope (and an asked-for entity outside it) narrows
 * the figures to nothing out of scope; the window bound is enforced; the response has no patient, claim or person field and
 * no target, benchmark or score field (asserted on the keys and against the published schema); a TPE exit threshold shows
 * only where the organization recorded one; a retired playbook stops covering a reason; the route gates on
 * medical_review.report.read, is no-store and bounded; migration 1252 grants existing roles idempotently.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:medical-review-report:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildMedicalReviewReportService } from "../src/modules/25-remittance/routes/medical-review-report-service";
import {
  MedicalReviewReportSchema,
  registerMedicalReviewReportRoutes,
} from "../src/modules/25-remittance/routes/medical-review-report.routes";
import { buildDrizzlePlaybookService } from "../src/modules/25-remittance/routes/playbook-service";
import { buildDrizzleTpeService } from "../src/modules/25-remittance/routes/tpe-service";
import { type M7Fixture, ORG, ORG_B, daysAgo, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ago = (n: number) => `now() - interval '${n} days'`;

describe.skipIf(!DB_URL)("M25 medical-review report (milestone 9a-2) - LIVE Postgres", () => {
  let fx: M7Fixture;
  let memberA2: string;
  let userA2: string;
  const window = { from: daysAgo(20), to: daysAgo(1) };
  const report = (
    actor = fx.actor(),
    q: { from?: string; to?: string; providerEntityId?: string } = {},
  ) =>
    buildMedicalReviewReportService(fx.handle.db, {
      tpe: buildDrizzleTpeService(fx.handle.db, { providerEntityExists: async () => true }),
    }).getReport(actor, { ...window, ...q });

  /** Seed helpers - rows go straight into the tables with explicit dates; the report only reads them. */
  async function adr(o: {
    requested?: number;
    requestedOn?: string;
    denialId?: string;
    mac: string;
    pe?: string;
    state: string;
    dueAgo: number;
    filedAgo?: number;
    verified: boolean;
    proof?: boolean;
    org?: string;
    claim?: string;
  }): Promise<string> {
    const org = o.org ?? ORG;
    const id = (
      await fx.admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, denial_case_id, mac_name, review_type, state, requested_on,
           window_days, window_source, window_verified, response_due_at, packet_manifest, filed_at, submitted_at,
           filing_channel, filing_confirmation_ref, reviewed_by_membership_id, reviewed_at, sent_to_review_by_membership_id)
         VALUES ($1,$2,$3,$11::uuid,$4,'adr',$5, COALESCE($12::date, CURRENT_DATE - $6::int), 30,'platform_default',$7, ${ago(o.dueAgo)},
           CASE WHEN $8::int IS NOT NULL THEN '{}'::jsonb END,
           CASE WHEN $8::int IS NOT NULL THEN ${ago(o.filedAgo ?? 0)} END,
           CASE WHEN $8::int IS NOT NULL THEN ${ago(o.filedAgo ?? 0)} END,
           CASE WHEN $8::int IS NOT NULL THEN 'fax' END, CASE WHEN $8::int IS NOT NULL THEN 'ref' END,
           CASE WHEN $8::int IS NOT NULL THEN $9::uuid END, CASE WHEN $8::int IS NOT NULL THEN now() END,
           CASE WHEN $8::int IS NOT NULL THEN $10::uuid END) RETURNING id`,
        [
          org,
          o.pe ?? (org === ORG ? fx.pe1 : fx.peB),
          o.claim ?? (org === ORG ? fx.claim1 : fx.claimB),
          o.mac,
          o.state,
          o.requested ?? 0,
          o.verified,
          o.filedAgo ?? null,
          fx.memberA,
          memberA2,
          o.denialId ?? null,
          o.requestedOn ?? null,
        ],
      )
    ).rows[0].id as string;
    if (o.proof) {
      await fx.admin.query(
        `INSERT INTO submission_attempt (organization_id, provider_entity_id, adr_case_id, purpose, attempt_no, idempotency_key,
           adapter, status, confirmation_ref, receipt_at, receipt_source)
         VALUES ($1,$2,$3,'adr_response',1,$4,'manual','acknowledged','R1',now(),'entered')`,
        [org, o.pe ?? fx.pe1, id, randomUUID()],
      );
    }
    return id;
  }
  async function denial(o: {
    openedAgo?: number;
    openedAt?: string;
    claim?: string;
    carc: string;
    rarc?: string;
    mac?: string;
    dollars: number;
    pe?: string;
    org?: string;
    closedAgo?: number;
    closure?: string;
  }): Promise<string> {
    const org = o.org ?? ORG;
    return (
      await fx.admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id, carc_code,
           rarc_code, mac_reason_code, category, source, state, dollar_value, taxonomy_status, opened_at, closed_at, closure_outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'denial','evv_aggregator_rejection',$8,$9,'mapped', COALESCE($12::timestamptz, ${ago(o.openedAgo ?? 0)}),
           CASE WHEN $10::int IS NOT NULL THEN ${ago(o.closedAgo ?? 0)} END, $11) RETURNING id`,
        [
          org,
          o.pe ?? (org === ORG ? fx.pe1 : fx.peB),
          o.claim ?? (org === ORG ? fx.claim1 : fx.claimB),
          randomUUID(),
          o.carc,
          o.rarc ?? null,
          o.mac ?? null,
          o.closure ? "closed" : "open",
          o.dollars,
          o.closedAgo ?? null,
          o.closure ?? null,
          o.openedAt ?? null,
        ],
      )
    ).rows[0].id as string;
  }
  async function appeal(o: {
    tier: string;
    state: string;
    submittedAgo?: number;
    submittedAt?: string;
    deadlineAhead: number;
    decidedAgo?: number;
    outcome?: string;
    pe?: string;
  }): Promise<void> {
    const id = await fx.mkAppeal({
      claimId: fx.claim1,
      pe: o.pe ?? fx.pe1,
      tier: o.tier,
      deadline: new Date(Date.now() + o.deadlineAhead * 864e5).toISOString(),
    });
    await fx.admin.query(
      `UPDATE appeal_case SET state = '${o.state}', submitted_at = ${o.submittedAt ? `'${o.submittedAt}'::timestamptz` : o.submittedAgo === undefined ? "NULL" : ago(o.submittedAgo)},
         decided_at = ${o.decidedAgo === undefined ? "NULL" : ago(o.decidedAgo)}, decision_outcome = $2 WHERE id=$1`,
      [id, o.outcome ?? null],
    );
  }

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-mr");
    userA2 = (
      await fx.admin.query(`INSERT INTO "user" (email) VALUES ('m25-mr-a2@x.test') RETURNING id`)
    ).rows[0].id as string;
    memberA2 = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userA2, ORG],
      )
    ).rows[0].id as string;

    // ADRs: current window (20 days ending yesterday) ...
    await adr({
      requested: 15,
      mac: "MAC-A",
      state: "submitted",
      dueAgo: 5,
      filedAgo: 8,
      verified: true,
      proof: true,
    });
    await adr({
      requested: 12,
      mac: "MAC-A",
      state: "submitted",
      dueAgo: 3,
      filedAgo: 1,
      verified: false,
    });
    await adr({
      requested: 10,
      mac: "MAC-B",
      state: "denied_no_response",
      dueAgo: 2,
      verified: false,
    });
    await adr({
      requested: 5,
      mac: "MAC-B",
      state: "in_assembly",
      dueAgo: -10,
      verified: false,
      pe: fx.pe2,
      claim: fx.claim2,
    });
    // ... the previous equal period, and another tenant.
    await adr({
      requested: 30,
      mac: "MAC-A",
      state: "submitted",
      dueAgo: 20,
      filedAgo: 22,
      verified: true,
    });
    await adr({
      requested: 10,
      mac: "MAC-Z",
      state: "in_assembly",
      dueAgo: -10,
      verified: false,
      org: ORG_B,
    });

    // Denials.
    await denial({ openedAgo: 10, carc: "50", dollars: 100, closedAgo: 2, closure: "written_off" });
    await denial({
      openedAgo: 9,
      carc: "50",
      dollars: 50,
      closedAgo: 2,
      closure: "resolved_via_appeal",
    });
    await denial({ openedAgo: 8, carc: "45", rarc: "N1", dollars: 10 });
    await denial({ openedAgo: 6, carc: "50", mac: "56900", dollars: 1 });
    await denial({ openedAgo: 3, carc: "97", dollars: 5, pe: fx.pe2 });
    await denial({ openedAgo: 30, carc: "50", dollars: 20 });
    await denial({ openedAgo: 10, carc: "50", dollars: 999, org: ORG_B });

    // Appeals (each makes its own denial opened now, which is outside the window).
    await appeal({
      tier: "redetermination",
      state: "decided",
      submittedAgo: 6,
      deadlineAhead: 10,
      decidedAgo: 3,
      outcome: "favorable",
    });
    await appeal({
      tier: "reconsideration",
      state: "decided",
      submittedAgo: 5,
      deadlineAhead: -8,
      decidedAgo: 2,
      outcome: "unfavorable",
    });
    await appeal({ tier: "alj", state: "submitted", submittedAgo: 4, deadlineAhead: 30 });
    await appeal({ tier: "redetermination", state: "draft", deadlineAhead: 30 });
    await appeal({
      tier: "reconsideration",
      state: "decided",
      submittedAgo: 25,
      deadlineAhead: 1,
      decidedAgo: 2,
      outcome: "partial",
      pe: fx.pe2,
    });
    await appeal({
      tier: "redetermination",
      state: "decided",
      submittedAgo: 30,
      deadlineAhead: 5,
      decidedAgo: 28,
      outcome: "favorable",
    });

    // Reopenings (one per denial).
    const reopening = async (
      createdAgo: number,
      outcome: string | null,
      decidedAgo: number | null,
    ) => {
      const d = await fx.mkDenial(fx.claim1, fx.pe1);
      await fx.admin.query(
        `INSERT INTO reopening_case (organization_id, provider_entity_id, claim_id, denial_case_id, mac_name, state, form_name,
           filing_channel, filing_confirmation_ref, filed_at, outcome, decided_at, created_at)
         VALUES ($1,$2,$3,$4,'MAC-A', $5, 'form', 'fax', 'ref', ${ago(createdAgo)}, $6,
           ${decidedAgo === null ? "NULL" : ago(decidedAgo)}, ${ago(createdAgo)})`,
        [ORG, fx.pe1, fx.claim1, d, outcome ? "decided" : "submitted", outcome],
      );
    };
    await reopening(7, "granted", 3);
    await reopening(6, "denied", 2);
    await reopening(30, null, null);

    // Audit requests: no deadline, a recorded deadline, closed, and "none stated".
    const audit = async (state: string, extra = "") =>
      (
        await fx.admin.query(
          `INSERT INTO audit_request (organization_id, provider_entity_id, authority_kind, received_on, state ${extra ? ", deadline_none_stated_at, deadline_none_stated_by_membership_id" : ""}, closed_at, responded_at)
           VALUES ($1,$2,'rac', CURRENT_DATE, $3 ${extra ? ", now(), $4" : ""}, ${state === "closed" ? "now(), now()" : "NULL, NULL"}) RETURNING id`,
          extra ? [ORG, fx.pe1, state, fx.memberA] : [ORG, fx.pe1, state],
        )
      ).rows[0].id as string;
    await audit("received");
    const withDeadline = await audit("in_assembly");
    await fx.admin.query(
      `INSERT INTO recorded_deadline (organization_id, provider_entity_id, audit_request_id, label, due_on, zone, source_note)
       VALUES ($1,$2,$3,'letter',CURRENT_DATE + 10,'America/New_York','typed from the letter')`,
      [ORG, fx.pe1, withDeadline],
    );
    await audit("closed");
    await audit("in_review", "none-stated");

    // TPE: one program on a MAC with a recorded exit threshold, one without.
    await fx.admin.query(
      `INSERT INTO tpe_mac_rule (organization_id, mac_name, exit_error_rate_pct, source_note, verified_on)
       VALUES ($1,'MAC-A', 8.00, 'typed from the MAC letter', CURRENT_DATE)`,
      [ORG],
    );
    for (const mac of ["MAC-A", "MAC-B"]) {
      await fx.admin.query(
        `INSERT INTO tpe_program (organization_id, provider_entity_id, mac_name, opened_on, state) VALUES ($1,$2,$3,CURRENT_DATE - 5,'active')`,
        [ORG, fx.pe1, mac],
      );
    }

    // One published playbook for CARC 50 (the second person publishes).
    const pb = buildDrizzlePlaybookService(fx.handle.db);
    const created = await pb.createPlaybook(fx.actor(), {
      codeKind: "carc",
      code: "50",
      title: "CARC 50",
      summary: "s",
      sourceNote: "fixture",
      steps: [{ key: "a", text: "a" }],
    } as never);
    await pb.publishVersion(
      { ...fx.actor(), userId: userA2, membershipId: memberA2 },
      created.versionId,
      1,
    );
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("computes exact ADR figures, the change against the previous period, and the unverified-window count", async () => {
    const r = await report();
    expect(r.adrs.received).toEqual({ value: 4, previous: 1, change: 3 });
    expect(r.adrs.filed).toEqual({ value: 2, previous: 1, change: 1 });
    expect(r.adrs.filedOnOrBeforeDue.value).toBe(1);
    expect(r.adrs.filedAfterDue.value).toBe(1);
    expect(r.adrs.onOrBeforeDueShareOfFiled).toEqual({ value: 0.5, previous: 1, change: -0.5 });
    expect(r.adrs.withRecordedProof.value).toBe(1);
    expect(r.adrs.deniedNoResponse.value).toBe(1);
    expect(r.adrs.dueDatesFromUnverifiedWindows.value).toBe(3);
    expect(r.adrs.medianDaysToFile).toEqual({ value: 9, previous: 8, change: 1 });
    expect(r.adrs.byMac).toEqual([
      { macName: "MAC-A", received: 2, filed: 2, filedOnOrBeforeDue: 1, deniedNoResponse: 0 },
      { macName: "MAC-B", received: 2, filed: 0, filedOnOrBeforeDue: 0, deniedNoResponse: 1 },
    ]);
    expect(r.window).toMatchObject({ from: window.from, to: window.to, days: 20 });
  });

  it("computes exact denial figures: totals, 56900 as typed, by reason, by month and closure outcome", async () => {
    const r = await report();
    expect(r.denials.opened).toEqual({ value: 5, previous: 1, change: 4 });
    expect(r.denials.openedDollars).toEqual({
      value: "166.00",
      previous: "20.00",
      change: "146.00",
    });
    expect(r.denials.macReasonAsTyped).toMatchObject({
      code: "56900",
      figure: { value: 1, previous: 0 },
    });
    expect(r.denials.byReason.rows).toEqual([
      { codeKind: "carc", code: "50", count: 2, dollars: "150.00" },
      { codeKind: "rarc", code: "N1", count: 1, dollars: "10.00" },
      { codeKind: "carc", code: "97", count: 1, dollars: "5.00" },
      { codeKind: "mac_reason", code: "56900", count: 1, dollars: "1.00" },
    ]);
    expect(r.denials.byMonth.reduce((n, m) => n + m.count, 0)).toBe(5);
    expect(r.denials.closureOutcomes).toEqual(
      expect.arrayContaining([
        { outcome: "written_off", count: 1 },
        { outcome: "resolved_via_appeal", count: 1 },
      ]),
    );
  });

  it("computes exact appeal and reopening figures, shows partial and unfavorable apart, and flags unconfirmed later-tier windows", async () => {
    const r = await report();
    expect(r.appeals.filed).toEqual({ value: 3, previous: 2, change: 1 });
    expect(r.appeals.decided).toEqual({ value: 3, previous: 1, change: 2 });
    expect(r.appeals.filedByTier).toEqual([
      {
        tier: "redetermination",
        filed: 1,
        filedOnOrBeforeDeadline: 1,
        deadlineWindowUnconfirmed: false,
      },
      {
        tier: "reconsideration",
        filed: 1,
        filedOnOrBeforeDeadline: 0,
        deadlineWindowUnconfirmed: false,
      },
      { tier: "alj", filed: 1, filedOnOrBeforeDeadline: 1, deadlineWindowUnconfirmed: true },
    ]);
    expect(r.appeals.decidedByOutcome).toEqual([
      { outcome: "favorable", count: 1 },
      { outcome: "partial", count: 1 },
      { outcome: "unfavorable", count: 1 },
    ]);
    expect(r.appeals.favorableShareOfDecided).toBeCloseTo(1 / 3);
    expect(r.appeals.openByTier).toEqual([
      { tier: "redetermination", count: 1 },
      { tier: "alj", count: 1 },
    ]);
    expect(r.reopenings.opened).toEqual({ value: 2, previous: 1, change: 1 });
    expect(r.reopenings.decidedByOutcome).toEqual([
      { outcome: "denied", count: 1 },
      { outcome: "granted", count: 1 },
    ]);
  });

  it("shows audits, TPE (a threshold only where the organization recorded one) and playbook coverage", async () => {
    const r = await report();
    expect(r.audits).toEqual({ open: 3, openWithNoRecordedDeadline: 1 });
    expect(r.tpe.available).toBe(true);
    const byMac = Object.fromEntries(r.tpe.active.map((p) => [p.macName, p]));
    expect(byMac["MAC-A"]).toMatchObject({ thresholdPct: 8, thresholdVerified: true });
    expect(byMac["MAC-B"]).toMatchObject({ thresholdPct: null, aboveThreshold: null });
    expect(r.tpe.byState).toEqual([{ state: "active", count: 2 }]);
    expect(r.playbookCoverage.reasonsSeen).toBe(4);
    expect(r.playbookCoverage.reasonsWithoutPlaybook).toBe(2);
    expect(r.playbookCoverage.withoutPlaybook.rows.map((x) => `${x.codeKind}:${x.code}`)).toEqual([
      "rarc:N1",
      "carc:97",
    ]);
  });

  it("counts every instant on a window seam exactly once (current, previous, neither), with a pinned clock", async () => {
    const day = (d: string) => `${d}T00:00:00.000Z`;
    const w = { from: "2026-03-02", to: "2026-03-11" }; // 10 days; previous = 2026-02-20 .. 2026-03-01
    const at = {
      prevStartMinus1: "2026-02-19T23:59:59.999Z", // neither
      prevStart: day("2026-02-20"), // previous
      prevEnd: "2026-03-01T23:59:59.999Z", // previous
      start: day("2026-03-02"), // current
      end: "2026-03-11T23:59:59.999Z", // current
      after: day("2026-03-12"), // neither
    };
    for (const instant of Object.values(at))
      await denial({ openedAt: instant, carc: "81", dollars: 1 });
    for (const [name, instant] of Object.entries(at)) {
      const appealId = await fx.mkAppeal({
        claimId: fx.claim1,
        pe: fx.pe1,
        tier: "redetermination",
      });
      await fx.admin.query(
        "UPDATE appeal_case SET state='submitted', submitted_at=$2::timestamptz WHERE id=$1",
        [appealId, instant],
      );
      void name;
    }
    for (const requestedOn of [
      "2026-02-19",
      "2026-02-20",
      "2026-03-01",
      "2026-03-02",
      "2026-03-11",
      "2026-03-12",
    ]) {
      await adr({
        requestedOn,
        mac: "MAC-SEAM",
        state: "in_assembly",
        dueAgo: -10,
        verified: true,
      });
    }
    const pinned = buildMedicalReviewReportService(fx.handle.db, {
      now: () => new Date("2026-03-20T12:00:00Z"),
    });
    const r = await pinned.getReport(fx.actor(), { ...w });
    expect(r.window.previous).toEqual({ from: "2026-02-20", to: "2026-03-01" });
    expect(r.generatedAt).toBe("2026-03-20T12:00:00.000Z");
    expect(r.denials.opened).toMatchObject({ value: 2, previous: 2 });
    expect(r.appeals.filed).toMatchObject({ value: 2, previous: 2 });
    expect(r.adrs.received).toMatchObject({ value: 2, previous: 2 });
    // A window ending after the pinned clock's day is refused whatever the real date is.
    expect(
      await fx.refused(pinned.getReport(fx.actor(), { from: "2026-03-10", to: "2026-03-21" })),
    ).toMatchObject({
      code: "REPORT_WINDOW_INVALID",
    });
  });

  it("decides playbook coverage per denial with the panel's MAC and code matching", async () => {
    const pb = buildDrizzlePlaybookService(fx.handle.db);
    const mk = async (code: string, macName?: string) => {
      const created = await pb.createPlaybook(fx.actor(), {
        codeKind: "carc",
        code,
        ...(macName ? { macName } : {}),
        title: `CARC ${code}`,
        summary: "s",
        sourceNote: "fixture",
        steps: [{ key: "a", text: "a" }],
      } as never);
      await pb.publishVersion(
        { ...fx.actor(), userId: userA2, membershipId: memberA2 },
        created.versionId,
        1,
      );
    };
    await mk("70", "mac-x"); // MAC-specific, written in lower case
    await mk("72"); // any MAC
    const w = { from: "2026-01-05", to: "2026-01-09" };
    const opened = "2026-01-06T10:00:00.000Z";
    // CARC 70: nine denials under MAC-X (covered) and one under MAC-Y (uncovered).
    for (let i = 0; i < 9; i++) {
      const d = await denial({ openedAt: opened, carc: "70", dollars: 1 });
      await adr({
        denialId: d,
        mac: "MAC-X",
        state: "in_assembly",
        dueAgo: -10,
        verified: true,
        requested: 400,
      });
    }
    const other = await denial({ openedAt: opened, carc: "70", dollars: 1 });
    await adr({
      denialId: other,
      mac: "MAC-Y",
      state: "in_assembly",
      dueAgo: -10,
      verified: true,
      requested: 400,
    });
    // CARC 70 with no ADR at all: no MAC, so a MAC-specific playbook does not apply.
    await denial({ openedAt: opened, carc: "70", dollars: 1 });
    // The MAC may come from an unlinked ADR on the same claim (the panel's fallback).
    const viaClaim = await denial({ openedAt: opened, carc: "70", dollars: 1, claim: fx.claim1b });
    void viaClaim;
    await adr({
      mac: "MAC-X",
      claim: fx.claim1b,
      state: "in_assembly",
      dueAgo: -10,
      verified: true,
      requested: 400,
    });
    // An any-MAC playbook covers whatever the MAC.
    await denial({ openedAt: opened, carc: "72", dollars: 1 });
    const pinned = buildMedicalReviewReportService(fx.handle.db, {
      now: () => new Date("2026-01-20T12:00:00Z"),
    });
    const r = await pinned.getReport(fx.actor(), w);
    const cov = r.playbookCoverage;
    expect(cov.denialsSeen).toBe(13);
    expect(cov.denialsWithoutPlaybook).toBe(2); // MAC-Y and no-ADR
    expect(cov.reasonsSeen).toBe(2);
    expect(cov.reasonsWithoutPlaybook).toBe(1); // one reason, with covered AND uncovered denials
    expect(cov.withoutPlaybook.rows).toEqual([
      { codeKind: "carc", code: "70", count: 2, dollars: "2.00" },
    ]);
    // The same code is listed once in the by-reason table, with all its denials.
    expect(r.denials.byReason.rows.find((x) => x.code === "70")).toMatchObject({ count: 12 });
    // Every figure agrees with what the panel resolves for those denials.
    const panelView = await pb.getDenialPlaybook(fx.actor(), other);
    expect(panelView.playbook).toBeNull();
  });

  it("passes the entity filter into the TPE section so a filtered report is not truncated by other entities", async () => {
    await fx.admin.query(
      "INSERT INTO tpe_program (organization_id, provider_entity_id, mac_name, opened_on, state) VALUES ($1,$2,'MAC-PE2',CURRENT_DATE - 5,'active')",
      [ORG, fx.pe2],
    );
    const r = await report(fx.actor(), { providerEntityId: fx.pe2 });
    expect(r.tpe.active.map((p) => p.macName)).toEqual(["MAC-PE2"]);
    expect(r.tpe.truncated).toBe(false);
    await fx.admin.query("DELETE FROM tpe_program WHERE mac_name='MAC-PE2'");
  });

  it("stops counting a reason as covered once its playbook is retired", async () => {
    const pb = buildDrizzlePlaybookService(fx.handle.db);
    const [first] = (await pb.listPlaybooks(fx.actor())).items;
    const detail = await pb.getPlaybook(fx.actor(), (first as { id: string }).id);
    const live = detail?.versions.find((v) => v.status === "published");
    await pb.retireVersion(
      { ...fx.actor(), userId: userA2, membershipId: memberA2 },
      (live as { id: string }).id,
      (live as { rowVersion: number }).rowVersion,
    );
    const r = await report();
    expect(r.playbookCoverage.reasonsWithoutPlaybook).toBe(4);
  });

  it("reads zeros and nulls where there is no data, never an invented rate", async () => {
    const r = await report(fx.actor(), { from: daysAgo(700), to: daysAgo(690) });
    expect(r.adrs.received.value).toBe(0);
    expect(r.adrs.onOrBeforeDueShareOfFiled).toEqual({ value: null, previous: null, change: null });
    expect(r.adrs.medianDaysToFile.value).toBeNull();
    expect(r.denials.byReason).toEqual({ rows: [], omitted: 0 });
    expect(r.appeals.favorableShareOfDecided).toBeNull();
  });

  it("shows another tenant none of this data and sees only its own", async () => {
    const b = await report(fx.actor(ORG_B));
    expect(b.adrs.received.value).toBe(1);
    expect(b.denials.openedDollars.value).toBe("999.00");
    expect(b.appeals.filed.value).toBe(0);
    expect(b.audits).toEqual({ open: 0, openWithNoRecordedDeadline: 0 });
    expect(b.tpe.active).toEqual([]);
    expect(b.adrs.byMac.map((m) => m.macName)).toEqual(["MAC-Z"]);
  });

  it("narrows to the provider-entity scope, and an asked-for entity outside the scope reads as nothing", async () => {
    const pe1 = await report(fx.actor(ORG, [fx.pe1]));
    expect(pe1.adrs.received.value).toBe(3);
    expect(pe1.denials.opened.value).toBe(4);
    const none = await report(fx.actor(ORG, []));
    expect(none.adrs.received.value).toBe(0);
    expect(none.denials.opened.value).toBe(0);
    expect(none.audits.open).toBe(0);
    const outside = await report(fx.actor(ORG, [fx.pe1]), { providerEntityId: fx.pe2 });
    expect(outside.adrs.received.value).toBe(0);
    const asked = await report(fx.actor(), { providerEntityId: fx.pe2 });
    expect(asked.adrs.received.value).toBe(1);
    expect(asked.denials.opened.value).toBe(1);
  });

  it("enforces the window bound with a typed 422", async () => {
    for (const q of [
      { from: daysAgo(500), to: daysAgo(1) },
      { from: daysAgo(5), to: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) },
      { from: daysAgo(1), to: daysAgo(5) },
      { from: "2026-02-30", to: daysAgo(1) },
    ]) {
      expect(await fx.refused(report(fx.actor(), q))).toMatchObject({
        code: "REPORT_WINDOW_INVALID",
        statusCode: 422,
      });
    }
  });

  it("returns no patient, claim or person field and no target, benchmark or score field", async () => {
    const r = await report();
    expect(Value.Check(MedicalReviewReportSchema, JSON.parse(JSON.stringify(r)))).toBe(true);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(r);
    expect(
      keys.filter(
        (k) => /patient|claim|membership|user|person|assignee|name$/i.test(k) && k !== "macName",
      ),
    ).toEqual([]);
    expect(
      keys.filter((k) => /target|benchmark|goal|score|compliant|grade|rating/i.test(k)),
    ).toEqual([]);
  });

  describe("route", () => {
    function makeApp(keys: string[]) {
      resetAuthorizationContract();
      resetRbacEngine();
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          {
            orgId: ORG,
            userId: fx.userA,
            grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
          },
        ]).store,
      );
      const app = buildServer({
        db: fx.handle.db as never,
        authenticate: (request: FastifyRequest) => {
          request.context.userId = fx.userA;
          request.context.organizationId = ORG;
          request.context.roles = ["billing_manager"];
          request.context.providerEntityIds = [fx.pe1, fx.pe2];
          request.context.attributes = { ...request.context.attributes, membershipId: fx.memberA };
        },
        security: { rateLimitEnabled: false },
      });
      registerMedicalReviewReportRoutes(app, {
        medicalReviewReportService: buildMedicalReviewReportService(fx.handle.db),
      });
      return app;
    }
    const url = `/api/v1/medical-review/report?from=${window.from}&to=${window.to}`;

    it("gates on medical_review.report.read, answers no-store, and refuses a bad window", async () => {
      const none = makeApp([]);
      expect((await none.inject({ method: "GET", url })).statusCode).toBe(403);
      await none.close();
      const other = makeApp(["appeal.read", "denial.read"]);
      expect((await other.inject({ method: "GET", url })).statusCode).toBe(403);
      await other.close();
      const app = makeApp(["medical_review.report.read"]);
      const ok = await app.inject({ method: "GET", url });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.json().adrs.received.value).toBe(4);
      // One aggregate read event per request is recorded (actor, resource kind; the window is the query filter).
      const events = (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'medical_review_report.%'",
          [ORG],
        )
      ).rows[0].n as number;
      expect(events).toBeGreaterThanOrEqual(1);
      expect(ok.json().tpe.available).toBe(false); // this app was built without the TPE reader
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/medical-review/report?from=${daysAgo(900)}&to=${window.to}`,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/medical-review/report" })).statusCode,
      ).toBe(422);
      expect(
        (await app.inject({ method: "GET", url: `${url}&providerEntityId=not-a-uuid` })).statusCode,
      ).toBe(422);
      await app.close();
    });
  });

  it("registers the key and migration 1252 grants existing roles idempotently", async () => {
    const key = await fx.admin.query(
      "SELECT key FROM permission WHERE key='medical_review.report.read'",
    );
    expect(key.rows).toHaveLength(1);
    const mkRole = async (k: string, grants: string[]) => {
      const id = (
        await fx.admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'billing_finance',true) RETURNING id`,
          [ORG, k],
        )
      ).rows[0].id as string;
      for (const g of grants) {
        await fx.admin.query(
          "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
          [ORG, id, g],
        );
      }
      return id;
    };
    const roles = {
      compliance: await mkRole("compliance_officer", ["audit.read"]),
      admin: await mkRole("administrator", ["org.manage"]),
      orgAdmin: await mkRole("org_admin", ["org.manage"]),
      lead: await mkRole("mr-lead", ["appeal.decide"]),
      worker: await mkRole("mr-worker", ["denial.read", "appeal.read"]),
    };
    const migration = readFileSync(
      join(fx.migrationsDir, "1252_m25_medical_review_report_permission.sql"),
      "utf8",
    );
    await fx.admin.query(migration);
    await fx.admin.query(migration);
    const held = async (id: string) =>
      (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM role_permission WHERE role_id=$1 AND permission_key='medical_review.report.read'",
          [id],
        )
      ).rows[0].n as number;
    expect(await held(roles.compliance)).toBe(1);
    expect(await held(roles.admin)).toBe(1);
    expect(await held(roles.orgAdmin)).toBe(1);
    expect(await held(roles.lead)).toBe(1);
    expect(await held(roles.worker)).toBe(0);
  });
});
