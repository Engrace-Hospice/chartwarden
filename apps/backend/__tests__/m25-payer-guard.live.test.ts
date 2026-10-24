/**
 * M25 milestone 11a-1 (hospice ADR/TPE/QIC PRD, Medicaid) - the payer guard and the Medicaid case view, LIVE Postgres as
 * the NOBYPASSRLS `chartwarden_app` role through the real write/read/case-view services, the real M24 seam and routes.
 *
 * Proves: a denial whose remittance is Medicaid refuses every Medicare appeal tier (422 PAYER_IS_MEDICAID) and writes
 * nothing; medicare, commercial and unknown (no advice) denials are unchanged; a legacy Medicare-tier appeal on a
 * Medicaid denial does not spawn the next Medicare tier; another tenant cannot reach the denial; the denial detail and
 * list carry payerKind; and the case view resolves a Medicaid claim through the M24 seam (read audit names its patient)
 * while an unknown, other-tenant or out-of-scope claim is still 404 and a Medicare claim still resolves.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:payer-guard:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { FormatRegistry } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerM24PublishedSeams } from "../src/modules/24-billing-medicaid/wiring";
import { buildDrizzleCaseViewService } from "../src/modules/25-remittance/routes/case-view-service";
import { registerCaseViewRoutes } from "../src/modules/25-remittance/routes/case-view.routes";
import { buildDrizzleQicService } from "../src/modules/25-remittance/routes/qic-service";
import { buildDrizzleM25ReadService } from "../src/modules/25-remittance/routes/read-service-drizzle";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { type M7Fixture, ORG, ORG_B, daysAgo, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("M25 payer guard + Medicaid case view (11a-1) - LIVE Postgres", () => {
  let fx: M7Fixture;
  let seq = 0;
  const write = () => buildDrizzleM25WriteService(fx.handle.db);
  const read = () => buildDrizzleM25ReadService(fx.handle.db);
  const A = () => fx.actor();
  const B = () => fx.actor(ORG_B);

  /** A denial linked to a remittance of `payerKind` (or to none when null: a 277CA/EVV-style denial). */
  async function mkDenial(
    payerKind: "medicare" | "medicaid" | "commercial" | null,
    claimId: string,
    org = ORG,
    pe = fx.pe1,
  ): Promise<string> {
    let lineId: string | null = null;
    if (payerKind) {
      seq += 1;
      const advice = (
        await fx.admin.query(
          `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
             interchange_control_number, transaction_set_control_number, check_or_eft_trace_number, payment_method,
             total_payment_amount, production_date, minio_object_key, file_sha256, parse_status)
           VALUES ($1,$2,$3,$4,$5,$6,'TRC','eft',0, now() - interval '10 days','k',$7,'partial_posted')
           RETURNING id, received_at`,
          [
            org,
            pe,
            randomUUID(),
            payerKind,
            `9${String(seq).padStart(8, "0")}`,
            `1${String(seq).padStart(5, "0")}`,
            "0".repeat(64),
          ],
        )
      ).rows[0];
      lineId = (
        await fx.admin.query(
          `INSERT INTO remittance_line (organization_id, remittance_advice_id, claim_id, clp02_status_code,
             clp03_total_charge_amount, clp04_total_payment_amount, clp05_patient_responsibility_amount, match_state, received_at)
           VALUES ($1,$2,$3,4,100,0,0,'auto_matched',$4) RETURNING id`,
          [org, advice.id, claimId, advice.received_at],
        )
      ).rows[0].id as string;
    }
    return (
      await fx.admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, remittance_line_id,
           source_evv_aggregator_submission_id, carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,$5,'50','denial',$6,'escalated',10,'mapped') RETURNING id`,
        [
          org,
          pe,
          claimId,
          lineId,
          payerKind ? null : randomUUID(),
          payerKind ? "remittance_adjustment" : "evv_aggregator_rejection",
        ],
      )
    ).rows[0].id as string;
  }

  const appealCount = async (denialId: string) =>
    Number(
      (
        await fx.admin.query("SELECT count(*)::int AS n FROM appeal_case WHERE denial_case_id=$1", [
          denialId,
        ])
      ).rows[0].n,
    );

  /** A Medicaid claim row (M24), inserted as the superuser; the seam reads it back as chartwarden_app under RLS. */
  async function mkMedicaidClaim(
    org: string,
    pe: string,
    patientId = randomUUID(),
  ): Promise<string> {
    seq += 1;
    return (
      await fx.admin.query(
        `INSERT INTO medicaid_claim (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
           service_state, kind, tob, service_from, service_to, state_plan_code_id, state_plan_code_snapshot,
           medicaid_claim_control_number, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'ZZ','hospice_only','811','2026-03-01','2026-03-31',$6,'TEST',$7,$8,$8) RETURNING id`,
        [
          org,
          pe,
          patientId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          `MCN-PG-${seq}`,
          randomUUID(),
        ],
      )
    ).rows[0].id as string;
  }

  function makeApp(keys: string[], opts: { scope?: string[] } = {}) {
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
        // a scoped actor is a non-oversight role; billing_manager reads org-wide
        request.context.roles = [opts.scope ? "biller" : "billing_manager"];
        request.context.providerEntityIds = opts.scope ?? [fx.pe1, fx.pe2];
        request.context.attributes = { ...request.context.attributes, membershipId: fx.memberA };
      },
      security: { rateLimitEnabled: false },
    });
    registerCaseViewRoutes(app, { caseViewService: buildDrizzleCaseViewService(fx.handle.db) });
    return app;
  }

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-pg");
    registerM24PublishedSeams(fx.handle.db);
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  describe("createAppeal payer guard", () => {
    it("refuses a Medicare tier on a Medicaid denial with 422 PAYER_IS_MEDICAID and writes nothing", async () => {
      const denial = await mkDenial("medicaid", fx.claim1);
      const before = await fx.ver("denial_case", denial);
      const refused = await fx.refused(write().createAppeal(A(), denial, {}));
      expect(refused?.code).toBe("PAYER_IS_MEDICAID");
      expect(refused?.statusCode).toBe(422);
      // every tier is refused, and an explicit notice date does not get around it
      for (const tier of ["redetermination", "reconsideration", "alj"] as const) {
        const r = await fx.refused(
          write().createAppeal(A(), denial, { tier, noticeDate: daysAgo(12) }),
        );
        expect(r?.code).toBe("PAYER_IS_MEDICAID");
      }
      expect(await appealCount(denial)).toBe(0);
      expect(await fx.ver("denial_case", denial)).toBe(before);
      const state = (await fx.admin.query("SELECT state FROM denial_case WHERE id=$1", [denial]))
        .rows[0].state;
      expect(state).toBe("escalated");
    });

    it("keeps today's behaviour for a medicare denial, a commercial denial and an unknown-payer denial", async () => {
      const medicare = await mkDenial("medicare", fx.claim1);
      const commercial = await mkDenial("commercial", fx.claim1b);
      const unknown = await mkDenial(null, fx.claim2, ORG, fx.pe2);
      for (const d of [medicare, commercial]) {
        const res = await write().createAppeal(A(), d, {});
        expect(res.id).toBeTruthy();
        expect(await appealCount(d)).toBe(1);
      }
      // no advice (277CA / EVV): nothing is assumed about the payer, so the printed notice date is asked for as before
      const needsDate = await fx.refused(write().createAppeal(A(), unknown, {}));
      expect(needsDate?.code).toBe("NOTICE_DATE_REQUIRED");
      const res = await write().createAppeal(A(), unknown, { noticeDate: daysAgo(10) });
      expect(res.id).toBeTruthy();
      expect(await appealCount(unknown)).toBe(1);
    });

    it("a denial with no remittance line whose claim is an M24 Medicaid claim is refused; an M23 claim is not", async () => {
      const medicaidClaim = await mkMedicaidClaim(ORG, fx.pe1);
      const viaClaim = await mkDenial(null, medicaidClaim);
      const refused = await fx.refused(
        write().createAppeal(A(), viaClaim, { noticeDate: daysAgo(10) }),
      );
      expect(refused?.code).toBe("PAYER_IS_MEDICAID");
      expect(await appealCount(viaClaim)).toBe(0);
      const medicareClaim = await mkDenial(null, fx.claim1);
      const ok = await write().createAppeal(A(), medicareClaim, { noticeDate: daysAgo(10) });
      expect(ok.id).toBeTruthy();
    });

    it("entity scope is enforced before the payer check: out-of-scope reads as 404, never a payer-revealing 422", async () => {
      const denial = await mkDenial("medicaid", fx.claim1);
      const scoped = fx.actor(ORG, [fx.pe2]);
      const r = await fx.refused(write().createAppeal(scoped, denial, {}));
      expect(r?.statusCode).toBe(404);
      expect(r?.code).not.toBe("PAYER_IS_MEDICAID");
    });

    it("a legacy Medicaid reconsideration cannot be escalated to a Medicare ALJ case", async () => {
      const denial = await mkDenial("medicaid", fx.claim1);
      const recon = (
        await fx.admin.query(
          `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, state,
             tier_deadline_at, notice_dated_on, escalation_requested_at, escalation_channel, escalation_confirmation_ref, qic_received_on)
           VALUES ($1,$2,$3,$4,'reconsideration','under_review','2099-01-01T00:00:00Z',$5, now() - interval '2 days','qic_portal','REF-1',$5)
           RETURNING id, version`,
          [ORG, fx.pe1, denial, fx.claim1, daysAgo(200)],
        )
      ).rows[0];
      const r = await fx.refused(
        buildDrizzleQicService(fx.handle.db).confirmEscalation(
          A(),
          recon.id,
          { forwardedOn: daysAgo(1) },
          recon.version,
        ),
      );
      expect(r?.code).toBe("PAYER_IS_MEDICAID");
      expect(await appealCount(denial)).toBe(1); // no ALJ case
      const st = (await fx.admin.query("SELECT state FROM appeal_case WHERE id=$1", [recon.id]))
        .rows[0].state;
      expect(st).toBe("under_review"); // the confirmation rolled back
    });

    it("another tenant cannot reach a Medicaid or Medicare denial, and nothing is written", async () => {
      const denial = await mkDenial("medicaid", fx.claim1);
      const r = await fx.refused(write().createAppeal(B(), denial, {}));
      expect(r?.statusCode).toBe(404);
      expect(await appealCount(denial)).toBe(0);
      expect(await read().getDenial(B(), denial)).toBeNull();
    });

    it("a legacy Medicare-tier appeal on a Medicaid denial does not spawn the next Medicare tier", async () => {
      const medicaid = await mkDenial("medicaid", fx.claim1);
      const medicare = await mkDenial("medicare", fx.claim1b);
      const insertAppeal = async (denial: string, claim: string) =>
        (
          await fx.admin.query(
            `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, state,
               tier_deadline_at, notice_dated_on)
             VALUES ($1,$2,$3,$4,'redetermination','under_review','2099-01-01T00:00:00Z',$5) RETURNING id`,
            [ORG, fx.pe1, denial, claim, daysAgo(20)],
          )
        ).rows[0].id as string;
      const legacy = await insertAppeal(medicaid, fx.claim1);
      const normal = await insertAppeal(medicare, fx.claim1b);
      const decide = (id: string) =>
        write().decideAppeal(
          A(),
          id,
          {
            outcome: "unfavorable",
            decidedAt: new Date().toISOString(),
            reason: "Unfavorable decision recorded for the payer-guard live suite.",
          },
          1,
        );
      await decide(legacy);
      await decide(normal);
      expect(await appealCount(medicaid)).toBe(1); // decision recorded, no reconsideration spawned
      expect(await appealCount(medicare)).toBe(2); // the Medicare chain still spawns the next tier
    });
  });

  describe("payerKind on the denial read model", () => {
    it("detail and list carry medicare / medicaid / commercial / unknown", async () => {
      const ids = {
        medicare: await mkDenial("medicare", fx.claim1),
        medicaid: await mkDenial("medicaid", fx.claim1),
        commercial: await mkDenial("commercial", fx.claim1),
        unknown: await mkDenial(null, fx.claim1),
      };
      for (const [kind, id] of Object.entries(ids)) {
        expect((await read().getDenial(A(), id))?.payerKind).toBe(kind);
      }
      const page = await read().denialWorklist(A(), {}, undefined, 200);
      const byId = new Map(page.items.map((i) => [i.id, i.payerKind]));
      for (const [kind, id] of Object.entries(ids)) expect(byId.get(id)).toBe(kind);
    });
  });

  describe("case view resolves a Medicaid claim", () => {
    it("200 with the read audited against the claim's patient; unknown, other-tenant and out-of-scope claims stay 404", async () => {
      const patient = randomUUID();
      const medicaidClaim = await mkMedicaidClaim(ORG, fx.pe1, patient);
      const medicaidClaimPe2 = await mkMedicaidClaim(ORG, fx.pe2);
      const medicaidClaimB = await mkMedicaidClaim(ORG_B, fx.peB);
      const app = makeApp(["appeal.read"]);
      const get = (claim: string) =>
        app.inject({ method: "GET", url: `/api/v1/claims/${claim}/case-view` });
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'claim_case_view.%'",
        [ORG],
      );

      const res = await get(medicaidClaim);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { claimId: string }).claimId).toBe(medicaidClaim);
      const audited = (
        await fx.admin.query(
          "SELECT resource_id::text AS rid, context->>'patientId' AS pid FROM audit_event WHERE organization_id=$1 AND event_type='claim_case_view.viewed'",
          [ORG],
        )
      ).rows;
      expect(audited).toContainEqual({ rid: medicaidClaim, pid: patient });

      expect((await get(randomUUID())).statusCode).toBe(404);
      expect((await get(medicaidClaimB)).statusCode).toBe(404); // another tenant's Medicaid claim
      expect((await get(fx.claim1)).statusCode).toBe(200); // Medicare claim still resolves through M23
      expect((await get(fx.claimB)).statusCode).toBe(404);
      await app.close();

      // outside the actor's provider entities a real Medicaid claim reads as absent, and no audit names its patient
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'claim_case_view.%'",
        [ORG],
      );
      const scoped = makeApp(["appeal.read"], { scope: [fx.pe1] });
      expect(
        (
          await scoped.inject({
            method: "GET",
            url: `/api/v1/claims/${medicaidClaimPe2}/case-view`,
          })
        ).statusCode,
      ).toBe(404);
      const leaked = await fx.admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='claim_case_view.viewed' AND context->>'patientId' IS NOT NULL",
        [ORG],
      );
      expect(leaked.rows[0].n).toBe(0);
      await scoped.close();
    });
  });
});
