// apps/backend/src/modules/10-hope/routes/hope-route-guards.ts — the small request-side helpers the M10 route
// registrar (`hope-routes.ts`) composes: the caseload narrowing of the org-wide SFV worklist, the amendment
// attribution check, the late-deadline override body rules, the raw-body attestation check, the request facts a
// signature audit row records and the guard lists the submission-lifecycle and regenerate routes share. Split out so the
// registrar stays a route inventory. No helper here reads a header: the request facts come off `request.context`, which the
// platform fills at the edge.
import { hasOrgWideScope, requireAbac, requirePermission } from "@chartwarden/auth";
import { assertAuthorBoundToActor, requireAttestation } from "@chartwarden/hope";
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import { type PreHandler, ROUTE_FORMATS, rejectAiActor } from "@chartwarden/shared/route-kit";
import { type HopeRfaKind, ValidationError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import type { HopeRouteService, HopeSignatureRequestFacts } from "./service";

/**
 * The patients on a clinician's caseload (GAP-182). `userId` is the M2 USER id (what
 * `patient_assignment.clinician_user_id` keys on).
 */
export type CaseloadLookup = (q: {
  organizationId: string;
  userId: string;
}) => Promise<readonly string[]>;

/**
 * GAP-182 — the caseload narrowing the org-wide HOPE SFV worklist applies. Org-wide scope
 * roles are unrestricted (`null`); everyone else sees their caseload plus the one patient a pinned
 * session names. Fail-CLOSED: a caseload that cannot be resolved narrows to the session patient (or nothing).
 */
export async function listScopeOf(
  request: FastifyRequest,
  lookup: CaseloadLookup,
): Promise<readonly string[] | null> {
  const ctx = request.context;
  if (hasOrgWideScope(ctx.roles)) return null;
  const pinned = ctx.attributes?.sessionPatientId;
  const sessionIds = typeof pinned === "string" && pinned.length > 0 ? [pinned] : [];
  if (!ctx.userId) return sessionIds;
  try {
    const caseload = await lookup({ organizationId: ctx.organizationId, userId: ctx.userId });
    return [...new Set([...caseload, ...sessionIds])];
  } catch (err) {
    request.log.warn({ err }, "HOPE caseload lookup failed — narrowing to the session patient");
    return sessionIds;
  }
}

/**
 * #850: the correct body accepts the SFV author union (RN/NP/MD/LPN/LVN) because the record's RFA kind is
 * only known server-side. The claimed attribution must clear the per-RFA floor AND be one of the ACTOR's own
 * role-derived disciplines, for every RFA kind and every claimed value (never the body's word). An
 * unresolvable id falls to the strict (non-SFV) floor.
 */
export async function assertAmendmentAttribution(
  service: HopeRouteService,
  request: FastifyRequest,
  organizationId: string,
  assessmentId: string,
  claimed: string,
): Promise<void> {
  const facts = await service.loadAssessment(organizationId, assessmentId);
  const rfaKind = (facts?.rfaKind ?? "02_huv1") as HopeRfaKind;
  assertAuthorBoundToActor(rfaKind, claimed, request.context?.roles ?? []);
}

// GAP-015 — `adminOverride` used to be a body boolean any `hope.timepoint.write` holder could set, and it
// lifts the HQRP hard cutoff (`M10_TIMEPOINT_EXPIRED` / `M10_SFV_PAST_DUE`). The catalog defined the gating
// permission `hope.admin.late_deadline_override` and nothing referenced it. Now a request that asks for the
// override must hold that permission (403 otherwise) AND state a justification (422) — which the service
// records on a critical audit event when the override is actually used. The flag only ever ADDS a gate.
// Fail closed on the RAW value: the handler's `parse()` runs `Value.Convert`, which coerces "true"/1 to
// `true` AFTER this gate has run, so a strict `=== true` here let `adminOverride: "true"` skip the permission.
export const adminOverrideRequested = (body: unknown): boolean => {
  const raw = (body as { adminOverride?: unknown } | null | undefined)?.adminOverride;
  return raw !== undefined && raw !== null && raw !== false;
};
/** The justification's minimum length; `RecordTimepointSchema` / `RecordSfvSchema` declare the same number (a unit test pins it). */
export const OVERRIDE_JUSTIFICATION_MIN_LENGTH = 20;

/** A run of Unicode White_Space: one space for the length minimum. The web client's counter must collapse the same runs. */
const WHITE_SPACE_RUN = /\p{White_Space}+/gu;

/**
 * Characters a justification may not contain: control characters (`\p{Cc}`: NUL, escapes, NEL...) EXCEPT tab, line feed and
 * carriage return (a multi-line reason is normal), format characters (`\p{Cf}`: zero-width space / joiner, bidi marks, soft
 * hyphen, BOM...) and a surrogate that has no partner (not text at all). Twenty zero-width characters would otherwise pass the
 * length minimum as an invisible "reason", and a NUL or a lone surrogate cannot be stored in the audit event's jsonb (22P05),
 * which would turn this 422 into a 500. REJECTED, never stripped: silently removing characters would store a different text
 * from the one the admin typed and measured the minimum on. Not screened: other blank-looking glyphs (Hangul fillers, the
 * Braille blank); the text is attributable to a named admin and still goes through the patient-identifier screen.
 */
const FORBIDDEN_JUSTIFICATION_CHARACTER =
  /(?![\t\n\r])[\p{Cc}\p{Cf}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * The late-deadline override's justification, judged and cleaned. It is stored verbatim in the IMMUTABLE critical
 * `hope.late_deadline_override` audit event (the only record of why the HQRP cutoff was lifted), so it must be a real
 * reason and must not name a patient: the surrounding whitespace is trimmed, and the minimum length is measured after every run
 * of Unicode White_Space (spaces, tabs, line breaks, U+00A0, U+2028 and U+2029, the em and en spaces...) is collapsed to ONE
 * space, so twenty blanks of any kind are not a reason (the stored text is the trimmed text as typed, never the collapsed one);
 * text with control or format characters is refused (see {@link FORBIDDEN_JUSTIFICATION_CHARACTER}); and an SSN- or MBI-shaped
 * value is refused with a 422 that names the field and never echoes the text.
 * Returns the text to hand the service, `undefined` when no override was asked for (a text sent without the flag is not kept).
 */
export function requireOverrideJustification(body: {
  readonly adminOverride?: boolean;
  readonly adminOverrideJustification?: string;
}): string | undefined {
  if (body.adminOverride !== true) return undefined;
  const text = body.adminOverrideJustification?.trim() ?? "";
  if (text.length === 0) {
    throw new ValidationError("an admin deadline override needs a justification", [
      {
        field: "adminOverrideJustification",
        code: "REQUIRED",
        message: "adminOverrideJustification is required with adminOverride",
      },
    ]);
  }
  if (FORBIDDEN_JUSTIFICATION_CHARACTER.test(text)) {
    throw new ValidationError("an admin deadline override needs a plain-text justification", [
      {
        field: "adminOverrideJustification",
        code: "INVALID_CHARACTERS",
        message:
          "adminOverrideJustification must not contain control, zero-width or other formatting characters",
      },
    ]);
  }
  if (text.replace(WHITE_SPACE_RUN, " ").length < OVERRIDE_JUSTIFICATION_MIN_LENGTH) {
    throw new ValidationError("an admin deadline override needs a fuller justification", [
      {
        field: "adminOverrideJustification",
        code: "TOO_SHORT",
        message: `adminOverrideJustification must be at least ${OVERRIDE_JUSTIFICATION_MIN_LENGTH} characters once surrounding whitespace is removed and each run of whitespace counts as one space`,
      },
    ]);
  }
  assertNoPatientIdentifier("adminOverrideJustification", text);
  return text;
}

/**
 * The attestation, read off the RAW request body BEFORE `parse`: `parse` runs TypeBox `Value.Convert`, which
 * turns `"true"`, `"TRUE"`, `1` and `"1"` into `true` ahead of the schema check, so the typed
 * `attestationConfirmed: true` alone would accept a value the signer never sent as a boolean. Fastify hands
 * the handler the plain JSON body (these routes declare no Fastify schema, so nothing coerces it earlier).
 */
export const requireStrictAttestation = (body: unknown): void =>
  requireAttestation(
    (body as { attestationConfirmed?: unknown } | null | undefined)?.attestationConfirmed,
  );

/**
 * What the signature audit row records about the request, as the request context captured it at the edge (never read
 * off a header here: these describe the caller for the audit trail and decide nothing about authorization). The
 * request id is `request.id`, exactly as the read-audit rows fill `request_id` (a per-process counter). The request's
 * correlation id rides along as a TRACE HINT: a client can choose it (`x-correlation-id`, kept when it is a safe short
 * token), so it ties a row to a request's other records but is never evidence. The session user is only passed when it
 * is a uuid (the `actor_user_id` column is one); the system principal's literal id is not, and stays null.
 * Every uuid `ctx.userId` is a real `user` row: the only other principal, the machine credential, is the literal
 * "system" (`authenticate.ts`), interactive ids come from a Better Auth session snapshot, and AI principals are refused
 * by `rejectAiActor` before a signing route runs, so the `actor_user_id` FK cannot fail on a signature.
 */
export const signatureRequestFacts = (request: FastifyRequest): HopeSignatureRequestFacts => ({
  requestId: request.id,
  ...(request.context?.correlationId ? { correlationId: request.context.correlationId } : {}),
  ...(request.context?.userId && ROUTE_FORMATS.uuid?.(request.context.userId)
    ? { actorUserId: request.context.userId }
    : {}),
  ...(request.context?.ip ? { sourceIp: request.context.ip } : {}),
  ...(request.context?.userAgent ? { userAgent: request.context.userAgent } : {}),
});

// ── The guard lists the operator routes share (extracted from the route registrar, which listed the same three guards seven times).
// Each list is the permission, then the AI-principal refusal, then the `hope.scope` guard for the entity the route names, in
// the order the registrar used to spell out. The registrar spreads a list into its own array per route.

// §D13 — the compliance-affecting operator writes that are NOT signatures (skipping a window closes an HQRP deadline and
// counts against the on-time rate; cancel, mark-uploaded, results, retry, assemble and the package download move a CMS package
// through its states; regenerate creates the windows an admission is held to) refuse an `ai_*` principal too, even one granted
// the permission. No step-up: these are not signing ceremonies. It sits right after the permission guard, as REJECT_AI does on sign.
export const REJECT_AI_OPERATIONS = rejectAiActor(
  "AI principals cannot skip schedules, regenerate them or change a HOPE submission",
) as PreHandler;

/** `hope.scope` on the submission the URL's `:id` names (the `:id` of these routes is a SUBMISSION id, never an assessment's). */
export const SCOPE_SUBMISSION = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      submissionId: (request.params as { id?: unknown } | null)?.id,
    }),
  }) as PreHandler;

