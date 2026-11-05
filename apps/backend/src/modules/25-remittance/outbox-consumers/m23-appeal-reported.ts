// apps/backend/src/modules/25-remittance/outbox-consumers/m23-appeal-reported.ts — M25's consumer of
// `m23.clearinghouse.appeal_reported` (ADR-0053 amendment D7): a clearinghouse (Claim.MD) told us about an appeal on a
// claim we submitted. Every report is RECORDED (payer_appeal_vendor_report, migration 1324) and billing staff are ALERTED.
//
// What a report may do to a payer appeal case is DATA, below, and deliberately small:
//   * a report for a vendor appeal already bound to a case  → an event on that case's timeline, no state change;
//   * `created` for an unbound vendor appeal whose control number names EXACTLY ONE live denial of a non-Medicare payer:
//       - that denial has an in-flight level not yet bound to a vendor appeal → LINK it;
//       - it has none → OPEN a draft level (level kind `other`, labelled unconfirmed, no derived deadline: the existing
//         `payer_appeal.no_deadline` alert then prompts staff to type the date from the notice);
//   * anything else (another word, zero or several denials, a Medicare/Medicaid payer, an unresolved payer) → recorded
//     with its reason, alert only.
// Nothing here decides, closes or withdraws a case, and no actor is invented (created_by_membership_id stays NULL).
// Idempotent on sourceEventKey; one vendor appeal binds at most one case (a partial unique index backs the advisory lock).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { canTransitionDenial, checkPayerKind } from "../domain";
import type { WorkerAlertPort } from "../jobs/cron-workers";
import { type PayerSeam, buildSeamPayerSeam } from "../routes/payer-seam";

export const M25_APPEAL_REPORTED_EVENT = "m23.clearinghouse.appeal_reported";
export const CLEARINGHOUSE_APPEAL_ALERT = "clearinghouse.appeal_reported";

/** Vendor words that may open or link a case. Exact, lower-case. Every other word only records and alerts. */
const CASE_OPENING_WORDS: ReadonlySet<string> = new Set(["created"]);
const VENDOR_LABELS: Readonly<Record<string, string>> = { claimmd: "Claim.MD" };
const IN_FLIGHT = ["draft", "submitted", "under_review"] as const;
const VENDOR_APPEAL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

type Disposition = "opened" | "linked" | "timeline" | "recorded_only";
type Reason =
  | "no_denial"
  | "several_denials"
  | "medicare_payer"
  | "medicaid_payer"
  | "no_payer_advice"
  | "payer_unresolved"
  | "no_vendor_appeal_id"
  | "not_linked"
  | "linked_elsewhere";

const REFUSAL_REASON: Readonly<Record<string, Reason>> = {
  MEDICARE_PAYER: "medicare_payer",
  MEDICAID_PAYER: "medicaid_payer",
  NO_PAYER_ADVICE: "no_payer_advice",
};

export interface M25AppealReportConsumerDeps {
  readonly db: DbClient;
  readonly payers?: PayerSeam;
  readonly alerts?: WorkerAlertPort;
  readonly onSkipped?: (info: {
    readonly reason: "unreadable_payload";
    readonly organizationId: string;
  }) => void;
  /** The report is already committed, so a failed notice is logged, not retried (a retry would find a duplicate). */
  readonly onAlertFailed?: (info: {
    readonly organizationId: string;
    readonly error: string;
  }) => void;
}

interface Report {
  readonly sourceEventKey: string;
  readonly providerEntityId: string;
  readonly vendor: string;
  readonly vendorStatus: string;
  readonly controlNumber: string;
  readonly vendorAppealId: string | null;
  readonly reportedAt: Date;
}

