// apps/web/src/shell — where "Back" goes from a screen reached out of a list (Workflow 09, WP1). A leaf (no React, no client) shared by the
// scheduling and encounter modules: a module may import the shell, never another module (ADR-0030).
//
// The origin travels in the URL as `?from=<path>`, so it survives a refresh and a new tab (router state does neither), like the step-up
// round trip's `returnTo`. The value is user-controlled input, so it is NEVER used as given: it is parsed against a fixed list of internal
// screens and rebuilt from the parts that list names. Anything else (an absolute URL, `//host`, `javascript:`, a backslash, an encoded
// slash, an unknown screen) is not a target at all and the caller falls back to its own default. Paths only: no name, and no value but
// the ones the screen itself already keeps in its own URL (a filter, a date, a patient or visit id).

/** The query parameter that carries the origin. */
export const RETURN_PARAM = "from";

export interface ReturnTarget {
  /** A canonical internal path (with the query the screen understands); safe to hand to a router link. */
  readonly href: string;
  /** Completes "Back to ...". */
  readonly label: string;
}

interface ReturnRoute {
  readonly path: RegExp;
  readonly label: string;
  /** The query keys the screen reads, in the order they are written; every other key is dropped. */
  readonly keys: readonly string[];
}

const ID = "[A-Za-z0-9_-]{1,64}";
const MAX_LENGTH = 1024;
const MAX_VALUE_LENGTH = 200;
/** A `from` inside a `from` (the encounter's way back to a visit that itself came from My Visits); a deeper chain is cut. */
const MAX_NESTING = 1;
/** A parse origin that no real request can have, so "the parsed origin moved" means the value named another host. */
const PROBE_ORIGIN = "http://return-target.invalid";
/** A backslash, a control character or whitespace: browsers read these as `/` or strip them, which can turn a path into a host. */
const LAST_CONTROL_OR_SPACE = 0x20;
const DELETE_CHARACTER = 0x7f;

function hostile(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\" || code <= LAST_CONTROL_OR_SPACE || code === DELETE_CHARACTER)
      return true;
  }
  return false;
}

const ROUTES: readonly ReturnRoute[] = [
  {
    path: /^\/me\/visits$/,
    label: "My Visits",
    keys: ["status", "purpose", "date", "page", "size"],
  },
  {
    path: new RegExp(`^/scheduling/visits/${ID}$`),
    label: "the visit",
    keys: [RETURN_PARAM, "view", "patient"],
  },
  {
    path: /^\/calendar$/,
    label: "Calendar",
    // What the calendar keeps in its URL (calendar-page.tsx), so a filtered week comes back filtered. Not `newVisit`: a way back never
    // reopens the New Visit dialog.
    keys: [
      "view",
      "date",
      "patient",
      "visit",
      "purpose",
      "setting",
      "status",
      "staff",
      "inactive",
      "density",
      "panel",
    ],
  },
  { path: /^\/work\/drafts$/, label: "My Notes", keys: [] },
  { path: /^\/work\/cosignatures$/, label: "Cosignature queue", keys: [] },
  {
    path: new RegExp(`^/patients/${ID}/encounters$`),
    label: "Encounters",
    keys: [],
  },
];

function plainValue(value: string): boolean {
  return value.length <= MAX_VALUE_LENGTH && !hostile(value);
}

function canonicalQuery(params: URLSearchParams, route: ReturnRoute, depth: number): string {
  const kept = new URLSearchParams();
  for (const key of route.keys) {
    const value = params.get(key);
    if (value === null) continue;
    if (key === RETURN_PARAM) {
      const nested = depth < MAX_NESTING ? parseAt(value, depth + 1) : null;
      if (nested) kept.set(key, nested.href);
    } else if (plainValue(value)) {
      kept.set(key, value);
    }
  }
  return kept.toString();
}

function parseAt(raw: string | null | undefined, depth: number): ReturnTarget | null {
  if (!raw || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || hostile(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  // An encoded slash or dot, or a `..` segment the parser resolved, is a path the list below never saw.
  const writtenPath = raw.split(/[?#]/, 1)[0];
  if (url.pathname.includes("%") || writtenPath !== url.pathname) return null;
  const route = ROUTES.find((candidate) => candidate.path.test(url.pathname));
  if (!route) return null;
  const query = canonicalQuery(url.searchParams, route, depth);
  return { href: query ? `${url.pathname}?${query}` : url.pathname, label: route.label };
}

/** The return target a `from` value names, or null when it names nothing this app offers (the caller then uses its default). */
export function parseReturnTarget(raw: string | null | undefined): ReturnTarget | null {
  return parseAt(raw, 0);
}

/** `href` carrying an already parsed target as its way back. A hash on `href` stays last. */
export function withParsedReturnTarget(href: string, target: ReturnTarget | null): string {
  if (!target) return href;
  const hashAt = href.indexOf("#");
  const base = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${RETURN_PARAM}=${encodeURIComponent(target.href)}${hash}`;
}

/**
 * `href` carrying `here` as its way back. `here` is the writer's own location (path and search) or an origin it is forwarding; one that
 * is not a valid target adds nothing, so a link is never worse than it was. A hash on `href` stays last.
 */
export function withReturnTarget(href: string, here: string | null | undefined): string {
  return withParsedReturnTarget(href, parseReturnTarget(here));
}
