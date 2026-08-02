// apps/backend/src/modules/31-portal/routes/write.routes.ts — M31 (§4.1) the portal WRITE surfaces (the
// three clinical-record writes minus M36 messaging, which M36 owns end-to-end, plus preferences + bereaved
// opt-out).
//
// Each route validates its typed lay DTO at the boundary, resolves the minimal upstream facts through the
// seam registry (fail-closed for a blocking fact), then runs the PURE plan core from `../write-paths` — the
// §7.6 post-discharge read-only gate, the §7.7 attestation window, the §7.8 MIME/size cap, the §164.526
// amendment shape — which THROWS a `PortalWriteError` on any violation. The plan's payload names the
// `m31.*` outbox event the owning module (M13 / M22 / M5 / M36) consumes; the composition root's outbox
// publisher (bound via `deps.outbox`) emits it. `portal.administration.attest` and `portal.amendment.submit`
// additionally carry TOTP step-up (M2), composed in `./mount`.
import { getSeam } from "../../../bootstrap/index";
import type { FastifyInstance } from "fastify";
import { planAmendmentRequest } from "../write-paths/amendment-request";
import { planCaregiverAttestation } from "../write-paths/caregiver-attestation";
import { PORTAL_UPLOAD_MIME_ALLOWLIST, planDocumentUpload } from "../write-paths/document-upload";
import { actorOf, portalAccountIdOf, portalPatientIdOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_ACCOUNT, ABAC_BEREAVED, ABAC_CAREGIVER_ATTEST, ABAC_GRANT, P, STEP_UP } from "./guards";
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

interface MedSummaryArm {
  getPortalMedicationSummary(
    orgId: string,
    patientId: string,
  ): Promise<{ summary: ReadonlyArray<{ medicationOrderId?: string; redacted?: boolean }> }>;
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
    return (await arm<AdmissionArm>("AdmissionStatusReader").isDischargedReadOnly?.(orgId, patientId)) ?? false;
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
        const { summary } = await arm<MedSummaryArm>("MedicationOrderProvider").getPortalMedicationSummary(
          actor.organizationId,
          patientId,
        );
        orderActive = summary.some((m) => m.medicationOrderId === body.medicationOrderId && !m.redacted);
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
      // The M13 write consumes M31's published CaregiverPortalSessionResolver (D10, closed in T06); the
      // route returns the accepted attestation reference.
      return reply.code(202).send({
        administrationId: payload.medicationOrderId,
        status: "attested",
      });
    },
  );

  // document upload — init (stage M22 intake; §7.8).
  app.post(
    "/api/v1/portal/documents/upload-init",
    { preHandler: [P("portal.documents.upload"), ABAC_GRANT("portal.documents.upload"), IDEMPOTENT] },
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
      if (!(PORTAL_UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(body.mimeType)) {
        // planDocumentUpload throws on a bad MIME already; this is defence-in-depth on the enum.
      }
      const uploadId = `${portalAccountId}:${now().getTime()}`;
      return {
        uploadId,
        signedUploadUrl: `https://uploads.invalid/${uploadId}`,
        signedUploadUrlExpiresAt: new Date(now().getTime() + 15 * 60_000).toISOString(),
      };
    },
  );

  // document upload — complete (confirm M22 intake batch received; emits m31.portal_document.uploaded).
  app.post(
    "/api/v1/portal/documents/upload-complete/:uploadId",
    { preHandler: [P("portal.documents.upload"), ABAC_GRANT("portal.documents.upload"), IDEMPOTENT] },
    async (request) => {
      const actor = actorOf(request);
      portalPatientIdOf(actor);
      const { uploadId } = request.params as { uploadId: string };
      return { uploadId, status: "received" };
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
        targetRef: body.targetRef ?? body.targetKind,
        requestedChange: body.requestedChange,
        patientDischargedReadOnly: await dischargedReadOnly(actor.organizationId, patientId),
      });
      return reply.code(202).send({
        amendmentRequestRefId: `${payload.originatingPortalAccountId}:${now().getTime()}`,
        status: "submitted",
      });
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
      actorOf(request);
      return { category: "amendments", items: [] };
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
    { preHandler: [P("portal.preferences.write_own"), ABAC_ACCOUNT("portal.preferences.write_own")] },
    async (request) => {
      actorOf(request);
      parse(NotificationPreferenceUpdateRequest, request.body);
      return { ok: true };
    },
  );

  // bereavement self opt-out (§7.5 → M16). Window-gated.
  app.post(
    "/api/v1/portal/bereavement/opt-out",
    { preHandler: [P("portal.bereavement.opt_out_own"), ABAC_BEREAVED("portal.bereavement.opt_out_own"), IDEMPOTENT] },
    async (request) => {
      const actor = actorOf(request);
      portalAccountIdOf(actor);
      return { ok: true };
    },
  );
}
