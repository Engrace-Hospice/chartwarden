import { Panel, StatusPill, type StatusTone, type operations, useApiClient } from "@wardenx/ui";
// apps/web/src/shell — the F-238 PROSPECT SUMMARY render, shared across modules (like goals-progress.tsx): the
// DocLens review workspace (M22) shows it once a review completes, and the patient chart's Overview (M5) shows
// every completed intake summary of a patient on service. One clean picture of the person an intake fax
// describes — name, date of birth, address, contact, diagnoses with page-printed ICD-10 codes and their
// coding checks, medications, allergies, advance-directive documents, the records in the packet — every value
// with the document and page it came from, plus the same summary as copyable plain text.
//
// The SERVER builds it deterministically from reviewer-approved values only (no model; nothing generated or
// inferred; 42 CFR Part 2 content withheld) — this file only renders it, including the coding checks' label
// and severity. Shapes derive from the generated `operations`, so a contract change is a compile error here.
import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import "./prospect-summary.css";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;

export type ProspectSummary = Ok<operations["getApiV1IntakeUploadsByIdSummary"]>;
export type ProspectCitation =
  ProspectSummary["patient"][number]["values"][number]["citations"][number];

const CODING_TONE: Record<"critical" | "warning" | "info", StatusTone> = {
  critical: "error",
  warning: "warning",
  info: "neutral",
};
const ROLE_LABEL: Record<string, string> = {
  principal: "Principal",
  secondary: "Secondary",
  unspecified: "Listed",
  history: "History",
};

/** "Discharge summary p.1, 3 · History & physical p.5" — grouped per document. */
export function citationText(cites: readonly ProspectCitation[]): string {
  const byDoc = new Map<string, number[]>();
  for (const c of cites) {
    const ps = byDoc.get(c.document) ?? [];
    if (!ps.includes(c.page)) ps.push(c.page);
    byDoc.set(c.document, ps);
  }
  return [...byDoc.entries()]
    .map(([doc, ps]) => {
      const sorted = [...ps].sort((a, b) => a - b);
      return `${doc} ${sorted.length === 1 ? "p." : "pp."}${sorted.join(", ")}`;
    })
    .join(" · ");
}

const pagesText = (from: number, to: number): string =>
  from === to ? `p. ${from}` : `pp. ${from}–${to}`;

function Cite({ cites }: { cites: readonly ProspectCitation[] }): JSX.Element | null {
  if (cites.length === 0) return null;
  return <span className="wx-prospect-cite">{citationText(cites)}</span>;
}

function Edited({ on }: { on: boolean }): JSX.Element | null {
  return on ? <span className="wx-prospect-edited">corrected by reviewer</span> : null;
}

