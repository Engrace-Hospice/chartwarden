// apps/backend/src/modules/16-bereavement/alert-port.ts — ADR-0109 D7: the real M16 `AlertPort`.
//
// M16 declares an alert as an EFFECT (`{kind:'alert', alert:<discriminator>}`) and hands the effect runner /
// the cron workers an `AlertPort.emit({organizationId, kind, payload})`. M36's published seam is a different
// shape — `AlertEmitter.emit(orgId, {eventType, payload, severity, correlationId})` — and, until this file,
// nothing bridged the two: the composition root passed no `alerts` at all, so every M16 alert effect was
// skipped silently.
//
// ROUTING IS EXPLICIT AND RULE-BACKED. `M16_ALERT_ROUTES` lists only the kinds that have a platform default
// rule in `@chartwarden/messaging` (`alert-rules-bereavement.ts`). A kind with no route is a no-op here and
// never reaches the emitter: M36 would persist a zero-recipient alert for it ("no rule -> a no-op alert"),
// which is noise, and M16's pre-existing kinds (`outreach_missed`, `contact_unreachable`, ...) have never had
// a seeded rule. Adding a kind to alert means adding its route AND its rule in the same change; the
// `m16-alert-port` test fails when one exists without the other.
//
// The adapter does NOT swallow an emitter failure: whether an alert failure may fail the caller is the
// caller's policy. A caller that raises an alert AFTER its change committed (the death-intake consumers, the
// assessment-task miss pass) uses `emitAlertBestEffort` below: logged with ids only, never thrown.
import type { AlertPort } from "./routes/write-service";

type AlertSeverity = "info" | "warn" | "critical";

/** The slice of M36's `AlertEmitter` this adapter uses (structural: M16 does not import the M36 type). */
export interface M16AlertEmitterLike {
  emit(
    orgId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: AlertSeverity;
      correlationId: string;
    },
  ): Promise<unknown>;
}

interface M16AlertRoute {
  /** The `alert_rule.event_type` the platform default rule is seeded under. */
  readonly eventType: string;
  /** The emit severity; M36 takes the higher of this and the rule's floor. */
  readonly severity: AlertSeverity;
}

/**
 * M16 alert kind -> M36 route, for the kinds that have a seeded platform rule. Keys are the discriminators of
 * `BereavementAlertPayload`.
 */
export const M16_ALERT_ROUTES = {
  death_intake: { eventType: "m16.bereavement.death_intake", severity: "warn" },
  physician_letter_pending_review: {
    eventType: "m16.bereavement.physician_letter_pending_review",
    severity: "info",
  },
  risk_assessment_overdue: {
    eventType: "m16.bereavement.risk_assessment_overdue",
    severity: "warn",
  },
} as const satisfies Readonly<Record<string, M16AlertRoute>>;

function routeFor(kind: string): M16AlertRoute | undefined {
  return Object.hasOwn(M16_ALERT_ROUTES, kind)
    ? M16_ALERT_ROUTES[kind as keyof typeof M16_ALERT_ROUTES]
    : undefined;
}

/**
 * The M36 dedupe key: `(org, correlationId)` collapses a repeat onto the first alert. Keyed on the subject ids
 * in the payload (every `*Id` key holding a string/number/boolean, in key order) so a redelivered event does
 * not page twice and a second subject (another task, another plan) does. Ids only: no PHI reaches the key.
 */
function correlationIdFor(kind: string, payload: Readonly<Record<string, unknown>>): string {
  const subject = Object.keys(payload)
    .filter((key) => key.endsWith("Id"))
    .sort()
    .map((key) => payload[key])
    .filter((value): value is string | number | boolean =>
      ["string", "number", "boolean"].includes(typeof value),
    );
  return ["m16", kind, ...subject].join(":");
}

/**
 * Build the M16 `AlertPort` over the M36 `AlertEmitter` seam. The emitter is resolved lazily, per emit, so the
 * composition root can pass `() => getSeam("AlertEmitter")` before the seam registry is fully populated and an
 * unrouted kind never touches the seam at all.
 */
export function createM16AlertPort(getEmitter: () => M16AlertEmitterLike): AlertPort {
  return {
    async emit({ organizationId, kind, payload }) {
      const route = routeFor(kind);
      if (route === undefined) return;
      await getEmitter().emit(organizationId, {
        eventType: route.eventType,
        payload,
        severity: route.severity,
        correlationId: correlationIdFor(kind, payload),
      });
    },
  };
}

/**
 * Raise an advisory alert AFTER the change it announces committed. A failure is logged (organization, kind and the payload's subject ids
 * only, never PHI) and swallowed: the committed change stands, a consumer retry would find it already done and would NOT re-alert, so
 * throwing here would only make the relay redeliver for nothing. The backstops are the review queue, the worklist and the 48h
 * counselor-assignment alert. Unbound alerts => skipped.
 */
export async function emitAlertBestEffort(
  alerts: AlertPort | undefined,
  input: Parameters<AlertPort["emit"]>[0],
): Promise<void> {
  if (alerts === undefined) return;
  try {
    await alerts.emit(input);
  } catch (err) {
    const ids = Object.fromEntries(
      Object.entries(input.payload).filter(
        ([key, value]) => key.endsWith("Id") && typeof value === "string",
      ),
    );
    // eslint-disable-next-line no-console -- consumers and standalone workers log via console (M9/M20 precedent).
    console.warn("m16.alert: emit failed after commit (best-effort; the committed change stands)", {
      organizationId: input.organizationId,
      kind: input.kind,
      ...ids,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
