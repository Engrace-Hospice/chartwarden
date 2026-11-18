// ADR-0113 — the web's list of screens that still work while a clinician is blocked (apps/web/src/shell/note-closure-screens.ts) MIRRORS
// the server's allowlist (apps/backend/src/bootstrap/note-closure-allowlist.ts), and nothing used to tie the two together: a screen could
// be allowed on the web whose own first read the server refuses, so a blocked clinician landed on it and saw a permission-style error
// instead of "close your overdue notes" (`/safety`, `/messaging/inbox`, `/messaging/unacknowledged`, `/n/:id`, a patient's claims,
// discipline plans, signatures, election certification and more did exactly that).
//
// The tables below are hand-written on purpose: for each screen the web calls allowed they name the screen's PRIMARY read (the call it
// opens with, METHOD + the route template the backend registers), found in that screen's own hook or component. The test then holds:
//   1. EVERY registered web screen that the web's own predicate allows has a row here, and every primary read is on the server's
//      allowlist. The registered paths are scanned from apps/web (every `screens.ts` and `system-pages.tsx`), so a new screen under an
//      allowed tree fails until someone writes down what it reads.
//   2. every tree and exact screen the web lists has a row, every row is a screen the web allows and that is really registered (or is
//      declared outside the registry), and a row with no gated read says why;
//   3. the screens the web REFUSES (REFUSED_SCREENS) really do open with a read the server refuses, and every refusal pattern the web
//      keeps is still needed. If the server is deliberately widened, move the screen to SCREEN_READS and delete its pattern.
// This lives with the backend's tests, importing the web's pure screen list by path: a SPA never imports the backend (ADR-0032), but a
// backend test may read the SPA's pure leaf, and scripts/tsconfig.json cannot (apps/web is not one of its project references, TS6307).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NOTE_CLOSURE_ALLOWED_SCREENS_EXACT,
  NOTE_CLOSURE_ALLOWED_SCREEN_TREES,
  NOTE_CLOSURE_REFUSED_UNDER_TREES,
  isNoteClosureAllowedScreen,
  matchesScreenPattern,
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
const BETTER_AUTH =
  "goes through Better Auth's /api/auth/* wildcard, which the gate admits by path";

