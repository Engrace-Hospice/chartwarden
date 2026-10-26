// apps/web/src/modules/41-billing-commercial — the ELIGIBILITY view (M41). Commercial eligibility (270/271) checks for ONE patient under
// one provider entity: the latest check for a plan with the server's freshness verdict, the check history, a form to run a check and
// the plan's eligibility policy. The reads need the patient (and, for the latest, the plan), so the screen starts at a patient search.
//   GET   /api/v1/billing/commercial/eligibility/latest?providerEntityId&patientId&planId   newest check + freshness verdict
//   GET   /api/v1/billing/commercial/eligibility?providerEntityId&patientId[&planId]         history, newest first
//   GET   /api/v1/billing/commercial/payer-plans?providerEntityId                             plan names and policy
// Run a check exists only for commercial_billing.write and Edit policy only for commercial_billing.manage_enrollment (fresh
// step-up); the server stays the authority. A failed read (a 404 included) is an error with a retry, never "no checks" or a pass.
// No member id appears anywhere: the server resolves it from the patient's coverage and never returns it.
import { Button, EmptyState, LoadingSpinner, useApiClient, useToast } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { PatientLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { clearStepUpDraft } from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import { patientLabel, usePatientNames } from "../23-billing-medicare/use-patient-names";
import { AuthorizationDrawerShell } from "./authorization-drawer";
import { CommercialTabs, EntityGate, EntityPicker } from "./commercial-chrome";
import { shortId } from "./commercial-model";
import { EligibilityCheckForm } from "./eligibility-check-form";
import { CheckHistory, LatestCheckCard } from "./eligibility-panels";
import {
  ELIGIBILITY_DRAFT_ACTIONS,
  EligibilityPolicyForm,
  type SavedPolicy,
  eligibilityPolicyDraftKey,
} from "./eligibility-policy-form";
import { useAuthorizationPlans } from "./use-authorization-plans";
import { useProviderEntity } from "./use-provider-entity";
import { useScopedLoad } from "./use-scoped-load";

const PATIENT_PARAM = "patient";
const PLAN_PARAM = "plan";
const POLICY_PARAM = "policy";
const EDIT_POLICY = "edit";
const WRITE_PERMISSION = "commercial_billing.write";
const MANAGE_PERMISSION = "commercial_billing.manage_enrollment";
const DEFAULT_POLICY = "warn";
const DEFAULT_MAX_AGE_DAYS = 30;

export function CommercialEligibility(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const permissions = useSession()?.permissions ?? [];
  const canWrite = permissions.includes(WRITE_PERMISSION);
  const canManage = permissions.includes(MANAGE_PERMISSION);
  const { state: entities, entityId, retry: retryEntities } = useProviderEntity();
  const { plans, retry: retryPlans } = useAuthorizationPlans(entityId);
  const patientId = params.get(PATIENT_PARAM) ?? "";
  const planId = params.get(PLAN_PARAM) ?? "";
  const policyOpen = params.get(POLICY_PARAM) === EDIT_POLICY;
  const [reloadKey, setReloadKey] = useState(0);
  // A policy saved here, applied to the plan list at once (the plans read is not re-fetched).
  const [savedPolicies, setSavedPolicies] = useState<Readonly<Record<string, SavedPolicy>>>({});
  const refocusPending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const toast = useToast();
  const owner = useStepUpOwner();
  // Back from /step-up: the policy form restores its stashed draft. An abandoned draft is discarded, never restored.
  const returning = useStepUpReturn(owner, ELIGIBILITY_DRAFT_ACTIONS);
  const names = usePatientNames(client, patientId ? [patientId] : []);

  // Loads belong to one entity + patient + plan: another scope's data is never shown, even for the render before the effect runs.
  const scopeKey = `${entityId}|${patientId}|${planId}`;
  const history = useScopedLoad(
    entityId && patientId ? scopeKey : null,
    () =>
      client
        .GET("/api/v1/billing/commercial/eligibility", {
          params: {
            query: { providerEntityId: entityId, patientId, ...(planId ? { planId } : {}) },
          },
        })
        .then(({ data, error }) => ({ data: data?.items, error })),
    reloadKey,
  );
  const latest = useScopedLoad(
    entityId && patientId && planId ? scopeKey : null,
    () =>
      client.GET("/api/v1/billing/commercial/eligibility/latest", {
        params: { query: { providerEntityId: entityId, patientId, planId } },
      }),
    reloadKey,
  );

  const reload = (): void => setReloadKey((k) => k + 1);
  const setParam = (changes: Record<string, string>): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  // After the drawer closes, focus returns to the opener via the drawer; if that opener is gone, land on the page heading.
  useEffect(() => {
    if (!refocusPending.current || policyOpen) return;
    refocusPending.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) heading.current?.focus();
  }, [policyOpen]);
  // Closing the drawer or switching entity abandons its draft; a step-up redirect leaves the page without either.
  const abandonDraft = (): void => {
    if (planId) clearStepUpDraft(eligibilityPolicyDraftKey(owner, planId));
  };
  const closeDrawer = (): void => {
    abandonDraft();
    setParam({ [POLICY_PARAM]: "" });
  };
  // Everything scoped to the old entity goes with it: patient, plan and an open drawer.
  const changeEntity = (id: string): void => {
    abandonDraft();
    setParam({
      entity: id,
      [PATIENT_PARAM]: "",
      [PLAN_PARAM]: "",
      [POLICY_PARAM]: "",
    });
  };
  const policySaved = (saved: SavedPolicy): void => {
    setSavedPolicies((prev) => ({ ...prev, [planId]: saved }));
    setParam({ [POLICY_PARAM]: "" });
    toast.show("Eligibility policy updated.", { tone: "success" });
    reload();
    refocusPending.current = true;
  };
  const checked = ({ planId: checkedPlan, replayed }: { planId: string; replayed: boolean }) => {
    toast.show(
      replayed
        ? "That request was already answered. This is the earlier result, not a new check."
        : "Eligibility check recorded.",
      { tone: "success" },
    );
    if (checkedPlan !== planId) setParam({ [PLAN_PARAM]: checkedPlan });
    reload();
  };

  const planList = (plans.state === "ready" ? plans.plans : []).map((p) => {
    const saved = savedPolicies[p.id];
    return saved
      ? { ...p, eligibilityStalenessPolicy: saved.policy, eligibilityMaxAgeDays: saved.maxAgeDays }
      : p;
  });
  const planName = (id: string): string =>
    planList.find((p) => p.id === id)?.planName ?? `Plan ${shortId(id)}`;
  const selectedPlan = planList.find((p) => p.id === planId);
  const patientName = patientLabel(names[patientId], patientId);
  const editingPolicy = policyOpen && canManage && selectedPlan !== undefined;

  return (
    <div className={`wx-list-drawer${editingPolicy ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              Eligibility
            </h1>
            <p>
              Commercial eligibility checks for a patient under a provider entity, and whether the
              latest one is fresh enough to bill on. Search for a patient to see theirs.
            </p>
          </div>
        </header>

        <BillingTabs />
        <CommercialTabs />

        <EntityGate state={entities} hasEntity={entityId !== ""} onRetry={retryEntities}>
          <div className="wx-filter-panel">
            <EntityPicker state={entities} value={entityId} onChange={changeEntity} />
            <div style={{ minWidth: "16rem" }}>
              <PatientLookupField
                label="Patient"
                value={patientId}
                clearable
                onChange={(id) => setParam({ [PATIENT_PARAM]: id })}
              />
            </div>
            <label className="wx-filter-field">
              <span>Plan</span>
              <select
                className="wx-select"
                aria-label="Plan"
                value={planId}
                onChange={(e) => {
                  abandonDraft();
                  setParam({ [PLAN_PARAM]: e.target.value, [POLICY_PARAM]: "" });
                }}
              >
                <option value="">All plans</option>
                {planList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.planName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!patientId ? (
            <div className="wx-list-state">
              <EmptyState
                title="Choose a patient"
                description="Eligibility checks are listed per patient. Search above by name or MRN."
              />
            </div>
          ) : (
            <>
              <div aria-live="polite">
                {planId ? (
                  <LatestCheckCard
                    load={latest}
                    planName={planName(planId)}
                    onRetry={reload}
                    {...(canManage && selectedPlan
                      ? { onEditPolicy: () => setParam({ [POLICY_PARAM]: EDIT_POLICY }) }
                      : {})}
                  />
                ) : (
                  <div className="wx-list-state">
                    <EmptyState
                      title="Choose a plan"
                      description="Pick a plan above to see its latest check and whether it is fresh enough to bill on."
                    />
                  </div>
                )}
              </div>

              {canWrite ? (
                <section className="wx-drawer-card" aria-label="Run eligibility check">
                  <h3>Run eligibility check</h3>
                  {plans.state === "loading" ? (
                    <output className="wx-list-state">
                      <LoadingSpinner />
                    </output>
                  ) : plans.state === "error" ? (
                    <div className="wx-list-state" role="alert">
                      <EmptyState
                        title="Plans unavailable"
                        description="The plans to check against could not be loaded."
                      />
                      <Button tone="secondary" onClick={retryPlans}>
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <EligibilityCheckForm
                      key={`${entityId}|${patientId}`}
                      providerEntityId={entityId}
                      patientId={patientId}
                      plans={planList}
                      defaultPlanId={planId}
                      onChecked={checked}
                    />
                  )}
                </section>
              ) : null}

              <h2>Check history</h2>
              <div aria-live="polite">
                <CheckHistory
                  load={history}
                  patientName={patientName}
                  scopeLabel={selectedPlan ? selectedPlan.planName : "all plans"}
                  planName={planName}
                  onRetry={reload}
                />
              </div>
            </>
          )}
        </EntityGate>
      </div>

      {editingPolicy && selectedPlan ? (
        <AuthorizationDrawerShell
          key={selectedPlan.id}
          label="Edit eligibility policy"
          title="Edit eligibility policy"
          subtitle={selectedPlan.planName}
          closeLabel="Close edit eligibility policy"
          onClose={closeDrawer}
        >
          <EligibilityPolicyForm
            providerEntityId={entityId}
            planId={selectedPlan.id}
            current={{
              policy: selectedPlan.eligibilityStalenessPolicy ?? DEFAULT_POLICY,
              maxAgeDays: selectedPlan.eligibilityMaxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
            }}
            resume={returning}
            onSaved={policySaved}
            onClose={closeDrawer}
          />
        </AuthorizationDrawerShell>
      ) : null}
    </div>
  );
}
