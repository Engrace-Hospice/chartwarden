// apps/backend/src/modules/14-idg/routes/idg-enrichment.ts — the read-enrichment PORTS for the IDG meeting
// screens: patient display info on the agenda / packet / decision / action-item reads, and the meeting-scoped
// recert/F2F windows read.
//
// MODULE BOUNDARY. M14's manifest `dependsOn` is [1, 7, 8, 36]; it does NOT (and after this change still does
// not) depend on M5 or M6, and `arch:boundaries` bars value imports across modules. The rows M14 needs live in
// M5 (`patient`) and M6 (`admission` / `election_period` / `face_to_face_encounter`), so — exactly like the
// packet-build worker's `Idg6PacketPort` / `Idg7PacketPort` (jobs/packet-build.ts, F-165's `m16-plan-closed.ts`
// precedent) — the ports below are LOCALLY-DECLARED STRUCTURAL types and the composition root
// (apps/backend/src/index.ts) binds them to the owners' org-explicit seam functions
// (`patientDisplayLabelsForOrg` on M5, `idgRecertWindowsForOrg` on M6). M14 imports no M5/M6 code or schema.
//
// BOTH ports are optional on the route deps: the in-memory slice / unit tests mount the routes without them, and
// the enriched fields are then simply absent (`patient` is `Optional` on the wire schemas). A port FAILURE
// degrades the same way — an unresolvable display name must never 500 the meeting screen — and is logged.
import type { FastifyBaseLogger } from "fastify";

/** The minimum-necessary patient display projection ("First L." + MRN last-4). Mirrors M5's `PatientDisplayLabel`. */
export interface IdgPatientDisplay {
  readonly displayName: string;
  readonly mrnSuffix: string | null;
}

/** M5's batched display read, injected. ONE call per response; ids unknown to the org are absent from the map. */
export interface IdgPatientDisplayPort {
  displayForPatients(
    organizationId: string,
    patientIds: readonly string[],
  ): Promise<ReadonlyMap<string, IdgPatientDisplay & { readonly patientId?: string }>>;
}

/** One patient's recert/F2F window. Mirrors M6's `IdgRecertWindow` (dates are org-local `yyyy-mm-dd`). */
export interface IdgRecertWindowFact {
  readonly patientId: string;
  readonly admissionId: string;
  readonly currentPeriodSequence: number | null;
  readonly benefitPeriodStart: string | null;
  readonly benefitPeriodEnd: string | null;
  readonly nextRecertDueDate: string | null;
  readonly nextPeriodSequence: number | null;
  readonly daysUntilNextRecert: number | null;
  readonly f2fRequired: boolean | null;
  readonly f2fWindowStart: string | null;
  readonly f2fWindowEnd: string | null;
  readonly f2fStatus:
    | "not_required"
    | "not_yet_open"
    | "window_open"
    | "attested"
    | "missed"
    | "unknown";
  readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
  readonly f2fScheduledDate: string | null;
}

/** M6's batched recert/F2F window read, injected. Patients with no live admission are absent from the map. */
export interface IdgRecertWindowPort {
  recertWindowsForPatients(
    organizationId: string,
    patientIds: readonly string[],
  ): Promise<ReadonlyMap<string, IdgRecertWindowFact>>;
}

/** The minimum-necessary staff display projection (name ONLY). Mirrors the identity seam's `MembershipDisplayLabel`. */
export interface IdgMembershipDisplay {
  readonly displayName: string | null;
}

/**
 * The identity-owned (M2) batched staff display read, injected. ONE call per response; ids unknown to the org are
 * absent from the map. M14 imports no identity code/schema — the composition root binds `membershipDisplayForOrg`.
 */
