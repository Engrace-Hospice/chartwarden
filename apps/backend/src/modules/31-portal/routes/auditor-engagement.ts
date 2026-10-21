// apps/backend/src/modules/31-portal/routes/auditor-engagement.ts — GAP-093(d): the auditor engagement view.
//
// The route names an ENGAGEMENT, not a patient. The handler used to pass that engagement id straight to
// `engagementForPatient` as if it were a patient id, so it read the aggregates of a patient that does not
// exist. Here the engagement is resolved through M3's published `AuditorEngagementReader.engagementScope`
// (which re-checks org / `active` / window itself) into the set of patients it covers, and ONLY those
// patients' aggregates are read and summed. Nothing outside the engagement's coverage is ever queried.
import type { EngagementCoverage } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import type { PortalStore } from "./store";

/** The slice of M3's `AuditorEngagementReader` this view needs (structural — no cross-module import). */
export interface EngagementCoverageReader {
  engagementScope(input: {
    organizationId: string;
    engagementId: string;
    auditorUserId: string;
    at: string;
  }): Promise<EngagementCoverage | null>;
}

export interface AuditorEngagementView {
  hasActiveAccount: boolean;
  daysActive: number;
  lastViewedAt: string | null;
  messagesSent: number;
  documentsViewed: number;
  amendmentsSubmitted: number;
  administrationsAttested: number;
}

/** The look-back window (days) the per-patient engagement aggregates are computed over. */
export const AUDITOR_VIEW_WINDOW_DAYS = 90;

/** The production reader: M3's published seam, resolved at request time (unbound ⇒ the deny-stub throws). */
export const seamEngagementReader: EngagementCoverageReader = {
  engagementScope: (input) => getSeam("AuditorEngagementReader").engagementScope(input),
};

/** Patients read concurrently per batch (the per-patient resolver is one query each). */
const PATIENT_BATCH = 25;

const EMPTY_VIEW: AuditorEngagementView = {
  hasActiveAccount: false,
  daysActive: 0,
  lastViewedAt: null,
  messagesSent: 0,
  documentsViewed: 0,
  amendmentsSubmitted: 0,
  administrationsAttested: 0,
};

export interface ResolveAuditorEngagementInput {
  readonly organizationId: string;
  readonly engagementId: string;
  readonly auditorUserId: string;
  readonly at: Date;
  readonly windowDays: number;
  readonly reader: EngagementCoverageReader;
  readonly store: Pick<PortalStore, "engagement" | "grants">;
}

/**
 * The covered patients' engagement, summed — or `null` when the engagement is not live for this auditor
 * (the caller answers 403). A reader failure propagates (the caller fails closed).
 */
export async function resolveAuditorEngagementView(
  input: ResolveAuditorEngagementInput,
): Promise<AuditorEngagementView | null> {
  const coverage = await input.reader.engagementScope({
    organizationId: input.organizationId,
    engagementId: input.engagementId,
    auditorUserId: input.auditorUserId,
    at: input.at.toISOString(),
  });
  if (!coverage) return null;

  const patients = new Set<string>(coverage.patientIds);
  if (coverage.tenantWide) {
    const granted = await input.store.grants.patientsWithActiveGrantsInOrg(
      input.organizationId as never,
      input.at.toISOString() as never,
    );
    for (const g of granted) patients.add(g.patientId);
  }
  const ids = [...patients];

  let view: AuditorEngagementView = EMPTY_VIEW;
  for (let i = 0; i < ids.length; i += PATIENT_BATCH) {
    const rows = await Promise.all(
      ids
        .slice(i, i + PATIENT_BATCH)
        .map((patientId) =>
          input.store.engagement.engagementForPatient(
            input.organizationId as never,
            patientId as never,
            input.windowDays,
          ),
        ),
    );
    for (const r of rows) view = addPatient(view, r);
  }
  return view;
}

function addPatient(
  acc: AuditorEngagementView,
  r: {
    hasActiveAccount: boolean;
    daysActive: number;
    lastViewedAt: string | null;
    messagesSent: number;
    documentsViewed: number;
    amendmentsSubmitted: number;
    administrationsAttested: number;
  },
): AuditorEngagementView {
  const lastViewedAt =
    r.lastViewedAt !== null && (acc.lastViewedAt === null || r.lastViewedAt > acc.lastViewedAt)
      ? r.lastViewedAt
      : acc.lastViewedAt;
  return {
    hasActiveAccount: acc.hasActiveAccount || r.hasActiveAccount,
    daysActive: Math.max(acc.daysActive, r.daysActive),
    lastViewedAt,
    messagesSent: acc.messagesSent + r.messagesSent,
    documentsViewed: acc.documentsViewed + r.documentsViewed,
    amendmentsSubmitted: acc.amendmentsSubmitted + r.amendmentsSubmitted,
    administrationsAttested: acc.administrationsAttested + r.administrationsAttested,
  };
}