/** `hope.scope` on the provider entity the BODY names (assemble). */
const SCOPE_BODY_PE = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      providerEntityId: (request.body as { providerEntityId?: unknown } | null)?.providerEntityId,
    }),
  }) as PreHandler;

/** GAP-124 — the regenerate-schedules body names the admission; scope it like the other admissionId routes. */
const SCOPE_BODY_ADMISSION = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      admissionId: (request.body as { admissionId?: unknown } | null)?.admissionId,
    }),
  }) as PreHandler;

const SUBMISSION_MANAGE = requirePermission("hope.submission.manage") as PreHandler;
const ADMIN_REGEN = requirePermission("hope.admin.regenerate_schedules") as PreHandler;

/** Retry, package download, mark-uploaded, cancel and results: one submission, by the URL's `:id`. */
export const SUBMISSION_OPERATION_GUARDS: readonly PreHandler[] = [
  SUBMISSION_MANAGE,
  REJECT_AI_OPERATIONS,
  SCOPE_SUBMISSION("hope.submission.manage"),
];

/** Assemble: the provider entity the body names. */
export const SUBMISSION_ASSEMBLE_GUARDS: readonly PreHandler[] = [
  SUBMISSION_MANAGE,
  REJECT_AI_OPERATIONS,
  SCOPE_BODY_PE("hope.submission.manage"),
];

/** Regenerate schedules: the admission the body names. */
export const REGENERATE_SCHEDULES_GUARDS: readonly PreHandler[] = [
  ADMIN_REGEN,
  REJECT_AI_OPERATIONS,
  SCOPE_BODY_ADMISSION("hope.admin.regenerate_schedules"),
];
