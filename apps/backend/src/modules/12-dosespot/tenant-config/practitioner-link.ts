// apps/backend/src/modules/12-dosespot/tenant-config/practitioner-link.ts — the PRESCRIBER's own confirmation of the physician record a
// roster administrator linked them to (ADR-0110 D9). The DoseSpot enrolment sends the linked record's NPI and legal name to the vendor;
// the administrator cannot choose either (they come from the NPPES-sourced record), but the LINK ("this member is that physician") was
// still one person's word about another. So the member, signed in as themself with a fresh step-up, is shown the record's name and NPI
// and confirms them, pinned to the link and the NPI they were shown; enrolment on both lanes is refused until a confirmation matches the
// CURRENT link and the record's CURRENT NPI. The confirmer is always the roster row's own member (the actor's membership IS the key, and
// a CHECK on the table refuses anyone else's), so neither another member nor a platform operator can confirm on someone's behalf.
// Audited with ids only: never the NPI or the name.
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { CLINIC_AUDIT_EVENTS, type ClinicAuditPort } from "./audit-port";
import type { PractitionerDirectoryPort, PractitionerProfileSource } from "./practitioner-profile";
import type { RosterRow, RosterStore } from "./prescriber-enrollment";

export interface PractitionerLinkView {
  readonly membershipId: string;
  /** The member is on the roster (not revoked) and the row links a physician record. */
  readonly linked: boolean;
  readonly externalPhysicianMdmId: string | null;
  /** What the prescriber is asked to confirm (their own record's public provider data); null when there is nothing to confirm. */
  readonly physician: {
    readonly firstName: string;
    readonly lastName: string;
    readonly npi: string;
  } | null;
  /** A confirmation exists for the CURRENT link and the record's CURRENT NPI. */
  readonly confirmed: boolean;
}

export interface PractitionerLinkActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The session's OWN membership: it selects the roster row, so nobody can confirm another member's. */
  readonly membershipId: string;
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

export interface ConfirmLinkInput {
  /** The link the prescriber was shown. */
  readonly externalPhysicianMdmId: string;
  /** The NPI the prescriber was shown. */
  readonly npi: string;
}

export interface PractitionerLinkService {
  view(actor: PractitionerLinkActor): Promise<PractitionerLinkView>;
  confirm(actor: PractitionerLinkActor, input: ConfirmLinkInput): Promise<PractitionerLinkView>;
}

export interface PractitionerLinkDeps {
  readonly inTx: <T>(
    organizationId: string,
    userId: string,
    fn: (store: RosterStore, tx: DbClient) => Promise<T>,
  ) => Promise<T>;
  readonly directory: PractitionerDirectoryPort;
  /** The same derivation enrolment runs (active record, valid NPI, NPPES cross-check), so nothing NPPES contradicts is confirmable. */
  readonly profiles: PractitionerProfileSource;
  readonly audit: ClinicAuditPort;
  readonly now?: () => Date;
}

const notLinked = (): ChartWardenError =>
  new ChartWardenError(
    "DOSESPOT_PRACTITIONER_NOT_LINKED",
    "you are not linked to a physician record on the prescriber roster; ask a roster administrator to link you",
    409,
  );
const rosterChanged = (): ChartWardenError =>
  new ChartWardenError(
    "DOSESPOT_ROSTER_CHANGED",
    "the physician record linked to you changed since you looked at it; review it again before confirming",
    409,
  );

const liveLink = (row: RosterRow | null): row is RosterRow & { externalPhysicianMdmId: string } =>
  row !== null && row.revokedAt === null && row.externalPhysicianMdmId !== null;

export function createPractitionerLinkService(deps: PractitionerLinkDeps): PractitionerLinkService {
  const now = deps.now ?? (() => new Date());

  async function view(actor: PractitionerLinkActor): Promise<PractitionerLinkView> {
    const { organizationId, membershipId } = actor;
    const row = await deps.inTx(organizationId, actor.userId, (store) =>
      store.rosterRow(organizationId, membershipId),
    );
    if (!liveLink(row)) {
      return {
        membershipId,
        linked: false,
        externalPhysicianMdmId: null,
        physician: null,
        confirmed: false,
      };
    }
    const record = await deps.directory.resolvePhysician(
      organizationId,
      row.externalPhysicianMdmId,
    );
    const npi = record?.status === "active" ? record.canonical.identifierValue : null;
    const physician =
      record?.status === "active" && npi !== null && npi.trim() !== ""
        ? {
            firstName: record.canonical.firstName.trim(),
            lastName: record.canonical.lastName.trim(),
            npi,
          }
        : null;
    return {
      membershipId,
      linked: true,
      externalPhysicianMdmId: row.externalPhysicianMdmId,
      physician,
      confirmed:
        physician !== null &&
        row.linkConfirmedMdmId === row.externalPhysicianMdmId &&
        row.linkConfirmedNpi === physician.npi,
    };
  }

  async function confirm(
    actor: PractitionerLinkActor,
    input: ConfirmLinkInput,
  ): Promise<PractitionerLinkView> {
    const { organizationId, membershipId } = actor;
    const row = await deps.inTx(organizationId, actor.userId, (store) =>
      store.rosterRow(organizationId, membershipId),
    );
    if (!liveLink(row)) throw notLinked();
    // pinned: what the prescriber was shown must still be what the roster says, and what the record carries
    if (row.externalPhysicianMdmId !== input.externalPhysicianMdmId) throw rosterChanged();
    // identity, not the production NPPES-listing rule (that is enforced at enrolment): any refusal enrolment would make for the
    // record itself (inactive, bad NPI, contradicted by NPPES) is made here too, so nothing unconfirmable is confirmed
    const profile = await deps.profiles.profileFor({
      organizationId,
      physicianMdmId: row.externalPhysicianMdmId,
      environment: "sandbox",
    });
    if (profile.npi !== input.npi) throw rosterChanged();
    const at = now();
    await deps.inTx(organizationId, actor.userId, async (store, tx) => {
      const confirmed = await store.confirmLink(organizationId, membershipId, {
        mdmId: input.externalPhysicianMdmId,
        npi: profile.npi,
        at,
      });
      if (confirmed === null) throw rosterChanged(); // the row was re-linked or revoked between the read and this write
      await deps.audit.record(tx, {
        organizationId,
        actorUserId: actor.userId,
        actorMembershipId: membershipId,
        eventType: CLINIC_AUDIT_EVENTS.prescriberLinkConfirmed,
        resourceKind: "dosespot_prescriber",
        resourceId: confirmed.id,
        changedFields: ["linkConfirmation"],
        // ids only: the confirmed physician record's id, never its NPI or name
        detail: { physicianMdmId: input.externalPhysicianMdmId },
        ...(actor.request ? { request: actor.request } : {}),
      });
    });
    return view(actor);
  }

  return { view, confirm };
}
