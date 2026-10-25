// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-credential-guard.ts — fail-safe handling of a
// clearinghouse credential the vendor REJECTS at runtime (Stedi API key or MAC submitter credential, HTTP 401/403;
// issue #714 / S14). The transports already map a rejection to the terminal `CH_NOT_WIRED`; this layer adds what a
// transport cannot: ONE alert per scope, and a hold during which calls for that scope are answered without touching
// the vendor, so a bad credential is not hammered by every BullMQ retry and ack-cron tick. State is per scope
// (org + provider entity + usage), so one tenant's rejected credential never holds another tenant's calls.
// ponytail: in-memory per process; a durable breaker only if several workers must share the hold.
import {
  CH,
  type ClearinghouseContext,
  type X12WorkerResult,
  degraded,
  scopeKey,
} from "@chartwarden/x12-837-client";

export const CREDENTIAL_REJECTED_ALERT = "m23.clearinghouse.credential_rejected";
/** How long calls for a scope are held after a rejection. */
export const CREDENTIAL_HOLD_MS = 10 * 60_000;
const HELD_REASON = "the clearinghouse credential was rejected; calls are held until it is fixed";

export interface CredentialAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface CredentialGuardDeps {
  readonly binding: { readonly vendor: string | null };
  readonly alerts?: CredentialAlertPort;
  readonly logger?: { error(fields: Record<string, unknown>, message: string): void };
  readonly now?: () => number;
}

const heldUntil = new WeakMap<object, Map<string, number>>();

function holdsOf(deps: object): Map<string, number> {
  const existing = heldUntil.get(deps);
  if (existing) return existing;
  const created = new Map<string, number>();
  heldUntil.set(deps, created);
  return created;
}

/**
 * Run one vendor call. A held scope returns the terminal degraded answer without calling; a `CH_NOT_WIRED` answer
 * (rejected credential) starts the hold and raises the alert once. Alert and log fields are ids and the stable code
 * only: never the key, an MBI, a payload or a vendor response body.
 */
export async function withCredentialGuard<T>(
  deps: CredentialGuardDeps,
  ctx: ClearinghouseContext,
  call: () => Promise<X12WorkerResult<T>>,
): Promise<X12WorkerResult<T>> {
  const now = (deps.now ?? Date.now)();
  const holds = holdsOf(deps);
  const key = scopeKey(ctx);
  if ((holds.get(key) ?? 0) > now) return degraded<T>(CH.NOT_WIRED, HELD_REASON);

  const result = await call();
  if (result.ok || result.degraded.code !== CH.NOT_WIRED) return result;

  holds.set(key, now + CREDENTIAL_HOLD_MS);
  const fields = {
    organizationId: ctx.organizationId,
    providerEntityId: ctx.providerEntityId,
    vendor: deps.binding.vendor,
    code: CH.NOT_WIRED,
  };
  deps.logger?.error(fields, "clearinghouse credential rejected; calls held");
  try {
    await deps.alerts?.dispatch({
      alertCode: CREDENTIAL_REJECTED_ALERT,
      severity: "critical",
      organizationId: ctx.organizationId,
      payload: {
        providerEntityId: ctx.providerEntityId,
        vendor: deps.binding.vendor,
        code: CH.NOT_WIRED,
      },
    });
  } catch {
    deps.logger?.error(fields, "clearinghouse credential alert could not be dispatched");
  }
  return result;
}
