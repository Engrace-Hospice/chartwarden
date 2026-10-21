// apps/web/src/modules/06-admission — pure helpers + the post-activation patient poll for Admission Detail.
// Split from admission-detail.tsx (file-size ceiling); nothing here renders.
import { type ApiClient, formatDateOnly } from "@chartwarden/ui";
import { type MutableRefObject, useCallback, useEffect, useState } from "react";
import { stateLabel } from "./admission-status";
import { ADDENDUM_WINDOW_LABEL } from "./election-addendum-format";

export interface SummaryRow {
  id: string;
  state: string;
  version: number;
}
export interface WindowRow extends SummaryRow {
  windowKind?: string | null;
  dueAt?: string | null;
}
export interface PeriodRow extends SummaryRow {
  sequenceNumber?: number;
  expectedStart?: string | null;
  effectiveAt?: string | null;
  scheduledEndAt?: string | null;
}

/** Backoff between patient re-reads while M5's prospective -> active promotion catches up (bounded). */
export const PROMOTION_POLL_DELAYS_MS = [1000, 2000, 3000, 5000, 8000] as const;

/** An active admission is authoritative: never show its patient as "prospective" while M5 catches up. */
export function displayPatientStatus(patientStatus: string, admissionState?: string): string {
  return admissionState === "active" && patientStatus === "prospective" ? "active" : patientStatus;
}

export function describePeriod(p: PeriodRow): string {
  const start = p.effectiveAt ?? p.expectedStart;
  const range = [start, p.scheduledEndAt].map((d) => (d ? formatDateOnly(d) : "TBD")).join(" – ");
  return `Period ${p.sequenceNumber ?? "?"} · ${range}`;
}

// `dueAt` is a timestamptz instant (not date-only), so it is shown as a date in the viewer's locale and zone.
export function describeWindow(w: WindowRow): string {
  const raw = w.windowKind ?? "compliance_window";
  const kind = ADDENDUM_WINDOW_LABEL[raw] ?? stateLabel(raw);
  if (!w.dueAt) return kind;
  const due = new Date(w.dueAt);
  if (Number.isNaN(due.getTime())) return kind;
  return `${kind} · due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

interface PromotionPollArgs<P extends { status?: string | null }> {
  readonly client: ApiClient;
  readonly admissionState: string | undefined;
  readonly patientId: string | undefined;
  readonly patientStatus: string | null | undefined;
  /** The page's patient-request counter: a poll that finishes after load()/retry/unmount is dropped. */
  readonly patientRequest: MutableRefObject<number>;
  readonly onPatient: (patient: P) => void;
}

/**
 * M5 promotes prospective -> active asynchronously (outbox consumer, ~0.2-4 s). Right after activation the
 * patient read can still say "prospective": re-read it a few times with backoff, then give up (the display
 * already derives "Active" from the admission, so a stuck consumer is never shown as truth).
 * Returns `resetPolls` (call on load) and a screen-reader line for when the poll caught the promotion.
 */
export function usePromotionPoll<P extends { status?: string | null }>({
  client,
  admissionState,
  patientId,
  patientStatus,
  patientRequest,
  onPatient,
}: PromotionPollArgs<P>): { resetPolls: () => void; announcement: string } {
  const [polls, setPolls] = useState(0);
  const resetPolls = useCallback(() => setPolls(0), []);

  useEffect(() => {
    if (
      admissionState !== "active" ||
      patientStatus !== "prospective" ||
      !patientId ||
      polls >= PROMOTION_POLL_DELAYS_MS.length
    )
      return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const request = patientRequest.current;
      try {
        const result = await client.GET("/api/v1/patients/{id}", {
          params: { path: { id: patientId } },
        });
        if (cancelled || request !== patientRequest.current) return;
        if (result.data) onPatient(result.data as unknown as P);
      } catch {
        // Best effort: a failed re-read just spends one attempt.
      } finally {
        if (!cancelled) setPolls((n) => n + 1);
      }
    }, PROMOTION_POLL_DELAYS_MS[polls]);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [admissionState, patientStatus, patientId, polls, client, patientRequest, onPatient]);

  const caughtUp = polls > 0 && admissionState === "active" && patientStatus === "active";
  return { resetPolls, announcement: caughtUp ? "Patient record is now active." : "" };
}
