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
  buildCommercial837iRenderer,
  buildCommercialClaimAssemblyService,
  buildCommercialClaimLifecycleService,
  buildCommercialContextPort,
  buildCommercialSubmissionService,
  runSubmissionDrain,
} from "../src/modules/41-billing-commercial/index";
import type { SubmissionWorkerDeps } from "../src/modules/41-billing-commercial/index";
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

  const workerDeps = (vendor: string | null): SubmissionWorkerDeps => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M41_OUTBOX_EVENTS]));
    return {
      db: handle.db,
      binding: { vendor, transport },
      contexts: buildCommercialContextPort({
        env: {},
        providerNpi: async () => NPI,
      }),
      renderer: renderer(),
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
      ).rejects.toThrow(/M41_CLAIM_ALREADY_SENT/);

      // timeline: ordered, ids/dates/codes only
      const tl = await svc.timeline(actor, c.claimId);
      expect(tl.state).toBe("submitted");
      expect(tl.truncated).toBe(false);
      const kinds = tl.items.map((i) =>
        i.kind === "state_change" ? `${i.fromState}>${i.toState}` : `submission:${i.status}`,
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
