import {
  Button,
  Glyph,
  SelectField,
  StatusPill,
  TextAreaField,
  useApiClient,
} from "@chartwarden/ui";
// M31 portal amendment requests: M5 owns the workflow. This screen can submit and track a
// request; it must never suggest that submitting changes the medical record directly.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { formatPortalInstant, humanize, readError, statusTone } from "./portal-format";
import { PortalPage } from "./portal-page";

type TargetKind = "patient_demographic" | "encounter_narrative";
interface Amendment {
  id?: string;
  targetKind?: string;
  requestedChange?: string;
  status?: string;
  submittedAt?: string;
}
type HistoryState =
  | { status: "loading"; items: [] }
  | { status: "error"; items: []; message: string }
  | { status: "ready"; items: Amendment[] };

const TARGET_OPTIONS = [
  { value: "patient_demographic", label: "Personal or contact information" },
  { value: "encounter_narrative", label: "Information written about a visit" },
] as const;

function requestType(value: string | undefined): string {
  if (value === "patient_demographic") return "Personal or contact information";
  if (value === "encounter_narrative") return "Information written about a visit";
  return value ? humanize(value) : "Record information";
}
function submittedDate(value: string | undefined): string {
  return formatPortalInstant(value) ?? "Date unavailable";
}
function sortRequests(items: Amendment[]): Amendment[] {
  const timestamp = (value?: string): number => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...items].sort((a, b) => timestamp(b.submittedAt) - timestamp(a.submittedAt));
}
function parseHistory(value: unknown): Amendment[] | null {
  if (!value || typeof value !== "object" || !("items" in value)) return null;
  const items = (value as { items: unknown }).items;
  if (!Array.isArray(items)) return null;
  const optionalText = (value: unknown): boolean => value == null || typeof value === "string";
  if (
    items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const entry = item as Record<string, unknown>;
      return ![
        entry.id,
        entry.targetKind,
        entry.requestedChange,
        entry.status,
        entry.submittedAt,
      ].every(optionalText);
    })
  )
    return null;
  return items as Amendment[];
}

/** Keyed by selected patient: drafts, requests and pending feedback never cross patient contexts. */
export function PortalAmendments(): JSX.Element {
  const { patientId } = usePortalPatient();
  return <AmendmentsForPatient key={patientId ?? "no-patient"} patientId={patientId} />;
}

