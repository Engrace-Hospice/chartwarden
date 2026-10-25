import {
  Button,
  EmptyState,
  Glyph,
  InlineAlert,
  KpiCard,
  LoadingSpinner,
  StatusPill,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
// apps/web/src/modules/41-billing-commercial — the COMMERCIAL CLAIM WORK QUEUE (M41, issue #726; spec section 5). The redesign's
// list + right drawer: a KPI strip, a filter panel (provider entity, payer kind, state) over one table of the entity's commercial
// claims, and a drawer that previews the selected claim before the full detail page.
//   GET /api/v1/billing/commercial/claims?providerEntityId&state&payerKind   one page; `hasMore` says narrow the filters.
// Payer kind is the coordination of benefits on the claim: commercial only, or Medicare / Medicaid secondary. The list carries ids,
// dates, plan name and money; patient names are read per patient through the shared name queue. The server is the only authz point.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { patientLabel, usePatientNames } from "../23-billing-medicare/use-patient-names";
import { CommercialTabs, EntityGate, EntityPicker } from "./commercial-chrome";
import {
  CLAIM_STATE_OPTIONS,
  COMMERCIAL_PATHS,
  PAYER_KIND_OPTIONS,
  asClaimState,
  asPayerKind,
  claimStateTone,
  dollars,
  payerKindLabel,
  servicePeriod,
  statusLabel,
  wholeDollars,
} from "./commercial-model";
import { useProviderEntity } from "./use-provider-entity";

export interface QueueClaim {
  readonly id: string;
  readonly claimControlNumber: string;
  readonly state: string;
  readonly patientId: string;
  readonly planName: string;
  readonly tob: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly secondaryPayerKind: string | null;
  readonly totalChargeCents: number;
  readonly expectedPaymentCents: number | null;
}

type QueueLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly items: readonly QueueClaim[]; readonly hasMore: boolean };

const KIND_PARAM = "kind";
const STATE_PARAM = "state";
const CLAIM_PARAM = "claim";

