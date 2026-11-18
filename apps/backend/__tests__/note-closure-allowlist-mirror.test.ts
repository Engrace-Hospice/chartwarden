// ADR-0113 — the web's list of screens that still work while a clinician is blocked (apps/web/src/shell/note-closure-screens.ts) MIRRORS
// the server's allowlist (apps/backend/src/bootstrap/note-closure-allowlist.ts), and nothing tied the two together: a screen could be
// listed on the web whose own first read the server refuses, so a blocked clinician landed on it and saw a permission-style error
// instead of "close your overdue notes" (`/safety`, `/messaging/inbox`, `/messaging/unacknowledged` and `/n/:id` did exactly that).
//
// The table below is hand-written on purpose: for each screen the web calls allowed it names the screen's PRIMARY read (the call it
// opens with, METHOD + the route template the backend registers), found in that screen's own hook or component. The test then holds
// three things together:
//   1. every primary read is on the server's allowlist (the server is the authority; widen the web list only after the server's);
//   2. every tree and exact screen the web lists has a row here, and every row is a screen the web's own predicate allows, so adding a
//      web entry means writing down what it reads, and the table cannot name a screen the web does not allow;
//   3. every row names a screen that is really registered in apps/web (or is declared as a page outside the registry), so a rename
//      cannot leave a stale row.
// This lives with the backend's tests, importing the web's pure screen list by path: a SPA never imports the backend (ADR-0032), but a
// backend test may read the SPA's pure leaf, and scripts/tsconfig.json cannot (apps/web is not one of its project references, TS6307).
// Not covered: a screen UNDER an allowed tree that is not in the table (for example the /patients/:id/claims billing screen): the table
// pins each tree's root and the screens a blocked clinician is expected to use, not every leaf.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NOTE_CLOSURE_ALLOWED_SCREENS_EXACT,
  NOTE_CLOSURE_ALLOWED_SCREEN_TREES,
  isNoteClosureAllowedScreen,
} from "../../web/src/shell/note-closure-screens";
import { NOTE_CLOSURE_ALLOWED_ROUTES } from "../src/bootstrap/note-closure-allowlist";

interface ScreenRead {
  /** The screen's route template as the web registers it. */
  readonly screen: string;
  /** `METHOD /route/template` of the call the screen opens with; null only for a screen that makes no gated API call. */
  readonly read: string | null;
  /** Required when `read` is null: why the screen needs nothing from the allowlist. */
  readonly why?: string;
  /** True for a page that is not in the SPA's screen registry (a plain link target). */
  readonly outsideRegistry?: true;
}

const SESSION_PAGE =
  "a session or system page: its calls are session plumbing the gate admits by path";

const SCREEN_READS: readonly ScreenRead[] = [
  // Closing the note and the queues around it.
  { screen: "/work/drafts", read: "GET /api/v1/encounters/my-drafts" },
  { screen: "/work/cosignatures", read: "GET /api/v1/encounters/cosignature-queue" },
  { screen: "/work/overdue-notes", read: "GET /api/v1/encounters/overdue-notes" },
  { screen: "/patients/:patientId/encounters", read: "GET /api/v1/encounters" },
  {
    screen: "/patients/:patientId/encounters/:encounterId",
    read: "GET /api/v1/encounters/:encounterId",
  },
  {
    screen: "/patients/:patientId/encounters/:encounterId/compose",
    read: "GET /api/v1/encounters/:encounterId",
  },
  // The read-only patient chart and eMAR.
  { screen: "/patients", read: "GET /api/v1/patients" },
  { screen: "/patients/:id", read: "GET /api/v1/patients/:id" },
  { screen: "/patients/:patientId/emar", read: "GET /api/v1/scheduled-doses" },
  { screen: "/patients/:patientId/administrations/:id", read: "GET /api/v1/administrations/:id" },
  // Orders, medication orders and verbal orders, standing orders.
  { screen: "/orders", read: "GET /api/v1/orders/pending-signature" },
  { screen: "/orders/:id", read: "GET /api/v1/orders/:id" },
  { screen: "/medication-orders/:id", read: "GET /api/v1/medication-orders/:id" },
  { screen: "/prescribing/sign-inbox", read: "GET /api/v1/medication-orders" },
  { screen: "/prescribing/verbal-orders", read: "GET /api/v1/medication-orders" },
  { screen: "/standing-orders", read: "GET /api/v1/standing-orders" },
  // After-hours triage and on-call.
  { screen: "/triage", read: "GET /api/v1/triage-calls" },
  { screen: "/triage/intake", read: "POST /api/v1/triage-calls" },
  { screen: "/triage/calls/:triageCallId", read: "GET /api/v1/triage-calls/:triageCallId" },
  {
    screen: "/triage/calls/:triageCallId/transcript",
    read: "GET /api/v1/triage-calls/:triageCallId/transcript-decrypt",
  },
  { screen: "/triage/escalations", read: "GET /api/v1/escalations" },
  { screen: "/triage/protocols", read: "GET /api/v1/triage-protocols" },
  { screen: "/triage/protocols/:protocolId", read: "GET /api/v1/triage-protocols/:protocolId" },
  { screen: "/triage/paper-reentry", read: "GET /api/v1/triage-calls/paper-reentry/worklist" },
  { screen: "/me/oncall", read: "GET /api/v1/oncall/current" },
  { screen: "/messaging/on-call", read: "GET /api/v1/messaging/oncall/coverage" },
  // Field safety: SOS, incidents and a clinician's own check-ins and consent.
  { screen: "/safety/sos", read: "GET /api/v1/safety/sos/active" },
  { screen: "/safety/sos/:sosAlertId", read: "GET /api/v1/safety/sos/:sosAlertId" },
  { screen: "/safety/incidents", read: "GET /api/v1/safety/incidents" },
  { screen: "/safety/incidents/new", read: "POST /api/v1/safety/incidents" },
  { screen: "/me/safety", read: "GET /api/v1/safety/check-ins/me/today" },
  { screen: "/me/safety/check-ins", read: "GET /api/v1/safety/check-ins/me/today" },
  { screen: "/me/safety/consent", read: "GET /api/v1/safety/consent" },
  // Emergency messaging and the alert inbox.
  { screen: "/messaging", read: "GET /api/v1/messaging/channels" },
  { screen: "/notifications", read: "GET /api/v1/alerts/inbox" },
  // Session plumbing and the system pages.
  {
    screen: "/login",
    read: null,
    why: "sign-in goes through Better Auth's /api/auth/* wildcard, which the gate admits by path",
  },
  { screen: "/login/organization", read: "POST /api/v1/auth/select-organization" },
  { screen: "/step-up", read: "POST /api/v1/sessions/step-up/initiate" },
  { screen: "/expired", read: null, why: SESSION_PAGE },
  { screen: "/maintenance", read: null, why: SESSION_PAGE },
  { screen: "/offline", read: null, why: SESSION_PAGE },
  { screen: "/tenant-unavailable", read: null, why: SESSION_PAGE },
  {
    screen: "/status",
    read: null,
    why: "the degraded banner's link to a plain status page: no API read",
    outsideRegistry: true,
  },
  {
    screen: "/security/passkeys",
    read: null,
    why: "passkeys go through Better Auth's /api/auth/* wildcard, which the gate admits by path",
  },
];

