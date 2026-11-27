// apps/backend/src/modules/10-hope/hope-signer-licence-policy.ts — CW-AC-46: the per-organization enforcement mode of the signer-licence
// check (hope-signer-licence.ts), stored in `hope_signer_licence_policy` (migration 1587).
//
//   enforce  (the default; an ABSENT row is enforce, applied here in code) a signer with no active licence in the record's discipline
//            is refused 403.
//   shadow   the signature goes through; the would-be refusal is recorded as an audit finding the CW-MON-01 burst rule still counts.
//
// The same shape as the CW-AC-24 claims-billing gate's mode, taken per organization instead of per deployment: compliant by default;
// running below enforce REQUIRES a written reason (20-200 characters, screened for patient identifiers) that is kept on the row while
// shadowed and carried by the audit event for good; every change is audited (m10.signature.licence_policy_changed beside the row-diff
// trigger); the finding a shadowed organization leaves says `mode: shadow`. The write needs the platform-category permission
// `hope.admin.signer_licence_policy` behind a fresh step-up (the route), so a tenant cannot lower its own control.
//
// The service takes the caller's transaction (`withOrgContext` upstream) so RLS scopes every row; it never opens its own. The mode is read
// INSIDE the sign transaction, only when a refusal would happen, so a change takes effect on the next signature (no cache) and a
// signature that would pass pays no extra query.
import { type DbClient, schema } from "@chartwarden/db";
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import {
  HOPE_SIGNER_LICENCE_DEFAULT_MODE,
  HOPE_SIGNER_LICENCE_MODES,
  HOPE_SIGNER_LICENCE_SHADOW_REASON_MAX,
  HOPE_SIGNER_LICENCE_SHADOW_REASON_MIN,
  type HopeSignerLicenceMode,
  ValidationError,
} from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { auditHopeSignerLicencePolicyChanged } from "./hope-operator-audit";
import { FORBIDDEN_REASON_CHARACTER, WHITE_SPACE_RUN } from "./hope-plain-text";
import type { HopeAuditRequestFacts } from "./hope-signature-audit";

const P = schema.hopeSignerLicencePolicies;

/** The organization's effective policy (the absent-row default already applied). Ids, an enum and the screened reason only. */
export interface SignerLicencePolicy {
  readonly mode: HopeSignerLicenceMode;
  /** The reason the organization runs in shadow; `null` while it enforces. */
  readonly reason: string | null;
  /** When the policy was last written; `null` for the default (nothing has ever been written). */
  readonly configuredAt: Date | null;
}

export const DEFAULT_SIGNER_LICENCE_POLICY: SignerLicencePolicy = Object.freeze({
  mode: HOPE_SIGNER_LICENCE_DEFAULT_MODE,
  reason: null,
  configuredAt: null,
});

/** The organization's policy, or the default (enforce) when it has never configured one. */
export async function readSignerLicencePolicy(
  tx: DbClient,
  organizationId: string,
): Promise<SignerLicencePolicy> {
  const [row] = await tx
    .select({ mode: P.mode, reason: P.shadowReason, configuredAt: P.updatedAt })
    .from(P)
    .where(eq(P.organizationId, organizationId))
    .limit(1);
  return row
    ? { mode: row.mode, reason: row.reason, configuredAt: row.configuredAt }
    : DEFAULT_SIGNER_LICENCE_POLICY;
}

/** Just the mode, for the sign path. */
export async function readSignerLicenceMode(
  tx: DbClient,
  organizationId: string,
): Promise<HopeSignerLicenceMode> {
  return (await readSignerLicencePolicy(tx, organizationId)).mode;
}

export interface PutSignerLicencePolicyInput {
  readonly organizationId: string;
  /** M10's acting id: the MEMBERSHIP, which rides in the audit context. */
  readonly membershipId: string;
  /** The Better Auth USER id (`configured_by_user_id` references `user`). */
  readonly actorUserId: string;
  readonly mode: HopeSignerLicenceMode;
  /** Required for `shadow`, refused for `enforce`. */
  readonly reason?: string;
  readonly request?: HopeAuditRequestFacts;
}