export interface IdgMembershipDisplayPort {
  displayForMemberships(
    organizationId: string,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, IdgMembershipDisplay>>;
}

/**
 * The authorization-owned (M3) batched role-key read, injected. Used to validate an attendance row's discipline against
 * the TARGET member's authoritative roles when a coordinator records someone else (a caller's OWN roles come from the
 * session context). A live membership with no role maps to `[]`; an unknown / cross-tenant / revoked membership is
 * ABSENT from the map. M14 imports no authorization code/schema — the composition root binds `membershipRoleKeysForOrg`.
 */
export interface IdgMembershipRolesPort {
  roleKeysForMemberships(
    organizationId: string,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}

/** The site display facts an IDG minutes/packet PDF header needs (NAMES only). Mirrors M1's `SiteDisplay`. */
export interface IdgSiteDisplay {
  /** The organization's display name, or null when unresolved. */
  readonly organizationName: string | null;
  /** Location id -> display name, for the ids that resolved (others absent). */
  readonly locationNames: ReadonlyMap<string, string>;
}

/**
 * The foundation-owned (M1) org-explicit site display read, injected: the organization's and the named locations'
 * display names, in ONE call. M14 imports no M1 code/schema — the composition root binds `siteDisplayForOrg`.
 * Used ONLY to fill the PDF header on the M22 render payloads; unbound / failing => the header omits the names.
 */
export interface IdgSiteDisplayPort {
  displayForSite(organizationId: string, locationIds: readonly string[]): Promise<IdgSiteDisplay>;
}

export interface IdgRouteEnrichmentPorts {
  readonly membershipRoles?: IdgMembershipRolesPort;
  readonly patientDisplay?: IdgPatientDisplayPort;
  readonly recertWindows?: IdgRecertWindowPort;
  readonly membershipDisplay?: IdgMembershipDisplayPort;
  /** M1's org/location display names — only the minutes render payload's PDF header reads it. */
  readonly siteDisplay?: IdgSiteDisplayPort;
}

/**
 * Attach `finalizedByName` to a minutes view (ONE single-id lookup). With no port (slice / tests) the view is
 * returned untouched; on a port failure it degrades to the untouched view too — an unresolvable staff name must
 * never 500 the minutes screen — and is logged. An unknown / nameless membership yields `finalizedByName: null`.
 */
export async function withFinalizerName<
  T extends { readonly finalizedByMembershipId: string | null },
>(
  port: IdgMembershipDisplayPort | undefined,
  organizationId: string,
  view: T,
  log?: FastifyBaseLogger,
): Promise<T | (T & { readonly finalizedByName: string | null })> {
  if (port === undefined) return view;
  if (view.finalizedByMembershipId === null) return { ...view, finalizedByName: null };
  try {
    const byId = await port.displayForMemberships(organizationId, [view.finalizedByMembershipId]);
    return {
      ...view,
      finalizedByName: byId.get(view.finalizedByMembershipId)?.displayName ?? null,
    };
  } catch (err) {
    log?.warn({ err }, "idg: membership display enrichment failed; returning the id only");
    return view;
  }
}

/**
 * Attach `authorName` to discipline notes (ONE batched lookup for the response). No port => untouched; a port
 * failure degrades to the untouched list (logged) — an unresolvable staff name must never 500 the notes pane.
 * An unknown / nameless membership yields `authorName: null`.
 */
export async function withAuthorNames<T extends { readonly authorMembershipId: string }>(
  port: IdgMembershipDisplayPort | undefined,
  organizationId: string,
  items: readonly T[],
  log?: FastifyBaseLogger,
): Promise<Array<T | (T & { readonly authorName: string | null })>> {
  if (port === undefined || items.length === 0) return [...items];
  const ids = [...new Set(items.map((i) => i.authorMembershipId))];
  try {
    const byId = await port.displayForMemberships(organizationId, ids);
    return items.map((i) => ({
      ...i,
      authorName: byId.get(i.authorMembershipId)?.displayName ?? null,
    }));
  } catch (err) {
    log?.warn({ err }, "idg: author display enrichment failed; returning ids only");
    return [...items];
  }
}

/** The wire projection: only the two minimum-necessary fields, never the port's incidental extras. */
export interface IdgPatientDisplayView {
  readonly displayName: string;
  readonly mrnSuffix: string | null;
}

/**
 * Attach `patient` to every item that carries a `patientId`, using ONE batched lookup for the whole response
 * (no N+1). An item whose `patientId` is null, or that the org cannot resolve, gets `patient: null`. With no port
 * (slice / tests) or on a port failure the items are returned untouched.
 */
export async function withPatientDisplay<T extends { readonly patientId: string | null }>(
  port: IdgPatientDisplayPort | undefined,
  organizationId: string,
  items: readonly T[],
  log?: FastifyBaseLogger,
): Promise<Array<T | (T & { readonly patient: IdgPatientDisplayView | null })>> {
  if (port === undefined) return [...items];
  const ids = [...new Set(items.map((i) => i.patientId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return items.map((i) => ({ ...i, patient: null }));
  let byId: ReadonlyMap<string, IdgPatientDisplay>;
  try {
    byId = await port.displayForPatients(organizationId, ids);
  } catch (err) {
    log?.warn({ err }, "idg: patient display enrichment failed; returning ids only");
    return [...items];
  }
  return items.map((i) => {
    const hit = i.patientId === null ? undefined : byId.get(i.patientId);
    return {
      ...i,
      patient: hit ? { displayName: hit.displayName, mrnSuffix: hit.mrnSuffix } : null,
    };
  });
}