interface Outcome {
  readonly disposition: Disposition;
  readonly reason: Reason | null;
  readonly payerAppealCaseId: string | null;
  readonly denialCaseId: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function reportOf(payload: unknown): Report | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const sourceEventKey = str(p.sourceEventKey);
  const providerEntityId = str(p.providerEntityId);
  const vendor = str(p.vendor);
  const vendorStatus = str(p.vendorStatus);
  const controlNumber = str(p.controlNumber);
  const reportedAt = str(p.reportedAt);
  if (
    !sourceEventKey ||
    !providerEntityId ||
    !vendor ||
    !vendorStatus ||
    !controlNumber ||
    !reportedAt
  )
    return null;
  const appealId = str(p.vendorAppealId);
  return {
    sourceEventKey,
    providerEntityId,
    vendor,
    vendorStatus,
    controlNumber,
    vendorAppealId: appealId && VENDOR_APPEAL_ID_RE.test(appealId) ? appealId : null,
    reportedAt: new Date(reportedAt),
  };
}

export function buildM25AppealReportConsumer(
  deps: M25AppealReportConsumerDeps,
): OutboxConsumerBinding {
  const payers = deps.payers ?? buildSeamPayerSeam();
  const PC = schema.payerAppealCase;
  const PE = schema.payerAppealCaseEvent;
  const VR = schema.payerAppealVendorReport;
  const DC = schema.denialCase;
  const RL = schema.remittanceLine;
  const RA = schema.remittanceAdvice;

  async function apply(
    tx: DbClient,
    organizationId: string,
    r: Report,
  ): Promise<Outcome | "duplicate"> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`m25.vendor_appeal:${organizationId}:${r.vendor}:${r.vendorAppealId ?? r.controlNumber}`}))`,
    );
    const seen = await tx
      .select({ id: VR.id })
      .from(VR)
      .where(eq(VR.sourceEventKey, r.sourceEventKey))
      .limit(1);
    if (seen[0]) return "duplicate";
    const timeline = (caseId: string, kind: string) =>
      tx.insert(PE).values({
        organizationId,
        payerAppealCaseId: caseId,
        eventKind: kind,
        eventPayload: {
          source: r.vendor,
          vendorAppealId: r.vendorAppealId,
          vendorStatus: r.vendorStatus,
        },
      });
    const record = async (o: Outcome): Promise<Outcome> => {
      await tx.insert(VR).values({
        organizationId,
        providerEntityId: r.providerEntityId,
        sourceEventKey: r.sourceEventKey,
        vendor: r.vendor,
        vendorAppealId: r.vendorAppealId,
        vendorStatus: r.vendorStatus,
        controlNumber: r.controlNumber,
        denialCaseId: o.denialCaseId,
        payerAppealCaseId: o.payerAppealCaseId,
        disposition: o.disposition,
        reason: o.reason,
        reportedAt: r.reportedAt,
      });
      return o;
    };
    const only = (reason: Reason, denialCaseId: string | null = null) =>
      record({ disposition: "recorded_only", reason, payerAppealCaseId: null, denialCaseId });

    if (!r.vendorAppealId) return only("no_vendor_appeal_id");
    const [bound] = await tx
      .select({ caseId: VR.payerAppealCaseId, denialCaseId: VR.denialCaseId })
      .from(VR)
      .where(
        and(
          eq(VR.vendor, r.vendor),
          eq(VR.vendorAppealId, r.vendorAppealId),
          inArray(VR.disposition, ["opened", "linked"]),
        ),
      )
      .limit(1);
    if (bound?.caseId) {
      await timeline(bound.caseId, "vendor_reported");
      return record({
        disposition: "timeline",
        reason: null,
        payerAppealCaseId: bound.caseId,
        denialCaseId: bound.denialCaseId,
      });
    }
    if (!CASE_OPENING_WORDS.has(r.vendorStatus)) return only("not_linked");

    const denials = await tx
      .select({ denial: DC, payerId: RA.payerId, payerKind: RA.payerKind })
      .from(DC)
      .innerJoin(RL, eq(RL.id, DC.remittanceLineId))
      .innerJoin(RA, eq(RA.id, RL.remittanceAdviceId))
      .where(
        and(
          eq(RL.clp01PatientControlNumber, r.controlNumber),
          eq(DC.providerEntityId, r.providerEntityId),
          ne(DC.state, "closed"),
        ),
      )
      .limit(2);
    if (denials.length === 0) return only("no_denial");
    if (denials.length > 1) return only("several_denials");
    const { denial, payerId, payerKind } = denials[0]!;
    const refusal = checkPayerKind(payerKind);
    if (refusal) return only(REFUSAL_REASON[refusal] ?? "no_payer_advice", denial.id);

    const [inFlight] = await tx
      .select({ id: PC.id })
      .from(PC)
      .where(and(eq(PC.denialCaseId, denial.id), inArray(PC.state, [...IN_FLIGHT])))
      .limit(1);
    if (inFlight) {
      const [other] = await tx
        .select({ id: VR.id })
        .from(VR)
        .where(
          and(eq(VR.payerAppealCaseId, inFlight.id), inArray(VR.disposition, ["opened", "linked"])),
        )
        .limit(1);
      if (other) return only("linked_elsewhere", denial.id);
      await timeline(inFlight.id, "vendor_linked");
      return record({
        disposition: "linked",
        reason: null,
        payerAppealCaseId: inFlight.id,
        denialCaseId: denial.id,
      });
    }

    // The program from the payer directory, as the staff `open` derives it; a payer it cannot resolve is not guessed.
    const payer = await payers.resolve(organizationId, payerId);
    if (!payer) return only("payer_unresolved", denial.id);
    if (payer.kind === "medicare") return only("medicare_payer", denial.id);
    if (payer.kind === "medicaid") return only("medicaid_payer", denial.id);
    const program = payer.kind === "medicare_advantage" ? "medicare_advantage" : "commercial";
    const [opened] = await tx
      .insert(PC)
      .values({
        organizationId,
        providerEntityId: denial.providerEntityId,
        denialCaseId: denial.id,
        claimId: denial.claimId,
        payerId,
        program,
        levelKind: "other",
        levelLabel: `${VENDOR_LABELS[r.vendor] ?? r.vendor} appeal (unconfirmed)`,
        state: "draft",
        deadlineSource: "none",
        windowVerified: false,
        createdByMembershipId: null,
      })
      .returning({ id: PC.id });
    const caseId = opened!.id;
    await tx.insert(PE).values({
      organizationId,
      payerAppealCaseId: caseId,
      eventKind: "created",
      eventPayload: {
        source: r.vendor,
        vendorAppealId: r.vendorAppealId,
        levelOrdinal: null,
        deadlineSource: "none",
      },
    });
    if (canTransitionDenial(denial.state, "appealed")) {
      await tx
        .update(DC)
        .set({ state: "appealed", version: denial.version + 1 })
        .where(and(eq(DC.id, denial.id), eq(DC.version, denial.version)));
    }
    return record({
      disposition: "opened",
      reason: null,
      payerAppealCaseId: caseId,
      denialCaseId: denial.id,
    });
  }

  return {
    consumerName: "m25.m23-appeal-reported",
    consumerModule: "m25",
    eventTypes: [M25_APPEAL_REPORTED_EVENT],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      if (event.eventType !== M25_APPEAL_REPORTED_EVENT) return;
      const r = reportOf(event.payload);
      const organizationId = event.organizationId;
      if (!r) {
        deps.onSkipped?.({ reason: "unreadable_payload", organizationId });
        return;
      }
      const outcome = await withOrgContext(deps.db, { organizationId, userId: "" }, (scoped) =>
        apply(scoped as unknown as DbClient, organizationId, r),
      );
      if (outcome === "duplicate") return;
      // Ids and closed-set words only.
      await deps.alerts
        ?.dispatch({
          alertCode: CLEARINGHOUSE_APPEAL_ALERT,
          severity: outcome.disposition === "recorded_only" ? "warn" : "info",
          organizationId,
          payload: {
            providerEntityId: r.providerEntityId,
            sourceEventKey: r.sourceEventKey,
            vendorStatus: r.vendorStatus,
            disposition: outcome.disposition,
            reason: outcome.reason,
            payerAppealCaseId: outcome.payerAppealCaseId,
            denialCaseId: outcome.denialCaseId,
          },
        })
        .catch((err: unknown) =>
          deps.onAlertFailed?.({
            organizationId,
            error: err instanceof Error ? err.name : "unknown",
          }),
        );
    },
  };
}
