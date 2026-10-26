import {
  Button,
  EmptyState,
  KpiCard,
  LoadingSpinner,
  StatusPill,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/41-billing-commercial — the AUTHORIZATIONS view (M41). Pre-authorizations recorded for ONE patient under one
// provider entity: the list endpoint needs both ids and has no paging, so the screen starts at a patient search.
//   GET /api/v1/billing/commercial/authorizations?providerEntityId&patientId   the patient's authorizations (no number)
//   GET /api/v1/billing/commercial/payer-plans?providerEntityId                 plan names and policy
// Write controls (record, deny, void) exist only for commercial_billing.write; the server stays the authority. A failed read is an
// error with a retry, never "none". The authorization number is never shown.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { PatientLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { patientLabel, usePatientNames } from "../23-billing-medicare/use-patient-names";
import { AuthorizationDrawer, AuthorizationDrawerShell } from "./authorization-drawer";
import { AuthorizationForm } from "./authorization-form";
import { CommercialTabs, EntityGate, EntityPicker } from "./commercial-chrome";
import {
  AUTHORIZATION_STATUS_OPTIONS,
  type AuthorizationView,
  authorizationPeriod,
  authorizationStatusLabel,
  authorizationStatusTone,
  authorizationWindowNote,
  levelOfCareLabel,
  localToday,
  shortId,
} from "./commercial-model";
import { useAuthorizationPlans } from "./use-authorization-plans";
import { useProviderEntity } from "./use-provider-entity";

type AuthorizationsLoad =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly items: readonly AuthorizationView[] };

const PATIENT_PARAM = "patient";
const AUTH_PARAM = "auth";
const STATUS_PARAM = "status";
const NEW_AUTH = "new";
const WRITE_PERMISSION = "commercial_billing.write";

