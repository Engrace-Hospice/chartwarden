// apps/web/src/modules/23-billing-medicare — the claim page's submission history: the claim's dispatch attempts and the
// acknowledgments received for them, read-only, on the claim page itself. The same reads and tables as the standalone
// /submissions and /acknowledgments timelines. Each section loads and fails on its own, so one unavailable read is said
// so and never looks like "no history".
import { EmptyState, LoadingSpinner, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { AcknowledgmentsTable, type ClaimAcknowledgment } from "./acknowledgments-timeline";
import { type ClaimSubmission, SubmissionsTable } from "./submissions-timeline";

type Load<T> = T[] | "loading" | "error";

function useClaimRows<T>(path: string, claimId: string): Load<T> {
  const client = useApiClient();
  const [rows, setRows] = useState<Load<T>>("loading");
  useEffect(() => {
    let active = true;
    setRows("loading");
    client
      .GET(path as never, { params: { path: { id: claimId } } } as never)
      .then((r) => {
        if (!active) return;
        const res = r as { data?: unknown; error?: unknown };
        setRows(res.error || !Array.isArray(res.data) ? "error" : (res.data as T[]));
      })
      .catch(() => active && setRows("error"));
    return () => {
      active = false;
    };
  }, [client, path, claimId]);
  return rows;
}

function Section<T>({
  title,
  rows,
  unavailable,
  empty,
  children,
}: {
  title: string;
  rows: Load<T>;
  unavailable: string;
  empty: string;
  children: (rows: T[]) => JSX.Element;
}): JSX.Element {
  return (
    <section aria-label={title} aria-busy={rows === "loading"}>
      <h2 style={headingStyle}>{title}</h2>
      {rows === "loading" ? (
        <LoadingSpinner />
      ) : rows === "error" ? (
        <EmptyState title="Unavailable" description={unavailable} />
      ) : rows.length === 0 ? (
        <EmptyState title={`No ${title.toLowerCase()}`} description={empty} />
      ) : (
        children(rows)
      )}
    </section>
  );
}

export function ClaimHistory({ claimId }: { claimId: string }): JSX.Element {
  const submissions = useClaimRows<ClaimSubmission>(
    "/api/v1/billing/claims/{id}/submissions",
    claimId,
  );
  const acknowledgments = useClaimRows<ClaimAcknowledgment>(
    "/api/v1/billing/claims/{id}/acknowledgments",
    claimId,
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Section
        title="Submissions"
        rows={submissions}
        unavailable="Submissions could not be read — reload to retry."
        empty="No dispatch attempts have been recorded for this claim."
      >
        {(rows) => <SubmissionsTable rows={rows} />}
      </Section>
      <Section
        title="Acknowledgments"
        rows={acknowledgments}
        unavailable="Acknowledgments could not be read — reload to retry."
        empty="No 999 / 277CA / 835 acknowledgments have been received for this claim."
      >
        {(rows) => <AcknowledgmentsTable rows={rows} />}
      </Section>
    </div>
  );
}

const headingStyle = {
  margin: "0 0 0.5rem",
  fontFamily: "var(--font-display)",
  fontSize: "1.05rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
