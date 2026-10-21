// apps/backend/src/modules/02-identity/auditor-enrolment.ts - the external auditor's ENROLMENT ceremony (M2 §7.7,
// architecture §7.5 grant steps 2-3): accept the versioned BAA / engagement terms and prove a second factor
// BEFORE the session can read anything.
//
// THE STATE MACHINE. Redeeming an emailed link (auditor-redemption.ts) mints an ENROLMENT-stage session
// (`session.scope.auditorStage = "enrolment"`): the authenticate hook lets it call exactly the enrolment routes,
// it holds no role and carries no engagement read scope. This service moves it to `active`:
//
//     enrolment --accept terms (BAA)-----------------+
//               --enrol TOTP (begin, confirm) --------+--> both done ==> grant role, stage = active,
//               --or: present TOTP / recovery code ---+                  step-up stamped (totp)
//
// The auditor's FIRST engagement enrols TOTP (the shared `two_factor` row, auditor-second-factor-store.ts) and is
// shown ten recovery codes ONCE; every later redemption - another engagement, or a re-issued link - must PRESENT
// the factor (a code, or a single-use recovery code) because the enrolled factor is user-level and is never
// replaced through a link. Activation is the ONLY place the `external_auditor` role is granted, so a session that
// has not finished cannot read even if a route were wired by mistake.
//
// FAIL CLOSED / AUDITED. Every step is audited (M4). A refusal is RECORDED AND COMMITTED, then thrown by the
// route after the transaction (throwing inside `withOrgContext` rolls the audit row back with everything else).
// Wrong codes count toward a lockout (5 in a row -> 15 minutes, in the Better Auth lockout columns); a TOTP step
// cannot be replayed; a recovery code is single use. SMS is never a factor.
import { type AuditContext, audit } from "@chartwarden/audit";
import {
  type TotpSecretOptions,
  createTotpEnrolment,
  generateRecoveryCodes,
  matchTotpStep,
} from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  type AuditorAccessPort,
  type AuditorRefusalReason,
  auditorRefusalError,
} from "./auditor-redemption";
import {
  AUDITOR_2FA_MAX_FAILURES,
  type TwoFactorState,
  isReplayedStep,
  lockRemainingSec,
  lockTwoFactor,
  recordFailedAttempt,
  recordTotpSuccess,
  replacePendingSecret,
  spendRecoveryCode,
  storeRecoveryCodes,
  unspentRecoveryCodes,
} from "./auditor-second-factor-store";
import { type AuditorTerms, CURRENT_AUDITOR_TERMS, isCurrentTerms } from "./auditor-terms";

export type EnrolmentRefusalReason =
  | AuditorRefusalReason
  | "session_invalid"
  | "already_active"
  | "terms_stale"
  | "terms_not_accepted"
  | "factor_locked"
  | "factor_invalid"
  | "factor_already_enrolled"
  | "factor_not_started"
  | "factor_not_enrolled";

export interface EnrolmentRefusal {
  readonly reason: EnrolmentRefusalReason;
  readonly retryAfterSec?: number;
}

export type EnrolmentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: EnrolmentRefusal };

export interface AuditorEnrolmentDeps {
  readonly db: DbClient;
  /** M3's side: the pre-flight engagement check and the activation-time role grant. */
  readonly access: AuditorAccessPort;
  /** Called once an activation has COMMITTED (drop the actor's cached RBAC permission set). */
  readonly onActivated?: (organizationId: string, userId: string) => void;
  readonly terms?: AuditorTerms;
  readonly now?: () => Date;
  /** Test seam for the Better Auth secret / KEK. */
  readonly secrets?: TotpSecretOptions;
}

/** The request-derived identity of the calling enrolment session (all server-stamped, none from the body). */
export interface EnrolmentActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly engagementId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export type SecondFactorStatus = "enrol" | "challenge" | "verified";

export interface EnrolmentState {
  readonly stage: "enrolment" | "active";
  readonly engagementId: string;
  readonly terms: Pick<AuditorTerms, "version" | "title" | "text" | "sha256">;
  readonly baaAccepted: boolean;
  /** enrol: no confirmed factor yet; challenge: a confirmed factor not yet presented; verified: done. */
  readonly secondFactor: SecondFactorStatus;
  /** An unconfirmed secret exists (the auditor began enrolment but has not confirmed a code). */
  readonly totpPending: boolean;
  readonly lockedUntil: string | null;
  readonly expiresAt: string;
}

