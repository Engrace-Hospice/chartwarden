// apps/backend/src/modules/02-identity/auditor-second-factor-store.ts - the `two_factor` row operations behind an
// external auditor's second factor (M2 §7.7). The row is the SAME one the staff TOTP stack reads
// (`createTotpStepUpVerifier` decrypts `secret_encrypted`), so an auditor's factor is a first-class M2 factor;
// what differs is only the enrolment ceremony (auditor-enrolment.ts) and that recovery codes are stored HASHED
// as `[{ hash, usedAt }]` - the shape the `two_factor.backup_codes_encrypted` column comment specifies.
//
// EVERY operation here runs inside the caller's transaction and the row is locked `FOR UPDATE` first: attempts
// for one user are serialised, so the failure counter, the replay guard (`last_used_at` = start of the last
// accepted TOTP step) and the single use of a recovery code cannot be raced. Lockout state lives in the
// columns Better Auth's own plugin uses (`failed_verification_count`, `locked_until`).
import {
  type TotpSecretOptions,
  hashRecoveryCode,
  recoveryCodeMatches,
  totpStepStart,
} from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { and, desc, eq } from "drizzle-orm";

/** Consecutive wrong codes before the factor locks. */
export const AUDITOR_2FA_MAX_FAILURES = 5;
/** How long a locked factor refuses every code (a correct one included). */
export const AUDITOR_2FA_LOCK_MS = 15 * 60 * 1000;

export interface RecoveryCodeEntry {
  readonly hash: string;
  readonly usedAt: string | null;
}

export interface TwoFactorState {
  readonly id: string;
  readonly secretEncrypted: string;
  readonly verified: boolean;
  readonly failedCount: number;
  readonly lockedUntil: Date | null;
  readonly lastUsedAt: Date | null;
  readonly recoveryCodes: readonly RecoveryCodeEntry[];
}

function parseRecoveryCodes(raw: unknown): RecoveryCodeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecoveryCodeEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { hash, usedAt } = entry as { hash?: unknown; usedAt?: unknown };
    if (typeof hash !== "string") continue;
    out.push({ hash, usedAt: typeof usedAt === "string" ? usedAt : null });
  }
  return out;
}

/** Lock and read the user's second-factor row (null when there is none). */
export async function lockTwoFactor(
  tx: DbClient,
  userId: string,
  options: { readonly lock: boolean } = { lock: true },
): Promise<TwoFactorState | null> {
  const query = tx
    .select({
      id: schema.twoFactor.id,
      secretEncrypted: schema.twoFactor.secretEncrypted,
      verified: schema.twoFactor.verified,
      failedCount: schema.twoFactor.failedVerificationCount,
      lockedUntil: schema.twoFactor.lockedUntil,
      lastUsedAt: schema.twoFactor.lastUsedAt,
      backupCodes: schema.twoFactor.backupCodesEncrypted,
    })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, userId))
    .orderBy(desc(schema.twoFactor.createdAt))
    .limit(1);
  const [row] = await (options.lock ? query.for("update") : query);
  if (!row) return null;
  return {
    id: row.id,
    secretEncrypted: row.secretEncrypted,
    verified: row.verified,
    failedCount: row.failedCount,
    lockedUntil: row.lockedUntil,
    lastUsedAt: row.lastUsedAt,
    recoveryCodes: parseRecoveryCodes(row.backupCodes),
  };
}

/** Seconds a still-locked factor stays locked, or 0 when it is usable. */
export function lockRemainingSec(state: Pick<TwoFactorState, "lockedUntil">, now: Date): number {
  if (!state.lockedUntil || state.lockedUntil.getTime() <= now.getTime()) return 0;
  return Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000);
}

/** Replace any unconfirmed secret with a fresh one (never touches a confirmed factor - the caller checks). */
export async function replacePendingSecret(
  tx: DbClient,
  userId: string,
  storedSecret: string,
): Promise<void> {
  await tx
    .delete(schema.twoFactor)
    .where(and(eq(schema.twoFactor.userId, userId), eq(schema.twoFactor.verified, false)));
  await tx.insert(schema.twoFactor).values({
    userId,
    method: "totp",
    secretEncrypted: storedSecret,
    backupCodesEncrypted: [],
    verified: false,
  });
}

