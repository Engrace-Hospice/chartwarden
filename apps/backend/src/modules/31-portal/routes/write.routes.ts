// apps/backend/src/modules/31-portal/routes/write.routes.ts — M31 (§4.1) the portal WRITE surfaces (the
// three clinical-record writes minus M36 messaging, which M36 owns end-to-end, plus preferences + bereaved
// opt-out).
//
// Each route validates its typed lay DTO at the boundary, resolves the minimal upstream facts through the
// seam registry (fail-closed for a blocking fact), then runs the PURE plan core from `../write-paths` — the
// §7.6 post-discharge read-only gate, the §7.7 attestation window, the §7.8 MIME/size cap, the §164.526
// amendment shape — which THROWS a `PortalWriteError` on any violation. The amendment submit then hands the
// validated request to M5's intake (`deps.amendmentIntake`, GAP-006) — synchronously, so the 202 means an M5
// row exists and the §164.526 60-day clock has started. Its `targetRef` is verified to name the session
// patient's own record first (`verifiedAmendmentTargetRef`), and a retry under the same Idempotency-Key is
// replayed by the M1 idempotency middleware (bootstrap/plugins/idempotency.ts) rather than re-run. A resubmit
// under a NEW key for a change the patient already has OPEN gets that open request back (same 202 shape) —
// M5's intake dedupes on a content key behind a partial unique index (migration 0323). (This header used to say a `deps.outbox` publisher
// emitted the plan's `m31.*` event; M31 has no outbox publisher, and the request was simply dropped.)
// `portal.administration.attest` and `portal.amendment.submit` additionally carry TOTP step-up (M2),
// composed in `./mount`.
import type { MedicationOrderProvider } from "@wardenx/types";
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { planAmendmentRequest } from "../write-paths/amendment-request";
import { planCaregiverAttestation } from "../write-paths/caregiver-attestation";
import { PORTAL_UPLOAD_MIME_ALLOWLIST, planDocumentUpload } from "../write-paths/document-upload";
import { requirePortalWrite } from "../write-paths/errors";
import { actorOf, portalAccountIdOf, portalPatientIdOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  ABAC_ACCOUNT,
  ABAC_BEREAVED,
  ABAC_CAREGIVER_ATTEST,
  ABAC_GRANT,
  P,
  STEP_UP,
} from "./guards";
import type { PortalRouteDeps } from "./index";
import {
  AmendmentSubmitRequest,
  CaregiverAttestedAdministrationRequest,
  MessageSendRequest,
  NotificationPreferenceUpdateRequest,
  PortalDocumentUploadInitRequest,
  parse,
} from "./portal-typebox";

const IDEMPOTENT = requireIdempotencyKey();

/** GAP-006 — M5's intake, or a 503: never a success the patient is told about while nothing is recorded. */
function amendmentIntakeOf(deps: PortalRouteDeps) {
  if (!deps.amendmentIntake) {
    throw new WardenXError(
      "AMENDMENT_INTAKE_UNAVAILABLE",
      "Amendment requests cannot be accepted right now. Please contact your care team.",
      503,
    );
  }
  return deps.amendmentIntake;
}

function caregiverAttestationOf(deps: PortalRouteDeps) {
  if (!deps.caregiverAttestation) {
    throw new WardenXError(
      "CAREGIVER_ATTESTATION_UNAVAILABLE",
      "Dose attestations cannot be recorded right now. Please tell your care team directly.",
      503,
    );
  }
  return deps.caregiverAttestation;
}

/**
 * GAP-092 — a portal write whose backing module has no production path yet. The route answers 501 rather than
 * a 2xx that persisted nothing (a patient or caregiver told "ok" for a write that never happened).
 */
export function portalWriteNotBacked(feature: string): never {
  throw new WardenXError(
    "PORTAL_WRITE_NOT_BACKED",
    `${feature} is not available yet. Please contact your care team.`,
    501,
  );
}

/** The slice of M8's `SignedEncountersReader` the amendment target check reads. */
interface SignedEncounterArm {
  signedEncountersForPatientSince(
    organizationId: string,
    patientId: string,
    since: string,
  ): Promise<ReadonlyArray<{ readonly encounterId: string; readonly patientId: string }>>;
}