export interface BeganTotp {
  readonly otpauthUri: string;
  readonly manualEntryKey: string;
}

export interface ConfirmedTotp {
  readonly recoveryCodes: readonly string[];
  readonly state: EnrolmentState;
}

export type PresentedFactor =
  | { readonly kind: "totp"; readonly code: string }
  | { readonly kind: "recovery"; readonly code: string };

/** refusal -> typed envelope. Locked answers 429 and carries `Retry-After` via the caller. */
export function enrolmentRefusalError(refusal: EnrolmentRefusal): ChartWardenError {
  switch (refusal.reason) {
    case "session_invalid":
      return new ChartWardenError("SESSION_INVALID", "this auditor session is not valid", 401);
    case "already_active":
      return new ChartWardenError(
        "AUDITOR_ENROLMENT_COMPLETE",
        "this auditor session has already completed enrolment",
        409,
      );
    case "terms_stale":
      return new ChartWardenError(
        "AUDITOR_TERMS_STALE",
        "the engagement terms have changed; reload and review the current terms",
        409,
      );
    case "terms_not_accepted":
      return new ChartWardenError(
        "AUDITOR_TERMS_REQUIRED",
        "accept the engagement terms before continuing",
        409,
      );
    case "factor_locked":
      return new ChartWardenError(
        "AUDITOR_2FA_LOCKED",
        "too many incorrect codes; try again later",
        429,
      );
    case "factor_invalid":
      return new ChartWardenError("AUDITOR_2FA_INVALID", "that code is not valid", 401);
    case "factor_already_enrolled":
      return new ChartWardenError(
        "AUDITOR_2FA_ALREADY_ENROLLED",
        "a second factor is already enrolled; present a code from it",
        409,
      );
    case "factor_not_started":
      return new ChartWardenError(
        "AUDITOR_2FA_NOT_STARTED",
        "start authenticator setup before confirming a code",
        409,
      );
    case "factor_not_enrolled":
      return new ChartWardenError(
        "AUDITOR_2FA_NOT_ENROLLED",
        "no second factor is enrolled yet; set up an authenticator first",
        409,
      );
    default:
      return auditorRefusalError(refusal.reason);
  }
}

interface SessionFacts {
  readonly stage: "enrolment" | "active";
  readonly scope: Record<string, unknown>;
  readonly engagementEnd: Date;
  readonly expiresAt: Date;
}

const ok = <T>(value: T): EnrolmentResult<T> => ({ ok: true, value });
const fail = <T>(refusal: EnrolmentRefusal): EnrolmentResult<T> => ({ ok: false, refusal });
const refuse = <T>(reason: EnrolmentRefusalReason, retryAfterSec?: number): EnrolmentResult<T> =>
  fail<T>({ reason, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });

function auditCtx(actor: EnrolmentActor): AuditContext {
  return {
    organizationId: actor.organizationId,
    userId: actor.userId,
    actorKind: "user",
    correlationId: actor.correlationId,
    ...(actor.requestId ? { requestId: actor.requestId } : {}),
    ...(actor.ip ? { sourceIp: actor.ip } : {}),
    ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
  };
}

