import { InlineAlert, StatusPill, type StatusTone, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";

interface NoeSummary {
  readonly noeId: string;
  readonly state: string;
  readonly electionEffectiveDate: string;
  readonly deadline?: {
    readonly risk: string;
    readonly dueDate: string | null;
    readonly acceptance: string;
    readonly lifecycle: string;
  };
}

const lifecycleLabel = (lifecycle: string | undefined): { label: string; tone: StatusTone } => {
  switch (lifecycle) {
    case "mac_accepted_verified": return { label: "MAC acceptance verified", tone: "success" };
    case "mac_rejected_verified": return { label: "MAC rejected · correction needed", tone: "error" };
    case "submission_requested": return { label: "Request recorded · not transmitted", tone: "progress" };
    case "dispatch_started": return { label: "Dispatch started · outcome not final", tone: "warning" };
    case "transport_receipt_confirmed": return { label: "Transport response · awaiting MAC evidence", tone: "progress" };
    case "outcome_unknown": return { label: "Outcome unknown · reconciliation required", tone: "error" };
    case "ready": return { label: "Internally ready · external dispatch held", tone: "warning" };
    case "cancelled": return { label: "Cancelled", tone: "neutral" };
    case "known_not_sent": return { label: "Known not sent · review required", tone: "warning" };
    case "transport_rejected": return { label: "Transport rejected · filing unverified", tone: "error" };
    case "external_filing_recorded": return { label: "External filing recorded · acceptance unverified", tone: "warning" };
    case "draft": return { label: "Draft", tone: "neutral" };
    default: return { label: "Lifecycle evidence incomplete", tone: "neutral" };
  }
};

/** Contextual M6→M23 read only. A billing permission denial or unavailable seam renders no notice details. */
export function NoeAdmissionNoticeStatus({ admissionId }: { readonly admissionId: string }): JSX.Element | null {
  const client = useApiClient();
  const [notice, setNotice] = useState<NoeSummary | null>(null);

  useEffect(() => {
    let active = true;
    void client.GET("/api/v1/noe-records" as never, {
      params: { query: { admissionId, limit: 1 } },
    } as never).then(({ data, error }) => {
      if (!active) return;
      const items = (data as { items?: NoeSummary[] } | undefined)?.items;
      setNotice(error || !items ? null : items[0] ?? null);
    }).catch(() => {
      if (active) setNotice(null);
    });
    return () => { active = false; };
  }, [admissionId, client]);

  if (!notice) return null;
  const state = lifecycleLabel(notice.deadline?.lifecycle);
  const risk = notice.deadline?.risk.replaceAll("_", " ") ?? "deadline unavailable";
  return (
    <InlineAlert tone={notice.state === "ack_rejected" ? "error" : "info"}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <strong>Medicare Notice of Election</strong>
        <StatusPill label={state.label} tone={state.tone} />
        {notice.deadline?.dueDate ? <span>Due {notice.deadline.dueDate} · {risk}</span> : <span>{risk}</span>}
        <Link to="/billing/noe" style={{ color: "var(--color-primary)", fontWeight: 600 }}>
          Open NOE worklist
        </Link>
      </span>
      {notice.deadline?.lifecycle === "ready" || notice.deadline?.lifecycle === "submission_requested" ? (
        <span> Internal preparation or a recorded request is not proof of transmission or MAC acceptance.</span>
      ) : null}
    </InlineAlert>
  );
}
