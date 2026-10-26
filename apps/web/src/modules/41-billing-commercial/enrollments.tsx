// apps/web/src/modules/41-billing-commercial — the ENROLLMENTS view (M41). The provider entity's enrollment with each payer on a
// clearinghouse: the fact that gates every send (ADR-0100 D5): only `enrolled`, in effect that day, on the platform's clearinghouse.
//   GET /api/v1/billing/commercial/enrollments?providerEntityId   the rows (up to 200, no paging, no patient data)
//   GET /api/v1/billing/commercial/payer-plans?providerEntityId    the payers the add form offers
// Add and Edit exist only for commercial_billing.manage_enrollment; the server stays the authority. A failed read (a 404 included)
// is an error with a retry, never "no enrollments". Evidence references are shown exactly as entered.
import {
  Button,
  EmptyState,
  KpiCard,
  LoadingSpinner,
  StatusPill,
  useApiClient,
  useToast,
} from "@chartwarden/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import { AuthorizationDrawerShell } from "./authorization-drawer";
import { CommercialTabs, EntityGate, EntityPicker } from "./commercial-chrome";
import {
  type EnrollmentView,
  enrollmentLabel,
  enrollmentPeriod,
  enrollmentTone,
  localToday,
  shortId,
} from "./commercial-model";
import { ENROLLMENT_DRAFT_ACTIONS, EnrollmentForm } from "./enrollment-form";
import { useAuthorizationPlans } from "./use-authorization-plans";
import { usePayerNames } from "./use-payer-names";
import { useProviderEntity } from "./use-provider-entity";

type EnrollmentsLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly key: string;
      readonly items: readonly EnrollmentView[];
    };

const ENROLLMENT_PARAM = "enrollment";
const NEW_ENROLLMENT = "new";
const MANAGE_PERMISSION = "commercial_billing.manage_enrollment";

