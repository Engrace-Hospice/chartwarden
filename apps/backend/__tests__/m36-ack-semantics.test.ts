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
  "apps/web/src/modules/36-messaging/reaction-palette.ts":
    "WP 2.4 user-facing copy that NEGATES the word: a reaction does not mean a message was read, acknowledged or acted on",
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
      .filter((f) => !(f.rel in WORDING_ALLOWLIST) && WORDING.test(f.text))
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
});
