// M36 WP 5.9 (ADR-0084, PROPOSED) - reads the dry-run (GET) and runs the execute step (POST) of a departed user's offboarding. The checklist shown is
// always the server's latest answer: a run replaces it, and a failed run leaves the previous one in place. After a 401/403 no further request is made.
// A stale step-up is handed back to the screen to send the officer through the step-up page. Nothing here stores or logs an id.
import type { OffboardingDto } from "@chartwarden/types";
import { isStepUpRequired } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

export type OffboardingView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "denied"; readonly code: 401 | 403 }
  | { readonly status: "not_found" }
  | { readonly status: "not_offboarded" }
  | { readonly status: "ready"; readonly data: OffboardingDto };

export type RunResult =
  | { readonly kind: "ran" }
  | { readonly kind: "step_up"; readonly error: unknown }
  | { readonly kind: "failed" };

export interface UseOffboarding {
  readonly view: OffboardingView;
  readonly running: boolean;
  /** Set after a run that could not be sent or answered; cleared by the next run. */
  readonly runFailed: boolean;
  readonly run: () => Promise<RunResult>;
  readonly retry: () => void;
}

const viewForFailure = (status: number | undefined): OffboardingView => {
  if (status === 401 || status === 403) return { status: "denied", code: status };
  if (status === 404) return { status: "not_found" };
  if (status === 409) return { status: "not_offboarded" };
  return { status: "error" };
};

export function useOffboarding(userId: string): UseOffboarding {
  const client = useOptionalApiClient();
  const [view, setView] = useState<OffboardingView>({ status: "loading" });
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const scope = useRef(0); // a response settling after a change of person or an unmount is dropped

  const read = useCallback(async (): Promise<void> => {
    if (!client) {
      setView({ status: "error" });
      return;
    }
    const mine = scope.current;
    try {
      const { data, response } = await client.GET(
        "/api/v1/messaging/governance/offboarding/{userId}",
        { params: { path: { userId } } },
      );
      if (mine !== scope.current) return;
      setView(
        data ? { status: "ready", data: data as OffboardingDto } : viewForFailure(response?.status),
      );
    } catch {
      if (mine === scope.current) setView({ status: "error" });
    }
  }, [client, userId]);

  useEffect(() => {
    scope.current += 1;
    setView({ status: "loading" });
    setRunning(false);
    setRunFailed(false);
    void read();
    return () => {
      scope.current += 1;
    };
  }, [read]);

  const run = useCallback(async (): Promise<RunResult> => {
    if (!client) return { kind: "failed" };
    const mine = scope.current;
    setRunning(true);
    setRunFailed(false);
    try {
      const { data, error, response } = await client.POST(
        "/api/v1/messaging/governance/offboarding/{userId}/execute",
        { params: { path: { userId } } },
      );
      if (mine !== scope.current) return { kind: "failed" };
      setRunning(false);
      if (data) {
        setView({ status: "ready", data: data as OffboardingDto });
        return { kind: "ran" };
      }
      // A step-up refusal is not a failed run: the screen sends the officer to verify and back.
      if (error !== undefined && isStepUpRequired(error)) return { kind: "step_up", error };
      const status = response?.status;
      if (status === 401 || status === 403 || status === 404 || status === 409) {
        setView(viewForFailure(status));
        return { kind: "failed" };
      }
      // The server may have done part of the work before it failed: show what is true now, not the checklist from before the run.
      setRunFailed(true);
      void read();
      return { kind: "failed" };
    } catch {
      if (mine === scope.current) {
        setRunning(false);
        setRunFailed(true);
        void read();
      }
      return { kind: "failed" };
    }
  }, [client, userId, read]);

  const retry = useCallback(() => {
    setView({ status: "loading" });
    void read();
  }, [read]);

  return { view, running, runFailed, run, retry };
}