/** A route template as a concrete path the web's predicate can be asked about (`:id` becomes a value). */
const concretePath = (template: string): string => template.replace(/:[A-Za-z]+/g, "x");

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../web/src");
const REGISTRY_FILE = /(^|\/)(screens\.ts|system-pages\.tsx)$/;

function registryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : registryFiles(path);
    return REGISTRY_FILE.test(path) ? [path] : [];
  });
}

/** Every `path: "/..."` the web's screen registries declare. */
function registeredScreenPaths(): ReadonlySet<string> {
  const paths = registryFiles(WEB_SRC).flatMap((file) =>
    Array.from(
      readFileSync(file, "utf8").matchAll(/\bpath:\s*"(\/[^"]*)"/g),
      (m) => m[1] as string,
    ),
  );
  return new Set(paths);
}

const isCovered = (listed: string, row: ScreenRead): boolean =>
  row.screen === listed || row.screen.startsWith(`${listed}/`);

describe("the web's blocked-clinician screens mirror the server's allowlist", () => {
  it("every primary read of a listed screen is on the server's allowlist", () => {
    const refused = SCREEN_READS.filter(
      (row) => row.read !== null && !NOTE_CLOSURE_ALLOWED_ROUTES.has(row.read),
    ).map((row) => `${row.screen} opens with ${row.read}`);
    expect(refused).toEqual([]);
  });

  it("every tree and exact screen the web lists has a row naming what it reads", () => {
    const listed = [...NOTE_CLOSURE_ALLOWED_SCREEN_TREES, ...NOTE_CLOSURE_ALLOWED_SCREENS_EXACT];
    const unexplained = listed.filter(
      (entry) => !SCREEN_READS.some((row) => isCovered(entry, row)),
    );
    expect(unexplained).toEqual([]);
  });

  it("every row is a screen the web's own predicate allows", () => {
    const notAllowed = SCREEN_READS.filter(
      (row) => !isNoteClosureAllowedScreen(concretePath(row.screen)),
    );
    expect(notAllowed.map((row) => row.screen)).toEqual([]);
  });

  it("a row with no gated read says why", () => {
    const unexplained = SCREEN_READS.filter((row) => row.read === null && !row.why);
    expect(unexplained.map((row) => row.screen)).toEqual([]);
  });

  it("every row is a registered screen (or declared to be outside the registry), so a rename leaves no stale row", () => {
    const registered = registeredScreenPaths();
    const missing = SCREEN_READS.filter(
      (row) => !row.outsideRegistry && !registered.has(row.screen),
    );
    expect(missing.map((row) => row.screen)).toEqual([]);
  });

  it("the screens the web refuses to vouch for are the ones whose first read the server refuses", () => {
    // The four the drift left behind, and the one it found: each opens with a read that is not on the allowlist, so none may be listed.
    const refusedReads: readonly (readonly [string, string])[] = [
      ["/safety", "GET /api/v1/safety/dashboard"],
      ["/safety/check-ins", "GET /api/v1/safety/dashboard"],
      ["/messaging/inbox", "GET /api/v1/messaging/inbox"],
      ["/messaging/unacknowledged", "GET /api/v1/messaging/escalations/unacknowledged"],
      ["/n/:id", "GET /api/v1/messaging/deliveries/:id/target"],
    ];
    for (const [screen, read] of refusedReads) {
      expect(NOTE_CLOSURE_ALLOWED_ROUTES.has(read)).toBe(false);
      expect(isNoteClosureAllowedScreen(concretePath(screen))).toBe(false);
    }
  });
});
