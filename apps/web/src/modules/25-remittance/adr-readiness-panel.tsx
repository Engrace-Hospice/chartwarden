import { Button, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the DOCUMENTATION READINESS section of the ADR work panel (hospice ADR/TPE/QIC PRD,
// milestone 8a-1). ADVISORY: it shows which checklist items have no document attached (computed by the server from the
// packet, no model), and, only when an assistant has answered, its findings under a persistent "AI-generated, advisory,
// may be wrong" banner, each with the documents it cites and a person's final disposition. When the AI check is
// unavailable the panel says so in one sentence and the manual checklist is unchanged: no error toast, no blocked control.
// Nothing here can tick the checklist, attach a document, or gate sign-off or filing, and no copy says the documentation
// is complete or sufficient. None of these routes is step-up gated (the server needs only the three readiness keys).
// The parent mounts this with `key={adrId}`, so switching ADRs resets every piece of state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ButtonRow, ErrorAlert, Hint, WarningAlert } from "./action-ui";
import {
  type AdrReadinessView,
  READINESS_DISPOSITIONS,
  type ReadinessDisposition,
  type ReadinessFinding,
  disposeReadinessFinding,
  loadReadiness,
  requestReadinessReview,
} from "./adr-readiness-api";
import { humanize } from "./remittance-status";

const GAP_LABEL: Record<string, string> = {
  no_document_attached: "No document attached",
  documents_attached: "Document attached",
  marked_not_applicable: "Marked not applicable",
};
const FINDING_LABEL: Record<string, string> = {
  looks_present: "A matching document appears to be attached",
  possibly_missing: "May be missing",
  cannot_tell: "Cannot tell",
};
const REQUESTABLE_STATES = ["in_assembly", "in_review"];
const BUSY_REASON_ID = "readiness-busy-reason";

/** What the panel says about a stored review, by its status. Unknown statuses are "not completed", never "no findings". */
function statusLine(status: string): string | null {
  switch (status) {
    case "ready":
      return null;
    case "requested":
      return "AI check in progress; the manual checklist is unchanged.";
    case "unavailable":
      return "AI check unavailable; the manual checklist is unchanged.";
    case "failed":
      return "AI check failed; the manual checklist is unchanged.";
    default:
      return "AI check not completed; the manual checklist is unchanged.";
  }
}

export interface AdrReadinessPanelProps {
  readonly adrId: string;
  /** Bumps when the packet changed, so the gap view reloads. */
  readonly packetVersion: number;
}

function CitedDocuments({ ids }: { readonly ids: readonly string[] }): JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <>
      {" "}
      Cited:{" "}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ", " : ""}
          <Link to={`/documents/${encodeURIComponent(id)}/versions`} title={id}>
            {`Document ${i + 1}`}
          </Link>
        </span>
      ))}
    </>
  );
}

