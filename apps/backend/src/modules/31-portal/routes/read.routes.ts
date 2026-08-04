// apps/backend/src/modules/31-portal/routes/read.routes.ts — M31 (§4.1) the portal lay-language READ
// surfaces. Every route runs under a portal session class, gates on its §4.6 key + the §4.7
// `portal_grant_active_for_patient` predicate (patient taken from the SESSION, never `?patientId=`), and
// declares `auditRead` so M4 writes the §164.528 `portal.view` disclosure row automatically.
//
// The lay projections come from `../read-surfaces/resolve.ts` — each resolver reads the DEDICATED upstream
// portal-summary seam OPAQUELY (`getSeam`) and fails CLOSED to an empty view on any outage. The surfaces
// whose upstream module has not yet published a portal-summary arm (M7 care-plan, M15 discipline, M8 visit
// history, M9 trend, M10 HOPE, M11 orders, M21 supplies, M40 grief) resolve their seam through a LOCAL
// structural shape with an OPTIONAL method, so a missing arm yields the empty lay view rather than a type
// error or a leak (D17). No route reads a raw clinical field.
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import {
  resolveAdministrationList,
  resolveBereavementScope,
  resolveDashboard,
  resolveDocumentList,
  resolveMedicationList,
  resolveTriageList,
  resolveVisitList,
} from "../read-surfaces/resolve";
import { type M31Actor, actorOf, portalAccountIdOf, portalPatientIdOf } from "./actor";
import { rejectOffsetPagination } from "./concurrency";
import { ABAC_ACCOUNT, ABAC_BEREAVED, ABAC_GRANT, P } from "./guards";
import type { PortalRouteDeps } from "./index";
import { WithinQuery, parseQuery } from "./portal-typebox";

const NO_OFFSET = rejectOffsetPagination();
const PHI = (resourceKind: string, list = true) => ({ auditRead: { resourceKind, list } });
const within = (q: unknown, def: number): number =>
  (parseQuery(WithinQuery, q).within ?? def) as number;

/** A per-patient lay-summary arm an upstream portal seam MAY publish (optional → fail-closed empty view). */
interface PortalPatientLayArm {
  portalSummaryForPatient?(orgId: string, patientId: string): Promise<unknown[]>;
  portalHistoryForPatient?(orgId: string, patientId: string): Promise<unknown[]>;
  portalTrendForPatient?(orgId: string, patientId: string): Promise<unknown[]>;
  portalTimepointsForPatient?(orgId: string, patientId: string): Promise<unknown[]>;
  getPortalOrderSummary?(orgId: string, patientId: string): Promise<unknown[]>;
  getPortalDeliveryView?(orgId: string, patientId: string): Promise<unknown[]>;
  portalSummary?(
    orgId: string,
    patientId: string,
  ): Promise<{ category: string; problems: unknown[]; redacted: boolean }>;
}
interface MessagingArm {
  syncCareTeamChannel?(orgId: string, patientId: string): Promise<{ channelId: string }>;
  openChannel(
    orgId: string,
    spec: { kind: string; subjectId?: string; creatorUserId: string },
  ): Promise<{ channelId: string }>;
}
interface DocumentDownloadArm {
  mintPortalDownloadUrl?(input: {
    organizationId: string;
    patientId: string;
    documentId: string;
  }): Promise<{ url: string; expiresAt: string }>;
}
/** Resolve a seam by name (raw — some upstream portal arms are not typed in `SeamContracts`; the name is in
 *  M31_REQUIRED_SEAMS so the fitness-gaps registry check covers it). */
const arm = <T>(name: string): T => (getSeam as unknown as (n: string) => unknown)(name) as T;

/** Fail-closed empty lay list from an OPTIONAL upstream arm (`?.()` yields `Promise|undefined`). */
async function layList(
  category: string,
  fn: () => Promise<unknown[]> | undefined,
): Promise<{ category: string; items: unknown[] }> {
  try {
    const result = fn();
    return { category, items: result ? ((await result) ?? []) : [] };
  } catch {
    return { category, items: [] };
  }
}

