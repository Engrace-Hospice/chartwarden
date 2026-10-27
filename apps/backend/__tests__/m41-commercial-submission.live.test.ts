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
import net from "node:net";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM41OverrideAuditPort } from "../src/m41-override-audit";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { createDrizzleCommercialBillingEraseStore } from "../src/modules/41-billing-commercial/erasers/commercial-billing-eraser";
import {
  type CommercialActor,
  type CommercialClaimSeams,
  M41_CRON_QUEUES,
  M41_OUTBOX_EVENTS,
  abandonForeignHeldEvents,
  applyAckEvent,
  buildCommercial837iRenderer,
  buildCommercialAuthorizationService,
  buildCommercialClaimAssemblyService,
  buildCommercialClaimLifecycleService,
  buildCommercialContextPort,
  buildCommercialSubmissionService,
  createDrainReadiness,
  createDrizzleAckCursorStore,
  createScheduleProbe,
  createSharedDrainReadiness,
  heldQuarantineReport,
  listHeldRows,
  outstandingAckWork,
  replayHeldEvents,
  resolveHeldRowByOperator,
  runAckPull,
  runSubmissionDrain,
  scheduleM41AckJobs,
  scheduleM41Jobs,
} from "../src/modules/41-billing-commercial/index";
import type {
  AckWorkerDeps,
  SubmissionWorkerDeps,
} from "../src/modules/41-billing-commercial/index";
import {
  QUARANTINE_RETENTION_DAYS,
  runQuarantinePrune,
} from "../src/modules/41-billing-commercial/jobs/quarantine-prune";
import { bindPayloadAndMarkCallStarted } from "../src/modules/41-billing-commercial/jobs/submission-worker";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
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
  /** The subscriber's last name the fake identity port answers; a test changes it to simulate a demographics edit. */
  let subscriberLastName = "Doe";

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
    opts: {
      enrolled?: boolean;
      routed?: boolean;
      authorization?: boolean;
      /** The clearinghouse the enrollment row names (default `stedi`). */
      enrollmentKey?: string;
      /** The enrollment status (default `enrolled`). */
      enrollmentStatus?: string;
    } = {},
  ): Promise<{
    claimId: string;
    controlNumber: string;
    planId: string;
    payerId: string;
    patientId: string;
    authorizationId: string | null;
  }> {
    const payerId = (
      await admin.query(
        "INSERT INTO payer (kind, name) VALUES ('commercial'::payer_kind, $1) RETURNING id",
        [`Synthetic Commercial Health ${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
    const planId = (
      await admin.query(
        `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement, effective_from)
         VALUES ($1,$2,'Synthetic PPO','CI',$3,'2026-01-01') RETURNING id`,
        [ORG, payerId, opts.authorization ? "required_at_admission" : "not_required"],
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
         VALUES ($1,$2,$3,$4,$5,'2026-01-01')`,
        [
          ORG,
          providerEntityId,
          payerId,
          opts.enrollmentKey ?? "stedi",
          opts.enrollmentStatus ?? "enrolled",
        ],
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
    let authorizationId: string | null = null;
    if (opts.authorization) {
      authorizationId = (
        await admin.query(
          `INSERT INTO commercial_authorization (organization_id, provider_entity_id, patient_id, plan_id, authorization_number, status, obtained_on, effective_from, created_by_membership_id)
           VALUES ($1,$2,$3,$4,'AUTH-1','approved','2026-02-01','2026-02-01',$5) RETURNING id`,
          [ORG, providerEntityId, patientId, planId, membershipId],
        )
      ).rows[0].id as string;
    }
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
    return { claimId: out.claimId, controlNumber, planId, payerId, patientId, authorizationId };
  }

  const service = (vendor: string | null) =>
    buildCommercialSubmissionService(handle.db, seams(randomUUID()), { vendor });

  const renderer = () =>
    buildCommercial837iRenderer(handle.db, {
      coverage: coverageReader,
      caseload: { isInCaseload: async () => true },
      identity: {
        identityFor: async () => ({
          lastName: subscriberLastName,
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

  const ackDepsFor = (vendor: string | null): AckWorkerDeps => {
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

    it("no silent fallback: routed on the bound clearinghouse but enrolled only on another one is refused, nothing written", async () => {
      const c = await readyClaim();
      // a second clearinghouse routes the plan after assembly (assembly itself refuses an ambiguous plan)
      await admin.query(
        `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
         VALUES ($1,$2,'other_vendor','SYNTH02','2026-01-01')`,
        [ORG, c.planId],
      );
      const err = await failure(service("other_vendor").submit(actor, c.claimId, "key-nofallback"));
      expect(err?.code).toBe("COMMERCIAL_SEND_REFUSED");
      expect(err?.statusCode).toBe(409);
      expect(err?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_PROVIDER_NOT_ENROLLED"]);
      expect(await submissionCount(c.claimId)).toBe(0);
      expect(await eventCount(c.claimId, "m41.claim.submit_requested")).toBe(0);
      // the refusal is stable: the same key answers the same refusal, still nothing queued
      const again = await failure(
        service("other_vendor").submit(actor, c.claimId, "key-nofallback"),
      );
      expect(again?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_PROVIDER_NOT_ENROLLED"]);
      expect(await submissionCount(c.claimId)).toBe(0);
    });

    it("an enrollment that is pending, suspended or not_enrolled is not an enrollment", async () => {
      for (const enrollmentStatus of ["pending", "suspended", "not_enrolled"]) {
        const c = await readyClaim({ enrollmentStatus });
        const err = await failure(
          service("stedi").submit(actor, c.claimId, `key-${enrollmentStatus}`),
        );
        expect(err?.details?.map((d) => d.code)).toEqual(["COMMERCIAL_PROVIDER_NOT_ENROLLED"]);
        expect(await submissionCount(c.claimId)).toBe(0);
      }
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
      const done = await service("stedi").reconcile(
        actor,
        c.claimId,
        sub.submissionId,
        "received",
        "clearinghouse_portal",
      );
      expect(done.status).toBe("sent");
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "sent",
        resolution: "operator_confirmed",
        reconcile_evidence: "clearinghouse_portal",
        last_failure_code: null, // the fault that put it in doubt is cleared once a person settled it
        transport_call_started_at: null,
      });
      expect(await claimState(c.claimId)).toBe("submitted");
      const hist = await admin.query(
        "SELECT actor_kind FROM commercial_claim_state_history WHERE claim_id=$1 AND to_state='submitted'",
        [c.claimId],
      );
      expect(hist.rows).toEqual([{ actor_kind: "user" }]);
      // what the person relied on is in the audit trail (the event), as a code
      const ev = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m41.claim.submit_reconciled' AND payload->>'claimId'=$1",
        [c.claimId],
      );
      expect(ev.rows[0].payload).toMatchObject({
        outcome: "received",
        evidence: "clearinghouse_portal",
      });
    });

    it("reconcile needs a fresh step-up and a human, and only settles a submission that is in doubt", async () => {
      const { c, sub } = await queued();
      const svc = service("stedi");
      const stale = await failure(
        svc.reconcile(
          { ...actor, stepUpRecent: false },
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        ),
      );
      expect(stale?.code).toBe("STEP_UP_REQUIRED");
      const ai = await failure(
        svc.reconcile(
          { ...actor, actorKind: "ai_agent" },
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        ),
      );
      expect(ai?.statusCode).toBe(403);
      // a queued submission is not in doubt
      const wrongState = await failure(
        svc.reconcile(actor, c.claimId, sub.submissionId, "received", "payer_portal"),
      );
      expect(wrongState?.statusCode).toBe(409);
      const unknown = await failure(
        svc.reconcile(actor, c.claimId, randomUUID(), "received", "vendor_support"),
      );
      expect(unknown?.statusCode).toBe(404);
      expect(await submissionStatus(sub.submissionId)).toBe("queued");
      expect(await eventCount(c.claimId, "m41.claim.submit_reconciled")).toBe(0);
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE id=$1",
        [sub.submissionId],
      );
    });

    it("H1: facts that changed after the first attempt give a DISTINCT code, never an opaque conflict, and the claim can be voided", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId); // the file reached the clearinghouse and the answer was lost
      const svc = service("stedi");
      await svc.reconcile(actor, c.claimId, sub.submissionId, "not_received"); // the person believes it did not arrive
      subscriberLastName = "Smith-Doe"; // ... and the patient's name was edited meanwhile
      try {
        const again = await svc.submit(actor, c.claimId, `key-${randomUUID()}`);
        const recorder = recordingTransport();
        await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
        expect(recorder.results).toEqual([]); // refused BEFORE the transport: nothing was sent
        expect(await submissionRow(again.submissionId)).toMatchObject({
          status: "failed",
          last_failure_code: "COMMERCIAL_PAYLOAD_CHANGED",
        });
        // the timeline says what to do in fixed words
        const tl = await svc.timeline(actor, c.claimId);
        const failed = tl.items.find(
          (i) => i.kind === "submission" && i.submissionId === again.submissionId,
        );
        expect(failed).toMatchObject({
          failureCode: "COMMERCIAL_PAYLOAD_CHANGED",
          failureMessage: expect.stringMatching(/Void the claim and assemble it again/),
        });
        // failed releases the slot, so the claim can be voided and assembled again
        const lifecycle = buildCommercialClaimLifecycleService(handle.db, seams(randomUUID()));
        await expect(lifecycle.voidClaim(actor, c.claimId)).resolves.toMatchObject({
          state: "void",
        });
      } finally {
        subscriberLastName = "Doe";
      }
    });

    it("M1: after a DEFINITE refusal (nothing accepted) the user fixes the data and resubmits: it is sent, not frozen out", async () => {
      const { c, sub } = await queued();
      await runSubmissionDrain(
        workerDeps("stedi", {
          transport: {
            submitClaim: async () => ({
              ok: false as const,
              degraded: { code: "CH_INVALID_REQUEST", reason: "payload refused" },
            }),
          },
        }),
      );
      const refused = await submissionRow(sub.submissionId);
      expect(refused).toMatchObject({ status: "failed", ambiguous: false });
      expect(refused.payload_hash).toBeTruthy(); // the hash was written before the call ...
      subscriberLastName = "Corrected";
      try {
        const again = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
        const recorder = recordingTransport();
        await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
        // ... but it binds nothing: the transport never held that payload, so the corrected one goes out
        expect(recorder.results).toEqual([{ ok: true, replayed: false }]);
        expect(await submissionRow(again.submissionId)).toMatchObject({ status: "sent" });
        expect(await claimState(c.claimId)).toBe("submitted");
      } finally {
        subscriberLastName = "Doe";
      }
    });

    it("M3: a legacy row with no hash binds nothing (the comparison is skipped), and the transport's own conflict is in_doubt", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      const svc = service("stedi");
      await svc.reconcile(actor, c.claimId, sub.submissionId, "not_received");
      await admin.query("UPDATE commercial_submission SET payload_hash = NULL WHERE claim_id=$1", [
        c.claimId,
      ]);
      subscriberLastName = "Legacy-Changed";
      try {
        const again = await svc.submit(actor, c.claimId, `key-${randomUUID()}`);
        const recorder = recordingTransport();
        await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
        expect(recorder.results).toHaveLength(1); // not frozen out by us: it reached the transport ...
        expect(recorder.results[0]).toMatchObject({ ok: false }); // ... which holds the earlier payload under the key
        expect(await submissionRow(again.submissionId)).toMatchObject({
          status: "in_doubt",
          last_failure_code: "CH_IDEMPOTENCY_CONFLICT",
        });
      } finally {
        subscriberLastName = "Doe";
      }
    });

    it("M3: the payload bind waits for the claim's row lock, because the first hash is read and the new one written under it", async () => {
      const { c, sub } = await queued();
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM commercial_claim WHERE id=$1 FOR UPDATE", [c.claimId]);
        const row = await submissionRow(sub.submissionId);
        const hash = "a".repeat(64);
        let finished = false;
        const bound = bindPayloadAndMarkCallStarted(
          workerDeps("stedi"),
          { id: row.id, claimId: row.claim_id, organizationId: row.organization_id } as never,
          hash,
        ).then((r) => {
          finished = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(finished).toBe(false); // blocked on the lock the other connection holds
        expect((await submissionRow(sub.submissionId)).payload_hash).toBeNull();
        await holder.query("COMMIT");
        expect(await bound).toBe("bound");
        expect((await submissionRow(sub.submissionId)).payload_hash).toBe(hash);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
        await admin.query(
          "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE id=$1",
          [sub.submissionId],
        );
      }
    });

    it("an ambiguous CH_UNAVAILABLE (timeout, 5xx, sent-but-unrecorded) makes the row ambiguous: exhaustion ends in_doubt, the hash still binds, and changed data gives PAYLOAD_CHANGED", async () => {
      const { c, sub } = await queued();
      const timeoutLike = {
        submitClaim: async () => ({
          ok: false as const,
          degraded: {
            code: "CH_UNAVAILABLE",
            reason: "Stedi could not be reached",
            ambiguous: true as const,
          },
        }),
      };
      for (let i = 0; i < 5; i += 1) {
        await dueNow(sub.submissionId);
        await runSubmissionDrain(workerDeps("stedi", { transport: timeoutLike }));
      }
      let row = await submissionRow(sub.submissionId);
      expect(row).toMatchObject({ status: "queued", attempt_count: 5, ambiguous: true });
      expect(row.payload_hash).toBeTruthy();
      await dueNow(sub.submissionId);
      await runSubmissionDrain(workerDeps("stedi", { transport: timeoutLike }));
      row = await submissionRow(sub.submissionId);
      expect(row).toMatchObject({
        status: "in_doubt", // NOT failed: the payload may be at the vendor
        last_failure_code: "COMMERCIAL_SEND_INTERRUPTED",
      });
      // a person says it was not received, the data is corrected, and it is sent again: the first payload still binds
      const svc = service("stedi");
      await svc.reconcile(actor, c.claimId, sub.submissionId, "not_received");
      subscriberLastName = "Corrected-After-Timeout";
      try {
        const again = await svc.submit(actor, c.claimId, `key-${randomUUID()}`);
        const recorder = recordingTransport();
        await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
        expect(recorder.results).toEqual([]); // refused before the transport: it might hold payload X
        expect(await submissionRow(again.submissionId)).toMatchObject({
          status: "failed",
          last_failure_code: "COMMERCIAL_PAYLOAD_CHANGED",
        });
      } finally {
        subscriberLastName = "Doe";
      }
    });

    it("a CLEAN CH_UNAVAILABLE (refused before the request left) until exhaustion ends failed and binds nothing", async () => {
      const { c, sub } = await queued();
      const refusedBeforeSend = {
        submitClaim: async () => ({
          ok: false as const,
          degraded: {
            code: "CH_UNAVAILABLE",
            reason: "the submission record could not be reserved",
          },
        }),
      };
      for (let i = 0; i < 6; i += 1) {
        await dueNow(sub.submissionId);
        await runSubmissionDrain(workerDeps("stedi", { transport: refusedBeforeSend }));
      }
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "failed",
        ambiguous: false,
        last_failure_code: "COMMERCIAL_SUBMISSION_EXHAUSTED",
      });
      subscriberLastName = "Fixed-Before-Resend";
      try {
        const again = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
        const recorder = recordingTransport();
        await runSubmissionDrain(workerDeps("stedi", { transport: recorder }));
        expect(recorder.results).toEqual([{ ok: true, replayed: false }]);
        expect(await submissionStatus(again.submissionId)).toBe("sent");
      } finally {
        subscriberLastName = "Doe";
      }
    });

    it("M3: a changed payload on a resubmission ends COMMERCIAL_PAYLOAD_CHANGED even with two drains running, and only the first hash is ever bound", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      const first = (await submissionRow(sub.submissionId)).payload_hash as string;
      await service("stedi").reconcile(actor, c.claimId, sub.submissionId, "not_received");
      subscriberLastName = "Raced";
      try {
        const again = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
        await Promise.all([
          runSubmissionDrain(workerDeps("stedi")),
          runSubmissionDrain(workerDeps("stedi")),
        ]);
        expect(await submissionRow(again.submissionId)).toMatchObject({
          status: "failed",
          last_failure_code: "COMMERCIAL_PAYLOAD_CHANGED",
        });
        const hashes = await admin.query(
          "SELECT DISTINCT payload_hash FROM commercial_submission WHERE claim_id=$1 AND payload_hash IS NOT NULL",
          [c.claimId],
        );
        expect(hashes.rows).toEqual([{ payload_hash: first }]); // only the first payload is ever bound
      } finally {
        subscriberLastName = "Doe";
      }
    });

    it("H1: an idempotency conflict from the transport after an earlier attempt is in_doubt, never failed", async () => {
      const { c, sub } = await queued();
      await dueNow(sub.submissionId);
      await runSubmissionDrain(
        workerDeps("stedi", {
          transport: {
            submitClaim: async () => ({
              ok: false as const,
              degraded: { code: "CH_IDEMPOTENCY_CONFLICT", reason: "key reused" },
            }),
          },
        }),
      );
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        status: "in_doubt",
        last_failure_code: "CH_IDEMPOTENCY_CONFLICT",
      });
      expect(await claimState(c.claimId)).toBe("ready");
    });

    it("M1: not_received on a row that holds a receipt is a typed 409, and received settles it", async () => {
      const { c, sub } = await queued();
      await runSubmissionDrain(
        workerDeps("stedi", { failPublish: (name) => name === "m41.claim.submitted" }),
      );
      const row = await submissionRow(sub.submissionId);
      expect(row).toMatchObject({
        status: "in_doubt",
        last_failure_code: "COMMERCIAL_RECORD_FAULT",
      });
      expect(row.clearinghouse_submission_id).toBeTruthy();
      const svc = service("stedi");
      const refused = await failure(
        svc.reconcile(actor, c.claimId, sub.submissionId, "not_received"),
      );
      expect(refused?.statusCode).toBe(409);
      expect(refused?.code).toBe("COMMERCIAL_RECONCILE_RECEIPT_ON_FILE");
      expect(await submissionStatus(sub.submissionId)).toBe("in_doubt"); // untouched: no 500, no half write
      const done = await svc.reconcile(
        actor,
        c.claimId,
        sub.submissionId,
        "received",
        "vendor_support",
      );
      expect(done.status).toBe("sent");
      expect(await submissionRow(sub.submissionId)).toMatchObject({
        reconcile_evidence: "vendor_support",
      });
    });

    it("M6: received needs a closed-set evidence, not_received takes none", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      const svc = service("stedi");
      const missing = await failure(svc.reconcile(actor, c.claimId, sub.submissionId, "received"));
      expect(missing?.statusCode).toBe(422);
      const extra = await failure(
        svc.reconcile(actor, c.claimId, sub.submissionId, "not_received", "payer_portal"),
      );
      expect(extra?.statusCode).toBe(422);
      expect(await submissionStatus(sub.submissionId)).toBe("in_doubt");
      expect(await eventCount(c.claimId, "m41.claim.submit_reconciled")).toBe(0);
    });

    it("reconcile with ANOTHER claim's submission id is a 404 and touches nothing (no IDOR)", async () => {
      const a = await queued();
      const b = await queued();
      await stageInDoubt(a.c, a.sub.submissionId);
      await stageInDoubt(b.c, b.sub.submissionId);
      const svc = service("stedi");
      const crossed = await failure(
        svc.reconcile(actor, a.c.claimId, b.sub.submissionId, "received", "payer_portal"),
      );
      expect(crossed?.statusCode).toBe(404);
      expect(await submissionStatus(b.sub.submissionId)).toBe("in_doubt");
      expect(await submissionStatus(a.sub.submissionId)).toBe("in_doubt");
      expect(await claimState(b.c.claimId)).toBe("ready");
    });

    it("M5: received is refused unless the claim is still ready", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      // a claim can only leave ready by an operator tool or a defect; force it to prove the guard
      await admin.query("UPDATE commercial_claim SET state='draft', ready_at=NULL WHERE id=$1", [
        c.claimId,
      ]);
      const refused = await failure(
        service("stedi").reconcile(actor, c.claimId, sub.submissionId, "received", "payer_portal"),
      );
      expect(refused?.statusCode).toBe(409);
      expect(refused?.code).toBe("COMMERCIAL_CLAIM_NOT_READY");
      expect(await submissionStatus(sub.submissionId)).toBe("in_doubt");
      expect(await claimState(c.claimId)).toBe("draft");
      await admin.query("UPDATE commercial_claim SET state='ready', ready_at=now() WHERE id=$1", [
        c.claimId,
      ]);
    });

    it("M5: a claim with a live submission is never demoted, re-validated, re-readied or voided (typed 409)", async () => {
      const { c } = await queued();
      const lifecycle = buildCommercialClaimLifecycleService(handle.db, seams(randomUUID()));
      for (const attempt of [
        () => lifecycle.validate(actor, c.claimId),
        () => lifecycle.markReady(actor, c.claimId),
        () => lifecycle.voidClaim(actor, c.claimId),
      ]) {
        const err = await failure(attempt());
        expect(err?.statusCode).toBe(409);
        expect(err?.code).toBe("COMMERCIAL_SUBMISSION_IN_FLIGHT");
      }
      expect(await claimState(c.claimId)).toBe("ready");
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE claim_id=$1",
        [c.claimId],
      );
    });

    it("M5: voiding an authorization that a claim in flight depends on is refused instead of orphaning the filed claim as a draft", async () => {
      const c = await readyClaim({ authorization: true });
      expect(c.authorizationId).not.toBeNull();
      await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      const authorizations = buildCommercialAuthorizationService(handle.db, seams(randomUUID()));
      const err = await failure(
        authorizations.setStatus(actor, c.authorizationId as string, "voided"),
      );
      expect(err?.statusCode).toBe(409);
      expect(err?.code).toBe("COMMERCIAL_SUBMISSION_IN_FLIGHT");
      // rolled back whole: the authorization is still approved and the claim still ready
      expect(
        await scalar<string>("SELECT status AS n FROM commercial_authorization WHERE id=$1", [
          c.authorizationId,
        ]),
      ).toBe("approved");
      expect(await claimState(c.claimId)).toBe("ready");
      // without a live submission the same change still demotes, as before
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE claim_id=$1",
        [c.claimId],
      );
      await authorizations.setStatus(actor, c.authorizationId as string, "voided");
      expect(await claimState(c.claimId)).toBe("draft");
    });

    it("M4: while the drain is not scheduled, submit and reconcile answer a typed 503 and queue nothing", async () => {
      const c = await readyClaim();
      const down = { drainScheduled: () => false };
      const svc = buildCommercialSubmissionService(
        handle.db,
        seams(randomUUID()),
        { vendor: "stedi" },
        down,
      );
      const submit = await failure(svc.submit(actor, c.claimId, "key-down"));
      expect(submit?.statusCode).toBe(503);
      expect(submit?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      const reconcile = await failure(
        svc.reconcile(actor, c.claimId, randomUUID(), "received", "payer_portal"),
      );
      expect(reconcile?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      expect(await submissionCount(c.claimId)).toBe(0);
      // the read view says why instead of offering the button
      const view = await svc.sendGate(actor, c.claimId);
      expect(view.canSubmit).toBe(false);
      expect(view.reasons.map((r) => r.code)).toContain("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      // and it works as soon as the schedule is back
      const up = buildCommercialSubmissionService(handle.db, seams(randomUUID()), {
        vendor: "stedi",
      });
      expect((await up.submit(actor, c.claimId, "key-up")).status).toBe("queued");
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE claim_id=$1",
        [c.claimId],
      );
    });

    it("L4: the receipt id is kept even when an acknowledgment settled the row while the transport call was still open", async () => {
      const { c, sub } = await queued();
      const ackedDuringSend = {
        submitClaim: async (...args: Parameters<InMemoryClearinghouse["submitClaim"]>) => {
          const receipt = await transport.submitClaim(...args);
          if (args[1].controlNumber !== c.controlNumber) return receipt; // another test's leftover row
          // the acknowledgment worker sees the in-flight (queued) row and settles it before the worker records the receipt
          const out = await applyAckEvent(
            ackDepsFor("stedi"),
            { organizationId: ORG, providerEntityId },
            {
              eventId: "during-send",
              controlNumber: c.controlNumber,
              stage: "clearinghouse",
              disposition: "accepted",
              reasonCodes: [],
              occurredAt: new Date().toISOString(),
            },
          );
          expect(out.result).toBe("applied");
          return receipt;
        },
      };
      await runSubmissionDrain(workerDeps("stedi", { transport: ackedDuringSend }));
      const row = await submissionRow(sub.submissionId);
      expect(row.status).toBe("sent");
      expect(row.resolution).toBe("acknowledgment"); // the first settler's provenance stands
      expect(row.clearinghouse_submission_id).toBeTruthy(); // ... and the receipt was still recorded
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
      expect(await claimState(c.claimId)).toBe("ack_pending");
    });

    it("a reconcile racing the acknowledgment worker settles the row exactly once with one submitted event", async () => {
      const { c, sub } = await queued();
      await stageInDoubt(c, sub.submissionId);
      await transport.control.clearinghouseAccepts(c.controlNumber, {
        organizationId: ORG,
        providerEntityId,
        usage: "test",
      });
      const [rec, ack] = await Promise.allSettled([
        service("stedi").reconcile(actor, c.claimId, sub.submissionId, "received", "payer_portal"),
        runAckPull(ackDepsFor("stedi")),
      ]);
      expect(ack.status).toBe("fulfilled");
      // whichever won, the other saw a settled row: reconcile either settled it or was told it is no longer in doubt
      if (rec.status === "rejected") {
        expect((rec.reason as { statusCode?: number }).statusCode).toBe(409);
      }
      const row = await submissionRow(sub.submissionId);
      expect(row.status).toBe("sent");
      expect(["acknowledgment", "operator_confirmed"]).toContain(row.resolution);
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
      expect(["submitted", "ack_pending"]).toContain(await claimState(c.claimId));
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
      expect(otherTenant).toEqual({ result: "unmatched", eventId: "foreign-1" });
      expect(await claimState(c.claimId)).toBe("submitted");
      expect(await ackRows(c.claimId)).toEqual([]);
      // the other provider entity's control number is STORED (ids and a reason, not lost to a log line); another tenant's event is
      // simply not ours (counted, never stored)
      expect(await quarantined("foreign-1", ORG)).toEqual([
        { control_number: c.controlNumber, reason: "scope_mismatch" },
      ]);
      expect(await quarantined("foreign-1", ORG_B)).toEqual([]);
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

    it("M2: a 277CA that arrives BEFORE the 999 on an in_doubt row is held, then applied once the 999 settles the row", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      await stageInDoubt(c, sub.submissionId);
      await transport.control.payerAccepts(c.controlNumber, "ICN-HELD", scope()); // the payer answer comes first
      await transport.control.clearinghouseAccepts(c.controlNumber, scope());
      await runAckPull(ackDeps("stedi"));
      expect(await claimState(c.claimId)).toBe("accepted"); // not stuck in ack_pending, not lost
      expect((await ackRows(c.claimId)).map((r) => r.stage).sort()).toEqual([
        "clearinghouse",
        "payer",
      ]);
      expect(await eventCount(c.claimId, "m41.claim.submitted")).toBe(1);
      expect(await eventCount(c.claimId, "m41.claim.accepted")).toBe(1);
      const held = await admin.query(
        "SELECT resolved_at FROM commercial_ack_quarantine WHERE control_number=$1 AND reason='no_receipt'",
        [c.controlNumber],
      );
      expect(held.rows).toHaveLength(1);
      expect(held.rows[0].resolved_at).not.toBeNull();
    });

    it("M2: a held 277CA is applied by the next pull after a person reconciles the row as received", async () => {
      const c = await readyClaim();
      const sub = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
      await stageInDoubt(c, sub.submissionId);
      await transport.control.payerRejects(c.controlNumber, ["A7:158"], scope());
      await runAckPull(ackDeps("stedi")); // quarantined no_receipt; the cursor moves on
      expect(await claimState(c.claimId)).toBe("ready");
      const held = () =>
        admin
          .query(
            "SELECT resolved_at, event FROM commercial_ack_quarantine WHERE control_number=$1 AND reason='no_receipt'",
            [c.controlNumber],
          )
          .then((r) => r.rows);
      expect((await held())[0].resolved_at).toBeNull();
      expect((await held())[0].event).toMatchObject({ stage: "payer", disposition: "rejected" });
      await service("stedi").reconcile(
        actor,
        c.claimId,
        sub.submissionId,
        "received",
        "payer_portal",
      );
      await runAckPull(ackDeps("stedi")); // the stream has nothing new; the held event is replayed
      expect(await claimState(c.claimId)).toBe("rejected");
      expect((await held())[0].resolved_at).not.toBeNull();
      expect((await ackRows(c.claimId))[0]).toMatchObject({
        stage: "payer",
        disposition: "rejected",
        reason_codes: ["A7:158"],
      });
    });

    it("M3: events that are not commercial submissions are counted and skipped, never stored (no growth)", async () => {
      await sentClaim();
      const before = await scalar<number>(
        "SELECT count(*)::int AS n FROM commercial_ack_quarantine WHERE organization_id=$1",
        [ORG],
      );
      const auditBefore = await scalar<number>(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='commercial_ack_quarantine'",
      );
      const ctx = {
        organizationId: ORG,
        providerEntityId,
        payerId: "MEDICARE",
        correlationId: randomUUID(),
        usage: "test" as const,
        billingNpi: NPI,
      };
      for (let i = 0; i < 5; i += 1) {
        await transport.submitClaim(ctx, {
          kind: "claim",
          controlNumber: `MEDICARE-N${i}`,
          idempotencyKey: `m23.claim.MEDICARE-N${i}`,
          payload: { format: "x12", x12: "ISA*stub~" },
        });
        await transport.control.payerAccepts(`MEDICARE-N${i}`, `M-ICN-${i}`, scope());
      }
      const res = await runAckPull(ackDeps("stedi"));
      expect(res.unmatched).toBeGreaterThanOrEqual(5);
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM commercial_ack_quarantine WHERE organization_id=$1",
          [ORG],
        ),
      ).toBe(before);
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='commercial_ack_quarantine'",
        ),
      ).toBe(auditBefore);
    });

    it("M3: a claim that reached a terminal state, or is older than the poll window, stops being polled", async () => {
      await admin.query(
        "UPDATE commercial_submission SET requested_at = now() - interval '60 days'",
      );
      expect(await outstandingAckWork(ackDeps("stedi"), ORG)).toEqual([]); // aged out: needs a status inquiry, not a poll
      const c = await sentClaim();
      expect(await outstandingAckWork(ackDeps("stedi"), ORG)).toHaveLength(1);
      await transport.control.payerAccepts(c.controlNumber, "ICN-TERMINAL", scope());
      await runAckPull(ackDeps("stedi"));
      expect(await claimState(c.claimId)).toBe("accepted");
      expect(await outstandingAckWork(ackDeps("stedi"), ORG)).toEqual([]);
      // and a tick with nothing outstanding never calls the transport
      let fetches = 0;
      const deps = ackDeps("stedi");
      await runAckPull({
        ...deps,
        binding: {
          vendor: "stedi",
          transport: {
            fetchAcknowledgments: async (...args) => {
              fetches += 1;
              return transport.fetchAcknowledgments(...args);
            },
            fetchClaimStatus: (...args) => transport.fetchClaimStatus(...args),
          },
        },
      });
      expect(fetches).toBe(0);
    });

    describe("held payer-stage events leave the queue (no starvation, no dead rows)", () => {
      const heldOf = (c: { controlNumber: string }) =>
        admin
          .query(
            "SELECT id, resolved_at, resolution FROM commercial_ack_quarantine WHERE control_number=$1 AND reason='no_receipt'",
            [c.controlNumber],
          )
          .then((r) => r.rows[0]);
      /** Deps whose transport cannot answer a claim-status inquiry (what the Stedi and direct-MAC transports do today). */
      const noInquiry = (vendor: string): AckWorkerDeps => ({
        ...ackDeps(vendor),
        binding: {
          vendor,
          transport: {
            fetchAcknowledgments: (ctx, cursor) => transport.fetchAcknowledgments(ctx, cursor),
            fetchClaimStatus: async () => ({
              ok: false,
              degraded: { code: "CH_NOT_WIRED", reason: "claim status is not wired" },
            }),
          },
        },
      });
      const rowOf = (controlNumber: string, reason: string) =>
        admin
          .query(
            "SELECT id, resolved_at, resolution, event FROM commercial_ack_quarantine WHERE control_number=$1 AND reason=$2",
            [controlNumber, reason],
          )
          .then((r) => r.rows[0]);
      const abandonedEvents = (controlNumber: string) =>
        admin
          .query(
            "SELECT payload FROM outbox_event WHERE event_type='m41.claim.ack_abandoned' AND payload->>'controlNumber'=$1",
            [controlNumber],
          )
          .then((r) => r.rows.map((x) => x.payload as Record<string, unknown>));
      /** A claim in doubt with a payer-stage answer held for it. */
      async function heldClaim() {
        const c = await readyClaim();
        const sub = await service("stedi").submit(actor, c.claimId, `key-${randomUUID()}`);
        await stageInDoubt(c, sub.submissionId);
        await transport.control.payerAccepts(c.controlNumber, "ICN-DEAD", scope());
        await runAckPull(ackDeps("stedi"));
        expect((await heldOf(c)).resolved_at).toBeNull();
        return { c, sub };
      }

      it("abandons a held event whose submission later failed (swept even with no live work), instead of holding it forever", async () => {
        const { c, sub } = await heldClaim();
        await service("stedi").reconcile(actor, c.claimId, sub.submissionId, "not_received");
        const logs: Record<string, unknown>[] = [];
        await runAckPull({ ...ackDeps("stedi"), log: (e) => logs.push(e) });
        expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_no_submission" });
        expect((await heldOf(c)).resolved_at).not.toBeNull();
        expect(await claimState(c.claimId)).toBe("ready");
        expect(await ackRows(c.claimId)).toEqual([]);
        // a dropped payer answer may be the only proof the file arrived, so it is never silent: a warn-level log with ids only
        const dropped = logs.filter(
          (l) => l.event === "ack.held_abandoned" && l.controlNumber === c.controlNumber,
        );
        expect(dropped).toEqual([
          {
            event: "ack.held_abandoned",
            eventId: expect.any(String),
            code: "abandoned_no_submission",
            controlNumber: c.controlNumber,
            claimId: c.claimId,
          },
        ]);
      });

      it("ages a held event from its SUBMISSION when that is older than the row", async () => {
        const { c, sub } = await heldClaim();
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '60 days' WHERE id=$1",
          [sub.submissionId],
        );
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        await replayHeldEvents(noInquiry("stedi"), scope());
        expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_aged" });
        expect(await claimState(c.claimId)).toBe("submitted"); // stale: not applied
      });

      it("replays the held events once per pull, and again only after a page that applied a clearinghouse-stage event", async () => {
        const count = (logs: { event: string }[]) =>
          logs.filter((l) => l.event === "ack.replay").length;
        const pull = async () => {
          const logs: { event: string }[] = [];
          await runAckPull({ ...ackDeps("stedi"), log: (e) => logs.push(e) });
          return count(logs);
        };
        await pull(); // consume whatever earlier tests left in the stream
        // held mismatch rows of OTHER provider entities (no live work) are swept once per pull: a constant the counts below include
        const swept = await pull(); // no live work here, so this counts only the sweep
        // three payer-stage answers (two pages of two): nothing can unblock a held row, so the held events are looked at once
        const a = await sentClaim();
        const b = await sentClaim();
        const d = await sentClaim();
        for (const c of [a, b, d])
          await transport.control.payerAccepts(c.controlNumber, "ICN-F", scope());
        expect(await pull()).toBe(1 + swept);
        // clearinghouse-stage answers (a page that settles rows): once at the start, once after that page
        const e = await sentClaim();
        const f = await sentClaim();
        await transport.control.clearinghouseAccepts(e.controlNumber, scope());
        await transport.control.clearinghouseAccepts(f.controlNumber, scope());
        expect(await pull()).toBe(2 + swept);
        // an idle pull with nothing new still looks once
        expect(await pull()).toBe(1 + swept);
      });

      it("never replays a held row under another clearinghouse's binding (cross-vendor and unbound), whichever way the binding changed", async () => {
        const { c, sub } = await heldClaim(); // held from the stedi stream
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        // the binding moved to another vendor: the stedi row is not its stream, so it is not looked at, let alone applied
        // (the other vendor's OWN leftover rows from earlier tests may be handled; ours is not)
        expect((await replayHeldEvents(ackDeps("another_vendor"), scope())).applied).toBe(0);
        // unbound: nothing replays at all
        expect(await replayHeldEvents(ackDeps(null), scope())).toEqual({
          applied: 0,
          abandoned: 0,
        });
        expect(await heldOf(c)).toMatchObject({ resolved_at: null });
        expect(await claimState(c.claimId)).toBe("submitted");
        expect(await ackRows(c.claimId)).toEqual([]);
        // back on its own stream the row applies as usual
        await replayHeldEvents(ackDeps("stedi"), scope());
        expect(await heldOf(c)).toMatchObject({ resolution: "applied" });
      });

      it("a row of a former vendor, or one held while unbound, still ages out audited, with no inquiry and nothing applied", async () => {
        const a = await heldClaim(); // stedi stream
        const b = await heldClaim();
        for (const c of [a.c, b.c]) {
          await service("stedi").reconcile(
            actor,
            c.claimId,
            c === a.c ? a.sub.submissionId : b.sub.submissionId,
            "received",
            "payer_portal",
          );
          await admin.query(
            "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
            [c.controlNumber],
          );
          // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
          await admin.query(
            "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
            [c.controlNumber],
          );
        }
        await replayHeldEvents(ackDeps("another_vendor"), scope()); // permanent switch away from stedi
        await replayHeldEvents(ackDeps(null), scope()); // and unbound
        for (const c of [a.c, b.c]) {
          expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_aged" });
          expect(await abandonedEvents(c.controlNumber)).toEqual([
            expect.objectContaining({
              resolution: "abandoned_aged",
              statusInquiry: "not_attempted",
            }),
          ]);
          expect(await claimState(c.claimId)).toBe("submitted"); // never applied
        }
      });

      it("a submission that reuses the control number AFTER the answer was held never inherits it", async () => {
        const { c, sub } = await heldClaim();
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() + interval '1 hour' WHERE id=$1",
          [sub.submissionId],
        );
        await replayHeldEvents(ackDeps("stedi"), scope());
        expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_no_submission" });
        expect(await claimState(c.claimId)).toBe("submitted");
        expect(await ackRows(c.claimId)).toEqual([]);
      });

      it("a claim-status answer about ANOTHER control number is never applied", async () => {
        const { c, sub } = await heldClaim();
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        const wrongAnswer: AckWorkerDeps = {
          ...ackDeps("stedi"),
          binding: {
            vendor: "stedi",
            transport: {
              fetchAcknowledgments: (ctx, cursor) => transport.fetchAcknowledgments(ctx, cursor),
              fetchClaimStatus: async () =>
                ({
                  ok: true,
                  data: {
                    controlNumber: c.controlNumber,
                    state: "payer_accepted",
                    latest: {
                      eventId: "status-other",
                      controlNumber: "000000000",
                      stage: "payer",
                      disposition: "accepted",
                      reasonCodes: [],
                      occurredAt: new Date().toISOString(),
                    },
                  },
                }) as never,
            },
          },
        };
        await replayHeldEvents(wrongAnswer, scope());
        expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_aged" });
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          expect.objectContaining({ statusInquiry: "no_answer" }),
        ]);
        expect(await claimState(c.claimId)).toBe("submitted");
      });

      it("two overlapping replays resolve a row once: one stamp, one abandonment event, never applied AND abandoned", async () => {
        const aged = await heldClaim();
        await service("stedi").reconcile(
          actor,
          aged.c.claimId,
          aged.sub.submissionId,
          "received",
          "payer_portal",
        );
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
          [aged.c.controlNumber],
        );
        // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [aged.c.controlNumber],
        );
        await Promise.all([
          replayHeldEvents(noInquiry("stedi"), scope()),
          replayHeldEvents(noInquiry("stedi"), scope()),
          replayHeldEvents(noInquiry("stedi"), scope()),
        ]);
        expect(await abandonedEvents(aged.c.controlNumber)).toHaveLength(1);

        const live = await heldClaim();
        await service("stedi").reconcile(
          actor,
          live.c.claimId,
          live.sub.submissionId,
          "received",
          "payer_portal",
        );
        await Promise.all([
          replayHeldEvents(ackDeps("stedi"), scope()),
          replayHeldEvents(ackDeps("stedi"), scope()),
        ]);
        expect(await heldOf(live.c)).toMatchObject({ resolution: "applied" });
        expect(await eventCount(live.c.claimId, "m41.claim.accepted")).toBe(1);
        expect(await abandonedEvents(live.c.controlNumber)).toEqual([]);
      });

      it("abandons a held event that aged past the poll window", async () => {
        const { c, sub } = await heldClaim();
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        await replayHeldEvents(noInquiry("stedi"), scope());
        expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_aged" });
        expect(await claimState(c.claimId)).toBe("submitted"); // aged out, NOT applied
        // the abandonment is an EVENT, not only a log line: ids and codes, and what the status inquiry made of it
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          {
            eventId: expect.any(String),
            controlNumber: c.controlNumber,
            claimId: c.claimId,
            reason: "no_receipt",
            resolution: "abandoned_aged",
            statusInquiry: "unavailable",
          },
        ]);
        await replayHeldEvents(noInquiry("stedi"), scope()); // idempotent: a resolved row is not abandoned twice
        expect(await abandonedEvents(c.controlNumber)).toHaveLength(1);
      });

      it("asks the clearinghouse for the claim status before giving up on an aged held answer, and applies what it reports", async () => {
        const { c, sub } = await heldClaim();
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        const replayed = await replayHeldEvents(ackDeps("stedi"), scope()); // the in-memory transport answers claim status
        expect(replayed.applied).toBeGreaterThanOrEqual(1);
        expect(await heldOf(c)).toMatchObject({ resolution: "applied_status_inquiry" });
        expect(await claimState(c.claimId)).toBe("accepted");
        expect(await abandonedEvents(c.controlNumber)).toEqual([]); // applied: nothing was abandoned
      });

      it("abandons a held answer whose submission is gone, with an m41.claim.ack_abandoned event", async () => {
        const { c, sub } = await heldClaim();
        await service("stedi").reconcile(actor, c.claimId, sub.submissionId, "not_received");
        await replayHeldEvents(ackDeps("stedi"), scope());
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          expect.objectContaining({
            resolution: "abandoned_no_submission",
            reason: "no_receipt",
            statusInquiry: "not_attempted",
          }),
        ]);
      });

      it("keeps the event of a vendor_mismatch and never applies it under a different binding, even one that now matches the submission", async () => {
        const c = await sentClaim();
        const out = await applyAckEvent(ackDeps("another_vendor"), scope(), {
          eventId: "replay-vendor",
          controlNumber: c.controlNumber,
          stage: "payer",
          disposition: "accepted",
          reasonCodes: [],
          occurredAt: new Date().toISOString(),
        });
        expect(out).toMatchObject({ result: "quarantined", reason: "vendor_mismatch" });
        expect((await rowOf(c.controlNumber, "vendor_mismatch")).event).toMatchObject({
          stage: "payer",
        });
        // its own stream's binding: the mismatch stands, the row stays held
        await replayHeldEvents(ackDeps("another_vendor"), scope());
        expect((await rowOf(c.controlNumber, "vendor_mismatch")).resolved_at).toBeNull();
        // the binding was switched to the vendor the claim went through: the other vendor's answer is NOT applied
        await replayHeldEvents(ackDeps("stedi"), scope());
        await replayHeldEvents(ackDeps(null), scope());
        expect((await rowOf(c.controlNumber, "vendor_mismatch")).resolved_at).toBeNull();
        expect(await claimState(c.claimId)).toBe("submitted");
        expect(await ackRows(c.claimId)).toEqual([]);
        // it ages out audited even under a binding that is not its own (a permanent vendor switch must not strand it)
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1 AND reason='vendor_mismatch'",
          [c.controlNumber],
        );
        // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await replayHeldEvents(ackDeps("stedi"), scope());
        expect(await rowOf(c.controlNumber, "vendor_mismatch")).toMatchObject({
          resolution: "abandoned_aged",
        });
        expect(await abandonedEvents(c.controlNumber)).toHaveLength(1);
        expect(await claimState(c.claimId)).toBe("submitted");
      });

      it("never re-routes a scope_mismatch to the other provider entity; it waits, then ages out audited", async () => {
        const c = await sentClaim();
        const otherPe = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'765432','Synthetic Hospice Three','1003000126','\\x00','12-31') RETURNING id`,
            [ORG],
          )
        ).rows[0].id as string;
        const otherScope = { organizationId: ORG, providerEntityId: otherPe };
        await applyAckEvent(ackDeps("stedi"), otherScope, {
          eventId: "replay-scope",
          controlNumber: c.controlNumber,
          stage: "payer",
          disposition: "accepted",
          reasonCodes: [],
          occurredAt: new Date().toISOString(),
        });
        await replayHeldEvents(ackDeps("stedi"), otherScope);
        expect((await rowOf(c.controlNumber, "scope_mismatch")).resolved_at).toBeNull();
        expect(await claimState(c.claimId)).toBe("submitted");
        expect(await ackRows(c.claimId)).toEqual([]);
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1 AND reason='scope_mismatch'",
          [c.controlNumber],
        );
        // the held answer is OLDER than any submission it could belong to, as in life: age the submission with it
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await replayHeldEvents(ackDeps("stedi"), otherScope);
        expect(await rowOf(c.controlNumber, "scope_mismatch")).toMatchObject({
          resolution: "abandoned_aged",
        });
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          expect.objectContaining({
            reason: "scope_mismatch",
            resolution: "abandoned_aged",
            statusInquiry: "not_attempted", // no inquiry on behalf of the wrong provider entity
          }),
        ]);
        expect(await claimState(c.claimId)).toBe("submitted");
      });

      it("a malformed event keeps no body and is never replayed", async () => {
        const c = await sentClaim();
        await applyAckEvent(ackDeps("stedi"), scope(), {
          eventId: "replay-malformed",
          controlNumber: c.controlNumber,
          stage: "vendor",
          disposition: "accepted",
          reasonCodes: [],
        });
        await replayHeldEvents(ackDeps("stedi"), scope());
        expect(await rowOf(c.controlNumber, "malformed")).toMatchObject({
          resolved_at: null,
          event: null,
        });
      });

      it("logs (ids only) and abandons a stored event that no longer validates, instead of skipping it silently every tick", async () => {
        const { c } = await heldClaim();
        await admin.query(
          `UPDATE commercial_ack_quarantine SET event = '{"stage":"vendor"}'::jsonb WHERE control_number=$1`,
          [c.controlNumber],
        );
        const logs: { event: string; eventId?: string }[] = [];
        await replayHeldEvents({ ...ackDeps("stedi"), log: (e) => logs.push(e) }, scope());
        expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_invalid" });
        expect(logs.filter((l) => l.event === "ack.held_invalid")).toHaveLength(1);
        expect(JSON.stringify(logs)).not.toContain("vendor"); // the reason names a field, never the value
      });

      it("resolves as applied once the submission is settled, and a resolved row is not replayed again", async () => {
        const { c, sub } = await heldClaim();
        await service("stedi").reconcile(
          actor,
          c.claimId,
          sub.submissionId,
          "received",
          "payer_portal",
        );
        const first = await replayHeldEvents(ackDeps("stedi"), scope());
        expect(first.applied).toBeGreaterThanOrEqual(1);
        expect(await heldOf(c)).toMatchObject({ resolution: "applied" });
        expect(await claimState(c.claimId)).toBe("accepted");
        const second = await replayHeldEvents(ackDeps("stedi"), scope());
        expect(second.applied).toBe(0);
        expect(await eventCount(c.claimId, "m41.claim.accepted")).toBe(1);
      });

      /** A vendor_mismatch row held from another vendor's stream (what a binding switch leaves behind). */
      async function foreignRow() {
        const c = await sentClaim();
        await applyAckEvent(ackDeps("another_vendor"), scope(), {
          eventId: `foreign-${randomUUID()}`,
          controlNumber: c.controlNumber,
          stage: "payer",
          disposition: "accepted",
          reasonCodes: [],
          occurredAt: new Date().toISOString(),
        });
        return c;
      }

      it("closes a pre-1279 mismatch row (no stored event) explicitly and audited, instead of skipping it forever (#820)", async () => {
        const c = await foreignRow();
        await admin.query(
          "UPDATE commercial_ack_quarantine SET event = NULL WHERE control_number=$1 AND reason='vendor_mismatch'",
          [c.controlNumber],
        );
        await replayHeldEvents(ackDeps("stedi"), scope());
        expect(await rowOf(c.controlNumber, "vendor_mismatch")).toMatchObject({
          resolution: "abandoned_no_event",
        });
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          expect.objectContaining({
            reason: "vendor_mismatch",
            resolution: "abandoned_no_event",
            claimId: c.claimId,
          }),
        ]);
        await replayHeldEvents(ackDeps("stedi"), scope()); // idempotent: not abandoned twice
        expect(await abandonedEvents(c.controlNumber)).toHaveLength(1);
        expect(await claimState(c.claimId)).toBe("submitted");
        expect(await ackRows(c.claimId)).toEqual([]);
      });

      it("sweeps an aged foreign row on an UNBOUND tick too (no vendor needed), audited (#820)", async () => {
        const c = await foreignRow();
        await admin.query(
          "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await admin.query(
          "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
          [c.controlNumber],
        );
        await failure(runAckPull(ackDeps(null))); // may fail on other tests' waiting work; the sweep still ran
        expect(await rowOf(c.controlNumber, "vendor_mismatch")).toMatchObject({
          resolution: "abandoned_aged",
        });
        expect(await abandonedEvents(c.controlNumber)).toHaveLength(1);
      });

      it("reports stranded rows and lets an operator close foreign ones, org-scoped and audited (#820)", async () => {
        const c = await foreignRow();
        const before = await heldQuarantineReport(ackDeps("stedi"), ORG);
        expect(before.strandedForeign).toBeGreaterThanOrEqual(1);
        expect(before.bound).toBe(true);
        // counts only: no ids, no payload
        expect(Object.keys(before).sort()).toEqual(
          [
            "bound",
            "held",
            "noEvent",
            "oldestHeldAt",
            "ownStream",
            "reviewOnlyMalformed",
            "strandedForeign",
          ].sort(),
        );
        // another tenant sees and closes nothing of ours
        expect((await heldQuarantineReport(ackDeps("stedi"), ORG_B)).held).toBe(0);
        expect(await abandonForeignHeldEvents(ackDeps("stedi"), ORG_B)).toEqual({ abandoned: 0 });
        // unbound closes nothing (may be a config blip)
        expect(await abandonForeignHeldEvents(ackDeps(null), ORG)).toEqual({ abandoned: 0 });
        expect((await rowOf(c.controlNumber, "vendor_mismatch")).resolved_at).toBeNull();
        const out = await abandonForeignHeldEvents(ackDeps("stedi"), ORG);
        expect(out.abandoned).toBeGreaterThanOrEqual(1);
        expect(await rowOf(c.controlNumber, "vendor_mismatch")).toMatchObject({
          resolution: "abandoned_foreign_vendor",
        });
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          expect.objectContaining({
            reason: "vendor_mismatch",
            resolution: "abandoned_foreign_vendor",
            claimId: c.claimId,
          }),
        ]);
        expect(await claimState(c.claimId)).toBe("submitted"); // closed, never applied
        expect(await abandonForeignHeldEvents(ackDeps("stedi"), ORG)).toEqual({ abandoned: 0 });
      });

      it("the operator sweep stamps the acting user on every abandonment event (#820)", async () => {
        const c = await foreignRow();
        await abandonForeignHeldEvents(ackDeps("stedi"), ORG, USER);
        expect(await abandonedEvents(c.controlNumber)).toEqual([
          expect.objectContaining({ resolution: "abandoned_foreign_vendor", operatorUserId: USER }),
        ]);
      });

      describe("operator resolution of one held row (#820)", () => {
        async function malformedRow() {
          const c = await sentClaim();
          await applyAckEvent(ackDeps("stedi"), scope(), {
            eventId: `op-malformed-${randomUUID()}`,
            controlNumber: c.controlNumber,
            stage: "vendor",
            disposition: "accepted",
            reasonCodes: [],
          });
          const row = await rowOf(c.controlNumber, "malformed");
          return { c, id: row.id as string };
        }

        it("lists the unresolved rows of one provider entity without any payload, and another tenant sees none", async () => {
          const { id } = await malformedRow();
          const items = await listHeldRows(ackDeps("stedi"), scope());
          const item = items.find((r) => r.id === id);
          expect(item).toMatchObject({ reason: "malformed", hasEvent: false });
          expect(Object.keys(item ?? {}).sort()).toEqual(
            ["clearinghouseKey", "controlNumber", "createdAt", "hasEvent", "id", "reason"].sort(),
          );
          expect(
            await listHeldRows(ackDeps("stedi"), { organizationId: ORG_B, providerEntityId }),
          ).toEqual([]);
        });

        it("closes a malformed row once, audited with the operator, and is idempotent", async () => {
          const { c, id } = await malformedRow();
          expect(await resolveHeldRowByOperator(ackDeps("stedi"), scope(), id, USER)).toBe(
            "resolved",
          );
          expect(await rowOf(c.controlNumber, "malformed")).toMatchObject({
            resolution: "abandoned_operator",
          });
          expect(await abandonedEvents(c.controlNumber)).toEqual([
            expect.objectContaining({
              reason: "malformed",
              resolution: "abandoned_operator",
              operatorUserId: USER,
              statusInquiry: "not_attempted",
            }),
          ]);
          expect(await resolveHeldRowByOperator(ackDeps("stedi"), scope(), id, USER)).toBe(
            "already_resolved",
          );
          expect(await abandonedEvents(c.controlNumber)).toHaveLength(1);
          expect(await claimState(c.claimId)).toBe("submitted"); // closed, never applied
        });

        it("never closes a row of another tenant or another provider entity (not_found, nothing changes)", async () => {
          const { c, id } = await malformedRow();
          const other = { organizationId: ORG_B, providerEntityId };
          expect(await resolveHeldRowByOperator(ackDeps("stedi"), other, id, USER)).toBe(
            "not_found",
          );
          const elsewhere = { organizationId: ORG, providerEntityId: randomUUID() };
          expect(await resolveHeldRowByOperator(ackDeps("stedi"), elsewhere, id, USER)).toBe(
            "not_found",
          );
          expect((await rowOf(c.controlNumber, "malformed")).resolved_at).toBeNull();
          expect(await abandonedEvents(c.controlNumber)).toEqual([]);
        });

        it("closes a held replayable row too (an operator settled it out of band)", async () => {
          const { c } = await heldClaim();
          const row = await heldOf(c);
          expect(
            await resolveHeldRowByOperator(ackDeps("stedi"), scope(), row.id as string, USER),
          ).toBe("resolved");
          expect(await heldOf(c)).toMatchObject({ resolution: "abandoned_operator" });
          await replayHeldEvents(ackDeps("stedi"), scope()); // a resolved row is not replayed
          expect(await abandonedEvents(c.controlNumber)).toHaveLength(1);
        });
      });

      describe("the claim-status inquiry carries a subscriber from the inquiry port (#820)", () => {
        const INQUIRY = {
          billingProvider: { organizationName: "Synthetic Hospice", npi: NPI },
          subscriber: {
            memberId: "SYN123456",
            firstName: "Test",
            lastName: "Patient",
            dateOfBirth: "1950-02-03",
          },
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
        };
        async function agedHeld() {
          const { c } = await heldClaim();
          await admin.query(
            "UPDATE commercial_ack_quarantine SET created_at = now() - interval '60 days' WHERE control_number=$1",
            [c.controlNumber],
          );
          await admin.query(
            "UPDATE commercial_submission SET requested_at = now() - interval '61 days' WHERE control_number=$1",
            [c.controlNumber],
          );
          return c;
        }

        it("hands the inquiry to the transport as the third argument, then abandons when nothing applies", async () => {
          const c = await agedHeld();
          const seen: unknown[] = [];
          const deps: AckWorkerDeps = {
            ...ackDeps("stedi"),
            inquiries: { inquiryFor: async () => INQUIRY },
            binding: {
              vendor: "stedi",
              transport: {
                fetchAcknowledgments: (ctx, cursor) => transport.fetchAcknowledgments(ctx, cursor),
                fetchClaimStatus: async (_ctx, _n, inquiry) => {
                  seen.push(inquiry);
                  return { ok: true, data: { controlNumber: _n, state: "received", latest: null } };
                },
              },
            },
          };
          await replayHeldEvents(deps, scope());
          expect(seen).toEqual([INQUIRY]);
          expect(await abandonedEvents(c.controlNumber)).toEqual([
            expect.objectContaining({ resolution: "abandoned_aged", statusInquiry: "no_answer" }),
          ]);
        });

        it("a claim the port cannot describe is not asked about at all (unavailable, then abandoned)", async () => {
          const c = await agedHeld();
          let asked = 0;
          const deps: AckWorkerDeps = {
            ...ackDeps("stedi"),
            inquiries: { inquiryFor: async () => null },
            binding: {
              vendor: "stedi",
              transport: {
                fetchAcknowledgments: (ctx, cursor) => transport.fetchAcknowledgments(ctx, cursor),
                fetchClaimStatus: async () => {
                  asked += 1;
                  return { ok: false, degraded: { code: "CH_NOT_WIRED", reason: "x" } };
                },
              },
            },
          };
          await replayHeldEvents(deps, scope());
          expect(asked).toBe(0);
          expect(await abandonedEvents(c.controlNumber)).toEqual([
            expect.objectContaining({ resolution: "abandoned_aged", statusInquiry: "unavailable" }),
          ]);
        });
      });
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

  // #824: the weekly retention prune deletes only RESOLVED rows past the horizon, in the caller's tenant, and the database refuses
  // the app role an unresolved delete.
  describe("quarantine retention prune (#824)", () => {
    const insertRow = async (eventId: string, resolvedDaysAgo: number | null) => {
      if (resolvedDaysAgo === null) {
        await admin.query(
          `INSERT INTO commercial_ack_quarantine (organization_id, provider_entity_id, clearinghouse_key, event_id, reason)
           VALUES ($1,$2,'stedi',$3,'malformed')`,
          [ORG, providerEntityId, eventId],
        );
        return;
      }
      await admin.query(
        `INSERT INTO commercial_ack_quarantine (organization_id, provider_entity_id, clearinghouse_key, event_id, reason, resolved_at, resolution)
         VALUES ($1,$2,'stedi',$3,'malformed', now() - make_interval(days => $4::int), 'abandoned_invalid')`,
        [ORG, providerEntityId, eventId, resolvedDaysAgo],
      );
    };
    const remaining = async () =>
      (
        await admin.query(
          "SELECT event_id FROM commercial_ack_quarantine WHERE event_id LIKE 'prune-%' ORDER BY event_id",
        )
      ).rows.map((r) => r.event_id as string);

    it("deletes resolved rows older than the horizon and keeps young resolved and unresolved ones", async () => {
      await insertRow("prune-old", QUARANTINE_RETENTION_DAYS + 5);
      await insertRow("prune-young", QUARANTINE_RETENTION_DAYS - 5);
      await insertRow("prune-open", null);
      // another tenant's context never reaches this org's rows, even far in the future
      await runQuarantinePrune({
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_B }] },
        now: () => new Date(Date.now() + 10 * 365 * 86_400_000),
      });
      expect(await remaining()).toEqual(["prune-old", "prune-open", "prune-young"]);
      const deleted = await runQuarantinePrune({
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      });
      expect(deleted).toBe(1);
      expect(await remaining()).toEqual(["prune-open", "prune-young"]);
    });

    it("the database refuses the app role an unresolved delete", async () => {
      await expect(
        withOrgContext(handle.db, systemOrgContext(ORG), (tx) =>
          tx
            .delete(schema.commercialAckQuarantine)
            .where(eq(schema.commercialAckQuarantine.eventId, "prune-open")),
        ),
      ).rejects.toThrow();
      expect(await remaining()).toContain("prune-open");
    });
  });

  // The split deployment: PROCESS_ROLE=api serves requests and never registers the repeatable jobs; a separate worker process does.
  // The API's readiness must therefore come from the SHARED queue store, not from a flag in its own process. Real Valkey, real BullMQ,
  // nothing injected: the "api" side builds its readiness exactly as index.ts does (a local flag that is never set, plus the probe).
  describe.skipIf(!REDIS_URL)("api role readiness against a real Valkey (split deployment)", () => {
    const url = new URL(REDIS_URL ?? "redis://localhost:6379");
    const connection: ConnectionOptions = { host: url.hostname, port: Number(url.port || 6379) };
    const open: { close(): Promise<void> }[] = [];

    const clearSchedules = async () => {
      for (const name of Object.values(M41_CRON_QUEUES)) {
        const q = new Queue(name, { connection });
        await q.obliterate({ force: true });
        await q.close();
      }
    };
    const apiReadiness = () => {
      const probe = createScheduleProbe({ connection });
      open.push(probe);
      return createSharedDrainReadiness({
        local: createDrainReadiness(), // the API process never marks itself scheduled
        probe,
        ttlMs: 0,
        negativeTtlMs: 0,
      });
    };
    const apiService = (readiness: ReturnType<typeof apiReadiness>) =>
      buildCommercialSubmissionService(
        handle.db,
        seams(randomUUID()),
        { vendor: "stedi" },
        readiness,
      );

    afterAll(async () => {
      await Promise.all(open.map((o) => o.close()));
      await clearSchedules();
    });

    it("refuses with 503 until the worker process has registered BOTH schedules, then serves; losing one refuses again", async () => {
      await clearSchedules();
      const readiness = apiReadiness();
      const api = apiService(readiness);
      const c1 = await readyClaim();

      // nothing in Valkey: the API fails closed
      const before = await failure(api.submit(actor, c1.claimId, `key-${randomUUID()}`));
      expect(before?.statusCode).toBe(503);
      expect(before?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      expect(await submissionCount(c1.claimId)).toBe(0);
      expect((await api.sendGate(actor, c1.claimId)).reasons.map((r) => r.code)).toContain(
        "COMMERCIAL_DRAIN_NOT_SCHEDULED",
      );

      // the worker process registers the repeatable jobs (a different process in production)
      const drainQueues = await scheduleM41Jobs(connection);
      const ackQueues = await scheduleM41AckJobs(connection);
      open.push(...drainQueues, ...ackQueues);
      // #824: schedules alone are not enough: with no consumer connected the API still refuses (a dead worker must not look ready)
      const noConsumer = await failure(api.submit(actor, c1.claimId, `key-${randomUUID()}`));
      expect(noConsumer?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      expect(await submissionCount(c1.claimId)).toBe(0);
      const workers = [M41_CRON_QUEUES.submissionDrain, M41_CRON_QUEUES.ackPull].map(
        (name) => new Worker(name, async () => undefined, { connection }),
      );
      open.push(...workers);
      await Promise.all(workers.map((w) => w.waitUntilReady()));
      const served = await api.submit(actor, c1.claimId, `key-${randomUUID()}`);
      expect(served.status).toBe("queued");
      expect((await api.sendGate(actor, c1.claimId)).reasons.map((r) => r.code)).not.toContain(
        "COMMERCIAL_DRAIN_NOT_SCHEDULED",
      );

      // a worker dies (schedules still present): not ready again, then ready when it returns
      const c3 = await readyClaim();
      await workers[0]?.close();
      const dead = await failure(api.submit(actor, c3.claimId, `key-${randomUUID()}`));
      expect(dead?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      expect(await submissionCount(c3.claimId)).toBe(0);
      const back = new Worker(M41_CRON_QUEUES.submissionDrain, async () => undefined, {
        connection,
      });
      open.push(back);
      await back.waitUntilReady();
      expect((await api.submit(actor, c3.claimId, `key-${randomUUID()}`)).status).toBe("queued");

      // one of the two schedules disappears: not ready again
      const c2 = await readyClaim();
      const ackQueue = ackQueues[0];
      if (!ackQueue) throw new Error("no ack queue");
      for (const job of await ackQueue.getRepeatableJobs())
        await ackQueue.removeRepeatableByKey(job.key);
      const after = await failure(api.submit(actor, c2.claimId, `key-${randomUUID()}`));
      expect(after?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      expect(await submissionCount(c2.claimId)).toBe(0);
      await admin.query(
        "UPDATE commercial_submission SET status='failed', last_failure_code='TEST' WHERE claim_id=$1",
        [c1.claimId],
      );
    });

    it("with no queue connection at all the API stays refused (fail closed)", async () => {
      const readiness = createSharedDrainReadiness({ local: createDrainReadiness() }); // REDIS_URL unset: no probe
      const c = await readyClaim();
      const err = await failure(
        apiService(readiness).submit(actor, c.claimId, `key-${randomUUID()}`),
      );
      expect(err?.statusCode).toBe(503);
      expect(err?.code).toBe("COMMERCIAL_DRAIN_NOT_SCHEDULED");
      expect(await submissionCount(c.claimId)).toBe(0);
    });

    // #818: the probe times out against a Valkey that is paused (sockets open, nothing answers) or gone (connection refused) and must
    // TEAR DOWN what it opened. A TCP proxy in front of the real Valkey plays "paused" (swallows traffic) and "down" (stops listening),
    // and counts the sockets the probe holds open, so a leak shows as a number that grows with the cycles.
    describe("a long Valkey outage does not accumulate connections (#818)", () => {
      type Mode = "forward" | "paused" | "down";
      const CYCLES = 25;
      const PROBE_TIMEOUT_MS = 150;

      async function startProxy(targetPort: number) {
        let mode: Mode = "forward";
        let accepted = 0;
        const live = new Set<net.Socket>();
        const handler = (client: net.Socket) => {
          accepted += 1;
          live.add(client);
          client.on("close", () => live.delete(client));
          client.on("error", () => undefined);
          if (mode === "paused") {
            client.on("data", () => undefined); // swallow: the peer is alive and never answers
            return;
          }
          const upstream = net.connect(targetPort, url.hostname);
          upstream.on("error", () => client.destroy());
          client.on("close", () => upstream.destroy());
          client.pipe(upstream);
          upstream.pipe(client);
        };
        let server = net.createServer(handler);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const port = (server.address() as net.AddressInfo).port;
        const stopListening = () =>
          new Promise<void>((r) => {
            server.close(() => r());
          });
        return {
          port,
          open: () => live.size,
          accepted: () => accepted,
          /** Existing sockets stay open (a paused process keeps its TCP connections) but nothing is forwarded any more. */
          pause: () => {
            mode = "paused";
            for (const s of live) {
              s.unpipe();
              s.resume(); // keep reading (and discarding), or the peer's close is never seen
            }
          },
          /** The process is gone: connections drop and new ones are refused. */
          down: async () => {
            mode = "down";
            for (const s of live) s.destroy();
            await stopListening();
          },
          up: async () => {
            if (mode === "down") {
              server = net.createServer(handler);
              await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
            }
            mode = "forward";
          },
          close: async () => {
            for (const s of live) s.destroy();
            if (mode !== "down") await stopListening();
          },
        };
      }
      const tcpSockets = () =>
        process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;
      const settle = () => new Promise((r) => setTimeout(r, 400));

      it("a paused Valkey: every timed-out probe frees its sockets, and the probe works again once Valkey is back", async () => {
        const targetPort = Number(url.port || 6379);
        const drain = await scheduleM41Jobs(connection);
        const ack = await scheduleM41AckJobs(connection);
        open.push(...drain, ...ack);
        const proxy = await startProxy(targetPort);
        try {
          const probe = createScheduleProbe({
            connection: { host: "127.0.0.1", port: proxy.port },
            timeoutMs: PROBE_TIMEOUT_MS,
          });
          await expect(probe()).resolves.toBe(true); // healthy through the proxy
          proxy.pause();
          let peak = 0;
          for (let i = 0; i < CYCLES; i++) {
            await expect(probe()).rejects.toThrow(/timed out/);
            peak = Math.max(peak, proxy.open());
          }
          await settle();
          // at most the queue being probed plus one still tearing down at any instant, and NONE left once the dust settles
          expect(peak).toBeLessThanOrEqual(3);
          expect(proxy.open()).toBe(0);
          expect(proxy.accepted()).toBeLessThanOrEqual(CYCLES + 4); // one queue per cycle, not a reconnect storm
          await proxy.up();
          await expect(probe()).resolves.toBe(true);
          await probe.close();
          await settle();
          expect(proxy.open()).toBe(0);
        } finally {
          await proxy.close();
        }
      });

      it("a Valkey that is gone (connection refused): no sockets or handles pile up across cycles, and shutdown does not hang", async () => {
        const targetPort = Number(url.port || 6379);
        const proxy = await startProxy(targetPort);
        try {
          const probe = createScheduleProbe({
            connection: { host: "127.0.0.1", port: proxy.port },
            timeoutMs: PROBE_TIMEOUT_MS,
          });
          await expect(probe()).resolves.toBe(true);
          await proxy.down();
          await settle();
          const before = tcpSockets();
          for (let i = 0; i < CYCLES; i++) await expect(probe()).rejects.toThrow();
          await settle();
          expect(tcpSockets() - before).toBeLessThanOrEqual(2); // not one per cycle
          await probe.close(); // must return against a dead store
        } finally {
          await proxy.close();
        }
      });
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
  // #838: org erasure. Runs LAST (it erases ORG, which the tests above share): the real eraser, as the real NOBYPASSRLS
  // chartwarden_destruction role under withOrgContext, empties every M41 table for one org and leaves the other org alone.
  describe("org erasure as chartwarden_destruction (#838)", () => {
    const M41_TABLES = [
      "commercial_payer_plan",
      "commercial_payer_route",
      "commercial_contract_rate",
      "commercial_payer_enrollment",
      "commercial_eligibility_check",
      "commercial_authorization",
      "commercial_claim",
      "commercial_claim_line",
      "commercial_claim_state_history",
      "commercial_validation_run",
      "commercial_validation_result",
      "commercial_validation_override",
      "commercial_submission",
      "commercial_acknowledgment",
      "commercial_ack_quarantine",
      "commercial_ack_cursor",
    ];
    const rowsIn = async (org: string) => {
      const out: Record<string, number> = {};
      for (const t of M41_TABLES) {
        out[t] = await scalar<number>(
          `SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`,
          [org],
        );
      }
      return out;
    };

    it("deletes every M41 row of one org, none of the other's, and unblocks the RESTRICT FKs", async () => {
      // ORG: a full graph (claim, line, history, run, result, authorization, plan, route, rate, enrollment via readyClaim) plus
      // submission, acknowledgment, an UNRESOLVED quarantine row, cursor and eligibility check.
      const c = await readyClaim({ authorization: true });
      const submitted = await service("stedi").submit(actor, c.claimId, "key-erase");
      await admin.query(
        `INSERT INTO commercial_acknowledgment (organization_id, provider_entity_id, claim_id, submission_id, clearinghouse_key, event_id, stage, disposition)
         SELECT organization_id, provider_entity_id, claim_id, id, 'stedi', 'erase-ack', 'clearinghouse', 'accepted' FROM commercial_submission WHERE claim_id=$1`,
        [c.claimId],
      );
      await admin.query(
        `INSERT INTO commercial_ack_quarantine (organization_id, provider_entity_id, clearinghouse_key, event_id, reason)
         VALUES ($1,$2,'stedi','erase-q','malformed')`,
        [ORG, providerEntityId],
      );
      await admin.query(
        `INSERT INTO commercial_ack_cursor (organization_id, provider_entity_id, vendor, usage, cursor) VALUES ($1,$2,'stedi','test','c1') ON CONFLICT DO NOTHING`,
        [ORG, providerEntityId],
      );
      await admin.query(
        `INSERT INTO commercial_eligibility_check (organization_id, provider_entity_id, patient_id, plan_id, patient_payer_id, clearinghouse_key, clearinghouse_payer_id, service_date, outcome, as_of_date, request_id, idempotency_key, checked_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'stedi','SYNTH01','2026-03-01','active','2026-03-01',$6,'erase-elig',$7)`,
        [ORG, providerEntityId, c.patientId, c.planId, randomUUID(), randomUUID(), USER],
      );
      // ORG_B: its own provider entity, plan, quarantine row and cursor.
      const existingB = (
        await admin.query("SELECT id FROM provider_entity WHERE organization_id=$1 LIMIT 1", [
          ORG_B,
        ])
      ).rows[0]?.id as string | undefined;
      const peB =
        existingB ??
        ((
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'777001','Other Hospice','9988770001','\\x00','12-31') RETURNING id`,
            [ORG_B],
          )
        ).rows[0].id as string);
      const payerB = (
        await admin.query(
          "INSERT INTO payer (kind, name) VALUES ('commercial'::payer_kind, 'Erase B Health') RETURNING id",
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement, effective_from)
         VALUES ($1,$2,'B PPO','CI','not_required','2026-01-01')`,
        [ORG_B, payerB],
      );
      await admin.query(
        `INSERT INTO commercial_ack_quarantine (organization_id, provider_entity_id, clearinghouse_key, event_id, reason)
         VALUES ($1,$2,'stedi','erase-qb','malformed')`,
        [ORG_B, peB],
      );
      await admin.query(
        `INSERT INTO commercial_ack_cursor (organization_id, provider_entity_id, vendor, usage, cursor) VALUES ($1,$2,'stedi','test','cb') ON CONFLICT DO NOTHING`,
        [ORG_B, peB],
      );
      expect(submitted).toBeTruthy();
      const seeded = await rowsIn(ORG);
      for (const t of M41_TABLES.filter((x) => x !== "commercial_validation_override")) {
        expect(seeded[t], t).toBeGreaterThan(0);
      }
      const beforeB = await rowsIn(ORG_B);

      await admin.query(`ALTER ROLE chartwarden_destruction LOGIN PASSWORD 'destroy-live'`);
      const url = new URL(DB_URL as string);
      url.username = "chartwarden_destruction";
      url.password = "destroy-live";
      const destruction = createDbClient({ connectionString: url.toString() });
      let counts: Record<string, number> = {};
      try {
        await withOrgContext(destruction.db, { organizationId: ORG, userId: "" }, async (tx) => {
          counts = {
            ...(await createDrizzleCommercialBillingEraseStore(
              tx as unknown as typeof destruction.db,
            ).eraseOrgCommercialBilling({ organizationId: ORG })),
          };
        });
      } finally {
        await destruction.close();
      }

      const after = await rowsIn(ORG);
      for (const t of M41_TABLES) {
        expect(after[t], t).toBe(0);
        expect(counts[t], t).toBe(seeded[t]);
      }
      expect(await rowsIn(ORG_B)).toEqual(beforeB);
      expect(beforeB.commercial_ack_quarantine).toBe(1);
      // nothing M41 still references the org or its provider entity, so deleting the org is no longer blocked by M41
      const blockers = await scalar<number>(
        `SELECT (SELECT count(*) FROM commercial_claim WHERE organization_id=$1 OR provider_entity_id=$2)::int AS n`,
        [ORG, providerEntityId],
      );
      expect(blockers).toBe(0);
    }, 120_000);
  });
});
