// apps/web/src/modules/10-hope — the writes on the HOPE record itself that the assessment screen offers: request the
// summary, create a correction, inactivate, confirm a HUV completion date. Moved out of the screen with its behaviour
// unchanged except that each one now ENDS in something visible: none can reject unhandled, a dialog that is busy is
// freed when its request settles (or, if the request is never answered, after `REQUEST_TIMEOUT_MS`), and a failure is
// shown, never left as a screen that looks as if nothing happened. A failure is worded by what is known: a refusal is
// "failed" with the server's reason, while a request with no usable answer is "not confirmed" (it may have been applied).
//
// Every body is typed against the generated contract (`CorrectAssessmentBody` and the others), and the author
// discipline in a correction or an inactivation is the ACTING user's own: the server refuses an attribution that is not one
// of the caller's role keys (403 M10_DISCIPLINE_NOT_PERMITTED), and the read projection carries no discipline of the
// record's author to borrow (it is always empty).
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type CorrectAssessmentBody,
  type HuvCompletionDateBody,
  type InactivateAssessmentBody,
  type SfvAuthorDiscipline,
  authorDisciplinesForRoles,
  failedWriteMessage,
  isStaleVersionRefusal,
  readSucceeded,
  requestSummaryPdf,
  withRequestTimeout,
  writeOutcomeUnknown,
  writeSucceeded,
} from "./hope-api";

/** What a write answers with: an openapi-fetch result (or a double of one). */
interface Reply {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly ok?: boolean; readonly status?: number };
}

interface RecordActionsApi {
  GET(path: string, init?: unknown): Promise<Reply>;
  PATCH(path: string, init?: unknown): Promise<Reply>;
  POST(path: string, init?: unknown): Promise<Reply>;
}

interface RecordInfo {
  readonly status: string;
  readonly version: number;
  readonly targetDate: string;
  readonly rfaKind: string;
  readonly patientId: string;
}

interface TimelineRow {
  readonly id: string;
  readonly status: string;
  readonly correctsAssessmentId?: string | null;
}

interface RecordActionsInputs<Row extends TimelineRow> {
  readonly api: RecordActionsApi;
  readonly client: ApiClient;
  readonly id: string | undefined;
  readonly assessment: RecordInfo | null;
  /** The workspace's version, once it is loaded (a HUV date is written against it). */
  readonly workspaceVersion: number | undefined;
  readonly timeline: readonly Row[];
  readonly setTimeline: (rows: Row[]) => void;
  /** Re-reads the screen; false when any of it could not be read. Never rejects. */
  readonly refresh: () => Promise<boolean>;
  readonly setSaving: (state: "saved" | "failed" | "unconfirmed" | "conflict") => void;
  readonly closeInactivation: () => void;
  readonly navigate: NavigateFunction;
}

const CORRECTION_UNCONFIRMED =
  "Could not confirm that the correction was created. Check the record's timeline before trying again.";
const INACTIVATION_UNCONFIRMED =
  "Could not confirm that the inactivation was created. Check the record's timeline before trying again.";
const COMPLETION_DATE_UNCONFIRMED =
  "Could not confirm that the completion date was saved. Check the assessment before trying again.";

