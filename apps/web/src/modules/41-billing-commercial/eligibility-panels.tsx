// apps/web/src/modules/41-billing-commercial — the read-only panels of the ELIGIBILITY view (M41): the latest check with the server's
// freshness verdict, and the check history. Both show what the server answered: freshness is never computed in the browser, and a
// missing, stale or unverified verdict is a real state with its own words, never a blank or a pass.
import { Button, EmptyState, InlineAlert, LoadingSpinner, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  type EligibilityCheckView,
  type EligibilityFreshnessView,
  checkedAtLabel,
  eligibilityOutcomeLabel,
  eligibilityOutcomeTone,
  eligibilityPolicyLabel,
  freshnessLabel,
  freshnessTone,
} from "./commercial-model";
import type { ScopedLoad } from "./use-scoped-load";

export interface LatestData {
  readonly latest: EligibilityCheckView | null;
  readonly freshness: EligibilityFreshnessView;
}

const ageLine = (f: EligibilityFreshnessView): string =>
  f.evidence.ageDays === null
    ? `No check age to report; a check goes stale after ${f.evidence.maxAgeDays} days`
    : `${f.evidence.ageDays} days old; stale after ${f.evidence.maxAgeDays} days`;

function Unavailable({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="wx-list-state" role="alert">
      <EmptyState title={title} description={description} />
      <Button tone="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

const Spinner = (): JSX.Element => (
  <output className="wx-list-state">
    <LoadingSpinner />
  </output>
);

export function LatestCheckCard({
  load,
  planName,
  onRetry,
  onEditPolicy,
}: {
  load: ScopedLoad<LatestData>;
  planName: string;
  onRetry: () => void;
  /** Present only for a manage_enrollment holder. */
  onEditPolicy?: () => void;
}): JSX.Element {
  if (load.status === "idle" || load.status === "loading") return <Spinner />;
  if (load.status === "error") {
    return (
      <Unavailable
        title="Latest check unavailable"
        description="The latest check could not be loaded. The patient or plan may be outside your scope for this provider entity."
        onRetry={onRetry}
      />
    );
  }
  const { latest, freshness } = load.data;
  return (
    <section className="wx-drawer-card" aria-label={`Latest eligibility check for ${planName}`}>
      {load.failed ? (
        <InlineAlert tone="error">
          The latest check could not be reloaded; what is shown may be out of date.{" "}
          <Button tone="tertiary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </InlineAlert>
      ) : null}
      <h3>Latest check: {planName}</h3>
      <dl className="wx-kv">
        <dt>Verdict</dt>
        <dd>
          <StatusPill
            label={freshnessLabel(freshness.status)}
            tone={freshnessTone(freshness.severity)}
          />
        </dd>
        <dt>What it means</dt>
        <dd>{freshness.message}</dd>
        <dt>Age</dt>
        <dd className="wx-nums">{ageLine(freshness)}</dd>
        <dt>Plan policy</dt>
        <dd>{eligibilityPolicyLabel(freshness.evidence.policy)}</dd>
        {latest ? (
          <>
            <dt>Coverage answer</dt>
            <dd>
              <StatusPill
                label={eligibilityOutcomeLabel(latest.outcome)}
                tone={eligibilityOutcomeTone(latest.outcome)}
              />
            </dd>
            <dt>Service date</dt>
            <dd className="wx-nums">{latest.serviceDate}</dd>
            <dt>Checked</dt>
            <dd className="wx-nums">{checkedAtLabel(latest.checkedAt)}</dd>
          </>
        ) : (
          <>
            <dt>Coverage answer</dt>
            <dd>No check is on record for this plan.</dd>
          </>
        )}
      </dl>
      {onEditPolicy ? (
        <Button tone="secondary" size="sm" onClick={onEditPolicy}>
          Edit eligibility policy
        </Button>
      ) : null}
    </section>
  );
}

export function CheckHistory({
  load,
  patientName,
  scopeLabel,
  planName,
  onRetry,
}: {
  load: ScopedLoad<readonly EligibilityCheckView[]>;
  patientName: string;
  /** "all plans" or the chosen plan's name; part of the empty state and the caption. */
  scopeLabel: string;
  planName: (planId: string) => string;
  onRetry: () => void;
}): JSX.Element {
  if (load.status === "idle" || load.status === "loading") return <Spinner />;
  if (load.status === "error") {
    return (
      <Unavailable
        title="Check history unavailable"
        description="The eligibility checks could not be loaded. The patient may be outside your scope for this provider entity."
        onRetry={onRetry}
      />
    );
  }
  const alert = load.failed ? (
    <InlineAlert tone="error">
      The check history could not be reloaded; what is shown may be out of date.{" "}
      <Button tone="tertiary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </InlineAlert>
  ) : null;
  if (load.data.length === 0) {
    return (
      <>
        {alert}
        <div className="wx-list-state">
          <EmptyState
            title="No checks recorded"
            description={`No eligibility check has been recorded for ${patientName} on ${scopeLabel}.`}
          />
        </div>
      </>
    );
  }
  return (
    <>
      {alert}
      <div className="wx-list-table-wrap">
        <table className="wx-list-table">
          <caption className="wx-sr-only">{`Eligibility checks for ${patientName}, ${scopeLabel}, newest first`}</caption>
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Service date</th>
              <th scope="col">Coverage answer</th>
              <th scope="col">As of</th>
              <th scope="col">Checked</th>
              <th scope="col">Clearinghouse</th>
            </tr>
          </thead>
          <tbody>
            {load.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="wx-row-title">{planName(c.planId)}</span>
                </td>
                <td className="wx-nums">{c.serviceDate}</td>
                <td>
                  <StatusPill
                    label={eligibilityOutcomeLabel(c.outcome)}
                    tone={eligibilityOutcomeTone(c.outcome)}
                  />
                </td>
                <td className="wx-nums">{c.asOfDate}</td>
                <td className="wx-nums">{checkedAtLabel(c.checkedAt)}</td>
                <td className="wx-nums">{c.clearinghouseKey}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
