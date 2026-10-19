// M36 WP 1.6 — receipt-semantics ratchet. A `message_receipt` is `delivered` (fanned out to the recipient's
// inbox server-side, NOT device delivery) or `read` (the recipient explicitly read it in the foreground).
// Nothing about a receipt is an acknowledgement: clinical acknowledgement exists only in the Phase 4
// message_acknowledgment_* tables (ADR-0056 item 1). This scan keeps the word, the status literal and the
// retired `acked_at` column from creeping back onto a read/open/delivery path in the M36 surface.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../..");
const ROOTS = [
  "apps/backend/src/modules/36-messaging",
  "packages/messaging/src",
  "apps/web/src/modules/36-messaging",
];
const FILES = ["apps/web/src/shell/alert-inbox.tsx", "apps/web/src/shell/notification-bell.tsx"];

/** Files allowed to use the words, each WITH a reason (a ratchet: add only for a real, different meaning). */
const WORDING_ALLOWLIST: Readonly<Record<string, string>> = {
  "apps/backend/src/modules/36-messaging/outbox-consumers/oncall-alerts.ts":
    "M19 triage escalation acknowledgement — a clinical triage action, not a message receipt",
  "apps/backend/src/modules/36-messaging/outbox-consumers/m39-consent-revoked.ts":
    "M39 revocation-cascade ACK recorded by the consumer — an outbox protocol step, not a receipt",
  "apps/backend/src/modules/36-messaging/part2-channel-gate.ts":
    "describes the same M39 cascade ACK",
  "packages/messaging/src/seed/alert-rules.ts":
    "alert-rule descriptions for M19/M23 ack crons and unacknowledged escalations (other modules' lifecycles)",
  "packages/messaging/src/seed/alert-rules-billing-cap.ts":
    "names the M23 ack crons the rule fires on",
  "apps/web/src/modules/36-messaging/global-search-settings.tsx":
    "the admin screen for the ADR-0058 F5 tenant notice acknowledgement, not a message receipt",
  "apps/backend/src/modules/36-messaging/global-search/notice.ts":
    "ADR-0058 F5 tenant notice acknowledgement (an org admin accepting the discoverability notice), not a message receipt",
  "apps/backend/src/modules/36-messaging/global-search/settings-service.ts":
    "ADR-0058 F5 tenant notice acknowledgement (an org admin accepting the discoverability notice), not a message receipt",
  "apps/backend/src/modules/36-messaging/global-search/tenant-setting-store.ts":
    "ADR-0058 F5 tenant notice acknowledgement (an org admin accepting the discoverability notice), not a message receipt",
  "apps/backend/src/modules/36-messaging/routes/global-search-settings-routes.ts":
    "ADR-0058 F5 tenant notice acknowledgement (an org admin accepting the discoverability notice), not a message receipt",
  "apps/backend/src/modules/36-messaging/routes/global-search-settings-typebox.ts":
    "ADR-0058 F5 tenant notice acknowledgement (an org admin accepting the discoverability notice), not a message receipt",
  "apps/web/src/modules/36-messaging/message-row.tsx":
    "WP 4.2 mounts the acknowledgment-request card under a message of a patient conversation (one import and one element)",
  "apps/web/src/modules/36-messaging/conversation-thread.tsx":
    "WP 4.2 wraps the timeline in the acknowledgment-request loader for a patient care-team conversation (one import and one element)",
  "apps/web/src/modules/36-messaging/ack-request-card.tsx":
    "WP 4.2 web: the acknowledgment-request card (taking responsibility is an explicit button; opening or reading sends nothing)",
  "apps/web/src/modules/36-messaging/ack-reassign-wording.ts":
    "ADR-0078 web: the reassign dialogs' words; they say a supervisor reassign acknowledges nothing and that only the new person takes responsibility",
  "apps/web/src/modules/36-messaging/ack-reassign-dialog.tsx":
    "ADR-0078 web: the reassign dialog of the acknowledgment-request card and the supervisor queue (it acknowledges nothing)",
  "apps/web/src/modules/36-messaging/use-ack-reassign.ts":
    "ADR-0078 web: the candidate read and the reassign call of the acknowledgment-request card and the supervisor queue (acknowledges nothing)",
  "apps/web/src/modules/36-messaging/ack-wording.ts":
    "WP 4.2 web: every word the acknowledgment-request card shows (provisional, pending clinical-lead review)",
  "apps/web/src/modules/36-messaging/use-ack-requests.ts":
    "WP 4.2 web hook for the acknowledgment requests of a channel and the explicit acknowledge / resolve calls",
  "apps/backend/src/modules/36-messaging/routes/ack-routes.ts":
    "WP 4.2 routes of the acknowledgment-request aggregate (acknowledge is an explicit POST by the assignee; no GET or receipt writes)",
  "apps/backend/src/modules/36-messaging/routes/ack-typebox.ts":
    "WP 4.2 request/response schemas of the acknowledgment-request aggregate",
  "apps/backend/src/modules/36-messaging/routes/messaging-routes.ts":
    "WP 4.2 mounts the acknowledgment-request routes (a registrar line and its comment)",
  "apps/backend/src/modules/36-messaging/index.ts":
    "WP 4.2 exports the acknowledgment-request binding (an export line and its comment)",
  "apps/backend/src/modules/36-messaging/events-by-m36.ts":
    "WP 4.2 outbox catalog entries of the acknowledgment-request lifecycle (m36.ack.*)",
  "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts":
    "WP 4.2 delete cancels the message's open acknowledgment request and edit is refused once a request exists (import lines and comments)",
  "apps/backend/src/modules/36-messaging/outbox-consumers/ack-notifications.ts":
    "WP 4.2 the in-app alert for the assignee of an acknowledgment request (never a receipt)",
  "apps/backend/src/modules/36-messaging/outbox-consumers/ack-escalation-notifications.ts":
    "WP 4.4 the in-app alerts of an escalated or unrouted acknowledgment request (never a receipt)",
  "apps/backend/src/modules/36-messaging/outbox-consumers/ack-timer-arming.ts":
    "WP 4.4 arms the escalation timer of an acknowledgment request (never a receipt)",
  "apps/backend/src/modules/36-messaging/outbox-consumers/ack-delivery-failure.ts":
    "WP 4.5 turns a failed out-of-band route to the assignee of an acknowledgment request into an early escalation or failed_unreachable (never a receipt)",
  "apps/backend/src/modules/36-messaging/outbox-consumers/ack-unreachable-notifications.ts":
    "WP 4.5 the in-app alert and ops notice for an acknowledgment request nobody could be reached for (never a receipt)",
  "packages/messaging/src/resolution/notification-policy.ts":
    "WP 4.6 the channel floor of the alerts that tell the assignee of an acknowledgment request (the class names and the m36.ack.* event names); it labels no delivery, open or read",
  "apps/backend/src/modules/36-messaging/notification-policy-ports.ts":
    "WP 4.6 the feature-flag gate of the m36.ack.* alerts (the ack_requests flag key and event names); it labels no delivery, open or read",
  "packages/messaging/src/jobs/queues.ts":
    "WP 4.4 names the two escalation queues of the acknowledgment-request aggregate (ack_escalation_timer / _sweep)",
  "packages/messaging/src/index.ts": "WP 4.2 re-exports the pure acknowledgment-request rules",
  "apps/backend/src/modules/36-messaging/delivery-target/delivery-target-service.ts":
    "WP 4.8 the deep-link landing: it names the open acknowledgment request to focus and states that opening a link never acknowledges (a read, never a receipt)",
  "apps/backend/src/modules/36-messaging/routes/delivery-target-routes.ts":
    "WP 4.8 the deep-link landing: it names the open acknowledgment request to focus and states that opening a link never acknowledges (a read, never a receipt)",
  "apps/backend/src/modules/36-messaging/routes/delivery-target-typebox.ts":
    "WP 4.8 the deep-link landing: it names the open acknowledgment request to focus and states that opening a link never acknowledges (a read, never a receipt)",
  "apps/web/src/modules/36-messaging/notification-landing.tsx":
    "WP 4.8 the deep-link landing: it names the open acknowledgment request to focus and states that opening a link never acknowledges (a read, never a receipt)",
  "apps/backend/src/modules/36-messaging/routes/unacknowledged-routes.ts":
    "WP 4.9 the supervisor's queue of requests still waiting for someone to take responsibility: it lists and counts what is NOT acknowledged and never acknowledges (a read, never a receipt)",
  "apps/backend/src/modules/36-messaging/routes/unacknowledged-typebox.ts":
    "WP 4.9 the supervisor's queue of requests still waiting for someone to take responsibility: it lists and counts what is NOT acknowledged and never acknowledges (a read, never a receipt)",
  "apps/web/src/modules/36-messaging/screens.ts":
    "WP 4.9 the supervisor's queue of requests still waiting for someone to take responsibility: it lists and counts what is NOT acknowledged and never acknowledges (a read, never a receipt)",
  "apps/web/src/modules/36-messaging/unacknowledged-queue.tsx":
    "WP 4.9 the supervisor's queue of requests still waiting for someone to take responsibility: it lists and counts what is NOT acknowledged and never acknowledges (a read, never a receipt)",
  "apps/web/src/modules/36-messaging/unacknowledged-wording.ts":
    "WP 4.9 the supervisor's queue of requests still waiting for someone to take responsibility: it lists and counts what is NOT acknowledged and never acknowledges (a read, never a receipt)",
  "apps/web/src/modules/36-messaging/use-unacknowledged-queue.ts":
    "WP 4.9 the supervisor's queue of requests still waiting for someone to take responsibility: it lists and counts what is NOT acknowledged and never acknowledges (a read, never a receipt)",
  "apps/backend/src/modules/36-messaging/routes/snooze-reminder-routes.ts":
    "WP 4.10 (ADR-0077) snooze and reminders: it names the acknowledgment request ONLY to refuse a snooze or a reminder where one is open (a read of its existence, never a receipt, never a write)",
  "packages/messaging/src/seams/alert-emitter-impl.ts":
    "WP 4.10 (ADR-0077) the snooze lookup port's comment: a snooze never applies where an acknowledgment request is open (a read of its existence, never a receipt)",
  "apps/web/src/modules/36-messaging/snooze-control.tsx":
    "WP 4.10 (ADR-0077) the header snooze control: it explains that a conversation with an acknowledgment request cannot be snoozed (words only, no receipt)",
  "apps/web/src/modules/36-messaging/reaction-palette.ts":
    "WP 2.4 user-facing copy that NEGATES the word: a reaction does not mean a message was read, acknowledged or acted on",
};

