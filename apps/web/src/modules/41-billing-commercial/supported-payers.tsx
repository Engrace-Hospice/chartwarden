import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  LoadingSpinner,
  StatusPill,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
// apps/web/src/modules/41-billing-commercial — the SUPPORTED PAYERS view (M41, issue #726; spec section 5). Which commercial payers
// the agency can bill, and whether it can SEND to each: the plan (filing indicator, authorization policy, eligibility staleness),
// the payer's state in master data, the clearinghouse payer id each plan routes on, and the provider entity's enrollment with the
// payer. "Not enrolled" is a first-class state, not a blank: nothing is sent until the enrollment is `enrolled` (ADR-0100 D5).
//   GET /api/v1/billing/commercial/payer-plans?providerEntityId     plans, payer state, routes (no patient data)
//   GET /api/v1/billing/commercial/enrollments?providerEntityId     enrollment rows
//   GET /api/v1/mdm/payer/{id}                                      the payer's display name
// The plans and enrollments are required; a payer name that cannot be read falls back to a short id and never blanks the page.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { CommercialTabs, EntityGate, EntityPicker } from "./commercial-chrome";
import {
  COMMERCIAL_PATHS,
  type EnrollmentFact,
  authorizationRequirementLabel,
  enrollmentStatusFor,
  filingIndicatorLabel,
  payerStatusLabel,
  payerStatusTone,
  shortId,
} from "./commercial-model";
import { usePayerNames } from "./use-payer-names";
import { useProviderEntity } from "./use-provider-entity";

export interface PlanRow {
  readonly id: string;
  readonly payerId: string;
  readonly planName: string;
  readonly claimFilingIndicator: string;
  readonly authorizationRequirement: string;
  readonly authorizationLeadDays: number | null;
  readonly eligibilityStalenessPolicy: string;
  readonly eligibilityMaxAgeDays: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly payerStatus: string | null;
  readonly routes: readonly {
    readonly clearinghouseKey: string;
    readonly clearinghousePayerId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
}

type PayersLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly plans: readonly PlanRow[];
      readonly enrollments: readonly EnrollmentFact[];
    };

const PLAN_PARAM = "plan";
const today = (): string => new Date().toISOString().slice(0, 10);