export function CommercialClaimQueue(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const { state: entities, entityId, setEntityId, retry: retryEntities } = useProviderEntity();
  const kind = params.get(KIND_PARAM) ?? "";
  const stateFilter = params.get(STATE_PARAM) ?? "";
  const selectedId = params.get(CLAIM_PARAM) ?? "";
  const [load, setLoad] = useState<QueueLoad>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (!entityId) return;
    let active = true;
    setLoad({ status: "loading" });
    const payerKind = asPayerKind(kind);
    const claimState = asClaimState(stateFilter);
    void client
      .GET("/api/v1/billing/commercial/claims", {
        params: {
          query: {
            providerEntityId: entityId,
            ...(payerKind ? { payerKind } : {}),
            ...(claimState ? { state: claimState } : {}),
          },
        },
      })
      .then(({ data, error }) => {
        if (!active) return;
        setLoad(
          error || !data
            ? { status: "error" }
            : { status: "ready", items: data.items, hasMore: data.hasMore },
        );
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, entityId, kind, stateFilter, reloadKey]);

  const items = load.status === "ready" ? load.items : [];
  const names = usePatientNames(client, [...new Set(items.map((c) => c.patientId))]);
  const nameOf = (id: string): string => patientLabel(names[id], id);
  const selected = items.find((c) => c.id === selectedId) ?? null;

  const setParam = (key: string, value: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== CLAIM_PARAM) next.delete(CLAIM_PARAM);
        return next;
      },
      { replace: true },
    );
  const filtered = kind !== "" || stateFilter !== "";

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Commercial Claims</h1>
            <p>
              Hospice claims whose primary payer is a commercial plan. Medicare and Medicaid claims
              are in their own lanes.
            </p>
          </div>
        </header>

        <BillingTabs />
        <CommercialTabs />

        <EntityGate state={entities} hasEntity={entityId !== ""} onRetry={retryEntities}>
          <QueueKpis load={load} />

          <div className="wx-filter-panel">
            <EntityPicker state={entities} value={entityId} onChange={setEntityId} />
            <label className="wx-filter-field">
              <span>Payer kind</span>
              <select
                className="wx-select"
                aria-label="Payer kind"
                value={kind}
                onChange={(e) => setParam(KIND_PARAM, e.target.value)}
              >
                {PAYER_KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wx-filter-field">
              <span>State</span>
              <select
                className="wx-select"
                aria-label="Claim state"
                value={stateFilter}
                onChange={(e) => setParam(STATE_PARAM, e.target.value)}
              >
                {CLAIM_STATE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div aria-live="polite">
            {load.status === "loading" ? (
              <output className="wx-list-state">
                <LoadingSpinner />
              </output>
            ) : load.status === "error" ? (
              <div className="wx-list-state" role="alert">
                <EmptyState
                  title="Claims unavailable"
                  description="The commercial claim queue could not be loaded. You may lack billing access to this provider entity."
                />
                <Button tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                  Try again
                </Button>
              </div>
            ) : load.items.length === 0 && load.hasMore ? (
              <div className="wx-list-state">
                <EmptyState
                  title="Too many claims to scan"
                  description="Nothing in the newest claims is in your caseload, and more claims exist. Narrow the filters (state, payer kind) to find yours."
                />
              </div>
            ) : load.items.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title={filtered ? "No matching claims" : "No commercial claims yet"}
                  description={
                    filtered
                      ? "No claim in your caseload matches these filters."
                      : "Commercial claims appear here once they are assembled for a patient whose primary coverage is a commercial plan."
                  }
                />
                {filtered ? (
                  <Button
                    tone="secondary"
                    onClick={() =>
                      setParams(new URLSearchParams({ entity: entityId }), { replace: true })
                    }
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {load.hasMore ? (
                  <InlineAlert tone="warning">
                    More claims match than this page shows. Narrow the filters to see the rest.
                  </InlineAlert>
                ) : null}
                <ClaimTable
                  claims={load.items}
                  selectedId={selected?.id ?? ""}
                  nameOf={nameOf}
                  onSelect={(id) => setParam(CLAIM_PARAM, id)}
                />
              </>
            )}
          </div>
        </EntityGate>
      </div>

      {selected ? (
        <ClaimDrawer
          claim={selected}
          patientName={nameOf(selected.patientId)}
          onClose={() => setParam(CLAIM_PARAM, "")}
        />
      ) : null}
    </div>
  );
}

function QueueKpis({ load }: { load: QueueLoad }): JSX.Element {
  const stats = useMemo(() => {
    const items = load.status === "ready" ? load.items : [];
    const open = items.filter((c) => c.state !== "void");
    return {
      total: items.length,
      draft: items.filter((c) => c.state === "draft").length,
      ready: items.filter((c) => c.state === "ready").length,
      expected: open.reduce((sum, c) => sum + (c.expectedPaymentCents ?? 0), 0),
    };
  }, [load]);
  const ready = load.status === "ready";
  const dash = (n: number | string): string | number => (ready ? n : "—");
  return (
    <div className="wx-stat-grid" aria-label="Commercial claim summary">
      <KpiCard
        icon="clipboard-list"
        label="In queue"
        value={dash(stats.total)}
        detail="Claims on this page"
      />
      <KpiCard
        icon="pencil"
        label="Draft"
        value={dash(stats.draft)}
        detail="Not yet ready to send"
      />
      <KpiCard
        icon="check-circle"
        label="Ready"
        value={dash(stats.ready)}
        detail="Validated, awaiting send"
      />
      <KpiCard
        icon="receipt"
        label="Expected payment"
        value={dash(wholeDollars(stats.expected))}
        detail="Open claims on this page"
      />
    </div>
  );
}

function ClaimTable({
  claims,
  selectedId,
  nameOf,
  onSelect,
}: {
  claims: readonly QueueClaim[];
  selectedId: string;
  nameOf: (patientId: string) => string;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Commercial claims</caption>
        <thead>
          <tr>
            <th scope="col">Claim #</th>
            <th scope="col">Patient</th>
            <th scope="col">Dates of service</th>
            <th scope="col">Payer kind</th>
            <th scope="col" style={{ textAlign: "right" }}>
              Charge
            </th>
            <th scope="col" style={{ textAlign: "right" }}>
              Expected
            </th>
            <th scope="col">State</th>
            <th scope="col">
              <span className="wx-sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <tr
              key={c.id}
              className="wx-data-row-interactive"
              {...interactiveRowProps(() => onSelect(c.id), c.id === selectedId, true)}
              aria-current={c.id === selectedId ? "true" : undefined}
            >
              <td className="wx-nums">
                <Link
                  to={COMMERCIAL_PATHS.claim(c.id)}
                  className="wx-row-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  {c.claimControlNumber}
                </Link>
                <div className="wx-row-sub">{c.planName}</div>
              </td>
              <td>{nameOf(c.patientId)}</td>
              <td className="wx-nums">{servicePeriod(c.serviceFrom, c.serviceTo)}</td>
              <td>{payerKindLabel(c.secondaryPayerKind)}</td>
              <td className="wx-nums" style={{ textAlign: "right" }}>
                {dollars(c.totalChargeCents)}
              </td>
              <td className="wx-nums" style={{ textAlign: "right" }}>
                {c.expectedPaymentCents === null ? "—" : dollars(c.expectedPaymentCents)}
              </td>
              <td>
                <StatusPill label={statusLabel(c.state)} tone={claimStateTone(c.state)} />
              </td>
              <td style={{ textAlign: "right" }}>
                <Link
                  to={COMMERCIAL_PATHS.claim(c.id)}
                  className="wx-icon-link"
                  aria-label={`Open claim ${c.claimControlNumber}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Glyph name="chevron-right" size={18} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClaimDrawer({
  claim,
  patientName,
  onClose,
}: {
  claim: QueueClaim;
  patientName: string;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside
      className="wx-admission-drawer"
      {...drawer}
      aria-label={`Claim ${claim.claimControlNumber}`}
    >
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="receipt" size={20} />
        </span>
        <div>
          <h2>{claim.claimControlNumber}</h2>
          <div className="wx-row-sub">{patientName}</div>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close claim preview" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Claim</h3>
            <StatusPill label={statusLabel(claim.state)} tone={claimStateTone(claim.state)} />
          </div>
          <dl className="wx-kv">
            <dt>Plan</dt>
            <dd>{claim.planName}</dd>
            <dt>Payer kind</dt>
            <dd>{payerKindLabel(claim.secondaryPayerKind)}</dd>
            <dt>Type of bill</dt>
            <dd className="wx-nums">{claim.tob}</dd>
            <dt>Dates of service</dt>
            <dd className="wx-nums">{servicePeriod(claim.serviceFrom, claim.serviceTo)}</dd>
            <dt>Charge</dt>
            <dd className="wx-nums">{dollars(claim.totalChargeCents)}</dd>
            <dt>Expected</dt>
            <dd className="wx-nums">
              {claim.expectedPaymentCents === null ? "—" : dollars(claim.expectedPaymentCents)}
            </dd>
          </dl>
        </section>
        <div className="wx-drawer-actions">
          <Link to={COMMERCIAL_PATHS.claim(claim.id)} className="wx-btn-primary">
            Open claim detail
          </Link>
        </div>
      </div>
    </aside>
  );
}