/** Every screen the web keeps for a blocked clinician, with the read it opens with. */
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
  // The read-only patient chart.
  { screen: "/patients", read: "GET /api/v1/patients" },
  { screen: "/patients/:id", read: "GET /api/v1/patients/:id" },
  { screen: "/patients/:id/privacy", read: "GET /api/v1/patients/:id/privacy" },
  {
    screen: "/patients/:patientId/assessments",
    read: "GET /api/v1/patients/:patientId/assessments",
  },
  {
    screen: "/patients/:patientId/assessments/:assessmentId",
    read: "GET /api/v1/patients/:patientId/assessments/:id",
  },
  {
    screen: "/patients/:patientId/assessments/changes",
    read: "GET /api/v1/patients/:patientId/significant-changes",
  },
  {
    screen: "/patients/:patientId/assessments/summary",
    read: "GET /api/v1/patients/:patientId/assessments/summary",
  },
  {
    screen: "/patients/:patientId/scales/:scaleType",
    read: "GET /api/v1/patients/:patientId/scales/:scaleType/series",
  },
  { screen: "/patients/:patientId/care-plan", read: "GET /api/v1/patients/:patientId/care-plan" },
  { screen: "/patients/:patientId/consents", read: "GET /api/v1/patients/:patientId/consents" },
  { screen: "/patients/:patientId/documents", read: "GET /api/v1/documents" },
  { screen: "/patients/:patientId/hope", read: "GET /api/v1/patients/:patientId/hope/assessments" },
  {
    screen: "/patients/:patientId/idg-history",
    read: "GET /api/v1/patients/:patientId/idg-history",
  },
  // eMAR and medications.
  { screen: "/patients/:patientId/emar", read: "GET /api/v1/scheduled-doses" },
  { screen: "/patients/:patientId/administrations/:id", read: "GET /api/v1/administrations/:id" },
  {
    screen: "/patients/:patientId/iv-sessions/:sessionId",
    read: "GET /api/v1/administrations/iv-sessions/:sessionId",
  },
  { screen: "/patients/:patientId/missed-doses", read: "GET /api/v1/missed-doses" },
  {
    screen: "/patients/:patientId/comfort-kit/:deploymentId",
    read: "GET /api/v1/comfort-kits/deployments/:id",
  },
  { screen: "/patients/:patientId/medications", read: "GET /api/v1/medication-orders" },
  {
    screen: "/patients/:patientId/medications/new",
    read: "GET /api/v1/patients/:patientId/admissions",
  },
  {
    screen: "/patients/:patientId/medications/reconciliation",
    read: "GET /api/v1/patients/:patientId/medications/history",
  },
  // Orders, medication orders and verbal orders, standing orders.
  { screen: "/orders", read: "GET /api/v1/orders/pending-signature" },
  { screen: "/orders/:id", read: "GET /api/v1/orders/:id" },
  { screen: "/orders/cosign-pending", read: "GET /api/v1/orders/cosign-pending" },
  { screen: "/orders/held-transmissions", read: "GET /api/v1/orders/held-transmissions" },
  { screen: "/orders/results-pending-review", read: "GET /api/v1/orders/results-pending-review" },
  { screen: "/orders/verbal-expiring", read: "GET /api/v1/orders/verbal-expiring" },
  { screen: "/patients/:patientId/orders", read: "GET /api/v1/orders" },
  { screen: "/medication-orders/:id", read: "GET /api/v1/medication-orders/:id" },
  { screen: "/medication-orders/:id/edit", read: "GET /api/v1/medication-orders/:id" },
  { screen: "/prescribing/sign-inbox", read: "GET /api/v1/medication-orders" },
  { screen: "/prescribing/verbal-orders", read: "GET /api/v1/medication-orders" },
  { screen: "/standing-orders", read: "GET /api/v1/standing-orders" },
  // After-hours triage and on-call.
  { screen: "/triage", read: "GET /api/v1/triage-calls" },
  { screen: "/triage/intake", read: "POST /api/v1/triage-calls" },
  { screen: "/triage/calls/:triageCallId", read: "GET /api/v1/triage-calls/:triageCallId" },
  { screen: "/triage/calls/:triageCallId/history", read: "GET /api/v1/triage-calls/:triageCallId" },
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
  { screen: "/safety/incidents/:incidentId", read: "GET /api/v1/safety/incidents/:incidentId" },
  { screen: "/me/safety", read: "GET /api/v1/safety/check-ins/me/today" },
  { screen: "/me/safety/check-ins", read: "GET /api/v1/safety/check-ins/me/today" },
  { screen: "/me/safety/consent", read: "GET /api/v1/safety/consent" },
  // Emergency messaging and the alert inbox.
  { screen: "/messaging", read: "GET /api/v1/messaging/channels" },
  { screen: "/notifications", read: "GET /api/v1/alerts/inbox" },
  // Session plumbing and the system pages.
  { screen: "/login", read: null, why: `sign-in ${BETTER_AUTH}` },
  { screen: "/login/2fa", read: null, why: `the second factor ${BETTER_AUTH}` },
  { screen: "/login/passkey", read: null, why: `passkey enrolment ${BETTER_AUTH}` },
  { screen: "/login/change-password", read: "POST /api/v1/auth/password/complete-required-change" },
  { screen: "/login/organization", read: "POST /api/v1/auth/select-organization" },
  { screen: "/step-up", read: "POST /api/v1/sessions/step-up/initiate" },
  { screen: "/security/passkeys", read: null, why: `passkeys ${BETTER_AUTH}` },
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
];

interface RefusedScreen {
  readonly screen: string;
  /** The read the screen opens with that the server refuses a blocked clinician. */
  readonly read: string;
}

