// apps/web/src/shell — which screens still work for a clinician whose visit note is past its block instant (ADR-0113), declared once.
//
// While blocked, the server refuses every route outside an allowlist with 403 NOTE_CLOSURE_REQUIRED (apps/backend/src/bootstrap/
// note-closure-allowlist.ts). The groups below are the web screens whose own calls sit on that allowlist; this list MIRRORS it, so
// add a screen here only after its calls are there. The shell's watcher uses it for ONE decision: when a refusal arrives, send the
// clinician to My notes UNLESS they are already on one of these screens. Navigating away from an allowed screen would throw away
// the form they are filling in (a note, an eMAR entry, a triage call), so the refusal there only shows the banner.
// The server is the authority; this only decides what the shell offers. A screen listed here whose own read is NOT on the allowlist
// would 403 a blocked clinician into a permission-style message instead of "close your overdue notes", so every entry is tied to its
// primary read by apps/backend/__tests__/note-closure-allowlist-mirror.test.ts. A screen that is not listed is not a loss: a refusal there
// simply moves the clinician to My notes.

/** Where a blocked clinician is sent: My notes (route `/work/drafts`, screen id `encounter.my-drafts`). */
export const NOTE_CLOSURE_HOME = "/work/drafts";

/** A screen and everything under it (`/orders` and `/orders/:id`, never `/orders-archive`). */
export const NOTE_CLOSURE_ALLOWED_SCREEN_TREES: readonly string[] = [
  // Closing the note and the queues around it. A blocked supervisor keeps the overdue board so they can unblock others.
  NOTE_CLOSURE_HOME,
  "/work/cosignatures",
  "/work/overdue-notes",
  // The read-only patient chart: the patient list, the chart, and with it the encounter composer / reader and the eMAR screens.
  "/patients",
  // Orders, medication orders and verbal orders, standing orders.
  "/orders",
  "/medication-orders",
  "/prescribing",
  "/standing-orders",
  // After-hours triage and on-call: the call, its protocols and escalations. Not the shifts, policy, vendors or metrics.
  "/triage/intake",
  "/triage/calls",
  "/triage/escalations",
  "/triage/protocols",
  "/triage/paper-reentry",
  "/me/oncall",
  "/messaging/on-call",
  // Field safety: SOS, incidents and a clinician's own check-ins. Not the safety board (`/safety`, `/safety/check-ins`: both open with
  // GET /safety/dashboard, an organization-wide read), the policy, subscriptions, high-risk areas or metrics.
  "/safety/sos",
  "/safety/incidents",
  "/me/safety",
  // Emergency messaging and the alert inbox (the closure alert itself arrives there). Not the work inbox or the unacknowledged queue
  // (GET /messaging/inbox, GET /messaging/escalations/unacknowledged), nor a notification link (`/n/:id` opens with
  // GET /messaging/deliveries/:id/target): none of those reads is on the allowlist.
  "/notifications",
  // Session plumbing and the system pages: a refusal must never bounce someone off sign-in, expiry or the step-up ceremony.
  "/login",
  "/step-up",
  "/expired",
  "/maintenance",
  "/offline",
  "/tenant-unavailable",
  "/status",
  "/security",
];

/** Screens that are allowed on their own but whose siblings are not (`/triage` the hub, never `/triage/shifts`). */
export const NOTE_CLOSURE_ALLOWED_SCREENS_EXACT: readonly string[] = ["/triage", "/messaging"];

const isUnder = (pathname: string, tree: string): boolean =>
  pathname === tree || pathname.startsWith(`${tree}/`);

/** The pathname as the router matches it: case-insensitive, and a trailing slash names the same screen. */
const routerForm = (pathname: string): string => {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
};

/** True when the gate still allows this screen's own calls for a blocked clinician. */
export function isNoteClosureAllowedScreen(pathname: string): boolean {
  const path = routerForm(pathname);
  return (
    NOTE_CLOSURE_ALLOWED_SCREENS_EXACT.includes(path) ||
    NOTE_CLOSURE_ALLOWED_SCREEN_TREES.some((tree) => isUnder(path, tree))
  );
}

/**
 * What the watcher does with a `note-closure-required` refusal: the path to navigate to, or null to stay. Only a signed-in person is
 * moved, and never off a screen the gate still allows.
 */
export function noteClosureRedirectFor(pathname: string, authenticated: boolean): string | null {
  if (!authenticated) return null;
  return isNoteClosureAllowedScreen(pathname) ? null : NOTE_CLOSURE_HOME;
}
