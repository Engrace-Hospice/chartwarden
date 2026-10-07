// apps/backend/src/modules/31-portal/routes/write.routes.ts — M31 (§4.1) the portal WRITE surfaces (the
// three clinical-record writes minus M36 messaging, which M36 owns end-to-end, plus preferences + bereaved
// opt-out) and, as of GAP-092, the PUBLIC token-authenticated invitation accept.
//
// GAP-092 — document upload is init (validate + record an intent) → content PUT (magic-byte check, sealed under the
// tenant DEK on `portal_document_upload`) → complete (hand the decrypted bytes to M22 intake); preferences persist in
// `portal_notification_preference`; the bereavement opt-out is M16's own D9 transition; the accept route creates the
// account's grant. Each depends on a provisioning port: unbound ⇒ a 503, never a fake success.
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
import { toPreferencesView } from "../provisioning/preferences";
import { planAmendmentRequest } from "../write-paths/amendment-request";
import { planCaregiverAttestation } from "../write-paths/caregiver-attestation";
import { PORTAL_UPLOAD_MAX_BYTES } from "../write-paths/document-upload";
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
  PortalInvitationAcceptRequest,
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

/** GAP-092 — the provisioning services, or a 503: never a success the caller is told about while nothing is stored. */
export function provisioningOf(deps: PortalRouteDeps) {
  if (!deps.provisioning) {
    throw new WardenXError(
      "PORTAL_PROVISIONING_UNAVAILABLE",
      "This is not available right now. Please contact your care team.",
      503,
    );
  }
  return deps.provisioning;
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
      // Validates (discharged-read-only, size, MIME) and records the intent; the bytes go to the content route.
      let begun: Awaited<ReturnType<ReturnType<typeof provisioningOf>["uploads"]["begin"]>>;
      try {
        begun = await provisioningOf(deps).uploads.begin({
          organizationId: actor.organizationId,
          actingUserId: actor.userId,
          portalAccountId,
          patientId,
          purpose: body.purpose,
          mimeType: body.mimeType,
          expectedByteSize: body.expectedByteSize,
          patientDischargedReadOnly: await dischargedReadOnly(actor.organizationId, patientId),
        });
      } catch (error) {
        // GAP-159 - a validation refusal (4xx) is an upload_rejected event; the sanitized reason is the stable
        // error CODE, never pipeline detail (spec 7.8 step 7). A 5xx (unbound port) is not a rejection.
        if (error instanceof WardenXError && error.statusCode < 500) {
          await deps.events?.emit(
            actor.organizationId,
            "m31.portal_document.upload_rejected",
            { kind: "portal_account", id: portalAccountId },
            { portalAccountId, patientId, rejectionReason: error.code },
          );
        }
        throw error;
      }
      await deps.events?.emit(
        actor.organizationId,
        "m31.portal_document.upload_started",
        { kind: "portal_account", id: portalAccountId },
        { uploadId: begun.uploadId, portalAccountId, patientId, purpose: body.purpose },
      );
      return {
        uploadId: begun.uploadId,
        signedUploadUrl: begun.contentPath,
        signedUploadUrlExpiresAt: begun.expiresAt,
      };
    },
  );

  // document upload — the bytes. Same-origin PUT under the caregiver's session: the body is size-checked,
  // magic-byte-checked against the declared MIME and kept ONLY as a tenant-DEK envelope (encrypted staging).
  app.addContentTypeParser(
    [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/heic",
      "image/tiff",
      "application/octet-stream",
    ],
    { parseAs: "buffer", bodyLimit: PORTAL_UPLOAD_MAX_BYTES + 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.put(
    "/api/v1/portal/documents/uploads/:uploadId/content",
    {
      bodyLimit: PORTAL_UPLOAD_MAX_BYTES + 1024 * 1024,
      preHandler: [P("portal.documents.upload"), ABAC_GRANT("portal.documents.upload")],
    },
    async (request) => {
      const actor = actorOf(request);
      const patientId = portalPatientIdOf(actor);
      const portalAccountId = portalAccountIdOf(actor);
      const { uploadId } = request.params as { uploadId: string };
      const bytes = request.body;
      requirePortalWrite(
        Buffer.isBuffer(bytes) && bytes.byteLength > 0,
        "UPLOAD_SIZE_MISMATCH",
        "No file content was received.",
      );
      return provisioningOf(deps).uploads.stage({
        organizationId: actor.organizationId,
        actingUserId: actor.userId,
        portalAccountId,
        patientId,
        uploadId,
        bytes,
      });
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
      const patientId = portalPatientIdOf(actor);
      const { uploadId } = request.params as { uploadId: string };
      // Hands the staged (decrypted) bytes to M22's intake; a 503 keeps the staged upload for a retry.
      const done = await provisioningOf(deps).uploads.complete({
        organizationId: actor.organizationId,
        actingUserId: actor.userId,
        portalAccountId: portalAccountIdOf(actor),
        patientId,
        uploadId,
      });
      await deps.events?.emit(
        actor.organizationId,
        "m31.portal_document.uploaded",
        { kind: "portal_account", id: portalAccountIdOf(actor) },
        { uploadId: done.uploadId, portalAccountId: portalAccountIdOf(actor), patientId, purpose: "portal_upload" },
      );
      return { uploadId: done.uploadId, status: done.status };
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
      await deps.events?.emit(
        actor.organizationId,
        "m31.portal_amendment_request.submitted",
        { kind: "portal_account", id: portalAccountId },
        {
          amendmentRequestRefId: created.id,
          m5AmendmentRequestId: created.id,
          portalAccountId,
          patientId,
        },
      );
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
      const portalAccountId = portalAccountIdOf(actor);
      await deps.events?.emit(
        actor.organizationId,
        "m31.portal_message.sent_via_m36",
        { kind: "portal_account", id: portalAccountId },
        { portalAccountId, patientId, channelId: channel.channelId },
      );
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
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const body = parse(NotificationPreferenceUpdateRequest, request.body);
      await provisioningOf(deps).preferences.update({
        organizationId: actor.organizationId,
        actingUserId: actor.userId,
        portalAccountId: portalAccountIdOf(actor),
        idOrChannel: id,
        update: body,
      });
      return { ok: true };
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
      const portalAccountId = portalAccountIdOf(actor);
      // A bereaved family member who opts out must never be told "ok" while outreach continues: the opt-out is
      // M16's own D9 transition (it cancels the contact's future outreach), or the call refuses.
      if (!deps.bereavementOptOut) {
        throw new WardenXError(
          "BEREAVEMENT_OPT_OUT_UNAVAILABLE",
          "Opting out is not available right now. Please contact your care team.",
          503,
        );
      }
      const result = await deps.bereavementOptOut.optOut({
        organizationId: actor.organizationId,
        userId: actor.userId,
        portalAccountId,
      });
      return { ok: true, ...result };
    },
  );

  // invitation acceptance — PUBLIC, authenticated by the single-use token alone (the invitee has no session yet).
  // Creates the account's grant and activates the account; see `provisioning/invitations.ts`.
  app.post("/api/v1/portal/invitations/accept", async (request) => {
    const body = parse(PortalInvitationAcceptRequest, request.body);
    return provisioningOf(deps).invitations.accept(body.token);
  });
}