/** The pure render of a loaded summary (no IO). */
export function ProspectSummaryView({ summary }: { summary: ProspectSummary }): JSX.Element {
  const uid = useId();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(summary.plainText);
      setCopied("copied");
    } catch {
      // Fall back to selecting the text so Ctrl/Cmd+C works.
      textRef.current?.focus();
      textRef.current?.select();
      setCopied("failed");
    }
  }

  return (
    <div className="wx-prospect-body">
      <p className="wx-prospect-note">
        Reviewer-approved values only — as written in the source documents, or as corrected by the
        reviewer. Nothing here was generated. Each value cites the document and page it came from.
      </p>

      <div className="wx-prospect-grid">
        <section aria-labelledby={`${uid}-patient`}>
          <h3 id={`${uid}-patient`}>Patient</h3>
          {summary.patient.length === 0 ? (
            <p className="wx-row-sub">No patient details were approved.</p>
          ) : (
            <dl className="wx-prospect-dl">
              {summary.patient.map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>
                    {f.values.length > 1 ? (
                      <StatusPill label="Documents differ" tone="warning" />
                    ) : null}
                    {f.values.map((v) => (
                      <div key={v.value} className="wx-prospect-value">
                        <span>{v.value}</span> <Edited on={v.edited} />
                        <Cite cites={v.citations} />
                      </div>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section aria-labelledby={`${uid}-dx`}>
          <h3 id={`${uid}-dx`}>Diagnoses</h3>
          {summary.diagnoses.length === 0 ? (
            <p className="wx-row-sub">No diagnoses were approved.</p>
          ) : (
            <ul className="wx-prospect-list">
              {summary.diagnoses.map((d) => (
                <li key={`${d.icd10Code ?? ""}|${d.description}`}>
                  <div className="wx-prospect-value">
                    <StatusPill
                      label={ROLE_LABEL[d.role] ?? d.role}
                      tone={d.role === "principal" ? "progress" : "neutral"}
                    />{" "}
                    <span>{d.description}</span>
                    {d.icd10Code ? (
                      <>
                        {" "}
                        <code className="wx-nums">{d.icd10Code}</code>
                      </>
                    ) : (
                      <span className="wx-row-sub"> no code</span>
                    )}{" "}
                    <Edited on={d.edited} />
                    <Cite cites={d.citations} />
                  </div>
                  {d.codingFlags.length > 0 ? (
                    <ul className="wx-prospect-flags" aria-label="Coding checks">
                      {d.codingFlags.map((f) => {
                        return (
                          <li key={`${f.kind}:${f.code}`}>
                            <StatusPill label={f.label} tone={CODING_TONE[f.severity]} />{" "}
                            <span className="wx-prospect-cite">{f.detail}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`${uid}-meds`}>
          <h3 id={`${uid}-meds`}>Medications</h3>
          <p className="wx-prospect-cite">As listed in the records — not orders.</p>
          {summary.medications.length === 0 ? (
            <p className="wx-row-sub">No medication lines were approved.</p>
          ) : (
            <ul className="wx-prospect-list">
              {summary.medications.map((m) => (
                <li key={m.text} className="wx-prospect-value">
                  <span>{m.text}</span> <Edited on={m.edited} />
                  <Cite cites={m.citations} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`${uid}-allergies`}>
          <h3 id={`${uid}-allergies`}>Allergies</h3>
          <p className="wx-prospect-cite">Unverified until a clinician verifies them.</p>
          {summary.allergies.length === 0 ? (
            <p className="wx-row-sub">
              No allergy lines were approved — this is not "no known allergies".
            </p>
          ) : (
            <ul className="wx-prospect-list">
              {summary.allergies.map((a) => (
                <li key={a.text} className="wx-prospect-value">
                  <span>{a.text}</span> <Edited on={a.edited} />
                  <Cite cites={a.citations} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`${uid}-ad`}>
          <h3 id={`${uid}-ad`}>Advance directives</h3>
          {summary.advanceDirectives.length === 0 ? (
            <p className="wx-row-sub">No advance directive or DPOA document in this packet.</p>
          ) : (
            <ul className="wx-prospect-list">
              {summary.advanceDirectives.map((d) => (
                <li key={d.pageFrom}>
                  {d.documentTypeLabel}
                  {d.title ? ` — ${d.title}` : ""}
                  {d.date ? `, dated ${d.date}` : ""}{" "}
                  <span className="wx-prospect-cite">
                    {pagesText(d.pageFrom, d.pageTo)} · content not extracted
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`${uid}-docs`}>
          <h3 id={`${uid}-docs`}>Records in this packet</h3>
          <ul className="wx-prospect-list">
            {summary.documents.map((d) => (
              <li key={d.pageFrom}>
                <span className="wx-nums">{pagesText(d.pageFrom, d.pageTo)}</span>{" "}
                {d.documentTypeLabel}
                {d.title ? ` — ${d.title}` : ""}
                {d.date ? `, dated ${d.date}` : ""}
                {d.status === "other_patient" ? (
                  <>
                    {" "}
                    <StatusPill label="Another patient's — excluded" tone="error" />
                  </>
                ) : null}
                {d.status === "duplicate" ? (
                  <>
                    {" "}
                    <StatusPill
                      label={`Re-sent copy of p. ${d.duplicateOfPage ?? "?"} — skipped`}
                      tone="neutral"
                    />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {summary.withheld.part2Values > 0 ? (
        <p className="wx-prospect-withheld" role="note">
          {summary.withheld.part2Values} approved value
          {summary.withheld.part2Values === 1 ? " is" : "s are"} not shown: 42 CFR Part 2 (substance
          use disorder) content stays on the review screen.
        </p>
      ) : null}
      <p className="wx-prospect-cite">
        Not captured by DocLens (check the source documents): {summary.notCaptured.join("; ")}.
      </p>

      <div className="wx-prospect-text">
        <div className="wx-prospect-text-head">
          <label htmlFor={`${uid}-plain`}>Plain-text summary</label>
          <button type="button" className="wx-btn-secondary" onClick={() => void copy()}>
            {copied === "copied" ? "Copied" : "Copy"}
          </button>
        </div>
        <textarea
          id={`${uid}-plain`}
          ref={textRef}
          readOnly
          rows={16}
          value={summary.plainText}
          spellCheck={false}
        />
        <span aria-live="polite" className="wx-sr-only">
          {copied === "copied"
            ? "Summary copied to the clipboard"
            : copied === "failed"
              ? "Copy is not available here; the text is selected — press Ctrl or Cmd plus C"
              : ""}
        </span>
      </div>
    </div>
  );
}

export type PatientIntakeSummaries = Ok<operations["getApiV1PatientsByPatientIdIntakesummaries"]>;

/** Patient statuses whose chart shows the intake summaries: the person is (or was) on service. */
export const SHOWS_INTAKE_SUMMARIES = new Set(["active", "on_hold", "discharged", "deceased"]);

/**
 * The patient chart's "Intake records summary": every completed DocLens review filed under this patient,
 * newest first — the referral packet, then older records requested later — as a snapshot of how the person
 * arrived and how their records evolved. Renders nothing when there are none (no empty panel on charts that
 * never came through DocLens). Reads GET /api/v1/patients/:patientId/intake-summaries (chart scope).
 */
export function PatientIntakeSummaries({
  patientId,
  className,
}: {
  patientId: string;
  className?: string;
}): JSX.Element | null {
  const client = useApiClient();
  const [items, setItems] = useState<ProspectSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void client
      .GET("/api/v1/patients/{patientId}/intake-summaries", { params: { path: { patientId } } })
      .then((r) => {
        if (!live) return;
        const data = r.data as PatientIntakeSummaries | undefined;
        if (r.error || !data || !Array.isArray(data.items)) {
          // 404 = outside the caller's caseload / no chart access: show nothing, not an error.
          if (r.response?.status !== 404 && r.response?.status !== 403) setFailed(true);
          setItems([]);
          return;
        }
        setItems(data.items);
      })
      .catch(() => {
        if (live) {
          setFailed(true);
          setItems([]);
        }
      });
    return () => {
      live = false;
    };
  }, [client, patientId]);

  if (items === null) return null;
  if (items.length === 0 && !failed) return null;
  return (
    <Panel
      title="Intake records summary"
      icon="clipboard-list"
      description="What the referral and records faxes said, as approved by the intake reviewer — newest first"
      className={className}
    >
      {failed ? (
        <p className="wx-row-sub" role="alert">
          The intake summaries could not be loaded.
        </p>
      ) : (
        <div className="wx-prospect-history">
          {items.map((s, i) => (
            <details key={s.batchId} open={i === 0} className="wx-prospect-entry">
              <summary>
                <strong>Records received {s.receivedAt.slice(0, 10)}</strong>
                <span className="wx-row-sub">
                  {" "}
                  · {s.documents.length} document{s.documents.length === 1 ? "" : "s"} · reviewed{" "}
                  {s.completedAt ? s.completedAt.slice(0, 10) : "—"}
                </span>
              </summary>
              <ProspectSummaryView summary={s} />
            </details>
          ))}
        </div>
      )}
    </Panel>
  );
}
