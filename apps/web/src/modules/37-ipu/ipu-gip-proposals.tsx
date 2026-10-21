// apps/web/src/modules/37-ipu — the intake worklist's "M19 GIP-proposed entries" (M37 spec §6.1 screen 3,
// F-219 #248). An after-hours triage call that ends in a GIP admission PROPOSAL lands here as a read-only
// entry so the intake team sees it before the durable M11 level-of-care order → M6 → M37 path exists.
//
// A PROPOSAL, NOT AN ADMISSION. No `ipu_admission` row can exist at proposal time (its `admission_id` /
// `level_of_care_period_id` are NOT NULL and the LOC period is created later by M11's order draft), so this
// section has no row actions: the admissions table below is where a real admission is worked. The entry
// carries ids, an instant and an enum only — the clinical criteria summary stays on the M19 call, and the
// patient is deliberately not named here (the same choice `screens.ts` documents for the admissions list).
//
// It renders NOTHING when there are no proposals, and a quiet one-line notice when the read fails — a
// silently-empty section would claim "nothing proposed", which is exactly the wrong thing to say.
import { Glyph, StatusPill, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";

interface GipProposal {
  triageCallId: string;
  patientId: string;
  proposedAt: string;
  preferredFacility: string | null;
  callState: string;
}

const titleCase = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

const formatWhen = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export function IpuGipProposals(): JSX.Element | null {
  const client = useApiClient();
  const [rows, setRows] = useState<GipProposal[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await client.GET("/api/v1/ipu-intake/gip-proposals");
        if (!live) return;
        if (res.error) {
          setFailed(true);
          setRows([]);
          return;
        }
        setFailed(false);
        setRows((res.data as unknown as { items?: GipProposal[] }).items ?? []);
      } catch {
        if (!live) return;
        setFailed(true);
        setRows([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [client]);

  if (rows === null) return null;
  if (failed) {
    return (
      <output style={noticeStyle}>
        <Glyph name="alert" size={14} />
        <span>After-hours GIP proposals are unavailable right now.</span>
      </output>
    );
  }
  if (rows.length === 0) return null;

  return (
    <section aria-label="GIP admission proposals from after-hours triage" style={panelStyle}>
      <div style={headingStyle}>
        <Glyph name="alert" size={16} />
        <strong>GIP proposals from after-hours triage</strong>
        <StatusPill tone="warning" label={`${rows.length} proposed`} />
      </div>
      <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
        Proposed by the on-call nurse; not yet admissions. Open the triage call to review, then
        place the level-of-care order.
      </div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Proposed</th>
            <th style={thStyle}>Preferred facility</th>
            <th style={thStyle}>Call state</th>
            <th style={thStyle}>Triage call</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.triageCallId}>
              <td style={tdStyle}>{formatWhen(p.proposedAt)}</td>
              <td style={tdStyle}>{p.preferredFacility ?? "No preference stated"}</td>
              <td style={tdStyle}>{titleCase(p.callState)}</td>
              <td style={tdStyle}>
                <code className="wx-data-md">{p.triageCallId.slice(0, 8)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  padding: "0.875rem 1rem",
  margin: "0 0 1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
  background: "var(--color-surface-container-low)",
};
const headingStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem" };
const noticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  margin: "0 0 1rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};
const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse" };
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.375rem 0.5rem",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const tdStyle: CSSProperties = { padding: "0.375rem 0.5rem", fontSize: "0.875rem" };