/**
 * WP 4.2 (ADR-0069, which retires the old `ack` per ADR-0056 item 4): the acknowledgment-request aggregate LEGITIMATELY lands here.
 * Whole directories that implement it may use the words (each WITH a reason). This relaxes ONLY the wording check: the `"ack"`
 * status literal and the retired `acked_at` column stay banned everywhere, so a receipt, a read or a delivery still cannot be
 * labelled acknowledged by code outside the aggregate.
 */
const WORDING_ALLOWLIST_PREFIXES: Readonly<Record<string, string>> = {
  "apps/backend/src/modules/36-messaging/ack-requests/":
    "WP 4.2 the acknowledgment-request aggregate itself (service, store, events, binding): an explicit action by the assigned clinician, never a receipt",
  "packages/messaging/src/ack-requests/":
    "WP 4.2 the pure state machine and deadline rules of the acknowledgment-request aggregate (and WP 4.4's timer rules)",
  "apps/backend/src/modules/36-messaging/ack-delivery-failure/":
    "WP 4.5 what happens to an acknowledgment request when every route to its assignee failed: a failed delivery is never an acknowledgment, it is the opposite",
  "apps/backend/src/modules/36-messaging/snooze-reminders/":
    "WP 4.10 (ADR-0077) snooze and reminders: they READ whether an acknowledgment request is open (to refuse a snooze or a reminder) and never write one or label anything acknowledged",
  "apps/backend/src/modules/36-messaging/oncall-directory/":
    "WP 4.12 (ADR-0080) the read-only on-call directory: it imports the escalation router guard from the ack-escalation directory and never writes or labels an acknowledgment",
  "apps/backend/src/modules/36-messaging/ack-escalation/":
    "WP 4.4 the escalation timers of the acknowledgment-request aggregate: what happens when nobody took responsibility in time",
};

