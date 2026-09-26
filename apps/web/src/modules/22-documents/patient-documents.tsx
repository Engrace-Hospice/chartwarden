import { Glyph, Panel, PatientWorkspaceLayout, t } from "@wardenx/ui";
// apps/web/src/modules/22-documents — the patient chart's Documents tab (M22, Track B / ADR-0030;
// 2026-09-25 redesign, mockup "Documents"). The chart banner and module rail around the patient document
// library, with a right rail that summarizes the patient and checks which of the hospice's key documents
// have an uploaded copy. That check reads only this library: an election or consent signed
// electronically on the admission is tracked there, so the panel says "no upload", not "missing".
import { useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ChartBanner, PatientSummaryPanel, useChartIdentity } from "../../shell/patient-context";
import { type DocumentRow, PatientDocumentWorkspace } from "./document-workflows";

const KEY_DOCUMENTS = [
  { type: "election_statement", label: "Election Statement" },
  { type: "notice_of_rights", label: "Notice of Rights" },
  { type: "consent_record", label: "Hospice Consent" },
  { type: "code_status_directive", label: "POLST / Code Status" },
  { type: "cti", label: "Certification of Terminal Illness" },
] as const;

export function PatientDocuments(): JSX.Element {
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const [rows, setRows] = useState<DocumentRow[] | null>(null);

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            identity={identity}
            actions={
              <Link to={`/patients/${patientId}`} className="wx-btn-secondary">
                <Glyph name="file-text" size={16} /> View Patient Chart
              </Link>
            }
          />
        ) : (
          <div
            className="wx-patient-banner"
            aria-busy="true"
            style={{ minHeight: "6.25rem", background: t.surfaceLowest }}
          />
        )
      }
      rail={
        patientId ? (
          <>
            <PatientSummaryPanel identity={identity} />
            <KeyDocumentsPanel rows={rows} />
          </>
        ) : undefined
      }
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="documents" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "0.5rem 1.5rem 1.5rem", minWidth: 0 }}>
          {patientId ? (
            <PatientDocumentWorkspace patientId={patientId} onRowsChange={setRows} />
          ) : (
            <div className="wx-list-state">Select a patient to view their documents.</div>
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function KeyDocumentsPanel({ rows }: { rows: DocumentRow[] | null }): JSX.Element {
  const typeOf = (d: DocumentRow): string => d.metadata?.documentType ?? d.aggregateType;
  return (
    <Panel title="Key Documents" icon="clipboard-check" flush>
      <ul className="wx-checklist wx-checklist-status" style={{ padding: "0 1.125rem 0.75rem" }}>
        {KEY_DOCUMENTS.map((k) => {
          const latest = (rows ?? [])
            .filter((d) => typeOf(d) === k.type)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
          return (
            <li key={k.type} className={latest ? "is-done" : undefined}>
              <span className="wx-check-box" aria-hidden>
                {latest ? <Glyph name="check" size={12} strokeWidth={3} /> : null}
              </span>
              <span style={{ display: "grid" }}>
                <span>{k.label}</span>
                <span className="wx-row-sub wx-nums" style={{ fontSize: "0.75rem" }}>
                  {rows === null
                    ? "Loading…"
                    : latest
                      ? `Uploaded ${new Date(latest.updatedAt).toLocaleDateString("en-US", {
                          month: "2-digit",
                          day: "2-digit",
                          year: "numeric",
                        })}`
                      : "No upload"}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p
        className="wx-row-sub"
        style={{ margin: 0, padding: "0 1.125rem 1rem", fontSize: "0.75rem" }}
      >
        Counts uploaded copies only. Elections and consents signed on the admission are tracked
        there.
      </p>
    </Panel>
  );
}