function AmendmentsForPatient({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const [history, setHistory] = useState<HistoryState>({
    status: "loading",
    items: [],
  });
  const [attempt, setAttempt] = useState(0);
  const [targetKind, setTargetKind] = useState<TargetKind>("patient_demographic");
  const [requestedChange, setRequestedChange] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    void attempt;
    let active = true;
    setHistory({ status: "loading", items: [] });
    if (!patientId)
      return () => {
        active = false;
      };
    void (async () => {
      try {
        const response = await client.GET("/api/v1/portal/amendments", {});
        if (!active) return;
        if ("error" in response) {
          setHistory({
            status: "error",
            items: [],
            message: readError(response.response?.status),
          });
          return;
        }
        const items = parseHistory(response.data);
        setHistory(
          items
            ? { status: "ready", items: sortRequests(items) }
            : { status: "error", items: [], message: readError(undefined) },
        );
      } catch {
        if (active)
          setHistory({
            status: "error",
            items: [],
            message: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, attempt]);

  function review(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!patientId || inFlight.current || !requestedChange.trim()) return;
    setFeedback(null);
    setReviewing(true);
  }

  async function submit(): Promise<void> {
    const request = requestedChange.trim();
    if (!patientId || !reviewing || !request || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setFeedback(null);
    try {
      const response = await client.POST("/api/v1/portal/amendments/submit", {
        body: { targetKind, requestedChange: request },
      });
      if (!mounted.current) return;
      if ("error" in response) {
        setFeedback({
          kind: "error",
          message: `We couldn't confirm your request. ${readError(response.response?.status)}`,
        });
        return;
      }
      setRequestedChange("");
      setTargetKind("patient_demographic");
      setReviewing(false);
      setFeedback({
        kind: "success",
        message:
          "Your correction request was submitted for review. This does not change the record directly.",
      });
      reload();
    } catch {
      if (mounted.current)
        setFeedback({
          kind: "error",
          message:
            "We couldn't confirm whether the request was received. Check your request history before submitting again.",
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }

  return (
    <PortalPage
      width="workspace"
      title="Request a correction"
      subtitle="Ask your hospice team to review information that may be incorrect in the record."
    >
      <div className="wx-amendments-intro" role="note">
        <span className="wx-amendments-intro__icon" aria-hidden="true">
          <Glyph name="file-text" size={24} />
        </span>
        <div>
          <strong>How correction requests work</strong>
          <p>
            Tell us which information you believe is incorrect and what you believe it should say.
            Your request goes through a review process; submitting it does not automatically change
            the record.
          </p>
        </div>
      </div>
      <div className="wx-amendments-layout">
        <section
          className="wx-amendments-panel wx-amendments-panel--form"
          aria-labelledby="amendment-new-title"
        >
          <div className="wx-amendments-panel__heading">
            <span className="wx-amendments-panel__icon" aria-hidden="true">
              <Glyph name="clipboard-list" size={22} />
            </span>
            <div>
              <h2 id="amendment-new-title">New correction request</h2>
              <p>Describe the information you want the team to review.</p>
            </div>
          </div>
          {!patientId ? (
            <p className="wx-amendments-muted">Choose a patient to request a correction.</p>
          ) : reviewing ? (
            <div className="wx-amendments-review">
              <h3>Review before sending</h3>
              <dl>
                <div>
                  <dt>Information to review</dt>
                  <dd>{requestType(targetKind)}</dd>
                </div>
                <div>
                  <dt>Requested correction</dt>
                  <dd className="wx-amendments-long-text">{requestedChange.trim()}</dd>
                </div>
              </dl>
              <p className="wx-amendments-muted">
                Your team will review this request. This step does not edit the medical record.
              </p>
              <div className="wx-amendments-actions">
                <Button
                  type="button"
                  tone="secondary"
                  disabled={sending}
                  onClick={() => {
                    setReviewing(false);
                    setFeedback(null);
                  }}
                >
                  Edit request
                </Button>
                <Button
                  type="button"
                  aria-label="Submit request"
                  loading={sending}
                  disabled={sending}
                  onClick={() => void submit()}
                >
                  Submit request
                </Button>
              </div>
            </div>
          ) : (
            <form className="wx-amendments-form" onSubmit={review}>
              <SelectField
                label="What information needs correcting?"
                value={targetKind}
                onChange={(event) => {
                  setTargetKind(event.target.value as TargetKind);
                  setFeedback(null);
                }}
                options={TARGET_OPTIONS}
              />
              <TextAreaField
                label="Describe the correction"
                aria-label="Describe the correction"
                hint="Explain what is incorrect and what the correct information should be. Include only details needed for review."
                value={requestedChange}
                onChange={(event) => {
                  setRequestedChange(event.target.value);
                  setFeedback(null);
                }}
                required
                rows={6}
                placeholder="The record currently says… It should say…"
              />
              <p className="wx-amendments-muted">
                For questions about care, contact your hospice team. Do not include passwords or
                account security codes.
              </p>
              <div className="wx-amendments-actions">
                <Button type="submit" disabled={!requestedChange.trim()}>
                  Review request <Glyph name="arrow-right" size={16} aria-hidden="true" />
                </Button>
              </div>
            </form>
          )}
          {feedback ? (
            <div
              className={`wx-amendments-feedback wx-amendments-feedback--${feedback.kind}`}
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              <Glyph
                name={feedback.kind === "error" ? "alert-circle" : "check-circle"}
                size={19}
                aria-hidden="true"
              />
              {feedback.message}
            </div>
          ) : null}
        </section>

        <section
          className="wx-amendments-panel wx-amendments-panel--history"
          aria-labelledby="amendment-history-title"
        >
          <div className="wx-amendments-panel__heading">
            <span className="wx-amendments-panel__icon" aria-hidden="true">
              <Glyph name="file-text" size={22} />
            </span>
            <div>
              <h2 id="amendment-history-title">Your requests</h2>
              <p>Review the requests submitted for this record.</p>
            </div>
          </div>
          {!patientId ? (
            <p className="wx-amendments-muted">Choose a patient to see their requests.</p>
          ) : history.status === "loading" ? (
            <output className="wx-amendments-skeleton" aria-label="Loading correction requests">
              <span />
              <span />
              <span />
            </output>
          ) : history.status === "error" ? (
            <div className="wx-amendments-history-state" role="alert">
              <Glyph name="alert-circle" size={23} aria-hidden="true" />
              <div>
                <h3>Requests unavailable</h3>
                <p>{history.message}</p>
                <Button tone="secondary" onClick={reload}>
                  Try again
                </Button>
              </div>
            </div>
          ) : history.items.length === 0 ? (
            <div className="wx-amendments-history-state">
              <Glyph name="clipboard-list" size={26} aria-hidden="true" />
              <div>
                <h3>No requests submitted yet</h3>
                <p>
                  When you send a request, it will appear here if the team has made it available for
                  tracking.
                </p>
              </div>
            </div>
          ) : (
            <ol className="wx-amendments-requests" aria-label="Correction request history">
              {history.items.map((item, index) => (
                <li
                  key={item.id ?? `${item.submittedAt ?? "unknown"}-${index}`}
                  className="wx-amendments-request"
                >
                  <div className="wx-amendments-request__top">
                    <span>{submittedDate(item.submittedAt)}</span>
                    {item.status ? (
                      <StatusPill tone={statusTone(item.status)} label={humanize(item.status)} />
                    ) : (
                      <span>Status unavailable</span>
                    )}
                  </div>
                  <h3>{requestType(item.targetKind)}</h3>
                  <p className="wx-amendments-long-text">
                    {item.requestedChange?.trim() || "Request details unavailable"}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </PortalPage>
  );
}