function refuse(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

/**
 * The trimmed reason a shadow policy carries (`null` for enforce), or a 422 naming what is wrong. Pure, and exported so the in-memory
 * twin of the route service judges a request exactly as the database backend does.
 */
export function validateSignerLicencePolicyInput(
  input: Pick<PutSignerLicencePolicyInput, "mode" | "reason">,
): string | null {
  if (!HOPE_SIGNER_LICENCE_MODES.includes(input.mode)) {
    refuse("mode", `mode must be one of ${HOPE_SIGNER_LICENCE_MODES.join(", ")}`);
  }
  const reason = input.reason?.trim() ?? "";
  if (input.mode === "enforce") {
    if (reason !== "") refuse("reason", "a reason is only recorded for shadow; enforce takes none");
    return null;
  }
  // Real, readable text (the same two rules as the late-deadline override's justification): no control, zero-width or formatting
  // character and no lone surrogate (twenty invisible characters are no reason; a NUL cannot be stored, a 500 where this is a 422), and
  // the minimum is measured with every run of whitespace counted as one space. The maximum is on the text as typed (trimmed).
  if (FORBIDDEN_REASON_CHARACTER.test(reason)) {
    refuse(
      "reason",
      "the reason must be plain text: no control, zero-width or formatting characters",
    );
  }
  const typed = [...reason].length;
  const readable = [...reason.replace(WHITE_SPACE_RUN, " ")].length;
  if (
    readable < HOPE_SIGNER_LICENCE_SHADOW_REASON_MIN ||
    typed > HOPE_SIGNER_LICENCE_SHADOW_REASON_MAX
  ) {
    refuse(
      "reason",
      `running below enforce needs a reason of ${HOPE_SIGNER_LICENCE_SHADOW_REASON_MIN}-${HOPE_SIGNER_LICENCE_SHADOW_REASON_MAX} characters (each run of whitespace counts as one)`,
    );
  }
  // The reason is the only durable record of why a compliance control was lowered, so it enters an immutable trail: screened for
  // SSN- and MBI-shaped values here, at the one place it is written (the same screen the late-deadline override's justification takes;
  // it cannot tell a typed name from a word, so the operator is told not to name a patient). It is kept on the row, in the row trigger's
  // snapshot and in the change event: three copies of the same screened text.
  assertNoPatientIdentifier("reason", reason);
  return reason;
}

/**
 * Idempotent upsert of the organization's policy. Validates first (mode; a reason of 20-200 characters for shadow, none for
 * enforce), reads the previous mode, writes the row and the explicit `m10.signature.licence_policy_changed` audit event on the
 * same transaction (warn when the organization moves below enforce, info on the return), and returns the policy written. The M4
 * row trigger records the row change too. Returning to enforce clears the reason from the row.
 */
export async function putSignerLicencePolicy(
  tx: DbClient,
  input: PutSignerLicencePolicyInput,
): Promise<SignerLicencePolicy> {
  const reason = validateSignerLicencePolicyInput(input);
  const previous = await readSignerLicencePolicy(tx, input.organizationId);
  const now = new Date();
  await tx
    .insert(P)
    .values({
      organizationId: input.organizationId,
      mode: input.mode,
      shadowReason: reason,
      configuredByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: P.organizationId,
      set: {
        mode: input.mode,
        shadowReason: reason,
        configuredByUserId: input.actorUserId,
        updatedAt: now,
      },
    });
  await auditHopeSignerLicencePolicyChanged(tx, {
    organizationId: input.organizationId,
    membershipId: input.membershipId,
    request: input.request,
    previousMode: previous.mode,
    mode: input.mode,
    reason,
  });
  return { mode: input.mode, reason, configuredAt: now };
}