export function CommercialAuthorizations(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const permissions = useSession()?.permissions ?? [];
  const canWrite = permissions.includes(WRITE_PERMISSION);
  const { state: entities, entityId, retry: retryEntities } = useProviderEntity();
  const { plans, retry: retryPlans } = useAuthorizationPlans(entityId);
  const patientId = params.get(PATIENT_PARAM) ?? "";
  const authParam = params.get(AUTH_PARAM) ?? "";
  const statusFilter = params.get(STATUS_PARAM) ?? "";
  const [load, setLoad] = useState<AuthorizationsLoad>({ status: "idle" });
  const [reloadKey, setReloadKey] = useState(0);
  const names = usePatientNames(client, patientId ? [patientId] : []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (!entityId || !patientId) {
      setLoad({ status: "idle" });
      return;
    }
    let active = true;
    setLoad({ status: "loading" });
    void client
      .GET("/api/v1/billing/commercial/authorizations", {
        params: { query: { providerEntityId: entityId, patientId } },
      })
      .then(({ data, error }) => {
        if (!active) return;
        setLoad(error || !data ? { status: "error" } : { status: "ready", items: data.items });
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, entityId, patientId, reloadKey]);

  const reload = (): void => setReloadKey((k) => k + 1);
  const setParam = (key: string, value: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== AUTH_PARAM) next.delete(AUTH_PARAM);
        return next;
      },
      { replace: true },
    );
  // Changing the entity or the patient drops everything scoped to the old one: patient, selection and any claim.
  const setScope = (changes: { entity?: string; patient?: string }): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (changes.entity !== undefined) next.set("entity", changes.entity);
        if (changes.patient) next.set(PATIENT_PARAM, changes.patient);
        else next.delete(PATIENT_PARAM);
        next.delete(AUTH_PARAM);
        next.delete("claim");
        return next;
      },
      { replace: true },
    );

  const items = load.status === "ready" ? load.items : [];
  const visible = statusFilter ? items.filter((a) => a.status === statusFilter) : items;
  const planList = plans.state === "ready" ? plans.plans : [];
  const planName = (id: string): string =>
    planList.find((p) => p.id === id)?.planName ?? `Plan ${shortId(id)}`;
  const selected = items.find((a) => a.id === authParam) ?? null;
  const recording = authParam === NEW_AUTH && canWrite && patientId !== "";
  const today = localToday();
  const patientName = patientLabel(names[patientId], patientId);
  const ready = load.status === "ready";

  return (
    <div className={`wx-list-drawer${selected || recording ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Authorizations</h1>
            <p>
              Pre-authorizations recorded for a patient under a provider entity. Search for a
              patient to see theirs.
            </p>
          </div>
          {canWrite && patientId ? (
            <Button onClick={() => setParam(AUTH_PARAM, NEW_AUTH)}>Record authorization</Button>
          ) : null}
        </header>

        <BillingTabs />
        <CommercialTabs />

        <EntityGate state={entities} hasEntity={entityId !== ""} onRetry={retryEntities}>
          <div className="wx-stat-grid" aria-label="Authorization summary">
            <KpiCard
              icon="clipboard-list"
              label="Authorizations"
              value={ready ? items.length : "—"}
              detail="For this patient"
            />
            <KpiCard
              icon="check-circle"
              label="Approved"
              value={ready ? items.filter((a) => a.status === "approved").length : "—"}
              detail="Currently approved"
            />
            <KpiCard
              icon="shield-check"
              label="Denied or voided"
              value={ready ? items.filter((a) => a.status !== "approved").length : "—"}
              detail="Final, no longer count"
            />
          </div>

          <div className="wx-filter-panel">
            <EntityPicker
              state={entities}
              value={entityId}
              onChange={(id) => setScope({ entity: id })}
            />
            <div style={{ minWidth: "16rem" }}>
              <PatientLookupField
                label="Patient"
                value={patientId}
                clearable
                onChange={(id) => setScope({ patient: id })}
              />
            </div>
            <label className="wx-filter-field">
              <span>Status</span>
              <select
                className="wx-select"
                aria-label="Authorization status"
                value={statusFilter}
                onChange={(e) => setParam(STATUS_PARAM, e.target.value)}
              >
                {AUTHORIZATION_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div aria-live="polite">
            {!patientId ? (
              <div className="wx-list-state">
                <EmptyState
                  title="Choose a patient"
                  description="Authorizations are listed per patient. Search above by name or MRN."
                />
              </div>
            ) : load.status === "loading" || load.status === "idle" ? (
              <output className="wx-list-state">
                <LoadingSpinner />
              </output>
            ) : load.status === "error" ? (
              <div className="wx-list-state" role="alert">
                <EmptyState
                  title="Authorizations unavailable"
                  description="The authorizations could not be loaded. The patient may be outside your scope for this provider entity."
                />
                <Button tone="secondary" onClick={reload}>
                  Try again
                </Button>
              </div>
            ) : visible.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title={statusFilter ? "No matching authorizations" : "No authorizations recorded"}
                  description={
                    statusFilter
                      ? "None of this patient's authorizations has that status."
                      : `No authorization has been recorded for ${patientName} under this entity.`
                  }
                />
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table">
                  <caption className="wx-sr-only">{`Authorizations for ${patientName}`}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Plan</th>
                      <th scope="col">Level of care</th>
                      <th scope="col">Period</th>
                      <th scope="col">Obtained</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((a) => {
                      const note = authorizationWindowNote(a, today);
                      return (
                        <tr
                          key={a.id}
                          className="wx-data-row-interactive"
                          {...interactiveRowProps(
                            () => setParam(AUTH_PARAM, a.id),
                            a.id === selected?.id,
                          )}
                        >
                          <td>
                            <span className="wx-row-title">{planName(a.planId)}</span>
                            <div className="wx-row-sub">{shortId(a.id)}</div>
                          </td>
                          <td>{levelOfCareLabel(a.levelOfCare)}</td>
                          <td className="wx-nums">
                            {authorizationPeriod(a.effectiveFrom, a.effectiveTo)}
                            {note ? <div className="wx-row-sub">{note}</div> : null}
                          </td>
                          <td className="wx-nums">{a.obtainedOn}</td>
                          <td>
                            <StatusPill
                              label={authorizationStatusLabel(a.status)}
                              tone={authorizationStatusTone(a.status)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </EntityGate>
      </div>

      {selected ? (
        <AuthorizationDrawer
          authorization={selected}
          plan={planList.find((p) => p.id === selected.planId)}
          today={today}
          canWrite={canWrite}
          onClose={() => setParam(AUTH_PARAM, "")}
          onChanged={reload}
          onReload={reload}
        />
      ) : null}
      {recording ? (
        <AuthorizationDrawerShell
          label="Record authorization"
          title="Record authorization"
          subtitle={patientName}
          closeLabel="Close record authorization"
          onClose={() => setParam(AUTH_PARAM, "")}
        >
          {plans.state === "loading" ? (
            <output className="wx-list-state">
              <LoadingSpinner />
            </output>
          ) : plans.state === "error" ? (
            <div className="wx-list-state" role="alert">
              <EmptyState
                title="Plans unavailable"
                description="The plans to record against could not be loaded."
              />
              <Button tone="secondary" onClick={retryPlans}>
                Try again
              </Button>
            </div>
          ) : (
            <AuthorizationForm
              providerEntityId={entityId}
              patientId={patientId}
              plans={planList}
              onRecorded={() => {
                setParam(AUTH_PARAM, "");
                reload();
              }}
              onClose={() => setParam(AUTH_PARAM, "")}
              onReload={reload}
            />
          )}
        </AuthorizationDrawerShell>
      ) : null}
    </div>
  );
}
