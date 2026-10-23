import { Button, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the DOCUMENTATION READINESS section of the ADR work panel (hospice ADR/TPE/QIC PRD,
// milestone 8a-1). ADVISORY: it shows which checklist items have no document attached (computed by the server from the
// packet, no model), and, only when an assistant has answered, its findings under a persistent "AI-generated, advisory,
// may be wrong" banner, each with the documents it cites and a person's disposition. When the AI check is unavailable
// the panel says so in one sentence and the manual checklist is unchanged: no error toast, no blocked control anywhere.
// Nothing here can tick the checklist, attach a document, or gate sign-off or filing. The server's wording is shown
// verbatim (ADR-0030); no CMS requirement is stated here.
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
          <Link to={`/documents/${id}/versions`}>{id}</Link>
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadReadiness(client, adrId);
    if (!mounted.current) return;
    if (res.ok) {
      setView(res.value);
      setError(null);
    } else if (res.status === 403 || res.status === 404) {
      setHidden(true); // not permitted (or not found): the section simply is not offered
    } else {
      setError(res.message);
    }
  }, [client, adrId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: packetVersion is the reload trigger
  useEffect(() => {
    void load();
  }, [load, packetVersion]);

  async function request(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await requestReadinessReview(client, adrId);
    if (!mounted.current) return;
    if (!res.ok) setError(res.message);
    await load();
    if (mounted.current) setBusy(false);
  }

  async function dispose(
    finding: ReadinessFinding,
    disposition: ReadinessDisposition,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await disposeReadinessFinding(client, adrId, finding.id, disposition);
    if (!mounted.current) return;
    if (!res.ok) setError(res.message);
    await load();
    if (mounted.current) setBusy(false);
  }

  if (hidden) return null;
  const review = view?.review ?? null;
  const gaps = view?.gaps.keys.filter((k) => k.isGap) ?? [];

  return (
    <section aria-label="Documentation readiness">
      <h3 className="wx-action-title">Documentation readiness</h3>
      <Hint>
        Advisory only. This never changes the checklist and never blocks sign-off or filing.
      </Hint>
      <ErrorAlert message={error} />
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
            <Hint>Every checklist item that applies has at least one document attached.</Hint>
          ) : null}
          {view.gaps.unmappedDocumentIds.length > 0 ? (
            <Hint>
              {view.gaps.unmappedDocumentIds.length} attached document(s) are not linked to a
              checklist item.
            </Hint>
          ) : null}
          {review?.source === "ai" ? (
            <WarningAlert>
              AI-generated, advisory, and may be wrong. Check the cited documents yourself.
            </WarningAlert>
          ) : null}
          {review && review.status !== "ready" ? (
            <Hint>AI check unavailable; the manual checklist is unchanged.</Hint>
          ) : null}
          {review?.stale ? <Hint>The packet changed after this AI check ran.</Hint> : null}
          {review && review.status === "ready" ? (
            review.findings.length === 0 ? (
              <Hint>The AI check returned no findings.</Hint>
            ) : (
              <ul aria-label="AI findings">
                {review.findings.map((f) => (
                  <li key={f.id}>
                    <strong>{humanize(f.checklistKey)}</strong>:{" "}
                    {FINDING_LABEL[f.status] ?? humanize(f.status)}. {f.note}
                    <CitedDocuments ids={f.citedDocumentIds} />{" "}
                    {f.disposition ? (
                      <StatusPill label={humanize(f.disposition)} tone="neutral" />
                    ) : null}
                    <ButtonRow>
                      {READINESS_DISPOSITIONS.map((d) => (
                        <Button
                          key={d.value}
                          tone="tertiary"
                          size="sm"
                          disabled={busy || f.disposition === d.value}
                          aria-label={`${d.label}: ${humanize(f.checklistKey)}`}
                          onClick={() => void dispose(f, d.value)}
                        >
                          {d.label}
                        </Button>
                      ))}
                    </ButtonRow>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {REQUESTABLE_STATES.includes(view.caseState) ? (
            <ButtonRow>
              <Button tone="secondary" size="sm" disabled={busy} onClick={() => void request()}>
                {review ? "Run the AI check again" : "Run the AI check"}
              </Button>
            </ButtonRow>
          ) : null}
        </>
      ) : error ? null : (
        <Hint>Loading documentation readiness…</Hint>
      )}
    </section>
  );
}
