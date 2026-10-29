// apps/web/src/modules/36-messaging - WP 4.12 (ADR-0080): the on-call "who is covering now" directory. Read-only: it names who covers a
// role for one patient's care team (the team is chosen by `?patient=` and no patient detail is shown), with the shift end and the
// time zone of the roster. A coverage gap, an unconnected roster and an unconfigured role are each said in words, never an empty list.
// It has no Message or Page button: addressing a role is a separate, undecided change (ADR-0080).
import {
  ONCALL_DIRECTORY_ROLES,
  type OnCallCoverageDto,
  type OnCallDirectoryRole,
} from "@chartwarden/types";
import { Button, EmptyState, LoadingSpinner, PageHeader, StatusPill } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ONCALL_BREADCRUMB,
  ONCALL_DENIED,
  ONCALL_GAP,
  ONCALL_LOAD_FAILED,
  ONCALL_NAME_UNKNOWN,
  ONCALL_NOTICE,
  ONCALL_NOT_CONFIGURED,
  ONCALL_NOT_CONNECTED,
  ONCALL_NO_PATIENT_TEXT,
  ONCALL_NO_PATIENT_TITLE,
  ONCALL_RETRY_LABEL,
  ONCALL_ROLE_LABEL,
  ONCALL_ROLE_NAMES,
  ONCALL_SHIFT_END_UNKNOWN,
  ONCALL_SIGN_IN,
  ONCALL_STALE,
  ONCALL_TITLE,
  ONCALL_UNAVAILABLE,
  RANK_LABELS,
  asOfText,
  tierLabel,
  untilText,
} from "./oncall-directory-wording";
import { type OnCallView, useOnCallCoverage } from "./use-oncall-coverage";
import "./oncall-directory.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRole = (value: string): value is OnCallDirectoryRole =>
  (ONCALL_DIRECTORY_ROLES as readonly string[]).includes(value);

function Tiers({ coverage }: { readonly coverage: OnCallCoverageDto }): JSX.Element {
  return (
    <ul className="wx-oncall-rows" aria-label={ONCALL_TITLE}>
      {coverage.tiers.map((tier) => (
        <li key={tier.tier} className="wx-oncall-row">
          <span className="wx-oncall-tier">{tierLabel(tier.tier)}</span>
          {tier.state === "coverage_gap" ? (
            <>
              <StatusPill tone="warning" label="Coverage gap" />
              <p className="wx-oncall-line">{ONCALL_GAP}</p>
            </>
          ) : (
            <>
              <span className="wx-oncall-names">
                {tier.people
                  .map(
                    (p) =>
                      `${p.display_name?.trim() || ONCALL_NAME_UNKNOWN}${
                        tier.tier === 1 ? ` (${RANK_LABELS[p.rank]})` : ""
                      }`,
                  )
                  .join(", ")}
              </span>
              <span className="wx-oncall-line">
                {tier.shift_ends_at
                  ? untilText(tier.shift_ends_at, coverage.as_of, tier.time_zone)
                  : ONCALL_SHIFT_END_UNKNOWN}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function Body({
  view,
  retry,
}: { readonly view: OnCallView; readonly retry: () => void }): JSX.Element {
  if (view.status === "loading") return <LoadingSpinner />;
  if (view.status === "denied") {
    const text =
      view.code === 401 ? ONCALL_SIGN_IN : view.code === 404 ? ONCALL_UNAVAILABLE : ONCALL_DENIED;
    return (
      <p className="wx-oncall-error" role="alert">
        {text}
      </p>
    );
  }
  if (view.status === "error") {
    return (
      <div className="wx-oncall-error" role="alert">
        <p>{ONCALL_LOAD_FAILED}</p>
        <Button type="button" tone="secondary" size="sm" onClick={retry}>
          {ONCALL_RETRY_LABEL}
        </Button>
      </div>
    );
  }
  const { coverage } = view;
  return (
    <>
      {view.stale ? (
        <div className="wx-oncall-error" role="alert">
          <p>{ONCALL_STALE}</p>
          <Button type="button" tone="secondary" size="sm" onClick={retry}>
            {ONCALL_RETRY_LABEL}
          </Button>
        </div>
      ) : null}
      {coverage.status === "roster_not_connected" ? (
        <p className="wx-oncall-error" role="alert">
          {ONCALL_NOT_CONNECTED}
        </p>
      ) : coverage.status === "not_configured" ? (
        <p className="wx-oncall-error" role="alert">
          {ONCALL_NOT_CONFIGURED}
        </p>
      ) : (
        <Tiers coverage={coverage} />
      )}
    </>
  );
}

export function OnCallDirectory(): JSX.Element {
  const [params] = useSearchParams();
  const patient = params.get("patient");
  const patientId = patient && UUID.test(patient) ? patient : null;
  const [role, setRole] = useState<OnCallDirectoryRole>("rn");
  const { view, retry } = useOnCallCoverage(role, patientId);
  const zone = view.status === "ready" ? view.coverage.tiers[0]?.time_zone : undefined;
  return (
    <>
      <PageHeader title={ONCALL_TITLE}>
        <p className="wx-oncall-line">{ONCALL_NOTICE}</p>
        {view.status === "ready" && zone ? (
          <output className="wx-oncall-asof" aria-live="polite">
            {asOfText(view.coverage.as_of, zone)}
            {` (${zone})`}
          </output>
        ) : null}
      </PageHeader>
      <section className="wx-oncall" aria-label={ONCALL_TITLE}>
        {patientId ? (
          <>
            <label className="wx-oncall-role">
              <span>{ONCALL_ROLE_LABEL}</span>
              <select
                value={role}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isRole(next)) setRole(next);
                }}
              >
                {ONCALL_DIRECTORY_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ONCALL_ROLE_NAMES[value]}
                  </option>
                ))}
              </select>
            </label>
            <Body view={view} retry={retry} />
          </>
        ) : (
          <EmptyState title={ONCALL_NO_PATIENT_TITLE} description={ONCALL_NO_PATIENT_TEXT} />
        )}
      </section>
    </>
  );
}