export function CommercialEnrollments(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const permissions = useSession()?.permissions ?? [];
  const canManage = permissions.includes(MANAGE_PERMISSION);
  const { state: entities, entityId, retry: retryEntities } = useProviderEntity();
  const { plans, retry: retryPlans } = useAuthorizationPlans(entityId);
  const drawerParam = params.get(ENROLLMENT_PARAM) ?? "";
  const [rawLoad, setLoad] = useState<EnrollmentsLoad>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const refocusPending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const toast = useToast();
  // Back from /step-up: the form restores its stashed draft. An abandoned draft is discarded, never restored.
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, ENROLLMENT_DRAFT_ACTIONS);
  // Rows belong to one entity: another entity's rows are never shown, even for the render before the effect runs.
  const load: EnrollmentsLoad =
    rawLoad.status === "ready" && rawLoad.key !== entityId ? { status: "loading" } : rawLoad;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (!entityId) return;
    let active = true;
    // Stale-while-revalidate: a reload of the same entity keeps its rows (and the open drawer) mounted.
    setLoad((prev) =>
      prev.status === "ready" && prev.key === entityId ? prev : { status: "loading" },
    );
    void client
      .GET("/api/v1/billing/commercial/enrollments", {
        params: { query: { providerEntityId: entityId } },
      })
      .then(({ data, error }) => {
        if (!active) return;
        setLoad(
          error || !data
            ? { status: "error" }
            : { status: "ready", key: entityId, items: data.items },
        );
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, entityId, reloadKey]);

  const items = load.status === "ready" ? load.items : [];
  const planList = plans.state === "ready" ? plans.plans : [];
  const names = usePayerNames([
    ...items.map((e) => e.payerId),
    ...planList.flatMap((p) => (p.payerId ? [p.payerId] : [])),
  ]);
  const nameOf = (payerId: string): string => names[payerId] ?? `Payer ${shortId(payerId)}`;
  const payers = useMemo(
    () => [...new Set(planList.flatMap((p) => (p.payerId ? [p.payerId] : [])))],
    [planList],
  );

  const reload = (): void => setReloadKey((k) => k + 1);
  const setDrawer = (value: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(ENROLLMENT_PARAM, value);
        else next.delete(ENROLLMENT_PARAM);
        return next;
      },
      { replace: true },
    );
  // After the drawer closes, focus returns to the opener via the drawer; if that opener is gone, land on the page heading.
  useEffect(() => {
    if (!refocusPending.current || drawerParam) return;
    refocusPending.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) heading.current?.focus();
  }, [drawerParam]);
  const finish = (message: string): void => {
    setDrawer("");
    toast.show(message, { tone: "success" });
    reload();
    refocusPending.current = true;
  };
  // An open drawer belongs to the old entity: one URL update drops it with the switch.
  const changeEntity = (id: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("entity", id);
        next.delete(ENROLLMENT_PARAM);
        return next;
      },
      { replace: true },
    );

  const today = localToday();
  const selected = items.find((e) => e.id === drawerParam) ?? null;
  const adding = drawerParam === NEW_ENROLLMENT && canManage;
  const editing = selected !== null && canManage;
  const ready = load.status === "ready";
  const inEffect = (e: EnrollmentView): boolean =>
    e.status === "enrolled" && e.effectiveFrom <= today && (e.effectiveTo ?? today) >= today;

  return (
    <div className={`wx-list-drawer${adding || editing ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              Enrollments
            </h1>
            <p>
              The agency's enrollment with each commercial payer. Nothing is sent to a payer unless
              its enrollment is Enrolled, in effect that day, on the platform's clearinghouse.
            </p>
          </div>
          {canManage && entityId ? (
            <Button onClick={() => setDrawer(NEW_ENROLLMENT)}>Add enrollment</Button>
          ) : null}
        </header>

        <BillingTabs />
        <CommercialTabs />

        <EntityGate state={entities} hasEntity={entityId !== ""} onRetry={retryEntities}>
          <div className="wx-stat-grid" aria-label="Enrollment summary">
            <KpiCard
              icon="clipboard-list"
              label="Enrollments"
              value={ready ? items.length : "—"}
              detail="Recorded for this entity"
            />
            <KpiCard
              icon="check-circle"
              label="Enrolled to send"
              value={ready ? items.filter(inEffect).length : "—"}
              detail="Enrolled and in effect today"
            />
          </div>

          <div className="wx-filter-panel">
            <EntityPicker state={entities} value={entityId} onChange={changeEntity} />
          </div>

          <div aria-live="polite">
            {load.status === "loading" ? (
              <output className="wx-list-state">
                <LoadingSpinner />
              </output>
            ) : load.status === "error" ? (
              <div className="wx-list-state" role="alert">
                <EmptyState
                  title="Enrollments unavailable"
                  description="The enrollments could not be loaded. You may lack billing access to this provider entity."
                />
                <Button tone="secondary" onClick={reload}>
                  Try again
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title="No enrollments recorded"
                  description="No enrollment is recorded for this entity, so no commercial claim can be sent."
                />
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table">
                  <caption className="wx-sr-only">Payer enrollments</caption>
                  <thead>
                    <tr>
                      <th scope="col">Payer</th>
                      <th scope="col">Clearinghouse key</th>
                      <th scope="col">Status</th>
                      <th scope="col">Effective from</th>
                      <th scope="col">Effective to</th>
                      <th scope="col">Evidence reference</th>
                      {canManage ? (
                        <th scope="col">
                          <span className="wx-sr-only">Actions</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {load.items.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <span className="wx-row-title">{nameOf(e.payerId)}</span>
                        </td>
                        <td className="wx-nums">{e.clearinghouseKey}</td>
                        <td>
                          <StatusPill
                            label={enrollmentLabel(e.status)}
                            tone={enrollmentTone(e.status)}
                          />
                        </td>
                        <td className="wx-nums">{e.effectiveFrom}</td>
                        <td className="wx-nums">{e.effectiveTo ?? "Open-ended"}</td>
                        <td className="wx-nums">{e.evidenceRef ?? "—"}</td>
                        {canManage ? (
                          <td>
                            <Button
                              tone="tertiary"
                              size="sm"
                              aria-label={`Edit enrollment for ${nameOf(e.payerId)} on ${e.clearinghouseKey}`}
                              onClick={() => setDrawer(e.id)}
                            >
                              Edit
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </EntityGate>
      </div>

      {editing && selected ? (
        <AuthorizationDrawerShell
          key={selected.id}
          label="Edit enrollment"
          title="Edit enrollment"
          subtitle={`${nameOf(selected.payerId)} · ${selected.clearinghouseKey} · ${enrollmentPeriod(selected.effectiveFrom, selected.effectiveTo)}`}
          closeLabel="Close edit enrollment"
          onClose={() => setDrawer("")}
        >
          <EnrollmentForm
            mode={{ kind: "edit", enrollment: selected }}
            providerEntityId={entityId}
            resume={returning}
            onSaved={() => finish("Enrollment updated.")}
            onClose={() => setDrawer("")}
            onReload={reload}
          />
        </AuthorizationDrawerShell>
      ) : null}
      {adding ? (
        <AuthorizationDrawerShell
          label="Add enrollment"
          title="Add enrollment"
          subtitle="Record the agency's enrollment with a payer"
          closeLabel="Close add enrollment"
          onClose={() => setDrawer("")}
        >
          {plans.state === "loading" ? (
            <output className="wx-list-state">
              <LoadingSpinner />
            </output>
          ) : plans.state === "error" ? (
            <div className="wx-list-state" role="alert">
              <EmptyState
                title="Payers unavailable"
                description="The payers to enroll with could not be loaded."
              />
              <Button tone="secondary" onClick={retryPlans}>
                Try again
              </Button>
            </div>
          ) : (
            <EnrollmentForm
              mode={{
                kind: "create",
                payers: payers.map((id) => ({ id, name: nameOf(id) })),
              }}
              providerEntityId={entityId}
              resume={returning}
              onSaved={() => finish("Enrollment added.")}
              onClose={() => setDrawer("")}
              onReload={reload}
            />
          )}
        </AuthorizationDrawerShell>
      ) : null}
    </div>
  );
}
