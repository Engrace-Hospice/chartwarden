import { BACKGROUND_REQUEST_HEADERS, type operations, useApiClient } from "@chartwarden/ui";
// apps/web/src/shell — the shell's view of the signed-in clinician's visit-note closure clock (ADR-0113). It polls
// GET /api/v1/encounters/closure-status beside the alert inbox, for AUTHORS ONLY (the route needs `encounter.author`; a
// non-author would only collect 403s), and hands the answer to the closure banner. The route is on the gate's allowlist, so it
// answers a blocked clinician too. The decision (stage, verdict, deadline) is the server's; nothing here re-derives it.
//
// A poll failure is silent: the last known answer stays, so the banner never flickers and no error toast appears for background work.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JSX, ReactNode } from "react";
import { getGlobalResponseSignal, subscribeGlobalResponseSignal } from "./global-response-signal";
import { isOnboardingSession } from "./onboarding-stage";
import { useSessionState } from "./session";
import { useRefreshCues } from "./use-refresh-cues";

/** How often an author's closure status is refreshed in the background. */
export const NOTE_CLOSURE_POLL_INTERVAL_MS = 60_000;
/** While the clinician is blocked the poll runs faster, so closing the last overdue note lifts the banner within seconds. */
export const NOTE_CLOSURE_BLOCKED_POLL_INTERVAL_MS = 15_000;
/**
 * A gate refusal refreshes the status at once, but never more often than this: should the status read itself ever be refused, the
 * refresh it triggers must not loop.
 */
export const NOTE_CLOSURE_MIN_REFRESH_GAP_MS = 5_000;

const AUTHOR_PERMISSION = "encounter.author";

/** The generated OpenAPI contract for the caller's own closure position. */
export type NoteClosureStatus =
  operations["getApiV1EncountersClosurestatus"]["responses"][200]["content"]["application/json"];

interface NoteClosureContextValue {
  /** The last answer, or null: not an author, still loading, or never answered. */
  readonly status: NoteClosureStatus | null;
  /** Re-read the status now (a no-op while a read is in flight). */
  readonly refresh: () => void;
}

const NO_CLOSURE: NoteClosureContextValue = { status: null, refresh: () => undefined };
const NoteClosureContext = createContext<NoteClosureContextValue>(NO_CLOSURE);

export function NoteClosureProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useApiClient();
  const { session, status: sessionStatus } = useSessionState();
  const [status, setStatus] = useState<NoteClosureStatus | null>(null);
  const inFlight = useRef(false);
  const lastStartedAt = useRef(0);
  const scopeRef = useRef<string | null>(null);
  const isAuthor = session?.permissions?.includes(AUTHOR_PERMISSION) === true;
  // An organization still being onboarded is confined by the server (no notes exist yet): ask nothing.
  const scope =
    sessionStatus === "authenticated" && session && isAuthor && !isOnboardingSession(session)
      ? `${session.organizationId}:${session.userId}`
      : null;

  useEffect(() => {
    scopeRef.current = scope;
    inFlight.current = false;
    lastStartedAt.current = 0;
    setStatus(null);
  }, [scope]);

  const load = useCallback(
    async (background: boolean): Promise<void> => {
      if (scope === null || inFlight.current) return;
      inFlight.current = true;
      lastStartedAt.current = Date.now();
      try {
        const { data, error } = background
          ? await client.GET("/api/v1/encounters/closure-status", {
              headers: BACKGROUND_REQUEST_HEADERS,
            })
          : await client.GET("/api/v1/encounters/closure-status");
        // A response for the previous user/org must not hydrate this scope.
        if (scopeRef.current === scope && !error && data) setStatus(data);
      } catch {
        // Silent by design: keep the last known answer.
      } finally {
        if (scopeRef.current === scope) inFlight.current = false;
      }
    },
    [client, scope],
  );

  // Opening the app is the person's own read, an ordinary request. Every later read is a CUE's (the timer below, a return to the tab, a
  // gate refusal) and is background work: marked, so it never counts as activity and keeps the idle logoff honest (GAP-002). Only
  // `refresh()` (the person pressing a button) is unmarked again. The same rule use-refresh-cues.ts gives every screen that re-reads.
  useEffect(() => {
    if (scope !== null) void load(false);
  }, [load, scope]);

  // While the clinician is blocked the poll runs faster, so closing the last overdue note lifts the banner within seconds.
  const blocked = status?.verdict === "blocked";
  const intervalMs =
    scope === null
      ? null
      : blocked
        ? NOTE_CLOSURE_BLOCKED_POLL_INTERVAL_MS
        : NOTE_CLOSURE_POLL_INTERVAL_MS;
  useRefreshCues(() => void load(true), intervalMs);

  // A gate refusal observed anywhere means the clock just changed for this clinician: read it now instead of waiting for the next poll.
  // A refusal is often the answer to someone ELSE's background poll (a wallboard's 30-second safety-dashboard refresh), so this read is
  // background work too, and skipped while the tab is hidden, like every cue.
  useEffect(() => {
    if (scope === null) return;
    return subscribeGlobalResponseSignal(() => {
      if (getGlobalResponseSignal()?.kind !== "note-closure-required") return;
      if (document.hidden) return;
      if (Date.now() - lastStartedAt.current < NOTE_CLOSURE_MIN_REFRESH_GAP_MS) return;
      void load(true);
    });
  }, [load, scope]);

  const refresh = useCallback((): void => {
    void load(false);
  }, [load]);
  const value = useMemo(() => ({ status, refresh }), [status, refresh]);
  return <NoteClosureContext.Provider value={value}>{children}</NoteClosureContext.Provider>;
}

/** The clinician's closure position; `status` is null outside a provider, for a non-author and until the first answer. */
export function useNoteClosure(): NoteClosureContextValue {
  return useContext(NoteClosureContext);
}
