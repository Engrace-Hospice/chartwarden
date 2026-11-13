// apps/web/src/modules/34-saas/wizard — step 5, Provider entity and NPI: the CMS identity (CCN, NPI, EIN) your organization bills under.
// The administrator creates it here (the same M2 route as Agency setup). The CCN, NPI, EIN and fiscal year end are write-once: a change
// is a re-enrolment ChartWarden handles. ChartWarden verifies the NPI against the registry itself; the tenant cannot read that result.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  LoadingSpinner,
  PendingAttestationWarning,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import type { JSX } from "react";
import { statusLabel } from "../saas-status";
import { type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { ONBOARDING_KEYS } from "./permissions";
import { ProviderEntityForm } from "./provider-entity-form";
import { RoleCannot } from "./role-cannot";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

type Entities =
  operations["getApiV1Providerentities"]["responses"][200]["content"]["application/json"];

const LIST_LIMIT = 100;

export function ProviderEntityPanel({ step, view, held, onChanged }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const mayManage = held.has(ONBOARDING_KEYS.orgManage);
  const list = useLoad<Entities>(
    `entities:${mayManage}`,
    async () =>
      mayManage
        ? client.GET("/api/v1/provider-entities", { params: { query: { limit: LIST_LIMIT } } })
        : { data: { items: [], nextCursor: null } },
    WIZARD_ERROR_COPY,
  );
  const items = list.data?.items ?? [];
  const canWrite = mayManage && isStepOpenForWork(view, step);

  const facts: Fact[] = [
    {
      key: "one",
      label: "At least one provider entity",
      state: items.length > 0 ? "ok" : "pending",
    },
    {
      key: "ccn",
      label: "Every entity has its CCN and NPI",
      state: items.length > 0 && items.every((e) => e.ccn && e.npi) ? "ok" : "pending",
    },
    {
      key: "npi",
      label: "ChartWarden verifies your NPI against the registry",
      state: "info",
    },
  ];

  return (
    <>
      <section className="wx-drawer-card" aria-label="Provider entities">
        <div className="wx-drawer-card-head">
          <h3>Provider entities</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        {!mayManage ? <RoleCannot what="see or add provider entities" /> : null}
        {list.failure ? (
          <div className="wx-form-stack">
            <InlineAlert tone="error">Could not load your provider entities.</InlineAlert>
            <div>
              <Button tone="secondary" size="sm" onClick={() => void list.reload()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
        {list.loading && !list.data && !list.failure ? (
          <LoadingSpinner label="Loading provider entities…" />
        ) : null}
        {mayManage && list.data && items.length === 0 ? <p>No provider entity yet.</p> : null}
        {items.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Provider entities</caption>
            <thead>
              <tr>
                <th scope="col">CCN</th>
                <th scope="col">NPI</th>
                <th scope="col">Legal name</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="wx-data-md">{e.ccn}</td>
                  <td className="wx-data-md">{e.npi}</td>
                  <td>{e.legalName}</td>
                  <td>{statusLabel(e.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {items.length > 0 ? (
          <p className="wx-row-sub">
            The CCN, NPI, EIN and fiscal year end cannot be changed here. To change one, ask
            ChartWarden.
          </p>
        ) : null}
      </section>

      {canWrite && list.data ? (
        <section className="wx-drawer-card" aria-label="Add a provider entity">
          <div className="wx-drawer-card-head">
            <h3>Add a provider entity</h3>
          </div>
          <PendingAttestationWarning view={view} audience="tenant" />
          <InlineAlert tone="info">
            The CCN, NPI, EIN and fiscal year end cannot be changed after saving. Check them before
            you save.
          </InlineAlert>
          <ProviderEntityForm
            onCreated={async () => {
              await Promise.all([list.reload(true), onChanged()]);
            }}
            onViewMoved={async () => onChanged()}
          />
        </section>
      ) : null}
    </>
  );
}
