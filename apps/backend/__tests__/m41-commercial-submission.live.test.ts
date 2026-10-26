/**
 * M41 Billing - Commercial, the SUBMISSION slice (ADR-0053 D10, ADR-0100 D4/D5/D9) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`
 * role, with the IN-MEMORY clearinghouse transport (nothing leaves the process).
 *
 *   S18  not routed / not enrolled / transport unbound: refused with a stable code, NO submission row and NO event (so no job).
 *   S15  a ready claim is queued by `submit` (claim stays ready), the drain sends it through the transport, and ONLY the transport's
 *        receipt moves it ready -> submitted (history row + m41.claim.submitted in the same transaction).
 *
 * Also proves: the Idempotency-Key replay and the one-live-submission rule; a retryable outage requeues and later sends once; an
 * incomplete 837I (no parties source) ends `failed` with the claim still ready; an unbound tick sends nothing and fails; void is
 * refused while a submission is in flight; the timeline; tenant isolation of commercial_submission as chartwarden_app; the REAL
 * catalog-validating outbox publisher is used (not NOOP_OUTBOX).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m41:commercial-submission:live
 * (SUPERUSER to a THROWAWAY db on a PRIVATE pgvector/pgvector:pg18 - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM41OverrideAuditPort } from "../src/m41-override-audit";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import {
  type CommercialActor,
  type CommercialClaimSeams,
  M41_OUTBOX_EVENTS,
  applyAckEvent,
  buildCommercial837iRenderer,
  buildCommercialClaimAssemblyService,
  buildCommercialClaimLifecycleService,
  buildCommercialContextPort,
  buildCommercialSubmissionService,
  createDrizzleAckCursorStore,
  runAckPull,
  runSubmissionDrain,
} from "../src/modules/41-billing-commercial/index";
import type {
  AckWorkerDeps,
  SubmissionWorkerDeps,
} from "../src/modules/41-billing-commercial/index";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "00000000-0000-4000-8000-0000000043a1";
const ORG_B = "00000000-0000-4000-8000-0000000043b1";
const USER = "00000000-0000-4000-8000-0000000043c1";
const FROM = "2026-03-01";
const TO = "2026-03-31";
const NPI = "1234567893";

describe.skipIf(!DB_URL)("M41 commercial submission - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId: string;
  let membershipId: string;
  let actor: CommercialActor;
  let transport: InMemoryClearinghouse;
  let coverageReader: ReturnType<typeof buildPatientCoverageReader>;
  let partiesAvailable = true;

  const scalar = async <T>(query: string, params: unknown[] = []): Promise<T> =>
    (await admin.query(query, params)).rows[0]?.n as T;

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; statusCode?: number; details?: { code: string }[] }) => e,
    );

  const seams = (admissionId: string): CommercialClaimSeams => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M41_OUTBOX_EVENTS]));
    return {
      coverage: coverageReader,
      caseload: { isInCaseload: async () => true },
      admission: {
        resolveForRange: async () => ({
          admissionId,
          providerEntityId,
          hospiceAdmissionDate: "2026-03-01",
          admissionTypeCode: "1",
          admissionSourceCode: "1",
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: null,
          placeOfDeath: null,
          transferOut: null,
        }),
      },
      electionPeriods: {
        coveringRange: async () => [
          {
            electionPeriodId: randomUUID(),
            sequence: 1,
            effectiveFrom: "2026-03-01",
            effectiveTo: null,
            revoked: false,
            revocationDate: null,
          },
        ],
      },
      levelOfCare: {
        periodsInRange: async () => [
          {
            levelOfCarePeriodId: randomUUID(),
            levelOfCare: "routine_home_care" as const,
            from: FROM,
            to: TO,
            chcDocumentedHours: null,
            gipAdmissionCriteriaDocumented: null,
          },
        ],
      },
      diagnoses: {
        forRange: async () => ({
          sequence: [{ position: 1, code: "C34.90", relationship: "terminal" as const }],
          withheldForConsentCount: 0,
          terminalWithheldForConsent: false,
        }),
      },
      clinicalParticipants: {
        resolveClinicalParticipants: async () => ({
          attending: {
            npi: "1245319599",
            firstName: "Alan",
            lastName: "Smith",
            status: "active" as const,
            licenseUnexpiredOnServiceDates: true,
          },
          hospicePhysician: null,
          placeOfService: "home",
        }),
      },
      outbox: {
        publish: (tx, e) =>
          publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
            ...e,
            callerModule: "m41",
          }),
      },
      audit: buildM41OverrideAuditPort(),
    };
  };

  /** A ready claim for a fresh patient, plan, route and (optionally) an enrollment. */
  async function readyClaim(
    opts: { enrolled?: boolean; routed?: boolean } = {},
  ): Promise<{ claimId: string; controlNumber: string; planId: string; payerId: string }> {
    const payerId = (
      await admin.query(
        "INSERT INTO payer (kind, name) VALUES ('commercial'::payer_kind, $1) RETURNING id",
        [`Synthetic Commercial Health ${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
    const planId = (
      await admin.query(
        `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement, effective_from)
         VALUES ($1,$2,'Synthetic PPO','CI','not_required','2026-01-01') RETURNING id`,
        [ORG, payerId],
      )
    ).rows[0].id as string;
    if (opts.routed !== false) {
      await admin.query(
        `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
         VALUES ($1,$2,'stedi','SYNTH01','2026-01-01')`,
        [ORG, planId],
      );
    }
    if (opts.enrolled !== false) {
      await admin.query(
        `INSERT INTO commercial_payer_enrollment (organization_id, provider_entity_id, payer_id, clearinghouse_key, status, effective_from)
         VALUES ($1,$2,$3,'stedi','enrolled','2026-01-01')`,
        [ORG, providerEntityId, payerId],
      );
    }
    await admin.query(
      `INSERT INTO commercial_contract_rate (organization_id, plan_id, level_of_care, revenue_code, rate_basis, rate_cents, effective_from)
       VALUES ($1,$2,'routine_home_care','0651','per_diem',20000,'2026-01-01')`,
      [ORG, planId],
    );
    const patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,'Jane','Doe','1950-01-01','female','active') RETURNING id`,
        [ORG, `mrn-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, group_number, effective_from)
       VALUES ($1,$2,$3,1,'commercial'::patient_payer_coverage_kind,'MEM-0001234','GRP100','2026-01-01')`,
      [patientId, ORG, payerId],
    );
    const s = seams(randomUUID());
    const out = await buildCommercialClaimAssemblyService(handle.db, s).assemble(actor, {
      providerEntityId,
      patientId,
      serviceFrom: FROM,
      serviceTo: TO,
    });
    await buildCommercialClaimLifecycleService(handle.db, s).assertReady(actor, out.claimId);
    const controlNumber = await scalar<string>(
      "SELECT claim_control_number AS n FROM commercial_claim WHERE id=$1",
      [out.claimId],
    );
    return { claimId: out.claimId, controlNumber, planId, payerId };
  }

  const service = (vendor: string | null) =>
    buildCommercialSubmissionService(handle.db, seams(randomUUID()), { vendor });

  const renderer = () =>
    buildCommercial837iRenderer(handle.db, {
      coverage: coverageReader,
      caseload: { isInCaseload: async () => true },
      identity: {
        identityFor: async () => ({
          lastName: "Doe",
          firstName: "Jane",
          dateOfBirth: "1950-01-01",
          sex: "F",
          address: { line1: "200 Oak Ave", city: "Salem", state: "OR", postalCode: "97301" },
        }),
      },
      parties: {
        partiesFor: async () =>
          partiesAvailable
            ? {
                submitter: {
                  name: "Example Hospice",
                  id: "CHARTWARDEN01",
                  contactName: "Billing Office",
                  contactPhone: "5035550100",
                },
                receiver: { name: "Stedi Test Payer", id: "STEDI", applicationCode: "STEDI" },
                billingProvider: {
                  organizationName: "Example Hospice",
                  npi: NPI,
                  taxId: "931234567",
                  address: {
                    line1: "100 Main St",
                    city: "Portland",
                    state: "OR",
                    postalCode: "97201",
                  },
                },
                payerName: "Synthetic Commercial Health",
                secondaryPayer: null,
              }
            : null,
      },
    });

  const workerDeps = (
    vendor: string | null,
    over: {
      transport?: SubmissionWorkerDeps["binding"]["transport"];
      failPublish?: (eventName: string) => boolean;
    } = {},
  ): SubmissionWorkerDeps => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M41_OUTBOX_EVENTS]));
    return {
      db: handle.db,
      binding: { vendor, transport: over.transport ?? transport },
      contexts: buildCommercialContextPort({
        env: {},
        providerNpi: async () => NPI,
      }),
      renderer: renderer(),
      outbox: {
        publish: (tx, e) => {
          if (over.failPublish?.(e.eventName)) throw new Error(`injected fault on ${e.eventName}`);
          return publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
            ...e,
            callerModule: "m41",
          });
        },
      },
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
    };
  };

  /** A transport that FILES the claim at the in-memory clearinghouse and then loses the connection: the send is ambiguous. */
  const crashAfterAccept = (calls: { n: number } = { n: 0 }) => ({
    calls,
    submitClaim: async (...args: Parameters<InMemoryClearinghouse["submitClaim"]>) => {
      calls.n += 1;
      await transport.submitClaim(...args);
      throw new Error("connection reset after the file was accepted");
    },
  });
  /** A transport that records every call and the receipt flags it got back from the real in-memory clearinghouse. */
  const recordingTransport = () => {
    const results: { replayed: boolean | null; ok: boolean }[] = [];
    return {
      results,
      submitClaim: async (...args: Parameters<InMemoryClearinghouse["submitClaim"]>) => {
        const r = await transport.submitClaim(...args);
        results.push({ ok: r.ok, replayed: r.ok ? r.data.replayed : null });
        return r;
      },
    };
  };
  const submissionStatus = (id: string) =>
    scalar<string>("SELECT status AS n FROM commercial_submission WHERE id=$1", [id]);
  const submissionRow = async (id: string) =>
    (await admin.query("SELECT * FROM commercial_submission WHERE id=$1", [id])).rows[0];
  const quarantined = async (eventId: string, org: string) =>
    (
      await admin.query(
        "SELECT control_number, reason FROM commercial_ack_quarantine WHERE event_id=$1 AND organization_id=$2",
        [eventId, org],
      )
    ).rows;
  /** Submit, then let the send end ambiguous (the file reached the clearinghouse, the answer was lost). */
  async function stageInDoubt(c: { claimId: string }, submissionId: string): Promise<void> {
    await runSubmissionDrain(workerDeps("stedi", { transport: crashAfterAccept() }));
    expect(await submissionStatus(submissionId)).toBe("in_doubt");
    expect(await claimState(c.claimId)).toBe("ready");
  }

  const eventCount = (claimId: string, name: string) =>
    scalar<number>(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND payload->>'claimId'=$2",
      [name, claimId],
    );
  const submissionCount = (claimId: string) =>
    scalar<number>("SELECT count(*)::int AS n FROM commercial_submission WHERE claim_id=$1", [
      claimId,
    ]);
  const claimState = (claimId: string) =>
    scalar<string>("SELECT state AS n FROM commercial_claim WHERE id=$1", [claimId]);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG, "m41s-a"],
      [ORG_B, "m41s-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m41sub@x.test')`, [USER]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'123456','Synthetic Hospice',$2,'\\x00','12-31') RETURNING id`,
        [ORG, NPI],
      )
    ).rows[0].id as string;
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    coverageReader = buildPatientCoverageReader(handle.db);
    transport = new InMemoryClearinghouse();
    actor = {
      organizationId: ORG,
      userId: USER,
      membershipId,
      actorKind: "user",
      stepUpRecent: true,
      billingScope: { all: false, providerEntityIds: [providerEntityId] },
    };
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  describe("S18 the send gate refuses and writes nothing", () => {
    it("unbound transport: 503 CH_NOT_WIRED, no submission, no event", async () => {
      const c = await readyClaim();
      const err = await failure(service(null).submit(actor, c.claimId, "key-unbound"));
      expect(err?.statusCode).toBe(503);
      expect(err?.code).toBe("COMMERCIAL_SEND_REFUSED");
      expect(err?.details?.map((d) => d.code)).toContain("CH_NOT_WIRED");
      expect(await submissionCount(c.claimId)).toBe(0);
      expect(await eventCount(c.claimId, "m41.claim.submit_requested")).toBe(0);
      expect(await claimState(c.claimId)).toBe("ready");
    });

    it("payer not routed by the bound clearinghouse", async () => {
      const c = await readyClaim();
      const err = await failure(service("other_vendor").submit(actor, c.claimId, "key-route"));
      expect(err?.statusCode).toBe(409);
      expect(err?.details?.map((d) => d.code)).toContain("COMMERCIAL_PAYER_NOT_ROUTED");
      expect(await submissionCount(c.claimId)).toBe(0);
    });

    it("provider entity not enrolled", async () => {
      const c = await readyClaim({ enrolled: false });
      const err = await failure(service("stedi").submit(actor, c.claimId, "key-enroll"));
      expect(err?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_PROVIDER_NOT_ENROLLED"]);
      expect(await submissionCount(c.claimId)).toBe(0);
      expect(await eventCount(c.claimId, "m41.claim.submit_requested")).toBe(0);
    });

    it("send-gate view lists the same reasons before the click", async () => {
      const c = await readyClaim({ enrolled: false });
      const view = await service("stedi").sendGate(actor, c.claimId);
      expect(view.canSubmit).toBe(false);
      expect(view.reasons.map((r) => r.code)).toEqual(["COMMERCIAL_PROVIDER_NOT_ENROLLED"]);
      const unbound = await service(null).sendGate(actor, c.claimId);
      expect(unbound.clearinghouseKey).toBeNull();
      expect(unbound.reasons[0]?.code).toBe("CH_NOT_WIRED");
    });

    it("a claim that is not ready is refused with CLAIM_NOT_READY", async () => {
      const c = await readyClaim();
      await buildCommercialClaimLifecycleService(handle.db, seams(randomUUID())).voidClaim(
        actor,
        c.claimId,
      );
      const err = await failure(service("stedi").submit(actor, c.claimId, "key-void"));
      expect(err?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_CLAIM_NOT_READY"]);
    });
  });

  describe("S15 submit queues, the drain sends, only the receipt moves the claim", () => {
    it("queues one submission, replays by key, refuses a second live one, then sends and submits", async () => {
      const c = await readyClaim();
      const svc = service("stedi");
      const first = await svc.submit(actor, c.claimId, "key-1");
      expect(first.status).toBe("queued");
      expect(first.replayed).toBe(false);
      expect(await claimState(c.claimId)).toBe("ready"); // queued is not submitted
      expect(await eventCount(c.claimId, "m41.claim.submit_requested")).toBe(1);

      const replay = await svc.submit(actor, c.claimId, "key-1");
      expect(replay.replayed).toBe(true);
      expect(replay.submissionId).toBe(first.submissionId);
      expect(await submissionCount(c.claimId)).toBe(1);

      const second = await failure(svc.submit(actor, c.claimId, "key-2"));
      expect(second?.details?.map((d) => d.code)).toContain("COMMERCIAL_SUBMISSION_IN_FLIGHT");
      expect(await submissionCount(c.claimId)).toBe(1);

      // a claim with a submission in flight cannot be voided or re-readied
      const voidErr = await failure(
        buildCommercialClaimLifecycleService(handle.db, seams(randomUUID())).voidClaim(
          actor,
          c.claimId,
        ),
      );
      expect(voidErr?.statusCode).toBe(409);

      const result = await runSubmissionDrain(workerDeps("stedi"));
      expect(result.sent).toBeGreaterThanOrEqual(1);
      expect(await claimState(c.claimId)).toBe("submitted");
      const row = (
        await admin.query(
          "SELECT status, attempt_count, clearinghouse_submission_id, sent_at FROM commercial_submission WHERE id=$1",
          [first.submissionId],
        )
      ).rows[0];
      expect(row.status).toBe("sent");
      expect(row.attempt_count).toBe(1);
      expect(row.clearinghouse_submission_id).toBeTruthy();
      expect(row.sent_at).not.toBeNull();
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
      const hist = await admin.query(
        "SELECT from_state, to_state, actor_kind FROM commercial_claim_state_history WHERE claim_id=$1 AND to_state='submitted'",
        [c.claimId],
      );
      expect(hist.rows).toEqual([
        { from_state: "ready", to_state: "submitted", actor_kind: "system" },
      ]);

      // the transport really has the claim under our control number (an ack for it is accepted)
      const scope = { organizationId: ORG, providerEntityId, usage: "test" as const };
      await expect(
        transport.control.clearinghouseAccepts(c.controlNumber, scope),
      ).resolves.toBeUndefined();

      // no member id or name in any event payload
      const payloads = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type LIKE 'm41.claim.submit%' AND payload->>'claimId'=$1",
        [c.claimId],
      );
      expect(JSON.stringify(payloads.rows)).not.toMatch(/MEM-0001234|GRP100|Doe|Jane/);

      // a draining again sends nothing twice; the sent claim cannot be re-submitted, voided or re-validated
      await runSubmissionDrain(workerDeps("stedi"));
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
      const again = await failure(svc.submit(actor, c.claimId, "key-3"));
      expect(again?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_CLAIM_NOT_READY"]);
      const lifecycle = buildCommercialClaimLifecycleService(handle.db, seams(randomUUID()));
      expect((await failure(lifecycle.voidClaim(actor, c.claimId)))?.statusCode).toBe(409);
      expect((await failure(lifecycle.validate(actor, c.claimId)))?.statusCode).toBe(409);
      expect((await failure(lifecycle.markReady(actor, c.claimId)))?.statusCode).toBe(409);

      // the database backstop refuses a sent claim going back to ready
      await expect(
        admin.query("UPDATE commercial_claim SET state='ready' WHERE id=$1", [c.claimId]),
      ).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);

      // timeline: ordered, ids/dates/codes only
      const tl = await svc.timeline(actor, c.claimId);
      expect(tl.state).toBe("submitted");
      expect(tl.truncated).toBe(false);
      const kinds = tl.items.map((i) =>
        i.kind === "state_change"
          ? `${i.fromState}>${i.toState}`
          : i.kind === "submission"
            ? `submission:${i.status}`
            : `ack:${i.stage}`,
      );
      expect(kinds).toContain("ready>submitted");
      expect(kinds).toContain("submission:sent");
      expect(kinds.indexOf("ready>submitted")).toBeGreaterThan(kinds.indexOf("draft>ready"));
      expect(JSON.stringify(tl)).not.toMatch(/MEM-0001234|GRP100|Doe|Jane/);
    });

    it("a retryable outage requeues, then sends exactly once when the transport is back", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, "key-outage");
      await transport.control.setOutage(true);
      await expect(runSubmissionDrain(workerDeps("stedi"))).resolves.toBeDefined();
      await transport.control.setOutage(false);
      let row = (
        await admin.query(
          "SELECT status, attempt_count, last_failure_code FROM commercial_submission WHERE id=$1",
          [sub.submissionId],
        )
      ).rows[0];
      expect(row).toMatchObject({
        status: "queued",
        attempt_count: 1,
        last_failure_code: "CH_UNAVAILABLE",
      });
      expect(await claimState(c.claimId)).toBe("ready"); // a degraded answer never moves the claim
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(0);

      await admin.query(
        "UPDATE commercial_submission SET next_attempt_at = now() - interval '1 second' WHERE id=$1",
        [sub.submissionId],
      );
      await runSubmissionDrain(workerDeps("stedi"));
      row = (
        await admin.query("SELECT status, attempt_count FROM commercial_submission WHERE id=$1", [
          sub.submissionId,
        ])
      ).rows[0];
      expect(row).toMatchObject({ status: "sent", attempt_count: 2 });
      expect(await claimState(c.claimId)).toBe("submitted");
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
    });

    it("an incomplete 837I (no parties source) ends failed, leaves the claim ready and emits submit_failed", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, "key-gap");
      partiesAvailable = false;
      try {
        await runSubmissionDrain(workerDeps("stedi"));
      } finally {
        partiesAvailable = true;
      }
      const row = (
        await admin.query(
          "SELECT status, last_failure_code FROM commercial_submission WHERE id=$1",
          [sub.submissionId],
        )
      ).rows[0];
      expect(row).toEqual({ status: "failed", last_failure_code: "COMMERCIAL_837I_INCOMPLETE" });
      expect(await claimState(c.claimId)).toBe("ready");
      expect(await eventCount(c.claimId, "m41.claim.submit_failed")).toBe(1);
      // failed releases the live slot: the user can submit again with a new key
      const retry = await service("stedi").submit(actor, c.claimId, "key-gap-2");
      expect(retry.status).toBe("queued");
    });

    it("the gate is judged again at send time: an enrollment ended after queueing sends nothing", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, "key-regate");
      await admin.query(
        "UPDATE commercial_payer_enrollment SET status='suspended' WHERE payer_id=$1",
        [c.payerId],
      );
      await runSubmissionDrain(workerDeps("stedi"));
      const row = (
        await admin.query(
          "SELECT status, last_failure_code FROM commercial_submission WHERE id=$1",
          [sub.submissionId],
        )
      ).rows[0];
      expect(row).toEqual({
        status: "failed",
        last_failure_code: "COMMERCIAL_PROVIDER_NOT_ENROLLED",
      });
      expect(await claimState(c.claimId)).toBe("ready");
    });

    it("an unbound tick sends nothing and fails while a submission waits", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, "key-unbound-tick");
      await expect(runSubmissionDrain(workerDeps(null))).rejects.toThrow(/CH_NOT_WIRED/);
      const row = (
        await admin.query("SELECT status, attempt_count FROM commercial_submission WHERE id=$1", [
          sub.submissionId,
        ])
      ).rows[0];
      expect(row).toEqual({ status: "queued", attempt_count: 0 });
      expect(await claimState(c.claimId)).toBe("ready");
      // clean up so later ticks are not affected
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE id=$1",
        [sub.submissionId],
      );
    });
  });

  describe("ambiguous sends, in_doubt and the way out", () => {
    const queued = async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      return { c, sub };
    };
    const dueNow = (id: string, set = "") =>
      admin.query(
        `UPDATE commercial_submission SET next_attempt_at = now() - interval '1 second'${set} WHERE id=$1`,
        [id],
      );

    it("a transport that throws after the file left ends in_doubt, is never resent automatically, and holds the slot", async () => {
      const { c, sub } = await queued();
      const calls = { n: 0 };
      await runSubmissionDrain(workerDeps("stedi", { transport: crashAfterAccept(calls) }));
      expect(calls.n).toBe(1);
      const row = await submissionRow(sub.submissionId);
      expect(row).toMatchObject({
        status: "in_doubt",
        ambiguous: true,
        last_failure_code: "COMMERCIAL_TRANSPORT_FAULT",
        transport_call_started_at: null,
      });
      expect(await claimState(c.claimId)).toBe("ready"); // never submitted on a guess
      expect(await eventCount(c.claimId, "m41.claim.submit_failed")).toBe(1);

      // ticks later: not one more transport call, nothing changes
      const later = recordingTransport();
      await dueNow(sub.submissionId);
      await runSubmissionDrain(workerDeps("stedi", { transport: later }));
      await runSubmissionDrain(workerDeps("stedi", { transport: later }));
      expect(later.results).toEqual([]);
      expect(await submissionStatus(sub.submissionId)).toBe("in_doubt");

      // the live slot is held: a second submit is refused, and the claim cannot be voided from under it
      const again = await failure(service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`));
      expect(again?.details?.map((d) => d.code)).toContain("COMMERCIAL_SUBMISSION_IN_FLIGHT");
      const lifecycle = buildCommercialClaimLifecycleService(handle.db, seams(randomUUID()));
      expect((await failure(lifecycle.voidClaim(actor, c.claimId)))?.statusCode).toBe(409);
    });

    it("a fault while recording what the transport ACCEPTED ends in_doubt with the receipt, never failed", async () => {
      const { c, sub } = await queued();
      await runSubmissionDrain(
        workerDeps("stedi", { failPublish: (name) => name === "m41.claim.submitted" }),
      );
      const row = await submissionRow(sub.submissionId);
      expect(row.status).toBe("in_doubt");
      expect(row.last_failure_code).toBe("COMMERCIAL_RECORD_FAULT");
      expect(row.clearinghouse_submission_id).toBeTruthy(); // the receipt is kept for the person who reconciles
      expect(row.sent_at).toBeNull();
      expect(await claimState(c.claimId)).toBe("ready");
    });

    it("a crash after the transport accepted: the next lease replays the receipt and the claim is filed once", async () => {
      const { c, sub } = await queued();
      // the file is accepted, then neither the result nor the in-doubt record can be written (the process 'dies')
      await expect(
        runSubmissionDrain(
          workerDeps("stedi", {
            failPublish: (name) =>
              name === "m41.claim.submitted" || name === "m41.claim.submit_failed",
          }),
        ),
      ).rejects.toThrow(/drain failed/);
      let row = await submissionRow(sub.submissionId);
      expect(row.status).toBe("queued");
      expect(row.transport_call_started_at).not.toBeNull(); // the interrupted attempt is on record
      expect(await claimState(c.claimId)).toBe("ready");

      await dueNow(sub.submissionId); // the lease expires
      const recorder = recordingTransport();
      await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
      // the transport was asked once more under the SAME key and payload: it replayed the original receipt, it did not file again
      expect(recorder.results).toEqual([{ ok: true, replayed: true }]);
      row = await submissionRow(sub.submissionId);
      expect(row).toMatchObject({
        status: "sent",
        attempt_count: 2,
        ambiguous: true,
        resolution: "receipt",
      });
      expect(await claimState(c.claimId)).toBe("submitted");
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
    });

    it("exhausted attempts end failed only when no attempt was ambiguous, otherwise in_doubt", async () => {
      const clean = await queued();
      await dueNow(clean.sub.submissionId, ", attempt_count = 5");
      const calls = recordingTransport();
      await runSubmissionDrain(workerDeps("stedi", { transport: calls }));
      expect(await submissionRow(clean.sub.submissionId)).toMatchObject({
        status: "failed",
        last_failure_code: "COMMERCIAL_SUBMISSION_EXHAUSTED",
      });

      const flagged = await queued();
      await dueNow(flagged.sub.submissionId, ", attempt_count = 5, ambiguous = true");
      const interrupted = await queued();
      await dueNow(
        interrupted.sub.submissionId,
        ", attempt_count = 5, transport_call_started_at = now()",
      );
      await runSubmissionDrain(workerDeps("stedi", { transport: calls }));
      for (const s of [flagged.sub, interrupted.sub]) {
        expect(await submissionRow(s.submissionId)).toMatchObject({
          status: "in_doubt",
          ambiguous: true,
          last_failure_code: "COMMERCIAL_SEND_INTERRUPTED",
        });
      }
      expect(calls.results).toEqual([]); // exhaustion never calls the transport
    });

    it("a definite refusal after an ambiguous attempt still ends in_doubt, and a gate refusal at send time too", async () => {
      const a = await queued();
      await dueNow(a.sub.submissionId, ", ambiguous = true");
      await runSubmissionDrain(
        workerDeps("stedi", {
          transport: {
            submitClaim: async () => ({
              ok: false as const,
              degraded: { code: "CH_INVALID_REQUEST", reason: "refused" },
            }),
          },
        }),
      );
      expect(await submissionStatus(a.sub.submissionId)).toBe("in_doubt");

      const b = await queued();
      await dueNow(b.sub.submissionId, ", ambiguous = true");
      await admin.query(
        "UPDATE commercial_payer_enrollment SET status='suspended' WHERE payer_id=$1",
        [b.c.payerId],
      );
      await runSubmissionDrain(workerDeps("stedi"));
      expect(await submissionRow(b.sub.submissionId)).toMatchObject({
        status: "in_doubt",
        last_failure_code: "COMMERCIAL_PROVIDER_NOT_ENROLLED",
      });
    });

    it("leases one row at a time and skips a row another worker holds: two concurrent ticks send once", async () => {
      const { c, sub } = await queued();
      let calls = 0;
      const slow = {
        submitClaim: async (...args: Parameters<InMemoryClearinghouse["submitClaim"]>) => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 400));
          return transport.submitClaim(...args);
        },
      };
      await Promise.all([
        runSubmissionDrain(workerDeps("stedi", { transport: slow })),
        runSubmissionDrain(workerDeps("stedi", { transport: slow })),
      ]);
      expect(calls).toBe(1);
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "sent",
        attempt_count: 1,
      });
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
    });

    it("a row that is still leased is not taken again; once the lease expires an interrupted attempt is picked up as ambiguous", async () => {
      const { c, sub } = await queued();
      // another worker holds it: leased for five minutes, mid-send
      await admin.query(
        "UPDATE commercial_submission SET attempt_count = 1, next_attempt_at = now() + interval '5 minutes', transport_call_started_at = now() WHERE id=$1",
        [sub.submissionId],
      );
      const idle = recordingTransport();
      await runSubmissionDrain(workerDeps("stedi", { transport: idle }));
      expect(idle.results).toEqual([]);
      expect(await submissionStatus(sub.submissionId)).toBe("queued");

      await dueNow(sub.submissionId); // the lease expired; that attempt never finished
      const taker = recordingTransport();
      await runSubmissionDrain(workerDeps("stedi", { transport: taker }));
      expect(taker.results).toHaveLength(1);
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "sent",
        attempt_count: 2,
        ambiguous: true,
      });
      expect(await claimState(c.claimId)).toBe("submitted");
    });

    it("reconcile not_received frees the slot; the re-send replays the earlier receipt (one filing) with the same interchange number", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      const first = await submissionRow(sub.submissionId);
      const svc = service("stedi");
      const done = await svc.reconcile(actor, c.claimId, sub.submissionId, "not_received");
      expect(done.status).toBe("failed");
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "failed",
        resolution: "operator_not_received",
        last_failure_code: "COMMERCIAL_RECONCILED_NOT_RECEIVED",
      });
      expect(await eventCount(c.claimId, "m41.claim.submit_reconciled")).toBe(1);
      expect(await claimState(c.claimId)).toBe("ready");

      const second = await svc.submit(actor, c.claimId, `key-${randomUUID()}`);
      const next = await submissionRow(second.submissionId);
      expect(next.interchange_control_number).toBe(first.interchange_control_number);
      expect(next.payload_stamp.getTime()).toBe(first.payload_stamp.getTime());
      const recorder = recordingTransport();
      await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
      expect(recorder.results).toEqual([{ ok: true, replayed: true }]); // it HAD arrived: replayed, not filed twice
      expect(await claimState(c.claimId)).toBe("submitted");
    });

    it("reconcile received settles it as sent and moves the claim ready -> submitted", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      const done = await service("stedi").reconcile(actor, c.claimId, sub.submissionId, "received");
      expect(done.status).toBe("sent");
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "sent",
        resolution: "operator_confirmed",
      });
      expect(await claimState(c.claimId)).toBe("submitted");
      const hist = await admin.query(
        "SELECT actor_kind FROM commercial_claim_state_history WHERE claim_id=$1 AND to_state='submitted'",
        [c.claimId],
      );
      expect(hist.rows).toEqual([{ actor_kind: "user" }]);
    });

    it("reconcile needs a fresh step-up and a human, and only settles a submission that is in doubt", async () => {
      const { c, sub } = await queued();
      const svc = service("stedi");
      const stale = await failure(
        svc.reconcile({ ...actor, stepUpRecent: false }, c.claimId, sub.submissionId, "received"),
      );
      expect(stale?.code).toBe("STEP_UP_REQUIRED");
      const ai = await failure(
        svc.reconcile({ ...actor, actorKind: "ai_agent" }, c.claimId, sub.submissionId, "received"),
      );
      expect(ai?.statusCode).toBe(403);
      // a queued submission is not in doubt
      const wrongState = await failure(
        svc.reconcile(actor, c.claimId, sub.submissionId, "received"),
      );
      expect(wrongState?.statusCode).toBe(409);
      const unknown = await failure(svc.reconcile(actor, c.claimId, randomUUID(), "received"));
      expect(unknown?.statusCode).toBe(404);
      expect(await submissionStatus(sub.submissionId)).toBe("queued");
      expect(await eventCount(c.claimId, "m41.claim.submit_reconciled")).toBe(0);
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE id=$1",
        [sub.submissionId],
      );
    });

    it("direct_mac (a Medicare contractor's portal) can never carry a commercial claim", async () => {
      const c = await readyClaim();
      const err = await failure(service("direct_mac").submit(actor, c.claimId, "key-direct-mac"));
      expect(err?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_TRANSPORT_UNSUPPORTED"]);
      expect(await submissionCount(c.claimId)).toBe(0);
    });
  });

  describe("acknowledgments (999 clearinghouse stage, 277CA payer stage)", () => {
    const scope = () => ({ organizationId: ORG, providerEntityId, usage: "test" as const });

    const ackDeps = (vendor: string | null): AckWorkerDeps => {
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M41_OUTBOX_EVENTS]));
      return {
        db: handle.db,
        binding: { vendor, transport },
        contexts: buildCommercialContextPort({ env: {}, providerNpi: async () => NPI }),
        cursors: createDrizzleAckCursorStore(handle.db),
        outbox: {
          publish: (tx, e) =>
            publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
              ...e,
              callerModule: "m41",
            }),
        },
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      };
    };

    /** A claim the transport has accepted (state `submitted`). */
    async function sentClaim() {
      const c = await readyClaim();
      await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      await runSubmissionDrain(workerDeps("stedi"));
      expect(await claimState(c.claimId)).toBe("submitted");
      return c;
    }
    const ackRows = (claimId: string) =>
      admin
        .query(
          "SELECT stage, disposition, reason_codes, payer_claim_number FROM commercial_acknowledgment WHERE claim_id=$1 ORDER BY created_at, stage",
          [claimId],
        )
        .then((r) => r.rows);

    it("a clearinghouse acceptance moves submitted to ack_pending and stamps the submission; only the payer stage accepts", async () => {
      const c = await sentClaim();
      await transport.control.clearinghouseAccepts(c.controlNumber, scope());
      const first = await runAckPull(ackDeps("stedi"));
      expect(first.applied).toBeGreaterThanOrEqual(1); // earlier tests left acks in the same stream
      expect(await claimState(c.claimId)).toBe("ack_pending"); // never accepted by the clearinghouse stage
      const stamped = await scalar<boolean>(
        "SELECT clearinghouse_accepted_at IS NOT NULL AS n FROM commercial_submission WHERE claim_id=$1 AND status='sent'",
        [c.claimId],
      );
      expect(stamped).toBe(true);
      expect(await eventCount(c.claimId, "m41.claim.clearinghouse_accepted")).toBe(1);
      expect(await eventCount(c.claimId, "m41.claim.accepted")).toBe(0);

      await transport.control.payerAccepts(c.controlNumber, "PAYER-ICN-1", scope());
      await runAckPull(ackDeps("stedi"));
      expect(await claimState(c.claimId)).toBe("accepted");
      expect(await eventCount(c.claimId, "m41.claim.accepted")).toBe(1);
      expect(await ackRows(c.claimId)).toEqual([
        {
          stage: "clearinghouse",
          disposition: "accepted",
          reason_codes: [],
          payer_claim_number: null,
        },
        {
          stage: "payer",
          disposition: "accepted",
          reason_codes: [],
          payer_claim_number: "PAYER-ICN-1",
        },
      ]);

      // an accepted claim is final for acknowledgments, and cannot be voided locally
      expect(
        (
          await failure(
            buildCommercialClaimLifecycleService(handle.db, seams(randomUUID())).voidClaim(
              actor,
              c.claimId,
            ),
          )
        )?.statusCode,
      ).toBe(409);

      // timeline now carries both stages, distinct, in order
      const tl = await service("stedi").timeline(actor, c.claimId);
      const acks = tl.items.filter((i) => i.kind === "acknowledgment");
      expect(acks.map((a) => (a.kind === "acknowledgment" ? a.stage : ""))).toEqual([
        "clearinghouse",
        "payer",
      ]);
    });

    it("duplicates collapse on the event id: replaying the whole stream changes nothing", async () => {
      const c = await sentClaim();
      await transport.control.clearinghouseAccepts(c.controlNumber, scope());
      const first = await runAckPull(ackDeps("stedi"));
      expect(first.applied).toBeGreaterThanOrEqual(1);
      expect(await claimState(c.claimId)).toBe("ack_pending");
      // lose the persisted cursor (admin only): the next pull re-reads every event from the start of the stream
      await admin.query("DELETE FROM commercial_ack_cursor");
      const replay = await runAckPull(ackDeps("stedi"));
      expect(replay.duplicates).toBeGreaterThanOrEqual(1);
      expect(replay.applied).toBe(0);
      expect(await ackRows(c.claimId)).toHaveLength(1);
      expect(await eventCount(c.claimId, "m41.claim.clearinghouse_accepted")).toBe(1);
      // the same event id applied directly collapses too
      const event = {
        eventId: "replayed-event",
        controlNumber: c.controlNumber,
        stage: "payer" as const,
        disposition: "accepted" as const,
        reasonCodes: [],
        occurredAt: new Date().toISOString(),
      };
      expect((await applyAckEvent(ackDeps("stedi"), scope(), event)).result).toBe("applied");
      expect((await applyAckEvent(ackDeps("stedi"), scope(), event)).result).toBe("duplicate");
      expect(await eventCount(c.claimId, "m41.claim.accepted")).toBe(1);
      expect(await claimState(c.claimId)).toBe("accepted");
    });

    it("a payer rejection rejects the claim with its reason codes; a rejected claim may be voided", async () => {
      const c = await sentClaim();
      await transport.control.payerRejects(c.controlNumber, ["A7:158", "A8:562"], scope());
      await runAckPull(ackDeps("stedi"));
      expect(await claimState(c.claimId)).toBe("rejected");
      expect(await eventCount(c.claimId, "m41.claim.rejected")).toBe(1);
      expect((await ackRows(c.claimId))[0]).toMatchObject({
        stage: "payer",
        disposition: "rejected",
        reason_codes: ["A7:158", "A8:562"],
      });
      await buildCommercialClaimLifecycleService(handle.db, seams(randomUUID())).voidClaim(
        actor,
        c.claimId,
      );
      expect(await claimState(c.claimId)).toBe("void");
    });

    it("a clearinghouse rejection rejects the claim; a partial payer answer rejects it too", async () => {
      const a = await sentClaim();
      const b = await sentClaim();
      await transport.control.clearinghouseRejects(a.controlNumber, ["AK5:R"], scope());
      await transport.control.payerPartiallyAccepts(b.controlNumber, ["STC:A3"], scope());
      await runAckPull(ackDeps("stedi"));
      expect(await claimState(a.claimId)).toBe("rejected");
      expect(await claimState(b.claimId)).toBe("rejected");
    });

    it("a payer answer that arrives before the clearinghouse answer still accepts, and the late 999 does not regress it", async () => {
      const c = await sentClaim();
      await transport.control.payerAccepts(c.controlNumber, "ICN-3", scope());
      await runAckPull(ackDeps("stedi"));
      expect(await claimState(c.claimId)).toBe("accepted");
      await transport.control.clearinghouseAccepts(c.controlNumber, scope());
      // nothing is outstanding for this provider entity now, so drive the late event directly
      const late = await applyAckEvent(ackDeps("stedi"), scope(), {
        eventId: "late-999",
        controlNumber: c.controlNumber,
        stage: "clearinghouse",
        disposition: "accepted",
        reasonCodes: [],
        occurredAt: new Date().toISOString(),
      });
      expect(late.result).toBe("applied");
      expect(await claimState(c.claimId)).toBe("accepted");
      expect(await eventCount(c.claimId, "m41.claim.clearinghouse_accepted")).toBe(0);
    });

    it("an event for a control number that is no commercial submission is skipped and changes nothing", async () => {
      const c = await sentClaim();
      // a Medicare-style submission sharing the provider entity's stream
      const ctx = {
        organizationId: ORG,
        providerEntityId,
        payerId: "MEDICARE",
        correlationId: randomUUID(),
        usage: "test" as const,
        billingNpi: NPI,
      };
      await transport.submitClaim(ctx, {
        kind: "claim",
        controlNumber: "MEDICARE-1",
        idempotencyKey: "m23.claim.MEDICARE-1",
        payload: { format: "x12", x12: "ISA*stub~" },
      });
      await transport.control.payerAccepts("MEDICARE-1", "M-ICN", scope());
      const res = await runAckPull(ackDeps("stedi"));
      expect(res.unmatched).toBeGreaterThanOrEqual(1);
      expect(await claimState(c.claimId)).toBe("submitted");
      expect(await ackRows(c.claimId)).toEqual([]);
    });

    it("quarantines an event whose control number belongs to another provider entity, and ignores another tenant's", async () => {
      const c = await sentClaim();
      const otherPe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'654321','Synthetic Hospice Two','1245319599','\\x00','12-31') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      const event = {
        eventId: "foreign-1",
        controlNumber: c.controlNumber,
        stage: "payer" as const,
        disposition: "accepted" as const,
        reasonCodes: [],
        occurredAt: new Date().toISOString(),
      };
      const foreign = await applyAckEvent(
        ackDeps("stedi"),
        { organizationId: ORG, providerEntityId: otherPe },
        event,
      );
      expect(foreign).toMatchObject({ result: "quarantined", reason: "scope_mismatch" });
      const otherTenant = await applyAckEvent(
        ackDeps("stedi"),
        { organizationId: ORG_B, providerEntityId },
        event,
      );
      expect(otherTenant).toMatchObject({ result: "unmatched", reason: "unmatched" });
      expect(await claimState(c.claimId)).toBe("submitted");
      expect(await ackRows(c.claimId)).toEqual([]);
      // both are STORED (ids and a reason), each under its own tenant, not lost to a log line
      expect(await quarantined("foreign-1", ORG)).toEqual([
        { control_number: c.controlNumber, reason: "scope_mismatch" },
      ]);
      expect(await quarantined("foreign-1", ORG_B)).toEqual([
        { control_number: c.controlNumber, reason: "unmatched" },
      ]);
    });

    it("a malformed event is stored and skipped, never thrown, and the events behind it still apply", async () => {
      const c = await sentClaim();
      // every malformed shape of the contract: stored once each, none applied, none thrown
      const bads: unknown[] = [
        null,
        "text",
        { eventId: "bad-no-control", stage: "payer", disposition: "accepted", reasonCodes: [] },
        {
          eventId: "bad-stage",
          controlNumber: c.controlNumber,
          stage: "vendor",
          disposition: "accepted",
          reasonCodes: [],
        },
        {
          eventId: "bad-partial",
          controlNumber: c.controlNumber,
          stage: "clearinghouse",
          disposition: "partial",
          reasonCodes: [],
        },
        {
          eventId: "bad-codes",
          controlNumber: c.controlNumber,
          stage: "payer",
          disposition: "rejected",
          reasonCodes: ["free text here"],
        },
        {
          eventId: "bad-time",
          controlNumber: c.controlNumber,
          stage: "payer",
          disposition: "accepted",
          reasonCodes: [],
          occurredAt: "soon",
        },
        {
          eventId: "bad\u0000nul",
          controlNumber: c.controlNumber,
          stage: "payer",
          disposition: "accepted",
          reasonCodes: [],
        },
      ];
      for (const bad of bads) {
        const out = await applyAckEvent(ackDeps("stedi"), scope(), bad);
        expect(out).toMatchObject({ result: "quarantined", reason: "malformed" });
      }
      expect(await ackRows(c.claimId)).toEqual([]);
      expect(await claimState(c.claimId)).toBe("submitted");
      const stored = await admin.query(
        "SELECT count(*)::int AS n FROM commercial_ack_quarantine WHERE reason='malformed' AND organization_id=$1",
        [ORG],
      );
      expect(stored.rows[0].n).toBeGreaterThanOrEqual(bads.length);

      // and through the stream: a poison event in the middle of a page does not stall it
      await transport.control.payerRejects(c.controlNumber, ["bad code with spaces"], scope());
      await transport.control.payerAccepts(c.controlNumber, "ICN-AFTER-POISON", scope());
      const res = await runAckPull(ackDeps("stedi"));
      expect(res.quarantined.some((q) => q.reason === "malformed")).toBe(true);
      expect(await claimState(c.claimId)).toBe("accepted");
    });

    it("a payer-stage answer for a submission with no recorded receipt is quarantined (no_receipt); a clearinghouse answer settles it", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      // the receipt was never recorded: the submission is in doubt (the transport DID get the file)
      await stageInDoubt(c, sub.submissionId);
      const payer = await applyAckEvent(ackDeps("stedi"), scope(), {
        eventId: "payer-before-receipt",
        controlNumber: c.controlNumber,
        stage: "payer",
        disposition: "accepted",
        reasonCodes: [],
        occurredAt: new Date().toISOString(),
      });
      expect(payer).toMatchObject({ result: "quarantined", reason: "no_receipt" });
      expect(await claimState(c.claimId)).toBe("ready");
      expect(await ackRows(c.claimId)).toEqual([]);
      expect(await submissionStatus(sub.submissionId)).toBe("in_doubt");
    });

    it("an acknowledgment resolves an in_doubt submission: sent by acknowledgment, claim ready -> submitted -> ack_pending", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      await stageInDoubt(c, sub.submissionId);
      await transport.control.clearinghouseAccepts(c.controlNumber, scope());
      const res = await runAckPull(ackDeps("stedi"));
      expect(res.applied).toBeGreaterThanOrEqual(1);
      expect(await submissionStatus(sub.submissionId)).toBe("sent");
      const row = (
        await admin.query("SELECT resolution, sent_at FROM commercial_submission WHERE id=$1", [
          sub.submissionId,
        ])
      ).rows[0];
      expect(row.resolution).toBe("acknowledgment");
      expect(row.sent_at).not.toBeNull();
      expect(await claimState(c.claimId)).toBe("ack_pending");
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
      expect(await eventCount(c.claimId, "m41.claim.clearinghouse_accepted")).toBe(1);
      const hist = await admin.query(
        "SELECT from_state, to_state FROM commercial_claim_state_history WHERE claim_id=$1 AND from_state IS NOT NULL ORDER BY created_at, to_state",
        [c.claimId],
      );
      expect(hist.rows.map((r) => `${r.from_state}>${r.to_state}`)).toEqual(
        expect.arrayContaining(["ready>submitted", "submitted>ack_pending"]),
      );
    });

    it("a clearinghouse event from a different vendor than the submission's is quarantined (vendor_mismatch)", async () => {
      const c = await sentClaim();
      const out = await applyAckEvent(ackDeps("another_vendor"), scope(), {
        eventId: "wrong-vendor",
        controlNumber: c.controlNumber,
        stage: "payer",
        disposition: "accepted",
        reasonCodes: [],
        occurredAt: new Date().toISOString(),
      });
      expect(out).toMatchObject({ result: "quarantined", reason: "vendor_mismatch" });
      expect(await claimState(c.claimId)).toBe("submitted");
    });

    it("the database refuses every illegal claim state jump, and allows only the legal paths", async () => {
      const move = (id: string, to: string) =>
        admin.query(
          `UPDATE commercial_claim SET state='${to}', ready_at = CASE WHEN '${to}' IN ('draft','void') THEN NULL ELSE coalesce(ready_at, now()) END WHERE id=$1`,
          [id],
        );
      // ready -> accepted, ready -> ack_pending, ready -> rejected skip the send
      const r = await readyClaim();
      for (const to of ["accepted", "ack_pending", "rejected"]) {
        await expect(move(r.claimId, to)).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
      }
      // draft -> submitted
      await move(r.claimId, "draft");
      await expect(move(r.claimId, "submitted")).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
      await expect(move(r.claimId, "accepted")).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
      await move(r.claimId, "ready"); // draft <-> ready stays legal

      // accepted is final for the state machine: never back to submitted, ack_pending or rejected
      const a = await sentClaim();
      await move(a.claimId, "ack_pending");
      await move(a.claimId, "accepted");
      for (const to of ["submitted", "ack_pending", "rejected", "ready", "draft", "void"]) {
        await expect(move(a.claimId, to)).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
      }
      // rejected -> accepted is refused; rejected -> void (so a corrected claim can be assembled) is the only way on
      const j = await sentClaim();
      await move(j.claimId, "rejected");
      for (const to of ["accepted", "ack_pending", "submitted", "ready", "draft"]) {
        await expect(move(j.claimId, to)).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
      }
      await move(j.claimId, "void");
      // a sent claim cannot be voided or sent back, only rejected-then-void
      const s = await sentClaim();
      await expect(move(s.claimId, "void")).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
      await expect(move(s.claimId, "ready")).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
    });

    it("an unbound tick fails while a sent claim waits for its answer and calls no transport", async () => {
      const c = await sentClaim();
      await expect(runAckPull(ackDeps(null))).rejects.toThrow(/CH_NOT_WIRED/);
      expect(await claimState(c.claimId)).toBe("submitted");
    });
  });

  describe("tenant isolation (as chartwarden_app)", () => {
    it("another organization sees no submissions and cannot write one for this tenant", async () => {
      const c = await readyClaim();
      await service("stedi").submit(actor, c.claimId, "key-rls");
      const seenByB = await withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: USER },
        async (tx) => {
          const r = await tx.execute(sql`SELECT count(*)::int AS n FROM commercial_submission`);
          return (r.rows[0] as { n: number }).n;
        },
      );
      expect(seenByB).toBe(0);
      const crossWrite = await failure(
        withOrgContext(handle.db, { organizationId: ORG_B, userId: USER }, async (tx) => {
          await tx.execute(
            sql.raw(`INSERT INTO commercial_submission (organization_id, provider_entity_id, claim_id, idempotency_key, control_number, clearinghouse_key, clearinghouse_payer_id, requested_by_membership_id)
             VALUES ('${ORG}','${providerEntityId}','${c.claimId}','x','C1','stedi','P1','${membershipId}')`),
          );
        }),
      );
      expect(crossWrite).not.toBeNull();
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE claim_id=$1",
        [c.claimId],
      );
    });

    it("the app role cannot delete a submission", async () => {
      const c = await readyClaim();
      await service("stedi").submit(actor, c.claimId, "key-del");
      const err = await failure(
        withOrgContext(handle.db, { organizationId: ORG, userId: USER }, async (tx) => {
          await tx.execute(
            sql.raw(`DELETE FROM commercial_submission WHERE claim_id='${c.claimId}'`),
          );
        }),
      );
      expect(err).not.toBeNull();
    });
  });
});