export function AdrReadinessPanel({
  adrId,
  packetVersion,
}: AdrReadinessPanelProps): JSX.Element | null {
  const client = useApiClient();
  const [view, setView] = useState<AdrReadinessView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Kept apart from the load error so a reload after an action cannot erase what the action reported.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await loadReadiness(client, adrId);
    // An older response must never overwrite a newer one.
    if (!mounted.current || seq !== loadSeq.current) return;
    if (res.ok) {
      setView(res.value);
      setLoadError(null);
      setHidden(false);
    } else if (res.status === 403) {
      setHidden(true); // not permitted: the section simply is not offered
    } else {
      setLoadError(res.message); // includes a transient 404: shown with a Retry, never latched
    }
  }, [client, adrId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: packetVersion is the reload trigger
  useEffect(() => {
    void load();
  }, [load, packetVersion]);

  /** Runs one user action once at a time; a second click while one is in flight does nothing. */
  async function act(
    call: () => Promise<{ ok: true } | { ok: false; message: string }>,
  ): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const res = await call();
      if (!mounted.current) return;
      if (!res.ok) setActionError(res.message);
      await load();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const request = () => act(() => requestReadinessReview(client, adrId));
  const dispose = (finding: ReadinessFinding, disposition: ReadinessDisposition) =>
    act(() => disposeReadinessFinding(client, adrId, finding.id, disposition));

  if (hidden) return null;
  const review = view?.review ?? null;
  const gaps = view?.gaps.keys.filter((k) => k.isGap) ?? [];
  const line = review ? statusLine(review.status) : null;
  const showFindings = review?.status === "ready";
  const canRespond = review !== null && !review.stale;
  const busyProps = {
    "aria-disabled": busy || undefined,
    "aria-describedby": busy ? BUSY_REASON_ID : undefined,
  };

  return (
    <section aria-label="Documentation readiness" aria-busy={busy}>
      <h3 className="wx-action-title">Documentation readiness</h3>
      <Hint>
        Advisory only. This never changes the checklist and never blocks sign-off or filing.
      </Hint>
      <output aria-live="polite">
        {busy ? (
          <p id={BUSY_REASON_ID} className="wx-action-hint">
            Working…
          </p>
        ) : null}
      </output>
      <ErrorAlert message={actionError} />
      {loadError ? (
        <>
          <ErrorAlert message={loadError} />
          {view ? <Hint>The information below may be out of date.</Hint> : null}
          <ButtonRow>
            <Button tone="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : null}
      {view ? (
        <>
          <ul aria-label="Checklist items and attached documents">
            {view.gaps.keys.map((k) => (
              <li key={k.checklistKey}>
                {humanize(k.checklistKey)}{" "}
                <StatusPill
                  label={GAP_LABEL[k.status] ?? humanize(k.status)}
                  tone={
                    k.isGap
                      ? "warning"
                      : k.status === "marked_not_applicable"
                        ? "neutral"
                        : "success"
                  }
                />
              </li>
            ))}
          </ul>
          {gaps.length === 0 ? (
            <Hint>
              No checklist item is missing an attachment. This does not mean the documentation is
              sufficient.
            </Hint>
          ) : null}
          {view.gaps.unmappedDocumentIds.length > 0 ? (
            <Hint>
              {view.gaps.unmappedDocumentIds.length} attached document(s) are not linked to a
              checklist item.
            </Hint>
          ) : null}
          {line ? <Hint>{line}</Hint> : null}
          {review?.stale ? <Hint>The packet changed after this AI check ran.</Hint> : null}
          {showFindings && review ? (
            review.findings.length === 0 ? (
              <Hint>
                The AI check reported nothing. This is not confirmation that the documentation is
                complete.
              </Hint>
            ) : (
              <>
                <WarningAlert>
                  AI-generated, advisory, and may be wrong. Check the cited documents yourself.
                </WarningAlert>
                {review.stale ? (
                  <Hint>Run the AI check again to record a response to these findings.</Hint>
                ) : null}
                <ul aria-label="AI findings">
                  {review.findings.map((f) => (
                    <li key={f.id}>
                      <strong>{humanize(f.checklistKey)}</strong>:{" "}
                      {FINDING_LABEL[f.status] ?? humanize(f.status)}. {f.note}
                      <CitedDocuments ids={f.citedDocumentIds} />{" "}
                      {f.disposition ? (
                        <StatusPill label={humanize(f.disposition)} tone="neutral" />
                      ) : canRespond ? (
                        <ButtonRow>
                          {READINESS_DISPOSITIONS.map((d) => (
                            <Button
                              key={d.value}
                              tone="tertiary"
                              size="sm"
                              {...busyProps}
                              aria-label={`${d.label}: ${humanize(f.checklistKey)}`}
                              onClick={() => void dispose(f, d.value)}
                            >
                              {d.label}
                            </Button>
                          ))}
                        </ButtonRow>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : null}
          {REQUESTABLE_STATES.includes(view.caseState) ? (
            <ButtonRow>
              <Button tone="secondary" size="sm" {...busyProps} onClick={() => void request()}>
                {review ? "Run the AI check again" : "Run the AI check"}
              </Button>
            </ButtonRow>
          ) : null}
        </>
      ) : loadError ? null : (
        <Hint>Loading documentation readiness…</Hint>
      )}
    </section>
  );
}
