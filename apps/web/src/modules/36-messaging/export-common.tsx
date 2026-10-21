// M36 WP 5.7 (ADR-0089, PROPOSED) - small pieces shared by the export screens: the load gate, the status chip (a word, never colour alone), the live
// expiry countdown and the step-up hand-off.
import type { MessagingExportStatus } from "@chartwarden/types";
import { Button, LoadingSpinner, StatusPill } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import * as W from "./export-wording";
import type { ExportResult, LoadView } from "./use-export";

const MINUTE_MS = 60_000;
const TICK_MS = 30_000;

export const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** The current time, refreshed while mounted so a countdown and the download button follow the clock. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Whole minutes left until `expiresAt`, or null when it is unknown or already past. */
export function minutesLeft(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at) || at <= now) return null;
  return Math.max(1, Math.floor((at - now) / MINUTE_MS));
}

/** Ready AND the link has not run out: the only state in which Download is offered. */
export const canDownload = (status: MessagingExportStatus, expiresAt: string | null, now: number) =>
  status === "ready" && minutesLeft(expiresAt, now) !== null;

export function StatusChip({
  status,
  expiresAt,
  now,
}: {
  readonly status: MessagingExportStatus;
  readonly expiresAt: string | null;
  readonly now: number;
}): JSX.Element {
  // A ready link past its time reads as expired even before the server's sweep has marked it.
  const shown: MessagingExportStatus =
    status === "ready" && minutesLeft(expiresAt, now) === null ? "expired" : status;
  const tone =
    shown === "ready" || shown === "approved"
      ? "success"
      : shown === "failed" || shown === "rejected"
        ? "error"
        : shown === "pending_approval" || shown === "building"
          ? "progress"
          : "neutral";
  const glyph =
    shown === "ready" || shown === "approved"
      ? "check"
      : shown === "failed" || shown === "rejected"
        ? "alert"
        : shown === "pending_approval" || shown === "building"
          ? "clock"
          : undefined;
  return <StatusPill tone={tone} {...(glyph ? { glyph } : {})} label={W.STATUS_LABELS[shown]} />;
}

export function Countdown({
  expiresAt,
  now,
}: {
  readonly expiresAt: string | null;
  readonly now: number;
}): JSX.Element | null {
  const left = minutesLeft(expiresAt, now);
  if (left === null) return null; // a lapsed link is already shown as the Expired chip
  return <span className="wx-export-detail">{W.expiresIn(Math.floor(left / 60), left % 60)}</span>;
}

export function LoadGate<T>({
  view,
  retry,
  deniedText,
  children,
}: {
  readonly view: LoadView<T>;
  readonly retry: () => void;
  readonly deniedText: string;
  readonly children: (data: T) => JSX.Element;
}): JSX.Element {
  switch (view.status) {
    case "loading":
      return <LoadingSpinner />;
    case "error":
      return (
        <div className="wx-export-error" role="alert">
          <p>{W.LOAD_FAILED}</p>
          <Button type="button" tone="secondary" size="sm" onClick={retry}>
            {W.RETRY_LABEL}
          </Button>
        </div>
      );
    case "denied":
      return (
        <p className="wx-export-error" role="alert">
          {view.code === 401 ? W.SIGN_IN : deniedText}
        </p>
      );
    case "ready":
      return children(view.data);
  }
}

/** Turns a non-ok result into the sentence to show; a stale step-up goes to the step-up page and says nothing. */
export function useFailureText(): (result: ExportResult<unknown>) => string | null {
  const navigate = useNavigate();
  const location = useLocation();
  return (result) => {
    switch (result.kind) {
      case "ok":
        return null;
      case "step_up": {
        const to = stepUpRedirectFor(result.error, `${location.pathname}${location.search}`);
        if (to) {
          navigate(to);
          return null;
        }
        return W.STEP_UP_TEXT;
      }
      case "limit":
        return W.LIMIT_TEXT;
      case "not_available":
        return W.NOT_AVAILABLE;
      case "conflict":
        return W.conflictText(result.code);
      case "denied":
        return result.code === 401 ? W.SIGN_IN : W.DENIED;
      default:
        return W.ACTION_FAILED;
    }
  };
}
