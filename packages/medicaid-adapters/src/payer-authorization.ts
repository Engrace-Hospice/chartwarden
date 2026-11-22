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

export type EvidenceLifecycleStatus =
  | "missing"
  | "unverified"
  | "available"
  | "prepared"
  | "sent"
  | "acknowledged"
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked"
  | "ambiguous";

/**
 * Project event evidence without equating a local document, notification, receipt or authorization.
 * This is policy-neutral and deliberately does not make a payer route sendable.
 */
export function resolvePayerAuthorizationEvidence(input: {
  readonly canonicalPayerId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly events: readonly PayerAuthorizationEventFact[];
}): {
  readonly clinicalDocuments: EvidenceLifecycleStatus;
  readonly notification: EvidenceLifecycleStatus;
  readonly authorization: EvidenceLifecycleStatus;
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
  const newestFirst = [...relevant].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  const latest = (...kinds: PayerAuthorizationEventKind[]) =>
    newestFirst.find((event) => kinds.includes(event.eventKind));
  const lifecycle = (event: PayerAuthorizationEventFact | undefined): EvidenceLifecycleStatus => {
    if (!event) return "missing";
    if (event.evidenceStatus !== "verified") return "unverified";
    switch (event.eventKind) {
      case "notification_prepared":
        return "prepared";
      case "notification_sent":
        return "sent";
      case "receipt_acknowledged":
        return "acknowledged";
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

  const documentEvent = latest("clinical_document_available");
  const notificationEvent = latest(
    "receipt_acknowledged",
    "notification_sent",
    "notification_prepared",
  );
  const authorizationEvents = newestFirst.filter((event) =>
    [
      "authorization_pending",
      "authorization_approved",
      "authorization_denied",
      "authorization_expired",
      "authorization_revoked",
    ].includes(event.eventKind),
  );
  const topAuth = authorizationEvents[0];
  const sameTime = topAuth
    ? authorizationEvents.filter((event) => event.createdAt === topAuth.createdAt)
    : [];
  const ambiguous = new Set(sameTime.map((event) => event.eventKind)).size > 1;
  const authorization = ambiguous ? "ambiguous" : lifecycle(topAuth);
  const clinicalDocuments = documentEvent
    ? documentEvent.evidenceStatus === "verified"
      ? "available"
      : "unverified"
    : "missing";
  const notification = lifecycle(notificationEvent);
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
