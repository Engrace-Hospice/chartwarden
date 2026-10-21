import { InlineAlert, StatusPill, type StatusTone, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/06-admission — a transferred-in admission's Medicare transfer notice (TOB 8xC), as M23
// reports it: GET /api/v1/billing/transfer-notices?admissionId=. Shows the latest notice's state and what holds
// it (the transferring hospice's billing not yet confirmed, a continuity gap, …) with a link to the billing
// worklist where it is worked. Renders nothing when the admission has no notice or the read is refused (the
// viewer may lack billing scope) — the worklist, not this line, is where the notice is filed.
import { type JSX, useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface NoticeSummary {
  transferNoticeId: string;
  state: string;
  tob: string;
  statementFromDate: string;
  blockers: { code: string; message: string }[];
}

const STATE: Record<string, { label: string; tone: StatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  ready: { label: "Ready to file", tone: "progress" },
  submitted: { label: "Submitted", tone: "progress" },
  ack_pending: { label: "Awaiting Medicare", tone: "progress" },
  ack_accepted: { label: "Accepted by Medicare", tone: "success" },
  ack_rejected: { label: "Rejected", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function TransferNoticeStatus({ admissionId }: { admissionId: string }): JSX.Element | null {
  const client = useApiClient();
  const [notice, setNotice] = useState<NoticeSummary | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() =>
        client.GET("/api/v1/billing/transfer-notices", {
          params: { query: { admissionId, limit: 1 } },
        }),
      )
      .then(({ data, error }) => {
        if (!active) return;
        const first = error ? undefined : (data?.items?.[0] as NoticeSummary | undefined);
        setNotice(first ?? null);
      })
      .catch(() => {
        if (active) setNotice(null);
      });
    return () => {
      active = false;
    };
  }, [client, admissionId]);

  if (!notice) return null;
  const s = STATE[notice.state] ?? { label: notice.state, tone: "neutral" as const };
  const open = notice.state === "draft" || notice.state === "ready";
  return (
    <InlineAlert tone={notice.state === "ack_rejected" ? "error" : "info"}>
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
      >
        <strong>Medicare transfer notice (TOB {notice.tob})</strong>
        <StatusPill label={s.label} tone={s.tone} />
      </span>{" "}
      {open && notice.blockers[0] ? `${notice.blockers[0].message} ` : null}
      <Link
        to={`/billing/transfer-notices?notice=${notice.transferNoticeId}`}
        style={{ color: "var(--color-primary)", fontWeight: 600 }}
      >
        Open in billing
      </Link>
    </InlineAlert>
  );
}