export interface FailureOutcome {
  readonly failedCount: number;
  readonly lockedUntil: Date | null;
  readonly justLocked: boolean;
}

/** Count one wrong code; lock at the threshold. An expired lock starts the count from zero. */
export async function recordFailedAttempt(
  tx: DbClient,
  state: TwoFactorState,
  now: Date,
): Promise<FailureOutcome> {
  const expired = state.lockedUntil !== null && state.lockedUntil.getTime() <= now.getTime();
  const failedCount = (expired ? 0 : state.failedCount) + 1;
  const lockedUntil =
    failedCount >= AUDITOR_2FA_MAX_FAILURES ? new Date(now.getTime() + AUDITOR_2FA_LOCK_MS) : null;
  const updated = await tx
    .update(schema.twoFactor)
    .set({ failedVerificationCount: failedCount, lockedUntil })
    .where(eq(schema.twoFactor.id, state.id))
    .returning({ id: schema.twoFactor.id });
  if (updated.length !== 1) throw new Error("two_factor failure counter update matched no row");
  return { failedCount, lockedUntil, justLocked: lockedUntil !== null };
}

/** Is this TOTP step not strictly newer than the last accepted one? (a replay) */
export function isReplayedStep(state: Pick<TwoFactorState, "lastUsedAt">, step: number): boolean {
  return state.lastUsedAt !== null && totpStepStart(step).getTime() <= state.lastUsedAt.getTime();
}

/** A correct TOTP code: clear the counter, advance the replay guard and (on enrolment) confirm the factor. */
export async function recordTotpSuccess(
  tx: DbClient,
  state: TwoFactorState,
  step: number,
  options: { readonly confirm: boolean },
): Promise<void> {
  const updated = await tx
    .update(schema.twoFactor)
    .set({
      failedVerificationCount: 0,
      lockedUntil: null,
      lastUsedAt: totpStepStart(step),
      ...(options.confirm ? { verified: true } : {}),
    })
    .where(eq(schema.twoFactor.id, state.id))
    .returning({ id: schema.twoFactor.id });
  if (updated.length !== 1) throw new Error("two_factor success update matched no row");
}

/** Store a fresh set of recovery codes as hashes (replaces any previous set). */
export async function storeRecoveryCodes(
  tx: DbClient,
  state: TwoFactorState,
  codes: readonly string[],
  options: TotpSecretOptions = {},
): Promise<void> {
  const entries = codes.map((code) => ({ hash: hashRecoveryCode(code, options), usedAt: null }));
  const updated = await tx
    .update(schema.twoFactor)
    .set({ backupCodesEncrypted: entries })
    .where(eq(schema.twoFactor.id, state.id))
    .returning({ id: schema.twoFactor.id });
  if (updated.length !== 1) throw new Error("two_factor recovery-code update matched no row");
}

/**
 * Spend a recovery code. Returns true when `typed` matched an UNUSED code (now marked used, counter cleared),
 * false otherwise. The row is already locked, so a code can be spent exactly once.
 */
export async function spendRecoveryCode(
  tx: DbClient,
  state: TwoFactorState,
  typed: string,
  now: Date,
  options: TotpSecretOptions = {},
): Promise<boolean> {
  // Compare against every entry (no early exit) so timing does not reveal which slot matched.
  let hitIndex = -1;
  state.recoveryCodes.forEach((entry, index) => {
    if (recoveryCodeMatches(typed, entry.hash, options) && entry.usedAt === null && hitIndex < 0) {
      hitIndex = index;
    }
  });
  if (hitIndex < 0) return false;
  const next = state.recoveryCodes.map((entry, index) =>
    index === hitIndex ? { hash: entry.hash, usedAt: now.toISOString() } : entry,
  );
  const updated = await tx
    .update(schema.twoFactor)
    .set({ backupCodesEncrypted: next, failedVerificationCount: 0, lockedUntil: null })
    .where(eq(schema.twoFactor.id, state.id))
    .returning({ id: schema.twoFactor.id });
  if (updated.length !== 1) throw new Error("two_factor recovery-code spend matched no row");
  return true;
}

/** How many recovery codes remain unspent. */
export function unspentRecoveryCodes(state: Pick<TwoFactorState, "recoveryCodes">): number {
  return state.recoveryCodes.filter((entry) => entry.usedAt === null).length;
}
