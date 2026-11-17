import type { HopeSfvStatus } from "@chartwarden/types";
// apps/web/src/modules/10-hope — what the SFV queue says about ONE signed record's follow-up visit.
//
// An SFV is completed against its TRIGGERING assessment, and the server allows that after the assessment is
// signed (it looks the obligation up by admission + triggering id and never reads the record's status). A signed
// record is read-only, so its own J2052/J2053 answers are never written and cannot say whether the visit has
// happened since. The queue (`GET /hope/sfv`) is the source of truth, and the server filters it by
// `triggeringAssessmentId`: one request for this record's row, never the whole worklist. Used only for a signed
// record whose follow-up is required and not yet recorded on it.
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { readSucceeded, withRequestTimeout } from "./hope-api";

const KNOWN_STATUSES: ReadonlySet<string> = new Set<HopeSfvStatus>([
  "open",
  "overdue",
  "completed",
  "missed",
  "withdrawn",
]);

export type SfvLookup =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "none" }
  | {
      readonly state: "found";
      readonly status: HopeSfvStatus;
      /** The RFA-04 assessment that recorded the visit, once it has been completed. */
      readonly completingAssessmentId: string | null;
    };

const IDLE: SfvLookup = { state: "idle" };
const LOADING: SfvLookup = { state: "loading" };
const FAILED: SfvLookup = { state: "failed" };
const NONE: SfvLookup = { state: "none" };

/**
 * This record's follow-up in a (server-filtered) queue response, or `none` (also for a status this screen does not
 * know). The match is a guard, not a scan: a row for another record can never be mistaken for this one.
 */
function lookupIn(data: unknown, assessmentId: string): SfvLookup {
  const rows = (data as { sfvs?: unknown } | null | undefined)?.sfvs;
  if (!Array.isArray(rows)) return NONE;
  const mine = rows.find(
    (r: unknown) =>
      typeof r === "object" &&
      r !== null &&
      (r as { triggeringAssessmentId?: unknown }).triggeringAssessmentId === assessmentId,
  ) as { status?: unknown; completingAssessmentId?: unknown } | undefined;
  const status = mine?.status;
  if (typeof status !== "string" || !KNOWN_STATUSES.has(status)) return NONE;
  const completing = mine?.completingAssessmentId;
  return {
    state: "found",
    status: status as HopeSfvStatus,
    completingAssessmentId: typeof completing === "string" && completing !== "" ? completing : null,
  };
}

/**
 * Reads the queue once per `reloadKey` while `enabled`, and answers `idle` (no request made) otherwise. While the
 * answer is outstanding it is `loading`, so nothing actionable is offered on a guess; a failed or unreadable
 * answer (a non-OK reply with no body included) is `failed`, and `retry` asks again. Bump `reloadKey` after completing the visit to read the new status.
 * A response that arrives after the record or the key changed, or after the screen went away, is dropped.
 */
export function useSfvOfSignedRecord(
  assessmentId: string,
  enabled: boolean,
  reloadKey: number,
): { lookup: SfvLookup; retry: () => void } {
  const client = useApiClient();
  const [attempt, setAttempt] = useState(0);
  const key = `${assessmentId}:${reloadKey}:${attempt}`;
  const [settled, setSettled] = useState<{ key: string; lookup: SfvLookup } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const settle = (lookup: SfvLookup): void => {
      if (current) setSettled({ key, lookup });
    };
    // Bounded: a request nobody answers is `failed` (with Retry), not a lookup that stays `loading` and never offers the action.
    withRequestTimeout((signal) =>
      client.GET("/api/v1/hope/sfv", {
        params: { query: { triggeringAssessmentId: assessmentId } },
        signal,
      }),
    ).then(
      // An empty reply from a gateway fault carries no error body, so `error` alone would read it as an empty queue and
      // tell the clinician the follow-up cannot be completed: it is `failed` (with Retry) unless the read really succeeded.
      (reply) => settle(readSucceeded(reply) ? lookupIn(reply.data, assessmentId) : FAILED),
      () => settle(FAILED),
    );
    return () => {
      current = false;
    };
  }, [client, assessmentId, enabled, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (!enabled) return { lookup: IDLE, retry };
  return { lookup: settled?.key === key ? settled.lookup : LOADING, retry };
}