/** Screens the web does NOT keep for a blocked clinician, because each opens with a read the server refuses (so it would show a permission error). */
const REFUSED_SCREENS: readonly RefusedScreen[] = [
  { screen: "/safety", read: "GET /api/v1/safety/dashboard" },
  { screen: "/safety/check-ins", read: "GET /api/v1/safety/dashboard" },
  { screen: "/messaging/inbox", read: "GET /api/v1/messaging/inbox" },
  { screen: "/messaging/unacknowledged", read: "GET /api/v1/messaging/escalations/unacknowledged" },
  { screen: "/n/:id", read: "GET /api/v1/messaging/deliveries/:id/target" },
  { screen: "/patients/:patientId/claims", read: "GET /api/v1/billing/claims" },
  { screen: "/patients/:patientId/consents/new", read: "GET /api/v1/consent-types" },
  { screen: "/patients/:patientId/consents/:consentId", read: "GET /api/v1/consents/:consentId" },
  {
    screen: "/patients/:patientId/consents/expiring",
    read: "GET /api/v1/patients/:patientId/expiring-consents",
  },
  { screen: "/patients/:patientId/discipline-plans", read: "GET /api/v1/discipline-plans" },
  {
    screen: "/patients/:patientId/discipline-plans/aide-poc",
    read: "GET /api/v1/discipline-plans",
  },
  {
    screen: "/patients/:patientId/election-certification",
    read: "GET /api/v1/patients/:patientId/election-certification",
  },
  {
    screen: "/patients/:patientId/reconciliation/:worksheetId",
    read: "GET /api/v1/reconciliation/worksheets/:id",
  },
  {
    screen: "/patients/:patientId/signatures",
    read: "GET /api/v1/admin/portal-signature-requests",
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
function registeredScreenPaths(): readonly string[] {
  return registryFiles(WEB_SRC).flatMap((file) =>
    Array.from(
      readFileSync(file, "utf8").matchAll(/\bpath:\s*"(\/[^"]*)"/g),
      (match) => match[1] as string,
    ),
  );
}

const isCovered = (listed: string, screen: string): boolean =>
  screen === listed || screen.startsWith(`${listed}/`);

describe("the web's blocked-clinician screens mirror the server's allowlist", () => {
  it("every primary read of a screen the web keeps is on the server's allowlist", () => {
    const refused = SCREEN_READS.filter(
      (row) => row.read !== null && !NOTE_CLOSURE_ALLOWED_ROUTES.has(row.read),
    ).map((row) => `${row.screen} opens with ${row.read}`);
    expect(
      refused,
      "the web keeps a screen whose first read the server refuses a blocked clinician: move it to REFUSED_SCREENS and add a refusal pattern to NOTE_CLOSURE_REFUSED_UNDER_TREES (or drop its tree entry) in note-closure-screens.ts; widen the server's allowlist only as a deliberate security decision",
    ).toEqual([]);
  });

  it("every registered web screen that the web allows has a row naming its primary read (or why it has none)", () => {
    const rowScreens = new Set(SCREEN_READS.map((row) => row.screen));
    const missing = registeredScreenPaths().filter(
      (path) => isNoteClosureAllowedScreen(concretePath(path)) && !rowScreens.has(path),
    );
    expect(
      [...new Set(missing)],
      "a registered screen is allowed by the web's list but has no row: find the call it opens with (its own hook or component) and add it to SCREEN_READS, or refuse it in NOTE_CLOSURE_REFUSED_UNDER_TREES when that read is not on the server's allowlist",
    ).toEqual([]);
  });

  it("every tree and exact screen the web lists has a row naming what it reads", () => {
    const listed = [...NOTE_CLOSURE_ALLOWED_SCREEN_TREES, ...NOTE_CLOSURE_ALLOWED_SCREENS_EXACT];
    const unexplained = listed.filter(
      (entry) => !SCREEN_READS.some((row) => isCovered(entry, row.screen)),
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
    const registered = new Set(registeredScreenPaths());
    const missing = [
      ...SCREEN_READS.filter((row) => !row.outsideRegistry),
      ...REFUSED_SCREENS,
    ].filter((row) => !registered.has(row.screen));
    expect(missing.map((row) => row.screen)).toEqual([]);
  });

  it("every screen the web refuses is refused by the web, and its first read really is refused by the server", () => {
    const stillAllowed = REFUSED_SCREENS.filter((row) =>
      isNoteClosureAllowedScreen(concretePath(row.screen)),
    ).map((row) => row.screen);
    expect(
      stillAllowed,
      "the web still allows a screen it lists as refused: add its pattern to NOTE_CLOSURE_REFUSED_UNDER_TREES or drop its tree entry",
    ).toEqual([]);

    const widened = REFUSED_SCREENS.filter((row) => NOTE_CLOSURE_ALLOWED_ROUTES.has(row.read)).map(
      (row) => `${row.screen} (${row.read})`,
    );
    expect(
      widened,
      "the server's allowlist now includes the first read of a screen the web refuses. If that was deliberate, move the screen from REFUSED_SCREENS to SCREEN_READS and delete its pattern from NOTE_CLOSURE_REFUSED_UNDER_TREES (or add its tree to the allowed list) in note-closure-screens.ts, so a blocked clinician stays on it",
    ).toEqual([]);
  });

  it("every refusal pattern the web keeps still matches a refused screen here (no stale pattern)", () => {
    const stale = NOTE_CLOSURE_REFUSED_UNDER_TREES.filter(
      (pattern) =>
        !REFUSED_SCREENS.some((row) => matchesScreenPattern(concretePath(row.screen), pattern)),
    );
    expect(stale).toEqual([]);
  });
});