/** Every signed encounter the patient has — the narrative an amendment can name is any of them. */
const ALL_TIME = "1970-01-01T00:00:00.000Z";

/**
 * GAP-006 — resolve the amendment's `targetRef` to a record of the SESSION's patient, or refuse. Staff act
 * on this ref, so it must never be a caller-chosen id pointing at someone else's chart:
 *   `patient_demographic` — the target IS the patient; an absent ref resolves to the session patient and
 *                           any other id is refused.
 *   `encounter_narrative` — a NAMED ref must be one of this patient's signed encounters, read through M8's
 *                           published reader in the session's org (RLS-scoped there). Unreadable → 503
 *                           (never store an unverified ref, never tell the patient a real visit is not theirs).
 *                           No ref named (the shipped portal form has no visit picker) resolves to the
 *                           session patient: the request is about this patient's chart, and staff find the
 *                           visit from the free-text change.
 * So a stored ref is always either the session patient or one of their encounters. A refusal does not say
 * whether the id exists elsewhere — the same 422 either way.
 */
async function verifiedAmendmentTargetRef(
  organizationId: string,
  patientId: string,
  body: { targetKind: "patient_demographic" | "encounter_narrative"; targetRef?: string },
): Promise<string> {
  const invalid = "Please choose the record you are asking us to correct.";
  if (body.targetKind === "patient_demographic") {
    requirePortalWrite(
      body.targetRef === undefined || body.targetRef === patientId,
      "AMENDMENT_TARGET_INVALID",
      invalid,
    );
    return patientId;
  }
  const encounterId = body.targetRef;
  if (encounterId === undefined) return patientId;
  let encounters: Awaited<ReturnType<SignedEncounterArm["signedEncountersForPatientSince"]>>;
  try {
    encounters = await arm<SignedEncounterArm>(
      "SignedEncountersReader",
    ).signedEncountersForPatientSince(organizationId, patientId, ALL_TIME);
  } catch {
    throw new WardenXError(
      "AMENDMENT_TARGET_UNVERIFIABLE",
      "We cannot check that visit right now. Please try again later or contact your care team.",
      503,
    );
  }
  requirePortalWrite(
    encounters.some((e) => e.encounterId === encounterId && e.patientId === patientId),
    "AMENDMENT_TARGET_INVALID",
    invalid,
  );
  return encounterId;
}

interface AdmissionArm {
  isDischargedReadOnly?(orgId: string, patientId: string): Promise<boolean>;
}
interface MessagingSendArm {
  syncCareTeamChannel?(orgId: string, patientId: string): Promise<{ channelId: string }>;
  openChannel(
    orgId: string,
    spec: { kind: string; subjectId?: string; creatorUserId: string },
  ): Promise<{ channelId: string }>;
  sendMessage(
    orgId: string,
    input: { channelId: string; authorUserId: string; body: string },
  ): Promise<{ messageId: string }>;
}
const arm = <T>(name: string): T => (getSeam as unknown as (n: string) => unknown)(name) as T;

/** §7.6 — is the patient in the post-discharge read-only window? Fail-OPEN (false) so an M6 outage does not
 *  silently disable every write; the plan cores are the authority and RLS still scopes the row. */
async function dischargedReadOnly(orgId: string, patientId: string): Promise<boolean> {
  try {
    return (
      (await arm<AdmissionArm>("AdmissionStatusReader").isDischargedReadOnly?.(orgId, patientId)) ??
      false
    );
  } catch {
    return false;
  }
}