export function SupportedPayers(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const { state: entities, entityId, setEntityId, retry: retryEntities } = useProviderEntity();
  const [load, setLoad] = useState<PayersLoad>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const selectedPlanId = params.get(PLAN_PARAM) ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (!entityId) return;
    let active = true;
    setLoad({ status: "loading" });
    const query = { providerEntityId: entityId };
    void Promise.all([
      client.GET("/api/v1/billing/commercial/payer-plans", { params: { query } }),
      client.GET("/api/v1/billing/commercial/enrollments", { params: { query } }),
    ])
      .then(([plans, enrollments]) => {
        if (!active) return;
        if (plans.error || !plans.data || enrollments.error || !enrollments.data) {
          setLoad({ status: "error" });
          return;
        }
        setLoad({ status: "ready", plans: plans.data.items, enrollments: enrollments.data.items });
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, entityId, reloadKey]);

  const names = usePayerNames(load.status === "ready" ? load.plans.map((p) => p.payerId) : []);

  const nameOf = (payerId: string): string => names[payerId] ?? `Payer ${shortId(payerId)}`;
  const plans = load.status === "ready" ? load.plans : [];
  const enrollments = load.status === "ready" ? load.enrollments : [];
  const selected = plans.find((p) => p.id === selectedPlanId) ?? null;
  const day = today();
  const enrolledCount = plans.filter(
    (p) => enrollmentStatusFor(p.payerId, enrollments, day).status === "enrolled",
  ).length;
  const authRequired = plans.filter((p) =>
    ["required_at_admission", "required_per_level_of_care"].includes(p.authorizationRequirement),
  ).length;
  const select = (id: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set(PLAN_PARAM, id);
        else next.delete(PLAN_PARAM);
        return next;
      },
      { replace: true },
    );
  const ready = load.status === "ready";

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Supported Payers</h1>
            <p>
              The commercial plans this agency can bill, how each is routed through the
              clearinghouse, and whether the agency is enrolled to send.
            </p>
          </div>
        </header>

        <BillingTabs />
        <CommercialTabs />

        <EntityGate state={entities} hasEntity={entityId !== ""} onRetry={retryEntities}>
          <div className="wx-stat-grid" aria-label="Supported payer summary">
            <KpiCard
              icon="building"
              label="Plans"
              value={ready ? plans.length : "—"}
              detail="Commercial payer plans"
            />
            <KpiCard
              icon="check-circle"
              label="Enrolled to send"
              value={ready ? enrolledCount : "—"}
              detail="Plans with an enrolled payer today"
            />
            <KpiCard
              icon="shield-check"
              label="Authorization required"
              value={ready ? authRequired : "—"}
              detail="Plans that need pre-authorization"
            />
          </div>

          <div className="wx-filter-panel">
            <EntityPicker state={entities} value={entityId} onChange={setEntityId} />
          </div>

          <div aria-live="polite">
            {load.status === "loading" ? (
              <output className="wx-list-state">
                <LoadingSpinner />
              </output>
            ) : load.status === "error" ? (
              <div className="wx-list-state" role="alert">
                <EmptyState
                  title="Supported payers unavailable"
                  description="The payer plans or enrollments could not be loaded. You may lack billing access to this provider entity."
                />
                <Button tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                  Try again
                </Button>
              </div>
            ) : load.plans.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title="No commercial payer plans"
                  description="No commercial plan is set up for this organization, so commercial claims cannot be assembled."
                />
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table">
                  <caption className="wx-sr-only">Supported commercial payers</caption>
                  <thead>
                    <tr>
                      <th scope="col">Payer and plan</th>
                      <th scope="col">Filing indicator</th>
                      <th scope="col">Authorization</th>
                      <th scope="col">Clearinghouse route</th>
                      <th scope="col">Enrollment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {load.plans.map((p) => {
                      const enrollment = enrollmentStatusFor(p.payerId, load.enrollments, day);
                      return (
                        <tr
                          key={p.id}
                          className="wx-data-row-interactive"
                          {...interactiveRowProps(() => select(p.id), p.id === selectedPlanId)}
                        >
                          <td>
                            <span className="wx-row-title">{nameOf(p.payerId)}</span>
                            <div className="wx-row-sub">{p.planName}</div>
                          </td>
                          <td>{filingIndicatorLabel(p.claimFilingIndicator)}</td>
                          <td>{authorizationRequirementLabel(p.authorizationRequirement)}</td>
                          <td className="wx-nums">
                            {p.routes.length === 0 ? (
                              <StatusPill label="No route" tone="warning" />
                            ) : (
                              p.routes
                                .map((r) => `${r.clearinghouseKey}: ${r.clearinghousePayerId}`)
                                .join(", ")
                            )}
                          </td>
                          <td>
                            <StatusPill label={enrollment.label} tone={enrollment.tone} />
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
        <PlanDrawer
          plan={selected}
          payerName={nameOf(selected.payerId)}
          enrollment={enrollmentStatusFor(selected.payerId, enrollments, day)}
          entityId={entityId}
          onClose={() => select("")}
        />
      ) : null}
    </div>
  );
}

function PlanDrawer({
  plan,
  payerName,
  enrollment,
  entityId,
  onClose,
}: {
  plan: PlanRow;
  payerName: string;
  enrollment: { status: string; label: string; tone: Parameters<typeof StatusPill>[0]["tone"] };
  entityId: string;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={`${payerName} ${plan.planName}`}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="building" size={20} />
        </span>
        <div>
          <h2>{payerName}</h2>
          <div className="wx-row-sub">{plan.planName}</div>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close plan details" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Can we send?</h3>
            <StatusPill label={enrollment.label} tone={enrollment.tone} />
          </div>
          {enrollment.status === "not_enrolled" ? (
            <p className="wx-row-sub">
              Nothing is sent to this payer until an enrollment is in effect.{" "}
              <Link to={`${COMMERCIAL_PATHS.enrollments}?entity=${encodeURIComponent(entityId)}`}>
                Manage enrollments
              </Link>
            </p>
          ) : null}
          <dl className="wx-kv">
            <dt>Payer in master data</dt>
            <dd>
              <StatusPill
                label={payerStatusLabel(plan.payerStatus)}
                tone={payerStatusTone(plan.payerStatus)}
              />
            </dd>
            <dt>Plan in effect</dt>
            <dd className="wx-nums">
              {plan.effectiveFrom} to {plan.effectiveTo ?? "open"}
            </dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Plan rules</h3>
          <dl className="wx-kv">
            <dt>Filing indicator</dt>
            <dd>{filingIndicatorLabel(plan.claimFilingIndicator)}</dd>
            <dt>Authorization</dt>
            <dd>{authorizationRequirementLabel(plan.authorizationRequirement)}</dd>
            <dt>Authorization lead time</dt>
            <dd className="wx-nums">
              {plan.authorizationLeadDays === null ? "None" : `${plan.authorizationLeadDays} days`}
            </dd>
            <dt>Eligibility check</dt>
            <dd>
              {plan.eligibilityStalenessPolicy === "block" ? "Blocks" : "Warns"} when older than{" "}
              {plan.eligibilityMaxAgeDays} days
            </dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Clearinghouse routes</h3>
          {plan.routes.length === 0 ? (
            <p className="wx-row-sub">No route: a claim for this plan cannot be sent.</p>
          ) : (
            <dl className="wx-kv">
              {plan.routes.map((r) => (
                <div key={`${r.clearinghouseKey}-${r.effectiveFrom}`}>
                  <dt>{r.clearinghouseKey}</dt>
                  <dd className="wx-nums">
                    {r.clearinghousePayerId}
                    <span className="wx-row-sub">
                      {r.effectiveFrom} to {r.effectiveTo ?? "open"}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
}
