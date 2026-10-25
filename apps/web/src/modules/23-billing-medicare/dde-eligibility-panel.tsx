// apps/web/src/modules/23-billing-medicare — the hospice section of the patient's latest Medicare eligibility check,
// read-only inside the DDE item drawer (#761). It reads GET /billing/eligibility/hospice-periods, the same read the
// admission benefit-period field uses, so it shows whatever the bound eligibility provider (HETS, Episode Alert)
// recorded and nothing is invented. A failed or forbidden read says so; it never blocks the DDE work.
import { InlineAlert, StatusPill, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { HetsHospicePeriodsView } from "../06-admission/hets-model";
import { fmtDateTime } from "./dde-queue-model";

type Load =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error" }
  | { kind: "loaded"; view: HetsHospicePeriodsView };

function electionText(open: boolean | null): string {
  if (open === null) return "Not reported";
  return open ? "Hospice election still open (possibly at another hospice)" : "No open election";
}

function Body({ view }: { view: HetsHospicePeriodsView }): JSX.Element {
  if (view.status === "no_check_on_file")
    return <p className="wx-row-sub">No eligibility check on file for this patient.</p>;
  if (view.status === "hets_not_configured")
    return (
      <p className="wx-row-sub">
        Medicare eligibility is not configured for this organization, so there is no hospice history
        to show.
      </p>
    );
  return (
    <>
      {view.synthetic ? (
        <InlineAlert tone="info">Sandbox data. This is not a real Medicare answer.</InlineAlert>
      ) : null}
      <dl className="wx-kv">
        <dt>Checked</dt>
        <dd>
          {fmtDateTime(view.checkedAt)}
          {view.stale ? <StatusPill label="Stale" tone="warning" /> : null}
        </dd>
        <dt>Result</dt>
        <dd>{view.outcome ?? "—"}</dd>
        <dt>Hospice history</dt>
        <dd>{view.hospiceHistoryReturned ? "Returned" : "Not returned"}</dd>
        <dt>Election</dt>
        <dd>{electionText(view.hospiceElectionOpen)}</dd>
        {view.hospiceHistoryTruncated ? (
          <>
            <dt>History</dt>
            <dd>Partial: Medicare returned only part of the hospice history.</dd>
          </>
        ) : null}
        {view.nextPeriodNumber !== null ? (
          <>
            <dt>Next benefit period</dt>
            <dd className="wx-nums">{view.nextPeriodNumber}</dd>
          </>
        ) : null}
      </dl>
      {view.lastAttempt?.reason ? (
        <p className="wx-row-sub">Latest attempt: {view.lastAttempt.reason}</p>
      ) : null}
    </>
  );
}

export function EligibilityPanel({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setLoad({ kind: "loading" });
    client
      .GET("/api/v1/billing/eligibility/hospice-periods", { params: { query: { patientId } } })
      .then(({ data, response }) => {
        if (!active) return;
        if (data) setLoad({ kind: "loaded", view: data as unknown as HetsHospicePeriodsView });
        else setLoad({ kind: response?.status === 403 ? "forbidden" : "error" });
      })
      .catch(() => {
        if (active) setLoad({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, patientId]);

  return (
    <section className="wx-drawer-card" aria-label="Hospice eligibility">
      <h3>Hospice eligibility</h3>
      {load.kind === "loading" ? <p className="wx-row-sub">Loading eligibility…</p> : null}
      {load.kind === "forbidden" ? (
        <p className="wx-row-sub">Eligibility is not available to you.</p>
      ) : null}
      {load.kind === "error" ? (
        <p className="wx-row-sub">Eligibility could not be loaded.</p>
      ) : null}
      {load.kind === "loaded" ? <Body view={load.view} /> : null}
    </section>
  );
}