export function registerPortalWriteRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  // caregiver-attested administration (§7.7 / M13 D10). TOTP step-up composed in ./mount.
  app.post(
    "/api/v1/portal/administrations/caregiver-attested",
    {
      preHandler: [
        P("portal.administration.attest"),
        STEP_UP("portal.administration.attest"),
        ABAC_CAREGIVER_ATTEST("portal.administration.attest"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const portalAccountId = portalAccountIdOf(actor);
      const body = parse(CaregiverAttestedAdministrationRequest, request.body);
      // Resolve M12 order-active fact fail-CLOSED (a caregiver may only attest against an active,
      // caregiver-administered order); the grant kind decides the attesting relationship.
      let orderActive = false;
      try {
        const { summary } = await arm<MedicationOrderProvider>(
          "MedicationOrderProvider",
        ).getPortalMedicationSummary(actor.organizationId, patientId);
        orderActive = summary.some(
          (m) => m.medicationOrderId === body.medicationOrderId && !m.isRedacted,
        );
      } catch {
        orderActive = false;
      }
      const grant = await deps.store.activeGrant(actor.organizationId, portalAccountId, patientId);
      const relationship =
        grant?.grantKind === "dpoa_healthcare" ? "dpoa_healthcare_agent" : "primary_caregiver";
      const payload = planCaregiverAttestation(
        {
          orgId: actor.organizationId,
          patientId,
          medicationOrderId: body.medicationOrderId,
          orderActive,
          attestingRelationship: relationship,
          patientDischargedReadOnly: await dischargedReadOnly(actor.organizationId, patientId),
          administeredAtMs: Date.parse(body.administeredAt),
          attestationChecked: body.caregiverAttestationText.trim().length > 0,
          note: body.notes,
          portalAccountId,
        },
        now().getTime(),
      );
      // GAP-092 — the attestation is a real M13 `administration_record` (pending_caregiver_review); an unbound
      // M13 port refuses 503 rather than telling the caregiver "attested" with nothing written.
      const written = await caregiverAttestationOf(deps).record({
        organizationId: actor.organizationId,
        patientId: payload.patientId,
        medicationOrderId: payload.medicationOrderId,
        administeredAt: payload.administeredAtIso,
        caregiverSessionId: portalAccountId,
        route: body.route,
        doseAmount: body.administeredAmount,
        doseUnit: body.administeredUnit,
      });
      return reply.code(202).send({
        administrationId: written.administrationId,
        status: written.status,
      });
    },
  );

  // document upload — init (stage M22 intake; §7.8).
  app.post(
    "/api/v1/portal/documents/upload-init",
    {
      preHandler: [P("portal.documents.upload"), ABAC_GRANT("portal.documents.upload"), IDEMPOTENT],
    },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const portalAccountId = portalAccountIdOf(actor);
      const body = parse(PortalDocumentUploadInitRequest, request.body);
      planDocumentUpload({
        orgId: actor.organizationId,
        patientId,
        portalAccountId,
        byteSize: body.expectedByteSize,
        declaredMime: body.mimeType,
        // magic-byte verification runs on the real bytes at upload-complete; init validates the declared
        // MIME against the allowlist so a rejected type never mints a signed URL.
        magicBytes: [],
        patientDischargedReadOnly: await dischargedReadOnly(actor.organizationId, patientId),
      });
      // GAP-092 — no M22 intake staging / object-store presigner is bound for portal uploads, so there is
      // no real signed URL to mint (the old `uploads.invalid` placeholder let a caregiver "upload" into the void).
      return portalWriteNotBacked("Document upload");
    },
  );

  // document upload — complete (confirm M22 intake batch received; emits m31.portal_document.uploaded).
  app.post(
    "/api/v1/portal/documents/upload-complete/:uploadId",
    {
      preHandler: [P("portal.documents.upload"), ABAC_GRANT("portal.documents.upload"), IDEMPOTENT],
    },
    async (request) => {
      const actor = actorOf(request);
      portalPatientIdOf(actor);
      // GAP-092 — nothing was staged at upload-init and nothing is emitted here; refuse rather than "received".
      return portalWriteNotBacked("Document upload");
    },
  );

  // amendment request submit (§164.526 → M5). TOTP step-up composed in ./mount.
  app.post(
    "/api/v1/portal/amendments/submit",
    {
      preHandler: [
        P("portal.amendment.submit"),
        STEP_UP("portal.amendment.submit"),
        ABAC_GRANT("portal.amendment.submit"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const portalAccountId = portalAccountIdOf(actor);
      const body = parse(AmendmentSubmitRequest, request.body);
      const payload = planAmendmentRequest({
        orgId: actor.organizationId,
        patientId,
        portalAccountId,
        targetKind: body.targetKind,
        targetRef: body.targetRef ?? patientId,
        requestedChange: body.requestedChange,
        patientDischargedReadOnly: await dischargedReadOnly(actor.organizationId, patientId),
      });
      // After the plan, so its guard order (discharged-read-only first) is unchanged.
      const targetRef = await verifiedAmendmentTargetRef(actor.organizationId, patientId, body);
      const created = await amendmentIntakeOf(deps).submit({
        organizationId: payload.orgId,
        patientId: payload.patientId,
        requestedByUserId: actor.userId,
        portalAccountId: payload.originatingPortalAccountId,
        targetKind: payload.targetKind,
        targetRef,
        requestedChange: payload.requestedChange,
      });
      return reply.code(202).send({ amendmentRequestRefId: created.id, status: created.status });
    },
  );

  // amendment request list (own) — M5 amendment surface filtered to portal-submitted (fail-closed empty).
  app.get(
    "/api/v1/portal/amendments",
    {
      preHandler: [P("portal.amendment.read_own"), ABAC_GRANT("portal.amendment.read_own")],
      config: { auditRead: { resourceKind: "portal_amendment", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const items = await amendmentIntakeOf(deps).listOwn({
        organizationId: actor.organizationId,
        patientId: portalPatientIdOf(actor),
        requestedByUserId: actor.userId,
      });
      return { category: "amendments", items };
    },
  );

  // secure message send — thin pass-through to M36 with the portal_caregiver membership reconciled first.
  app.post(
    "/api/v1/portal/messages/send",
    { preHandler: [P("portal.messages.send"), ABAC_GRANT("portal.messages.send"), IDEMPOTENT] },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const body = parse(MessageSendRequest, request.body);
      const provider = arm<MessagingSendArm>("MessagingProvider");
      // The roster reconcile MUST succeed before the body is written into the channel, so this
      // deliberately does NOT catch. A failed `syncCareTeamChannel` means the `care_team` channel's
      // membership is whatever it was last time — including clinicians M5 has since removed from the
      // care team — and `openChannel` below happily returns that stale channel. Swallowing the error
      // here therefore turned a reconciliation failure into a PHI disclosure to a removed clinician
      // (the exact GAP-059 condition, where the M5 CareTeamProvider seam is the thing that throws).
      // read.routes.ts's channel-pointer catch is NOT precedent for this: there the catch abandons the
      // whole read (`channelId: ""`) and discloses nothing; here the handler proceeds to write.
      await provider.syncCareTeamChannel?.(actor.organizationId, patientId);
      const channel = await provider.openChannel(actor.organizationId, {
        kind: "care_team",
        subjectId: patientId,
        creatorUserId: actor.userId,
      });
      const sent = await provider.sendMessage(actor.organizationId, {
        channelId: channel.channelId,
        authorUserId: actor.userId,
        body: body.body,
      });
      return { messageId: sent.messageId };
    },
  );

  // notification preferences (write) — no owned table; acknowledged (M36 reconciles channel availability).
  app.patch(
    "/api/v1/portal/notification-preferences/:id",
    {
      preHandler: [P("portal.preferences.write_own"), ABAC_ACCOUNT("portal.preferences.write_own")],
    },
    async (request) => {
      actorOf(request);
      parse(NotificationPreferenceUpdateRequest, request.body);
      // GAP-092 — no preference table / M36 reconcile is bound; refuse rather than answer ok.
      return portalWriteNotBacked("Changing notification preferences");
    },
  );

  // bereavement self opt-out (§7.5 → M16). Window-gated.
  app.post(
    "/api/v1/portal/bereavement/opt-out",
    {
      preHandler: [
        P("portal.bereavement.opt_out_own"),
        ABAC_BEREAVED("portal.bereavement.opt_out_own"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      portalAccountIdOf(actor);
      // GAP-092 — no M16 opt-out port is bound; a bereaved family member who opts out must not be told
      // "ok" while outreach continues.
      return portalWriteNotBacked("Opting out of bereavement outreach");
    },
  );
}