export function registerPortalReadRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  // care summary — the home view (aggregate of upstream reader seams; lay DTO).
  app.get(
    "/api/v1/portal/care-summary",
    {
      preHandler: [P("portal.care_summary.read"), ABAC_GRANT("portal.care_summary.read")],
      config: PHI("portal_care_summary", false),
    },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const dash = await resolveDashboard(actor.organizationId, patientId, now().getTime());
      return {
        patient: { layLabel: dash?.displayName ?? "Your family member" },
        upcomingVisitsCount: dash?.counts.upcomingVisits ?? 0,
        recentVisitsCount: 0,
        activeMedicationsCount: dash?.counts.activeMedications ?? 0,
        unreadMessagesCount: 0,
        pendingDocumentSharesCount: dash?.counts.unreadDocuments ?? 0,
      };
    },
  );

  // care-plan lay summary (M7 §5.4 — no dedicated portal reader yet, fail-closed).
  app.get(
    "/api/v1/portal/care-plan/summary",
    {
      preHandler: [P("portal.care_plan.read_summary"), ABAC_GRANT("portal.care_plan.read_summary")],
      config: PHI("portal_care_plan", false),
    },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      try {
        const summary = await arm<PortalPatientLayArm>("CarePlanReader").portalSummary?.(
          actor.organizationId,
          patientId,
        );
        if (summary) return summary;
      } catch {
        /* fail closed */
      }
      return { category: "care_plan", problems: [], redacted: false };
    },
  );

  // discipline-plan lay summaries (M15 §5.3).
  app.get(
    "/api/v1/portal/discipline-plans/summary",
    opts("portal.discipline_plans.read_summary", "portal_discipline_plan"),
    async (request) => {
      const a = actorOf(request);
      return layList("care_plan", () =>
        arm<PortalPatientLayArm>("DisciplinePlanReader").portalSummaryForPatient?.(
          a.organizationId,
          portalPatientIdOf(a),
        ),
      );
    },
  );

  // upcoming visits (M17 PortalVisitReader).
  app.get(
    "/api/v1/portal/visits/upcoming",
    opts("portal.visits.read_upcoming", "portal_visit"),
    async (request) => {
      const a = actorOf(request);
      return resolveVisitList(a.organizationId, portalPatientIdOf(a), within(request.query, 168));
    },
  );

  // visit history (M8 SignedEncountersReader, lay DTO).
  app.get(
    "/api/v1/portal/visits/history",
    opts("portal.visits.read_history", "portal_visit"),
    async (request) => {
      const a = actorOf(request);
      return layList("visits", () =>
        arm<PortalPatientLayArm>("SignedEncountersReader").portalHistoryForPatient?.(
          a.organizationId,
          portalPatientIdOf(a),
        ),
      );
    },
  );

  // active medications (M12 getPortalMedicationSummary).
  app.get(
    "/api/v1/portal/medications/active",
    opts("portal.medications.read_summary", "portal_medication"),
    async (request) => {
      const a = actorOf(request);
      return resolveMedicationList(a.organizationId, portalPatientIdOf(a));
    },
  );

  // recent administrations (M13 getPortalAdministrationSummary).
  app.get(
    "/api/v1/portal/administrations/recent",
    opts("portal.administrations.read_summary", "portal_administration"),
    async (request) => {
      const a = actorOf(request);
      return resolveAdministrationList(a.organizationId, portalPatientIdOf(a), now().toISOString());
    },
  );

  // symptom trend (M9 ScaleSeriesProvider).
  app.get(
    "/api/v1/portal/assessments/trend",
    opts("portal.assessments.read_trend", "portal_assessment"),
    async (request) => {
      const a = actorOf(request);
      return layList("assessments", () =>
        arm<PortalPatientLayArm>("ScaleSeriesProvider").portalTrendForPatient?.(
          a.organizationId,
          portalPatientIdOf(a),
        ),
      );
    },
  );

  // HOPE patient-facing subset (M10 HopeTimepointProvider).
  app.get(
    "/api/v1/portal/hope/timepoints",
    opts("portal.hope.read_summary", "portal_hope"),
    async (request) => {
      const a = actorOf(request);
      return layList("assessments", () =>
        arm<PortalPatientLayArm>("HopeTimepointProvider").portalTimepointsForPatient?.(
          a.organizationId,
          portalPatientIdOf(a),
        ),
      );
    },
  );

  // non-medication orders (M11 getPortalOrderSummary).
  app.get(
    "/api/v1/portal/orders/non-medication",
    opts("portal.orders.read_summary", "portal_order"),
    async (request) => {
      const a = actorOf(request);
      return layList("care_plan", () =>
        arm<PortalPatientLayArm>("OrderProvider").getPortalOrderSummary?.(
          a.organizationId,
          portalPatientIdOf(a),
        ),
      );
    },
  );

  // upcoming supplies (M21 getPortalDeliveryView).
  app.get(
    "/api/v1/portal/supplies/upcoming",
    opts("portal.supplies.read_upcoming", "portal_supply"),
    async (request) => {
      const a = actorOf(request);
      return layList("supplies", () =>
        arm<PortalPatientLayArm>("SupplyFulfillmentProvider").getPortalDeliveryView?.(
          a.organizationId,
          portalPatientIdOf(a),
        ),
      );
    },
  );

  // triage call log + own (M19 portal reader).
  app.get(
    "/api/v1/portal/triage-entries",
    opts("portal.triage.read_log", "portal_triage"),
    async (request) => {
      const a = actorOf(request);
      return resolveTriageList(a.organizationId, portalPatientIdOf(a), within(request.query, 168));
    },
  );
  app.get(
    "/api/v1/portal/triage-entries/me",
    opts("portal.triage.read_own", "portal_triage"),
    async (request) => {
      const a = actorOf(request);
      return resolveTriageList(a.organizationId, portalPatientIdOf(a), within(request.query, 168));
    },
  );

  // documents list (M22 PortalDocumentReader).
  app.get(
    "/api/v1/portal/documents",
    opts("portal.documents.read_list", "portal_document"),
    async (request) => {
      const a = actorOf(request);
      return resolveDocumentList(a.organizationId, portalPatientIdOf(a));
    },
  );

  // document download url (M22 mintPortalDownloadUrl — 60-min watermarked).
  app.get(
    "/api/v1/portal/documents/:documentId/download-url",
    {
      preHandler: [P("portal.documents.download"), ABAC_GRANT("portal.documents.download")],
      config: PHI("portal_document", false),
    },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const { documentId } = request.params as { documentId: string };
      try {
        const minted = await arm<DocumentDownloadArm>(
          "PortalDocumentReader",
        ).mintPortalDownloadUrl?.({
          organizationId: actor.organizationId,
          patientId,
          documentId,
        });
        if (minted) return { url: minted.url, expiresAt: minted.expiresAt };
      } catch {
        /* fail closed */
      }
      return { url: "", expiresAt: now().toISOString() };
    },
  );

  // secure-message channel pointer (M36 — the bodies are M36's GET; membership reconciled here).
  app.get(
    "/api/v1/portal/messages/channel",
    {
      preHandler: [P("portal.messages.read_channel"), ABAC_GRANT("portal.messages.read_channel")],
      config: PHI("portal_message", false),
    },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      try {
        const provider = arm<MessagingArm>("MessagingProvider");
        await provider.syncCareTeamChannel?.(actor.organizationId, patientId);
        const channel = await provider.openChannel(actor.organizationId, {
          kind: "care_team",
          subjectId: patientId,
          creatorUserId: actor.userId,
        });
        return { channelId: channel.channelId, lastReadPointer: null };
      } catch {
        return { channelId: "", lastReadPointer: null };
      }
    },
  );

  // notification preferences (read) — M31 owns no preference table; reconciled against M36 availability.
  app.get(
    "/api/v1/portal/notification-preferences",
    {
      preHandler: [P("portal.preferences.read_own"), ABAC_ACCOUNT("portal.preferences.read_own")],
      config: {
        auditRead: {
          none: "static default notification-preference stub; M31 owns no preference table, no patient data",
        },
      },
    },
    async (request) => {
      actorOf(request);
      return {
        channels: [
          { channel: "email", enabled: true },
          { channel: "sms", enabled: false },
          { channel: "push", enabled: false },
        ],
      };
    },
  );

  // bereavement program overview (M16 BereavementPlanProvider.publicView) — window-gated.
  app.get(
    "/api/v1/portal/bereavement/program",
    {
      preHandler: [
        P("portal.bereavement.read_program"),
        ABAC_BEREAVED("portal.bereavement.read_program"),
      ],
      config: PHI("portal_bereavement", false),
    },
    async (request) => {
      const actor = actorOf(request);
      return resolveBereavementScope(actor.organizationId, portalAccountIdOf(actor));
    },
  );

  // bereavement resources (M40 grief resources + M22 tenant catalog).
  app.get(
    "/api/v1/portal/bereavement/resources",
    {
      preHandler: [
        P("portal.bereavement.read_resources"),
        ABAC_BEREAVED("portal.bereavement.read_resources"),
        NO_OFFSET,
      ],
      config: PHI("portal_bereavement"),
    },
    async (request) => {
      const actor = actorOf(request);
      // TASK-015/ARCH-018 — a real, registered seam now (deny-stub until M40 builds the catalog); a
      // typed direct call, not the `arm()` cast-and-hope indirection. `layList`'s catch-to-empty-200
      // would make "the catalog doesn't exist yet" indistinguishable from "this org has no resources"
      // — an honest 501 says which one it is.
      try {
        const items = await getSeam("ExternalGriefResourceReader").resourcesForOrg(
          actor.organizationId,
        );
        return { category: "bereavement", items };
      } catch {
        throw new WardenXError(
          "NOT_IMPLEMENTED",
          "external grief resources are not yet available (M40 has not built this catalog)",
          501,
        );
      }
    },
  );
}

/** The common lay-language read route options: `P + ABAC_GRANT + auditRead + NO_OFFSET` (paths stay literal
 *  at the call site so `scan-routes` sees every route in the contract). */
function opts(key: string, resourceKind: string) {
  return { preHandler: [P(key), ABAC_GRANT(key), NO_OFFSET], config: PHI(resourceKind) };
}