export function createAuditorEnrolment(deps: AuditorEnrolmentDeps) {
  const terms = deps.terms ?? CURRENT_AUDITOR_TERMS;
  const clock = deps.now ?? (() => new Date());

  const scoped = <T>(actor: EnrolmentActor, run: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, { organizationId: actor.organizationId, userId: actor.userId }, (tx) =>
      run(tx as unknown as DbClient),
    );

  async function record(
    tx: DbClient,
    actor: EnrolmentActor,
    eventType: string,
    outcome: "success" | "denied",
    context: Record<string, unknown>,
    severity: "info" | "warn" = outcome === "denied" ? "warn" : "info",
  ): Promise<void> {
    await audit(tx, auditCtx(actor), {
      eventType,
      resourceKind: "auditor_engagement_session",
      resourceId: actor.engagementId,
      outcome,
      severity,
      retentionClass: "compliance",
      context: {
        organizationId: actor.organizationId,
        engagementId: actor.engagementId,
        sessionId: actor.sessionId,
        ...context,
      },
    });
  }

  /** Lock and validate the calling session: an auditor session of THIS user, org and engagement, still in window. */
  async function loadSession(
    tx: DbClient,
    actor: EnrolmentActor,
    now: Date,
  ): Promise<SessionFacts | null> {
    const [row] = await tx
      .select({
        scope: schema.sessions.scope,
        org: schema.sessions.activeOrganizationId,
        engagementEnd: schema.sessions.engagementEnd,
        expiresAt: schema.sessions.expiresAt,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, actor.sessionId),
          eq(schema.sessions.userId, actor.userId),
          eq(schema.sessions.sessionClass, "auditor"),
        ),
      )
      .limit(1)
      .for("update");
    if (!row || row.org !== actor.organizationId || !row.engagementEnd) return null;
    const scope = (row.scope && typeof row.scope === "object" ? row.scope : {}) as Record<
      string,
      unknown
    >;
    if (scope.engagementId !== actor.engagementId) return null;
    if (row.engagementEnd.getTime() <= now.getTime() || row.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return {
      stage: scope.auditorStage === "active" ? "active" : "enrolment",
      scope,
      engagementEnd: row.engagementEnd,
      expiresAt: row.expiresAt,
    };
  }

  async function membershipOf(tx: DbClient, actor: EnrolmentActor): Promise<string | null> {
    const [row] = await tx
      .select({ id: schema.memberships.id, status: schema.memberships.status })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, actor.userId),
          eq(schema.memberships.organizationId, actor.organizationId),
          ne(schema.memberships.status, "revoked"),
        ),
      )
      .limit(1);
    return row && row.status === "active" ? row.id : null;
  }

  async function termsAccepted(tx: DbClient, actor: EnrolmentActor): Promise<boolean> {
    const rows = await tx
      .select({ id: schema.auditorBaaAcceptances.id })
      .from(schema.auditorBaaAcceptances)
      .where(
        and(
          eq(schema.auditorBaaAcceptances.organizationId, actor.organizationId),
          eq(schema.auditorBaaAcceptances.engagementId, actor.engagementId),
          eq(schema.auditorBaaAcceptances.userId, actor.userId),
          eq(schema.auditorBaaAcceptances.termsSha256, terms.sha256),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

  function stateOf(
    session: SessionFacts,
    actor: EnrolmentActor,
    factor: TwoFactorState | null,
    baaAccepted: boolean,
    now: Date,
  ): EnrolmentState {
    const proven = typeof session.scope.factorProvenAt === "string";
    const confirmed = factor?.verified === true;
    const secondFactor: SecondFactorStatus = !confirmed
      ? "enrol"
      : proven
        ? "verified"
        : "challenge";
    const remaining = factor ? lockRemainingSec(factor, now) : 0;
    return {
      stage: session.stage,
      engagementId: actor.engagementId,
      terms: {
        version: terms.version,
        title: terms.title,
        text: terms.text,
        sha256: terms.sha256,
      },
      baaAccepted,
      secondFactor,
      totpPending: factor !== null && !factor.verified,
      lockedUntil: remaining > 0 && factor?.lockedUntil ? factor.lockedUntil.toISOString() : null,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  /** Pre-flight for every mutating step: M3 still considers the engagement live for this auditor. */
  async function preflight(
    tx: DbClient,
    actor: EnrolmentActor,
    now: Date,
  ): Promise<EnrolmentRefusalReason | null> {
    const refusal = await deps.access.check(tx, {
      organizationId: actor.organizationId,
      engagementId: actor.engagementId,
      membershipId: await membershipOf(tx, actor),
      at: now,
    });
    return refusal;
  }

  /** If terms are accepted AND a factor was proven in this session, grant the role and go `active`. */
  async function activateIfReady(
    tx: DbClient,
    actor: EnrolmentActor,
    session: SessionFacts,
    now: Date,
  ): Promise<boolean> {
    const proven = typeof session.scope.factorProvenAt === "string";
    // The method the factor was proven BY rides the session scope, so terms accepted AFTER a recovery-code
    // login never stamp a TOTP step-up the auditor did not perform.
    const factorMethod = session.scope.factorMethod === "recovery_code" ? "recovery_code" : "totp";
    if (!proven || !(await termsAccepted(tx, actor))) return false;
    const membershipId = await membershipOf(tx, actor);
    if (!membershipId) throw new Error("auditor activation found no active membership");
    await deps.access.grant(tx, {
      organizationId: actor.organizationId,
      engagementId: actor.engagementId,
      membershipId,
      userId: actor.userId,
      expiresAt: session.engagementEnd,
    });
    const stepUp =
      factorMethod === "totp" ? { lastStepUpAt: now, lastStepUpFactor: "totp" as const } : {};
    const updated = await tx
      .update(schema.sessions)
      .set({
        scope: sql`COALESCE(${schema.sessions.scope}, '{}'::jsonb) || ${JSON.stringify({ auditorStage: "active" })}::jsonb`,
        updatedAt: now,
        ...stepUp,
      })
      .where(
        and(
          eq(schema.sessions.id, actor.sessionId),
          eq(schema.sessions.userId, actor.userId),
          eq(schema.sessions.sessionClass, "auditor"),
        ),
      )
      .returning({ id: schema.sessions.id });
    if (updated.length !== 1) throw new Error("auditor session activation matched no row");
    await record(tx, actor, "m2.auditor_enrolment.activated", "success", {
      factorMethod,
      termsVersion: terms.version,
      windowEnd: session.engagementEnd.toISOString(),
    });
    return true;
  }

  async function markFactorProven(
    tx: DbClient,
    actor: EnrolmentActor,
    session: SessionFacts,
    method: "totp" | "recovery_code",
    now: Date,
  ): Promise<SessionFacts> {
    const patch = { factorProvenAt: now.toISOString(), factorMethod: method };
    const updated = await tx
      .update(schema.sessions)
      .set({
        scope: sql`COALESCE(${schema.sessions.scope}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(schema.sessions.id, actor.sessionId), eq(schema.sessions.userId, actor.userId)))
      .returning({ id: schema.sessions.id });
    if (updated.length !== 1) throw new Error("auditor session factor stamp matched no row");
    return { ...session, scope: { ...session.scope, ...patch } };
  }

  /** Shared gate: a live enrolment session whose engagement M3 still honours. */
  async function openStep(
    tx: DbClient,
    actor: EnrolmentActor,
    now: Date,
  ): Promise<{ session: SessionFacts } | { refusal: EnrolmentRefusal }> {
    const session = await loadSession(tx, actor, now);
    if (!session) return { refusal: { reason: "session_invalid" } };
    if (session.stage === "active") return { refusal: { reason: "already_active" } };
    const engagementRefusal = await preflight(tx, actor, now);
    if (engagementRefusal) {
      await record(tx, actor, "m2.auditor_enrolment.refused", "denied", {
        reason: engagementRefusal,
      });
      return { refusal: { reason: engagementRefusal } };
    }
    return { session };
  }

  async function currentState(
    tx: DbClient,
    actor: EnrolmentActor,
    session: SessionFacts,
    now: Date,
  ): Promise<EnrolmentState> {
    const factor = await lockTwoFactor(tx, actor.userId, { lock: false });
    return stateOf(session, actor, factor, await termsAccepted(tx, actor), now);
  }

  return {
    /** Read-only: where the auditor is in the ceremony. Works for an active session too (the final poll). */
    async getState(actor: EnrolmentActor): Promise<EnrolmentResult<EnrolmentState>> {
      const now = clock();
      return scoped(actor, async (tx) => {
        const session = await loadSession(tx, actor, now);
        if (!session) return refuse<EnrolmentState>("session_invalid");
        return ok(await currentState(tx, actor, session, now));
      });
    },

    /** Accept the CURRENT terms. Idempotent: re-posting the same acceptance records nothing new. */
    async acceptTerms(
      actor: EnrolmentActor,
      input: { termsVersion: string; termsSha256: string; acceptedName: string },
    ): Promise<EnrolmentResult<EnrolmentState>> {
      const now = clock();
      return scoped(actor, async (tx) => {
        const opened = await openStep(tx, actor, now);
        if ("refusal" in opened) return fail<EnrolmentState>(opened.refusal);
        let { session } = opened;
        if (!isCurrentTerms(input, terms)) {
          await record(tx, actor, "m2.auditor_enrolment.refused", "denied", {
            reason: "terms_stale",
            postedVersion: input.termsVersion,
          });
          return refuse<EnrolmentState>("terms_stale");
        }
        const inserted = await tx
          .insert(schema.auditorBaaAcceptances)
          .values({
            organizationId: actor.organizationId,
            engagementId: actor.engagementId,
            userId: actor.userId,
            termsVersion: terms.version,
            termsSha256: terms.sha256,
            acceptedName: input.acceptedName.trim(),
            acceptedAt: now,
            sessionId: actor.sessionId,
            ...(actor.ip ? { ipAddress: actor.ip } : {}),
            ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
          })
          .onConflictDoNothing()
          .returning({ id: schema.auditorBaaAcceptances.id });
        if (inserted.length === 1) {
          await record(tx, actor, "m2.auditor_enrolment.baa_accepted", "success", {
            termsVersion: terms.version,
            termsSha256: terms.sha256,
            acceptanceId: inserted[0]?.id,
          });
        }
        const activated = await activateIfReady(tx, actor, session, now);
        if (activated) session = { ...session, stage: "active" };
        return ok(await currentState(tx, actor, session, now));
      }).then((result) => {
        if (result.ok && result.value.stage === "active") {
          deps.onActivated?.(actor.organizationId, actor.userId);
        }
        return result;
      });
    },

    /** Start authenticator setup (first engagement only): a fresh unconfirmed secret and its otpauth URI. */
    async beginTotp(actor: EnrolmentActor): Promise<EnrolmentResult<BeganTotp>> {
      const now = clock();
      return scoped(actor, async (tx) => {
        const opened = await openStep(tx, actor, now);
        if ("refusal" in opened) return fail<BeganTotp>(opened.refusal);
        const factor = await lockTwoFactor(tx, actor.userId);
        if (factor?.verified) return refuse<BeganTotp>("factor_already_enrolled");
        const [user] = await tx
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, actor.userId))
          .limit(1);
        // Auditor enrolment is email-invitation-only. A username-only staff identity never reaches
        // this session class; fail closed if an invalid/misclassified identity has no email label.
        if (!user?.email) return refuse<BeganTotp>("session_invalid");
        const enrolment = await createTotpEnrolment(user.email, deps.secrets);
        await replacePendingSecret(tx, actor.userId, enrolment.storedSecret);
        await record(tx, actor, "m2.auditor_enrolment.totp_started", "success", {
          method: "totp",
        });
        return ok({
          otpauthUri: enrolment.otpauthUri,
          manualEntryKey: enrolment.manualEntryKey,
        });
      });
    },

    /** Confirm the first code: the factor becomes real, recovery codes are issued ONCE. */
    async confirmTotp(
      actor: EnrolmentActor,
      code: string,
    ): Promise<EnrolmentResult<ConfirmedTotp>> {
      const now = clock();
      const result = await scoped(actor, async (tx) => {
        const opened = await openStep(tx, actor, now);
        if ("refusal" in opened) return fail<ConfirmedTotp>(opened.refusal);
        const factor = await lockTwoFactor(tx, actor.userId);
        if (!factor) return refuse<ConfirmedTotp>("factor_not_started");
        if (factor.verified) return refuse<ConfirmedTotp>("factor_already_enrolled");
        const gate = await checkTotp(tx, actor, factor, code, now, "enrolment");
        if (!gate.ok) return gate.result as EnrolmentResult<ConfirmedTotp>;
        await recordTotpSuccess(tx, factor, gate.step, { confirm: true });
        const recoveryCodes = generateRecoveryCodes();
        await storeRecoveryCodes(tx, factor, recoveryCodes, deps.secrets);
        await record(tx, actor, "m2.auditor_enrolment.totp_enrolled", "success", {
          method: "totp",
          recoveryCodesIssued: recoveryCodes.length,
        });
        let session = await markFactorProven(tx, actor, opened.session, "totp", now);
        if (await activateIfReady(tx, actor, session, now)) {
          session = { ...session, stage: "active" };
        }
        const state = await currentState(tx, actor, session, now);
        return ok({ recoveryCodes, state });
      });
      if (result.ok && result.value.state.stage === "active") {
        deps.onActivated?.(actor.organizationId, actor.userId);
      }
      return result;
    },

    /** Present an ENROLLED factor (a TOTP code, or a single-use recovery code) for this session. */
    async presentFactor(
      actor: EnrolmentActor,
      presented: PresentedFactor,
    ): Promise<EnrolmentResult<EnrolmentState>> {
      const now = clock();
      const result = await scoped(actor, async (tx) => {
        const opened = await openStep(tx, actor, now);
        if ("refusal" in opened) return fail<EnrolmentState>(opened.refusal);
        let { session } = opened;
        const factor = await lockTwoFactor(tx, actor.userId);
        if (!factor?.verified) return refuse<EnrolmentState>("factor_not_enrolled");
        if (typeof session.scope.factorProvenAt === "string") {
          return ok(await currentState(tx, actor, session, now)); // already proven: never burn another code
        }
        let method: "totp" | "recovery_code";
        if (presented.kind === "totp") {
          const gate = await checkTotp(tx, actor, factor, presented.code, now, "challenge");
          if (!gate.ok) return gate.result as EnrolmentResult<EnrolmentState>;
          await recordTotpSuccess(tx, factor, gate.step, { confirm: false });
          method = "totp";
        } else {
          const gate = await checkRecovery(tx, actor, factor, presented.code, now);
          if (!gate.ok) return gate.result as EnrolmentResult<EnrolmentState>;
          method = "recovery_code";
        }
        await record(tx, actor, "m2.auditor_enrolment.factor_verified", "success", { method });
        session = await markFactorProven(tx, actor, session, method, now);
        if (await activateIfReady(tx, actor, session, now)) {
          session = { ...session, stage: "active" };
        }
        return ok(await currentState(tx, actor, session, now));
      });
      if (result.ok && result.value.stage === "active") {
        deps.onActivated?.(actor.organizationId, actor.userId);
      }
      return result;
    },
  };

  /** Lockout gate + TOTP match + replay guard. On any failure the failure is counted, audited, and returned. */
  async function checkTotp(
    tx: DbClient,
    actor: EnrolmentActor,
    factor: TwoFactorState,
    code: string,
    now: Date,
    phase: "enrolment" | "challenge",
  ): Promise<{ ok: true; step: number } | { ok: false; result: EnrolmentResult<never> }> {
    const locked = lockRemainingSec(factor, now);
    if (locked > 0) return { ok: false, result: await lockedRefusal(tx, actor, locked) };
    const match = await matchTotpStep(factor.secretEncrypted, code, now.getTime(), deps.secrets);
    if (match.ok && !isReplayedStep(factor, match.step)) return { ok: true, step: match.step };
    const reason = match.ok ? "totp_code_replayed" : match.reason;
    return {
      ok: false,
      result: await failedAttempt(tx, actor, factor, now, "totp", phase, reason),
    };
  }

  async function checkRecovery(
    tx: DbClient,
    actor: EnrolmentActor,
    factor: TwoFactorState,
    code: string,
    now: Date,
  ): Promise<{ ok: true } | { ok: false; result: EnrolmentResult<never> }> {
    const locked = lockRemainingSec(factor, now);
    if (locked > 0) return { ok: false, result: await lockedRefusal(tx, actor, locked) };
    if (await spendRecoveryCode(tx, factor, code, now, deps.secrets)) {
      await record(tx, actor, "m2.auditor_enrolment.recovery_code_used", "success", {
        remaining: unspentRecoveryCodes(factor) - 1,
      });
      return { ok: true };
    }
    return {
      ok: false,
      result: await failedAttempt(
        tx,
        actor,
        factor,
        now,
        "recovery_code",
        "challenge",
        "recovery_code_invalid",
      ),
    };
  }

  async function lockedRefusal(
    tx: DbClient,
    actor: EnrolmentActor,
    retryAfterSec: number,
  ): Promise<EnrolmentResult<never>> {
    await record(tx, actor, "m2.auditor_enrolment.refused", "denied", {
      reason: "factor_locked",
      retryAfterSec,
    });
    return refuse<never>("factor_locked", retryAfterSec);
  }

  async function failedAttempt(
    tx: DbClient,
    actor: EnrolmentActor,
    factor: TwoFactorState,
    now: Date,
    method: "totp" | "recovery_code",
    phase: "enrolment" | "challenge",
    detail: string,
  ): Promise<EnrolmentResult<never>> {
    const outcome = await recordFailedAttempt(tx, factor, now);
    await record(tx, actor, "m2.auditor_enrolment.factor_failed", "denied", {
      method,
      phase,
      detail,
      failedCount: outcome.failedCount,
      maxFailures: AUDITOR_2FA_MAX_FAILURES,
    });
    if (outcome.justLocked && outcome.lockedUntil) {
      await record(
        tx,
        actor,
        "m2.auditor_enrolment.locked",
        "denied",
        { lockedUntil: outcome.lockedUntil.toISOString() },
        "warn",
      );
      return refuse<never>(
        "factor_locked",
        Math.ceil((outcome.lockedUntil.getTime() - now.getTime()) / 1000),
      );
    }
    return refuse<never>("factor_invalid");
  }
}

export type AuditorEnrolment = ReturnType<typeof createAuditorEnrolment>;
