// M31 ADR-0107 (PROPOSED) — the portal admission-document signing routes:
//   GET  /api/v1/portal/signature-requests                 the session patient's requests (read-audited list)
//   GET  /api/v1/portal/signature-requests/:requestId      one request + the exact attestation sentence (read-audited, resource id recorded)
//   POST /api/v1/portal/signature-requests/:requestId/sign sign it: TOTP step-up + Idempotency-Key + the per-grant authority matrix
// Every id and every fact about WHO is signing comes from the SESSION (account, patient, session id) and the grant row, never from the body.
// The route only authorizes and shapes; the authority matrix, the DPOA check and the call-then-record order live in `signAdmissionDocument`.
//
//   POST /api/v1/portal/signature-requests/:requestId/signed-copy  attach a completed `signed_admission_document` upload as the signed paper copy (D6)
// An attached copy parks the request in `uploaded_pending_review`; it is never marked signed here (staff accept or reject it).
import { createHash } from "node:crypto";
import { ChartWardenError, ForbiddenError, NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { type PortalSigningGrantKind, decideSigningAuthority } from "../portal-signing-authority";
import {
  SIGNATURE_TEMPLATES,
  type SignatureDocumentText,
  renderDocumentText,
} from "../signature-templates";
import { type SignDenyCode, signAdmissionDocument } from "../write-paths/sign-admission-document";
import { actorOf, portalAccountIdOf, portalPatientIdOf, portalSessionIdOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_GRANT, P, STEP_UP } from "./guards";
import type { PortalRouteDeps } from "./index";
import { PortalSignatureAttachUpload, PortalSignatureSignRequest, parse } from "./portal-typebox";
import type { PortalSigningDeps } from "./signature-deps";

const IDEMPOTENT = requireIdempotencyKey();

/** The exact sentence a signer agrees to. The server shows it and hashes it; a client-supplied text is never trusted. */
export function attestationTextFor(docKind: string, templateVersion: string): string {
  return `By typing my name and checking this box I confirm that I have read this document (${docKind.replaceAll("_", " ")}, version ${templateVersion}), that the information I gave about myself is true, and that I understand my typed name is my legal electronic signature.`;
}
/** The wording registered for this kind, or null (the M06 documents carry theirs in the admission record). The version is the request's own, so a later template never rewrites an old request. */
export function documentTextFor(
  docKind: string,
  agencyName: string | null = null,
): SignatureDocumentText | null {
  const text = (SIGNATURE_TEMPLATES as Record<string, { text?: SignatureDocumentText }>)[docKind]
    ?.text;
  return text ? renderDocumentText(text, agencyName) : null;
}
/** What the evidence hash covers: the document wording the person was shown plus the attestation sentence. */
export function signedContentFor(
  docKind: string,
  templateVersion: string,
  agencyName: string | null = null,
): string {
  const doc = documentTextFor(docKind, agencyName);
  const body = doc ? `${doc.title}\n\n${doc.paragraphs.join("\n\n")}\n\n` : "";
  return body + attestationTextFor(docKind, templateVersion);
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function signingOf(deps: PortalRouteDeps): PortalSigningDeps {
  if (!deps.signing) {
    throw new ChartWardenError(
      "PORTAL_SIGNING_UNAVAILABLE",
      "Signing is not available right now. Please contact your care team.",
      503,
    );
  }
  return deps.signing;
}

const ATTACH_DENY = {
  request_not_found: { status: 404, message: "That request was not found." },
  request_not_pending: {
    status: 409,
    message: "That request is no longer waiting for a signature.",
  },
  upload_not_usable: {
    status: 422,
    message: "That file cannot be used as the signed copy. Please upload it again.",
  },
} as const;

const NOT_READY = "This document is not ready to sign yet. Your care team will let you know.";
const NOT_ABLE = "You are not able to sign this document for this patient.";

/** Lay-language refusals: a code the app can branch on, never record content. */
const DENY_STATUS: Readonly<Record<SignDenyCode, { status: number; message: string }>> = {
  request_not_found: { status: 404, message: "That request was not found." },
  request_not_open: { status: 409, message: "That request is no longer open." },
  not_authorized_for_document: { status: 403, message: NOT_ABLE },
  relationship_required: { status: 422, message: "Please say how you are related to the patient." },
  patient_unable_reason_required: {
    status: 422,
    message: "Please say why the patient was not able to sign.",
  },
  signer_name_required: { status: 422, message: "Please type your full name." },
  dpoa_consent_not_active: {
    status: 403,
    message:
      "Your authority to act for this patient could not be confirmed. Please contact your care team.",
  },
  template_pending_legal_review: { status: 409, message: NOT_READY },
  request_target_missing: { status: 409, message: NOT_READY },
  grant_kind_unsupported: { status: 403, message: NOT_ABLE },
};

export function registerPortalSignatureRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  app.get(
    "/api/v1/portal/signature-requests",
    {
      preHandler: [P("portal.signature.read"), ABAC_GRANT("portal.signature.read")],
      config: { auditRead: { resourceKind: "portal_signature_request", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const items = await signingOf(deps).store.listForPatient(
        actor.organizationId,
        portalPatientIdOf(actor),
      );
      return { items };
    },
  );

  app.get(
    "/api/v1/portal/signature-requests/:requestId",
    {
      preHandler: [P("portal.signature.read"), ABAC_GRANT("portal.signature.read")],
      config: {
        auditRead: { resourceKind: "portal_signature_request", resourceIdParam: "requestId" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { requestId } = request.params as { requestId: string };
      const view = await signingOf(deps).store.viewForPatient(
        actor.organizationId,
        portalPatientIdOf(actor),
        requestId,
      );
      if (!view) throw new NotFoundError("signature request", requestId);
      const doc = documentTextFor(
        view.docKind,
        await signingOf(deps).agencyName(actor.organizationId),
      );
      return {
        ...view,
        attestationText: attestationTextFor(view.docKind, view.templateVersion),
        ...(doc ? { documentTitle: doc.title, documentParagraphs: doc.paragraphs } : {}),
      };
    },
  );

  app.post(
    "/api/v1/portal/signature-requests/:requestId/sign",
    {
      preHandler: [
        P("portal.signature.sign"),
        STEP_UP("portal.signature.sign"),
        ABAC_GRANT("portal.signature.sign"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const accountId = portalAccountIdOf(actor);
      const patientId = portalPatientIdOf(actor);
      const sessionId = portalSessionIdOf(actor);
      const { requestId } = request.params as { requestId: string };
      const body = parse(PortalSignatureSignRequest, request.body);
      const idempotencyKey = String(request.headers["idempotency-key"]);
      const signing = signingOf(deps);

      // The request must be the SESSION patient's own, and the signer's grant must be live; neither is taken from the body.
      const view = await signing.store.viewForPatient(actor.organizationId, patientId, requestId);
      if (!view) throw new NotFoundError("signature request", requestId);
      const grant = await signing.store.activeGrantSource(
        actor.organizationId,
        accountId,
        patientId,
      );
      if (!grant) throw new ForbiddenError("no active grant for this patient");
      // An unrecognized grant kind is carried as-is and denied by the matrix (fail closed), not guessed at here.
      const grantKind = grant.grantKind as PortalSigningGrantKind;
      if (!decideSigningAuthority({ grantKind, docKind: view.docKind }).allowed) {
        throw new ForbiddenError(NOT_ABLE);
      }

      const outcome = await signAdmissionDocument(
        {
          requests: signing.store,
          signers: signing.signers,
          consents: signing.consents,
          allowUnreviewedTemplates: signing.allowUnreviewedTemplates,
        },
        {
          organizationId: actor.organizationId,
          requestId,
          signer: {
            portalUserId: actor.userId,
            portalAccountId: accountId,
            portalSessionId: sessionId,
            grantKind,
            sourceConsentRecordId: grant.sourceConsentRecordId,
          },
          statement: {
            signedTypedName: body.signedTypedName,
            ...(body.signerRelationshipText
              ? { signerRelationshipText: body.signerRelationshipText }
              : {}),
            ...(body.patientUnableReason ? { patientUnableReason: body.patientUnableReason } : {}),
            attestationSha256: sha256(
              signedContentFor(
                view.docKind,
                view.templateVersion,
                await signing.agencyName(actor.organizationId),
              ),
            ),
            idempotencyKey,
          },
        },
      );
      if (!outcome.ok) {
        const refusal = DENY_STATUS[outcome.code];
        throw new ChartWardenError(outcome.code.toUpperCase(), refusal.message, refusal.status);
      }
      const done = await signing.store.viewForPatient(actor.organizationId, patientId, requestId);
      return { request: done ?? view, alreadySigned: outcome.alreadySigned };
    },
  );

  app.post(
    "/api/v1/portal/signature-requests/:requestId/signed-copy",
    { preHandler: [P("portal.signature.sign"), ABAC_GRANT("portal.signature.sign"), IDEMPOTENT] },
    async (request) => {
      const actor = actorOf(request);
      const accountId = portalAccountIdOf(actor);
      const patientId = portalPatientIdOf(actor);
      const { requestId } = request.params as { requestId: string };
      const { uploadId } = parse(PortalSignatureAttachUpload, request.body);
      const signing = signingOf(deps);

      const view = await signing.store.viewForPatient(actor.organizationId, patientId, requestId);
      if (!view) throw new NotFoundError("signature request", requestId);
      const grant = await signing.store.activeGrantSource(
        actor.organizationId,
        accountId,
        patientId,
      );
      if (!grant) throw new ForbiddenError("no active grant for this patient");
      // The same authority matrix as signing: someone who may not sign this document may not stand behind a paper copy of it either.
      const grantKind = grant.grantKind as PortalSigningGrantKind;
      if (!decideSigningAuthority({ grantKind, docKind: view.docKind }).allowed) {
        throw new ForbiddenError(NOT_ABLE);
      }
      const outcome = await signing.store.attachSignedCopy(actor.organizationId, {
        patientId,
        portalAccountId: accountId,
        requestId,
        uploadId,
      });
      if (!outcome.ok) {
        const refusal = ATTACH_DENY[outcome.code];
        throw new ChartWardenError(outcome.code.toUpperCase(), refusal.message, refusal.status);
      }
      return { request: outcome.request };
    },
  );
}
