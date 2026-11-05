/**
 * M25 Claim.MD appeal reports (migration 1324, ADR-0053 amendment D7) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`.
 *
 * `m23.clearinghouse.appeal_reported`, published through the REAL catalog-validating publisher and delivered by the REAL
 * dispatcher into M25's consumer:
 *   - `created` + exactly one live commercial denial with that control number and no in-flight level -> a DRAFT level (kind
 *     `other`, labelled unconfirmed, no deadline, no invented actor), the denial moves to `appealed`, one alert, ids only;
 *   - a redelivery changes nothing; a later word for the bound appeal is a timeline event, never a state change;
 *   - an existing in-flight level is LINKED, not duplicated;
 *   - zero or several denials, a Medicare payer, an unbound appeal's other word, another tenant -> recorded + alerted only.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:appeal-reports:live
 * (SUPERUSER to a THROWAWAY db on a PRIVATE pgvector/pgvector:pg18 - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { withOrgContext } from "@chartwarden/tenancy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import {
  CLEARINGHOUSE_APPEAL_ALERT,
  M25_OUTBOX_EVENTS,
  buildM25AppealReportConsumer,
} from "../src/modules/25-remittance/index";
import type { PayerSeam } from "../src/modules/25-remittance/routes/payer-seam";
import { type M7Fixture, ORG, ORG_B, setupM7Fixture } from "./_m25-m7-fixture";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("M25 Claim.MD appeal reports - LIVE Postgres", () => {
  let fx: M7Fixture;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  const commercial = randomUUID();
  const medicare = randomUUID();
  const payers: PayerSeam = {
    resolve: async (_org, id) =>
      id === commercial
        ? { id, name: "Synthetic Commercial", kind: "commercial" }
        : id === medicare
          ? { id, name: "Synthetic Medicare", kind: "medicare" }
          : null,
  };
  const alerts: {
    alertCode: string;
    severity: string;
    organizationId: string;
    payload: Record<string, unknown>;
  }[] = [];
  let seq = 0;

  /** A denial seeded from an 835 line carrying `controlNumber` as CLP01. */
  async function denial(
    controlNumber: string,
    payerKind: "commercial" | "medicare" = "commercial",
    org = ORG,
  ) {
    seq += 1;
    const pe = org === ORG ? fx.pe1 : fx.peB;
    const advice = (
      await fx.admin.query(
        `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
           interchange_control_number, transaction_set_control_number, check_or_eft_trace_number, payment_method,
           total_payment_amount, production_date, minio_object_key, file_sha256, parse_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'eft',0, now(),'k',$8,'partial_posted') RETURNING id, received_at`,
        [
          org,
          pe,
          payerKind === "commercial" ? commercial : medicare,
          payerKind,
          `9324${seq}`,
          `1324${seq}`,
          `TRC324${seq}`,
          "0".repeat(64),
        ],
      )
    ).rows[0];
    const line = (
      await fx.admin.query(
        `INSERT INTO remittance_line (organization_id, remittance_advice_id, clp01_patient_control_number, clp07_payer_icn,
           clp02_status_code, clp03_total_charge_amount, clp04_total_payment_amount,
           clp05_patient_responsibility_amount, match_state, received_at)
         VALUES ($1,$2,$3,$4,4,100,0,0,'unmatched',$5) RETURNING id`,
        [org, advice.id, controlNumber, `ICN-324-${seq}`, advice.received_at],
      )
    ).rows[0].id as string;
    return (
      await fx.admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, remittance_line_id, source_evv_aggregator_submission_id,
           carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,'50','denial','evv_aggregator_rejection','escalated',10,'mapped') RETURNING id`,
        [org, pe, line, randomUUID()],
      )
    ).rows[0].id as string;
  }

  async function report(o: {
    controlNumber: string;
    appealId?: string | null;
    word?: string;
    org?: string;
    key?: string;
  }): Promise<string> {
    const org = o.org ?? ORG;
    const pe = org === ORG ? fx.pe1 : fx.peB;
    const key = o.key ?? `test:99999:a${++seq}`;
    await withOrgContext(fx.handle.db, { organizationId: org, userId: "" }, async (tx) => {
      await publisher.publish(tx as never, {
        eventName: "m23.clearinghouse.appeal_reported",
        organizationId: org,
        aggregateKind: "clearinghouse_report",
        aggregateId: pe,
        callerModule: "m23",
        payload: {
          sourceEventKey: key,
          usage: "test",
          vendor: "claimmd",
          providerEntityId: pe,
          vendorStatus: o.word ?? "created",
          reportedAt: "2026-11-05T12:00:00.000Z",
          eventTime: null,
          controlNumber: o.controlNumber,
          vendorAppealId: o.appealId === undefined ? `AP-${seq}` : o.appealId,
          appealType: "electronic",
        },
      });
    });
    await dispatcher.tick();
    return key;
  }
  const reportRow = async (key: string) =>
    (
      await fx.admin.query("SELECT * FROM payer_appeal_vendor_report WHERE source_event_key = $1", [
        key,
      ])
    ).rows[0];
  const casesOf = async (denialId: string) =>
    (await fx.admin.query("SELECT * FROM payer_appeal_case WHERE denial_case_id = $1", [denialId]))
      .rows;
  const eventsOf = async (caseId: string) =>
    (
      await fx.admin.query(
        "SELECT event_kind, actor_membership_id FROM payer_appeal_case_event WHERE payer_appeal_case_id = $1 ORDER BY occurred_at",
        [caseId],
      )
    ).rows;

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-cmd");
    const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M25_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: fx.handle.db,
      orgs,
      eventCatalog: catalog,
      consumers: [
        buildM25AppealReportConsumer({
          db: fx.handle.db,
          payers,
          alerts: {
            dispatch: async (a) => {
              alerts.push(a);
            },
          },
        }),
      ],
    });
  }, 600_000);

  beforeEach(() => {
    alerts.length = 0;
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("opens one unconfirmed draft level from `created`, moves the denial to appealed, and alerts with ids only", async () => {
    const d = await denial("CN-1");
    const key = await report({ controlNumber: "CN-1", appealId: "AP-OPEN" });
    const [c, ...more] = await casesOf(d);
    expect(more).toHaveLength(0);
    expect(c).toMatchObject({
      state: "draft",
      level_kind: "other",
      level_label: "Claim.MD appeal (unconfirmed)",
      deadline_source: "none",
      deadline_at: null,
      program: "commercial",
      payer_id: commercial,
      created_by_membership_id: null,
    });
    expect((await eventsOf(c.id)).map((e) => [e.event_kind, e.actor_membership_id])).toEqual([
      ["created", null],
    ]);
    expect(
      (await fx.admin.query("SELECT state FROM denial_case WHERE id = $1", [d])).rows[0].state,
    ).toBe("appealed");
    expect(await reportRow(key)).toMatchObject({
      disposition: "opened",
      payer_appeal_case_id: c.id,
      denial_case_id: d,
    });
    expect(alerts).toEqual([
      {
        alertCode: CLEARINGHOUSE_APPEAL_ALERT,
        severity: "info",
        organizationId: ORG,
        payload: {
          providerEntityId: fx.pe1,
          sourceEventKey: key,
          vendorStatus: "created",
          disposition: "opened",
          reason: null,
          payerAppealCaseId: c.id,
          denialCaseId: d,
        },
      },
    ]);

    // A redelivery changes nothing and alerts nobody.
    await report({ controlNumber: "CN-1", appealId: "AP-OPEN", key });
    expect(await casesOf(d)).toHaveLength(1);
    expect(alerts).toHaveLength(1);

    // A later word for the bound appeal is a timeline event only: the level stays a draft.
    const later = await report({ controlNumber: "CN-1", appealId: "AP-OPEN", word: "in_review" });
    expect(await reportRow(later)).toMatchObject({
      disposition: "timeline",
      payer_appeal_case_id: c.id,
    });
    expect((await eventsOf(c.id)).map((e) => e.event_kind)).toEqual(["created", "vendor_reported"]);
    expect((await casesOf(d))[0]?.state).toBe("draft");
  });

  it("links an in-flight level the staff opened instead of opening a second", async () => {
    const d = await denial("CN-2");
    const staffCase = (
      await fx.admin.query(
        `INSERT INTO payer_appeal_case (organization_id, provider_entity_id, denial_case_id, payer_id, program, level_kind, level_label)
         VALUES ($1,$2,$3,$4,'commercial','internal','First level') RETURNING id`,
        [ORG, fx.pe1, d, commercial],
      )
    ).rows[0].id as string;
    const key = await report({ controlNumber: "CN-2", appealId: "AP-LINK" });
    expect(await casesOf(d)).toHaveLength(1);
    expect(await reportRow(key)).toMatchObject({
      disposition: "linked",
      payer_appeal_case_id: staffCase,
    });
    expect((await eventsOf(staffCase)).map((e) => e.event_kind)).toEqual(["vendor_linked"]);
  });

  it("records and alerts only: no denial, several denials, a Medicare payer, another word, another tenant", async () => {
    const none = await report({ controlNumber: "CN-NONE" });
    await denial("CN-DUP");
    await denial("CN-DUP");
    const several = await report({ controlNumber: "CN-DUP" });
    const md = await denial("CN-MCR", "medicare");
    const mcr = await report({ controlNumber: "CN-MCR" });
    const cd = await denial("CN-WORD");
    const word = await report({ controlNumber: "CN-WORD", word: "approved" });
    // Org B reports org A's control number: org B has no such denial, and org A's is untouched.
    const cross = await report({ controlNumber: "CN-WORD", org: ORG_B });
    const reasons = await Promise.all([none, several, mcr, word, cross].map(reportRow));
    expect(reasons.map((r) => [r.disposition, r.reason])).toEqual([
      ["recorded_only", "no_denial"],
      ["recorded_only", "several_denials"],
      ["recorded_only", "medicare_payer"],
      ["recorded_only", "not_linked"],
      ["recorded_only", "no_denial"],
    ]);
    expect(await casesOf(md)).toHaveLength(0);
    expect(await casesOf(cd)).toHaveLength(0);
    expect(alerts.map((a) => [a.severity, a.payload.disposition])).toEqual(
      Array.from({ length: 5 }, () => ["warn", "recorded_only"]),
    );
    expect(alerts.every((a) => !JSON.stringify(a).includes("CN-"))).toBe(true); // no control number in a notice
  });
});