export function useHopeRecordActions<Row extends TimelineRow>(inputs: RecordActionsInputs<Row>) {
  const { api, client, id, assessment, workspaceVersion, timeline, setTimeline, refresh } = inputs;
  const { setSaving, closeInactivation, navigate } = inputs;
  const session = useSession();
  const [summaryState, setSummaryState] = useState<"idle" | "requesting" | "requested" | "failed">(
    "idle",
  );
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [inactivating, setInactivating] = useState(false);
  const [inactivationError, setInactivationError] = useState<string | null>(null);
  const [completionDateSaving, setCompletionDateSaving] = useState(false);
  const [completionDateError, setCompletionDateError] = useState<string | null>(null);
  // A reply that arrives after the clinician has left the record must not act on it: the 30 s bound lets them leave while a
  // create is out, and a late `navigate` would pull them away from wherever they went (as `useSfvSubmit` guards). Every check of
  // it below stands before something observable beyond this screen (a navigation, a timeline lookup, a re-read); none guards a
  // state update alone, which is a no-op after unmount on React 18. Each is covered by an unmount test in
  // `use-hope-record-actions.dom.test.tsx` / `-g3` that fails without it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The disciplines the ACTING user may be attributed as (their own role keys, mirrored from the server's check): one is
  // preselected in the dialog, several make the clinician choose, none blocks the write with a message.
  const roles = session?.roles;
  const rfaKind = assessment?.rfaKind;
  const amendmentDisciplines = useMemo(
    () => authorDisciplinesForRoles(roles ?? [], { sfv: rfaKind === "04_sfv" }),
    [roles, rfaKind],
  );

  // A signed record with a correction already in progress: open that draft instead of a second one
  // (the server refuses a second pending correction with 409).
  const openCorrectionId =
    assessment?.status === "signed"
      ? (timeline.find((t) => t.correctsAssessmentId === id && t.status === "draft")?.id ?? null)
      : null;

  const requestSummary = useCallback(async () => {
    if (!id) return;
    setSummaryState("requesting");
    try {
      // Emits `m10.hope.summary_requested`; M22 renders it out of band.
      const result = await requestSummaryPdf(client, id);
      setSummaryState(result.ok ? "requested" : "failed");
    } catch {
      setSummaryState("failed");
    }
  }, [client, id]);

  /** Opens the correction dialog, or the draft that is already open (the server refuses a second one). */
  const beginCorrection = useCallback(() => {
    if (!id || !assessment) return;
    setCorrectionError(null);
    if (openCorrectionId) {
      navigate(`/hope/assessments/${openCorrectionId}`);
      return;
    }
    setCorrectionOpen(true);
  }, [assessment, id, navigate, openCorrectionId]);

  const closeCorrection = useCallback(() => {
    setCorrectionOpen(false);
    setCorrectionError(null);
  }, []);

  /** The patient's HOPE timeline, or null when it could not be read (a bad reply, a rejection, a timeout): never an empty list. */
  const lookUpTimeline = useCallback(
    async (patientId: string): Promise<Row[] | null> => {
      try {
        const lookup = await withRequestTimeout((signal) =>
          api.GET("/api/v1/patients/{patientId}/hope/assessments", {
            params: { path: { patientId } },
            signal,
          }),
        );
        return readSucceeded(lookup)
          ? ((lookup.data as { assessments?: Row[] }).assessments ?? [])
          : null;
      } catch {
        return null;
      }
    },
    [api],
  );

  const createCorrection = useCallback(
    async (reason: string, authorDiscipline: SfvAuthorDiscipline) => {
      if (!id || !assessment) return;
      setCorrecting(true);
      setCorrectionError(null);
      let conflict = false;
      try {
        const body: CorrectAssessmentBody = {
          correctionReason: reason.trim(),
          ifVersion: assessment.version,
          targetDate: assessment.targetDate,
          authorDiscipline,
          data: {},
        };
        const res = await withRequestTimeout((signal) =>
          api.POST("/api/v1/hope/assessments/{id}/correct", {
            params: { path: { id } },
            body,
            signal,
          }),
        );
        if (!mounted.current) return; // before the navigation to the new correction, and the lookup request
        const correctionId = (res.data as { id?: string } | undefined)?.id;
        if (correctionId) {
          setCorrectionOpen(false);
          navigate(`/hope/assessments/${correctionId}`);
          return;
        }
        conflict = isStaleVersionRefusal(res);
        // Another session may have started one: look it up before reporting the failure. An unreadable answer (a bad
        // reply, a rejection, a timeout) is not an empty timeline, so it never replaces the rows already on screen, and it
        // never replaces the create's own refusal with a "could not confirm" about a correction that was never created.
        const rows = await lookUpTimeline(assessment.patientId);
        if (!mounted.current) return; // before the navigation to the draft another session started
        if (rows) setTimeline(rows);
        const existing = rows?.find((t) => t.correctsAssessmentId === id && t.status === "draft");
        if (existing) {
          setCorrectionOpen(false);
          navigate(`/hope/assessments/${existing.id}`);
          return;
        }
        setCorrectionError(
          failedWriteMessage(res, CORRECTION_UNCONFIRMED, "The correction could not be created."),
        );
      } catch {
        setCorrectionError(CORRECTION_UNCONFIRMED);
      } finally {
        // Freed whatever happened: a request nobody answers ends in the catch above once REQUEST_TIMEOUT_MS has passed.
        setCorrecting(false);
        // After the dialog is free, so a read that never answers cannot hold it: the next attempt must carry the version
        // the record has now, not the stale one that was just refused.
        if (conflict && mounted.current) void refresh();
      }
    },
    [api, assessment, id, lookUpTimeline, navigate, refresh, setTimeline],
  );

  const createInactivation = useCallback(
    async (reason: string, authorDiscipline: SfvAuthorDiscipline) => {
      if (!id || !assessment) return;
      setInactivating(true);
      setInactivationError(null);
      let conflict = false;
      try {
        const body: InactivateAssessmentBody = {
          reason: reason.trim(),
          ifVersion: assessment.version,
          authorDiscipline,
        };
        const res = await withRequestTimeout((signal) =>
          api.POST("/api/v1/hope/assessments/{id}/inactivations", {
            params: { path: { id } },
            body,
            signal,
          }),
        );
        if (!mounted.current) return; // before `closeInactivation` and the navigation to the new inactivation
        if (!writeSucceeded(res)) {
          conflict = isStaleVersionRefusal(res);
          setInactivationError(
            failedWriteMessage(
              res,
              INACTIVATION_UNCONFIRMED,
              "The inactivation could not be created.",
            ),
          );
          return;
        }
        closeInactivation();
        const inactivationId = (res.data as { id?: string } | undefined)?.id;
        if (inactivationId) navigate(`/hope/assessments/${inactivationId}`);
      } catch {
        setInactivationError(INACTIVATION_UNCONFIRMED);
      } finally {
        // Freed whatever happened: a request nobody answers ends in the catch above once REQUEST_TIMEOUT_MS has passed.
        setInactivating(false);
        // As in createCorrection: after the dialog is free, and so the retry does not resend the version just refused.
        if (conflict && mounted.current) void refresh();
      }
    },
    [api, assessment, closeInactivation, id, navigate, refresh],
  );

  const setHuvCompletionDate = useCallback(
    async (z0350: string) => {
      if (!id || workspaceVersion === undefined || assessment?.status !== "draft") return;
      setCompletionDateSaving(true);
      setCompletionDateError(null);
      let reread = false;
      try {
        const body: HuvCompletionDateBody = { ifVersion: workspaceVersion, z0350 };
        const res = await withRequestTimeout((signal) =>
          api.PATCH("/api/v1/hope/assessments/{id}/huv/completion-date", {
            params: { path: { id } },
            body,
            signal,
          }),
        );
        if (!writeSucceeded(res)) {
          // Another session saved first: say so (the page's conflict banner), and re-read so the retry carries the version
          // the record has now instead of the one just refused.
          const conflict = isStaleVersionRefusal(res);
          setSaving(conflict ? "conflict" : writeOutcomeUnknown(res) ? "unconfirmed" : "failed");
          // The conflict banner already says the page is stale; any other failure is worded next to the control.
          if (!conflict) {
            setCompletionDateError(
              failedWriteMessage(
                res,
                COMPLETION_DATE_UNCONFIRMED,
                "The completion date could not be saved.",
              ),
            );
          }
          reread = conflict;
          return;
        }
        setSaving("saved");
        reread = true;
      } catch {
        setSaving("unconfirmed");
        setCompletionDateError(COMPLETION_DATE_UNCONFIRMED);
      } finally {
        setCompletionDateSaving(false);
        // After the control is free, so a read that never answers cannot hold it shut (as in createCorrection).
        if (reread && mounted.current) void refresh();
      }
    },
    [api, assessment?.status, id, refresh, setSaving, workspaceVersion],
  );

  return {
    summaryState,
    requestSummary,
    amendmentDisciplines,
    correctionOpen,
    correcting,
    correctionError,
    openCorrectionId,
    beginCorrection,
    closeCorrection,
    createCorrection,
    inactivating,
    inactivationError,
    clearInactivationError: useCallback(() => setInactivationError(null), []),
    createInactivation,
    completionDateSaving,
    completionDateError,
    setHuvCompletionDate,
  };
}
