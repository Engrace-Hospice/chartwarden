// apps/backend/src/modules/30-quality/idg-flagged-events-for-org.ts — the org-explicit, BATCHED "fall" and
// "infection" read the M14 IDG packet's `sinceLastIdg.flaggedEvents` block needs (M14 spec §2.4 "flagged events
// (hospitalizations, ER visits, missed doses, falls, infections)").
//
// SOURCES (M30-owned): `incident_report` rows of kind `fall` (the safety-incident ledger) and
// `infection_surveillance_event` rows (per-event infection surveillance). This seam only PROJECTS them —
//   • fall      `occurredAt` = incident `occurred_at`; `severity` from the incident's own severity enum
//               (`minor`→`info`, `moderate`→`attention`, `severe`/`critical`→`urgent`). Every lifecycle state is
//               read — a fall that has not been triaged yet is still a fall the team should hear about.
//   • infection `occurredAt` = `observed_at`; `severity` is `attention` (a confirmed or suspected infection is
//               never merely informational on an IDG cover).
// Only PATIENT-scoped rows (`patient_id` in the batch) cross this seam — visitor/staff incidents and staff
// exposure events have a NULL patient and are never returned. Free text (`kind_data` narrative / witness names /
// quotes; `exposure_source`; pathogen / body site) NEVER crosses: M14's digest is an id, an enum, an instant and
// a severity. SEAM PULL at packet build; RLS scopes by `app.org_id` (both tables are org-scoped).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, inArray } from "drizzle-orm";

const INC = schema.incidentReport;
const INF = schema.infectionSurveillanceEvent;

/** A read with no acting human (the empty-GUC system convention). */
const IDG_FLAGGED_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug (an IDG caseload is dozens). */
export const IDG_QUALITY_EVENTS_MAX_PATIENTS = 500;

/** One projected fall / infection (structural twin of M14's `PacketFlaggedEventDigest`). */
export interface IdgQualityFlaggedEvent {
  readonly kind: "fall" | "infection";
  /** The M30 `incident_report.id` / `infection_surveillance_event.id` — the back-reference. */
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly severity: "info" | "attention" | "urgent";
}

/** Pure incident-severity → packet-severity rule (exported for unit tests). */
export function fallSeverity(incidentSeverity: string): IdgQualityFlaggedEvent["severity"] {
  if (incidentSeverity === "severe" || incidentSeverity === "critical") return "urgent";
  if (incidentSeverity === "moderate") return "attention";
  return "info";
}

/**
 * Falls + infections for each patient in `patientIds`, strictly AFTER `sinceIso` (the earliest §1.1 cursor in
 * the batch — M14's builder re-filters per patient). Patients with none are absent. TWO queries, never per patient.
 */
export async function idgQualityFlaggedEventsForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  sinceIso: string,
): Promise<ReadonlyMap<string, readonly IdgQualityFlaggedEvent[]>> {
  const ids = [...new Set(patientIds)];
  const out = new Map<string, IdgQualityFlaggedEvent[]>();
  if (ids.length === 0) return out;
  if (ids.length > IDG_QUALITY_EVENTS_MAX_PATIENTS) {
    throw new Error(
      `idgQualityFlaggedEventsForOrg: ${ids.length} patients exceeds the ${IDG_QUALITY_EVENTS_MAX_PATIENTS} cap`,
    );
  }
  const since = new Date(sinceIso);
  return withOrgContext(db, { organizationId, userId: IDG_FLAGGED_SYSTEM_USER_ID }, async (tx) => {
    const t = tx as unknown as DbClient;
    const push = (patientId: string | null, e: IdgQualityFlaggedEvent): void => {
      if (patientId === null) return;
      const list = out.get(patientId) ?? [];
      list.push(e);
      out.set(patientId, list);
    };
    const falls = await t
      .select({
        id: INC.id,
        patientId: INC.patientId,
        occurredAt: INC.occurredAt,
        severity: INC.severity,
      })
      .from(INC)
      .where(
        and(
          eq(INC.organizationId, organizationId),
          eq(INC.kind, "fall"),
          inArray(INC.patientId, ids),
          gt(INC.occurredAt, since),
        ),
      );
    for (const r of falls) {
      push(r.patientId, {
        kind: "fall",
        sourceId: r.id,
        occurredAt: new Date(r.occurredAt).toISOString(),
        severity: fallSeverity(r.severity),
      });
    }
    const infections = await t
      .select({ id: INF.id, patientId: INF.patientId, observedAt: INF.observedAt })
      .from(INF)
      .where(
        and(
          eq(INF.organizationId, organizationId),
          inArray(INF.patientId, ids),
          gt(INF.observedAt, since),
        ),
      );
    for (const r of infections) {
      push(r.patientId, {
        kind: "infection",
        sourceId: r.id,
        occurredAt: new Date(r.observedAt).toISOString(),
        severity: "attention",
      });
    }
    return out;
  });
}
