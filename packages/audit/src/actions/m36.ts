// @wardenx/audit — Module 36 (Secure Messaging & Alerts) action catalog (M36-T08; §4.6.1 `m36.ts`,
// M36 spec §8.1.2).
//
// The job-emitted message-integrity + DLQ audit events from M36 §8.1.2 — the events the §4.4 jobs
// this task implements produce — registered under the D9 `m36.<resource>.<verb>` namespace the
// catalog validator enforces. These are operational/compliance record-keeping about message
// integrity and queue health; they carry IDs + hashes + counts only (PHI-free by construction — the
// DLQ payload is HASHED, never stored verbatim), so every entry has an empty denylist and is not
// Part 2 eligible. The alert-dispatch / alert-lifecycle events (§8.1 / §8.1.1) and the
// `m36.notification.delivery_failed` outbox event are emitted by the dispatch + composition surfaces
// (their own tasks); this slice is the job layer's audit surface.
import type { ModuleActionCatalog } from "./types";

/** `m36` Secure Messaging job/integrity actions (M36 §8.1.2). */
export const M36_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m36.integrity.hash_mismatch", // §8.1.2 — emitted by messaging.hash_verify on divergence
    moduleOwner: "m36",
    defaultRetentionClass: "compliance",
    description:
      "A message body failed integrity verification (messageId, channelId, organizationId, storedHash, computedHash, detectedAt); paged to ops, investigated before the next retention scan.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m36.hash_verify.run", // §8.1.2 — one row per nightly messaging.hash_verify execution
    moduleOwner: "m36",
    defaultRetentionClass: "operational",
    description:
      "A nightly message-integrity verification run completed (runId, scanned, matched, mismatched, skippedDeletedTenant, skippedLegalHold); query-able for compliance reporting.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m36.retention_scan.run", // WP 1.9 — one row per weekly messaging.retention_scan execution (plan only)
    moduleOwner: "m36",
    defaultRetentionClass: "operational",
    description:
      "A weekly message retention scan completed per tenant (runId, candidates, toDestroy, skippedLegalHold). Counts only; the scan plans and never deletes, and a legal-held message is withheld from the plan.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m36.dlq_job", // §8.1.2 / §4.4.1 OPS-035 — written for every job landing in any DLQ
    moduleOwner: "m36",
    defaultRetentionClass: "compliance",
    description:
      "A job exhausted its retries and landed in a DLQ (queue, jobId, jobDataHash, failedAt, finalError, disposition); the OPS-035 no-silent-drain protocol requires a documented disposition before clearing.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m36.realtime.connected", // ADR-0054 item 12 — a socket joined its rooms
    moduleOwner: "m36",
    defaultRetentionClass: "operational",
    description:
      "A staff socket completed the realtime handshake and joined its rooms (sessionId; the actor is the user). Ids only; no message content.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m36.realtime.disconnected", // ADR-0054 item 12 — a joined socket ended, forced or not
    moduleOwner: "m36",
    defaultRetentionClass: "operational",
    description:
      "A joined realtime socket ended (sessionId, reason, forced, durationMs). forced=true when the server ended it: revocation, session end, connection cap or shutdown.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
