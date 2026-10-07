// apps/backend/src/modules/06-admission/election-addendum/compliance.ts — the two org-explicit reads that run
// outside a request: the M23 claim-assembly snapshot (`election_addendum_signed` billing rule) and the
// overdue scan (`admission.window_alert` cron). Both are FY2027, 42 CFR 418.24(c)/(d).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  ElectionAddendumComplianceSnapshot,
  ElectionAddendumExemptionReason,
} from "@wardenx/types";
import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { AddendumOutboxPort as AdmissionWriteOutboxPort } from "./outbox-port";
import { ADDENDUM_WINDOW_KINDS, loadAddendumAdmissionFacts } from "./store";

const EA = schema.electionAddenda;
const CW = schema.complianceWindows;
const ADM = schema.admissions;
const DE = schema.dischargeEvents;
const RV = schema.revocationEvents;
const EP = schema.electionPeriods;

function leftCareReason(
  status: string,
  dischargeReason: string | null,
): ElectionAddendumExemptionReason | null {
  if (status !== "discharged" && status !== "bereavement" && status !== "closed") return null;
  if (status === "bereavement" || dischargeReason === "death") return "death";
  if (dischargeReason === "revocation") return "revocation";
  return "discharge";
}

/**
 * The addendum facts for one admission, for M23's `election_addendum_signed` rule. Org-explicit (claim
 * assembly runs in a worker). Aggregate and PHI-free: flags only.
 */
export async function electionAddendumComplianceForOrg(
  db: DbClient,
  organizationId: string,
  admissionId: string,
): Promise<ElectionAddendumComplianceSnapshot> {
  return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
    const tx = txRaw as DbClient;
    const facts = await loadAddendumAdmissionFacts(tx, admissionId);
    const versions = await tx
      .select({ status: EA.status })
      .from(EA)
      .where(eq(EA.admissionId, admissionId));
    const [discharge] = facts
      ? await tx
          .select({ reason: DE.dischargeType })
          .from(DE)
          .where(eq(DE.admissionId, admissionId))
          .orderBy(desc(DE.createdAt))
          .limit(1)
      : [];
    // Revocation and transfer-out write no `discharge_event`; a revocation leaves a `revocation_event`.
    const [revocation] =
      facts && !discharge
        ? await tx
            .select({ id: RV.id })
            .from(RV)
            .innerJoin(EP, eq(EP.id, RV.electionPeriodId))
            .where(eq(EP.admissionId, admissionId))
            .limit(1)
        : [];
    const has = (...s: string[]) => versions.some((v) => s.includes(v.status));
    return {
      admissionId,
      electionEffectiveDate: facts?.electionEffectiveDate ?? null,
      versionCount: versions.length,
      anyFurnished: has("furnished", "signed", "refused", "signature_not_required"),
      anySigned: has("signed"),
      anyRefusalDocumented: has("refused"),
      anyExemptionDocumented: has("signature_not_required", "not_required"),
      leftCareReason: facts
        ? leftCareReason(facts.status, discharge?.reason ?? (revocation ? "revocation" : null))
        : null,
    };
  });
}

/** One addendum window that has just gone overdue. */
export interface OverdueAddendumWindow {
  readonly complianceWindowId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly windowKind: (typeof ADDENDUM_WINDOW_KINDS)[number];
  readonly dueAt: string;
  readonly electionAddendumId: string | null;
}

/**
 * The overdue edge for addendum windows: every open / closing-soon addendum window past its due instant moves
 * to `overdue` (severity `alert`) and emits BOTH the generic `m6.compliance.window.overdue` and the
 * patient-routable `m6.election_addendum.overdue` M36 pages on. Runs in the caller's org tx. Idempotent: an
 * already-overdue window is not selected again, so each window alerts once.
 */
export async function markOverdueAddendumWindowsInTx(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  organizationId: string,
  now: Date,
): Promise<OverdueAddendumWindow[]> {
  const due = await tx
    .select({
      id: CW.id,
      admissionId: CW.admissionId,
      windowKind: CW.windowKind,
      mustCompleteBy: CW.mustCompleteBy,
      payload: CW.payload,
      patientId: ADM.patientId,
    })
    .from(CW)
    .innerJoin(ADM, eq(ADM.id, CW.admissionId))
    .where(
      and(
        eq(CW.organizationId, organizationId),
        inArray(CW.windowKind, [...ADDENDUM_WINDOW_KINDS]),
        inArray(CW.status, ["open", "closing_soon"]),
        lte(CW.mustCompleteBy, now),
      ),
    );
  const marked: OverdueAddendumWindow[] = [];
  for (const w of due) {
    const [moved] = await tx
      .update(CW)
      .set({ status: "overdue", severity: "alert", updatedAt: now })
      .where(and(eq(CW.id, w.id), ne(CW.status, "overdue"), ne(CW.status, "closed")))
      .returning({ id: CW.id });
    if (!moved) continue; // another tick won the edge
    const payload = (w.payload ?? {}) as { electionAddendumId?: unknown };
    const item: OverdueAddendumWindow = {
      complianceWindowId: w.id,
      admissionId: w.admissionId,
      patientId: w.patientId,
      windowKind: w.windowKind as OverdueAddendumWindow["windowKind"],
      dueAt: w.mustCompleteBy.toISOString(),
      electionAddendumId:
        typeof payload.electionAddendumId === "string" ? payload.electionAddendumId : null,
    };
    await outbox.publish(tx, {
      eventName: "m6.compliance.window.overdue",
      payload: {
        complianceWindowId: w.id,
        severity: "alert",
        admissionId: w.admissionId,
        patientId: w.patientId,
        windowKind: w.windowKind,
        dueAt: w.mustCompleteBy.toISOString(),
      },
      organizationId,
      aggregateKind: "compliance_window",
      aggregateId: w.id,
    });
    await outbox.publish(tx, {
      eventName: "m6.election_addendum.overdue",
      payload: { ...item },
      organizationId,
      aggregateKind: "compliance_window",
      aggregateId: w.id,
    });
    marked.push(item);
  }
  return marked;
}
