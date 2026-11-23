export type PayerAuthorizationEventKind =
  | "clinical_document_available"
  | "notification_prepared"
  | "notification_sent"
  | "receipt_acknowledged"
  | "authorization_pending"
  | "authorization_approved"
  | "authorization_denied"
  | "authorization_expired"
  | "authorization_revoked"
  | "unknown_unverified";

export interface PayerAuthorizationEventFact {
  readonly canonicalPayerId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly eventKind: PayerAuthorizationEventKind;
  readonly evidenceStatus: "unverified" | "verified" | "rejected" | "superseded";
  readonly createdAt: string;
  readonly id: string;
  readonly supersedesId?: string | null;
}

export type ClinicalDocumentEvidenceStatus = "missing" | "unverified" | "available";
export type NotificationEvidenceStatus =
  | "missing"
  | "unverified"
  | "prepared"
  | "sent"
  | "acknowledged";
export type AuthorizationEvidenceStatus =
  | "missing"
  | "unverified"
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked"
  | "ambiguous";
export type EvidenceLifecycleStatus =
  | ClinicalDocumentEvidenceStatus
  | NotificationEvidenceStatus
  | AuthorizationEvidenceStatus;

const AUTHORIZATION_KINDS: readonly PayerAuthorizationEventKind[] = [
  "authorization_pending",
  "authorization_approved",
  "authorization_denied",
  "authorization_expired",
  "authorization_revoked",
];
/** Lifecycle order of the notification kinds: a later stage is never undone by a later-recorded earlier one. */
const NOTIFICATION_STAGE: Readonly<Partial<Record<PayerAuthorizationEventKind, number>>> = {
  notification_prepared: 1,
  notification_sent: 2,
  receipt_acknowledged: 3,
};

interface TimedEvent {
  readonly event: PayerAuthorizationEventFact;
  readonly at: number;
}

const instantOf = (createdAt: string): number => {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) throw new RangeError("invalid payer authorization event timestamp");
  return at;
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Verified evidence decides when any exists: an unverified or rejected record never masks a verified one, whatever its
 * timestamp. Only when nothing verified matches do the other records speak (as "unverified").
 */
const decisive = (candidates: readonly TimedEvent[]): readonly TimedEvent[] => {
  const verified = candidates.filter(({ event }) => event.evidenceStatus === "verified");
  return verified.length > 0 ? verified : candidates;
};

/**
 * Project event evidence without equating a local document, notification, receipt or authorization.
 * This is policy-neutral and deliberately does not make a payer route sendable.
 *
 * Timestamps are compared as instants (`2026-01-01T10:00:00Z` equals `...:00.000Z`); an unparseable one throws a
 * `RangeError`. Only verified records decide a lifecycle (see {@link decisive}); a notification is read at its
 * furthest verified stage, ties broken by time.
 */
export function resolvePayerAuthorizationEvidence(input: {
  readonly canonicalPayerId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly events: readonly PayerAuthorizationEventFact[];
}): {
  readonly clinicalDocuments: ClinicalDocumentEvidenceStatus;
  readonly notification: NotificationEvidenceStatus;
  readonly authorization: AuthorizationEvidenceStatus;
  readonly authorizationSatisfied: false;
  readonly reasonCodes: readonly string[];
} {
  const supersededIds = new Set(
    input.events
      .filter((event) => event.evidenceStatus === "verified" && event.supersedesId)
      .map((event) => event.supersedesId as string),
  );
  const relevant = input.events.filter(
    (event) =>
      event.canonicalPayerId === input.canonicalPayerId &&
      event.serviceFrom <= input.serviceFrom &&
      event.serviceTo >= input.serviceTo &&
      !supersededIds.has(event.id) &&
      event.evidenceStatus !== "superseded",
  );
  const newestFirst: readonly TimedEvent[] = relevant
    .map((event) => ({ event, at: instantOf(event.createdAt) }))
    .sort((a, b) => b.at - a.at || compareText(a.event.id, b.event.id));
  const ofKinds = (kinds: readonly PayerAuthorizationEventKind[]) =>
    newestFirst.filter(({ event }) => kinds.includes(event.eventKind));
  const notificationLifecycle = (
    event: PayerAuthorizationEventFact | undefined,
  ): NotificationEvidenceStatus => {
    if (!event) return "missing";
    if (event.evidenceStatus !== "verified") return "unverified";
    switch (event.eventKind) {
      case "notification_prepared":
        return "prepared";
      case "notification_sent":
        return "sent";
      case "receipt_acknowledged":
        return "acknowledged";
      default:
        return "unverified";
    }
  };
  const authorizationLifecycle = (
    event: PayerAuthorizationEventFact | undefined,
  ): AuthorizationEvidenceStatus => {
    if (!event) return "missing";
    if (event.evidenceStatus !== "verified") return "unverified";
    switch (event.eventKind) {
      case "authorization_pending":
        return "pending";
      case "authorization_approved":
        return "approved";
      case "authorization_denied":
        return "denied";
      case "authorization_expired":
        return "expired";
      case "authorization_revoked":
        return "revoked";
      default:
        return "unverified";
    }
  };

  const documentEvent = decisive(ofKinds(["clinical_document_available"]))[0]?.event;
  // Newest-first order plus a strict `>` keeps the newest event of the furthest stage.
  const notificationEvent = decisive(
    ofKinds(["receipt_acknowledged", "notification_sent", "notification_prepared"]),
  ).reduce<TimedEvent | undefined>(
    (best, candidate) =>
      best === undefined ||
      (NOTIFICATION_STAGE[candidate.event.eventKind] ?? 0) >
        (NOTIFICATION_STAGE[best.event.eventKind] ?? 0)
        ? candidate
        : best,
    undefined,
  )?.event;
  const authorizationEvents = decisive(ofKinds(AUTHORIZATION_KINDS));
  const topAuth = authorizationEvents[0];
  const ambiguous =
    topAuth !== undefined &&
    new Set(
      authorizationEvents.filter(({ at }) => at === topAuth.at).map(({ event }) => event.eventKind),
    ).size > 1;
  const authorization = ambiguous ? "ambiguous" : authorizationLifecycle(topAuth?.event);
  const clinicalDocuments = documentEvent
    ? documentEvent.evidenceStatus === "verified"
      ? "available"
      : "unverified"
    : "missing";
  const notification = notificationLifecycle(notificationEvent);
  const reasons: string[] = [];
  if (clinicalDocuments !== "available") reasons.push("CLINICAL_DOCUMENT_EVIDENCE_UNVERIFIED");
  if (notification !== "acknowledged") reasons.push("PAYER_NOTIFICATION_RECEIPT_UNVERIFIED");
  if (authorization !== "approved") reasons.push("PAYER_AUTHORIZATION_UNRESOLVED");
  return {
    clinicalDocuments,
    notification,
    authorization,
    authorizationSatisfied: false,
    reasonCodes: reasons,
  };
}