/** The schema owns the retired column; the test files below pin that it stays NULL. */
const ACKED_AT_ALLOWED = ["packages/db/src/schema/messaging/message-receipts.ts"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "__tests__") return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const files = [
  ...ROOTS.flatMap((r) => walk(join(REPO, r))),
  ...FILES.map((f) => join(REPO, f)),
].map((abs) => ({ rel: relative(REPO, abs), text: readFileSync(abs, "utf8") }));

const STATUS_LITERAL = /["'`]ack["'`]/;
const ACKED_AT = /\backedAt\b|\backed_at\b/;
const WORDING = /\back(ed|s)?\b|acknowledg/i;
const allowedPrefix = (rel: string): boolean =>
  Object.keys(WORDING_ALLOWLIST_PREFIXES).some((prefix) => rel.startsWith(prefix));

describe("M36 receipt semantics ratchet (no acknowledgement on a receipt)", () => {
  it("scans a non-trivial file set", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never uses "ack" as a status literal', () => {
    const hits = files.filter((f) => STATUS_LITERAL.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it("never reads or writes the retired acked_at column outside its schema file", () => {
    const hits = files
      .filter((f) => !ACKED_AT_ALLOWED.includes(f.rel) && ACKED_AT.test(f.text))
      .map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it("does not label a delivery, open or read as an ack/acknowledgement (reasoned allowlist only)", () => {
    const hits = files
      .filter((f) => !(f.rel in WORDING_ALLOWLIST) && !allowedPrefix(f.rel) && WORDING.test(f.text))
      .map((f) => `${f.rel}: ${WORDING.exec(f.text)?.[0]}`);
    expect(hits).toEqual([]);
  });

  it("keeps every allowlist entry live (delete an entry once its file stops needing it)", () => {
    const stale = Object.keys(WORDING_ALLOWLIST).filter((rel) => {
      const f = files.find((x) => x.rel === rel);
      return !f || !WORDING.test(f.text);
    });
    expect(stale).toEqual([]);
  });

  it("keeps every allowlisted directory live (a prefix with no file that needs it is deleted)", () => {
    const stale = Object.keys(WORDING_ALLOWLIST_PREFIXES).filter(
      (prefix) => !files.some((f) => f.rel.startsWith(prefix) && WORDING.test(f.text)),
    );
    expect(stale).toEqual([]);
  });
});
