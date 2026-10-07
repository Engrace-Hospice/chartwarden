import {
  Button,
  EmptyState,
  Glyph,
  InlineAlert,
  KpiCard,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  interactiveRowProps,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — HOSPICE RATES (M23 F-210 + FY2027 workstream E; 2026-09-25 redesign,
// mockup "Billing / Claims" frame 10 for the page + the Admissions right drawer 03_20_25 for the selected version).
//
// The tenant-entered, per-provider-entity, per-fiscal-year national base rates claim assembly prices from, with:
//   • an HQRP-compliance declaration per version (compliant vs the 4-percentage-point reduction, 42 CFR
//     418.306(b)(2));
//   • "Prefill from CMS national rates" from GET /billing/rate-tables/national-reference (the CORRECTED FY2027
//     rates, CMS-1851-CN), choosing the compliant or non-compliant column by the toggle;
//   • a live inline warning while keying when an entered rate differs from that column (advisory — the server
//     recomputes `nationalReferenceWarnings` on every saved version, and never blocks a save on them).
// Reads gate billing.rate_table.read, writes billing.rate_table.admin + the provider-entity scope; the server is
// the only authz point (ADR-0030). Rates are append-only: a correction SUPERSEDES the live version.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { BillingTabs } from "../../shell/billing-tabs";
import { ProviderEntityLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import {
  type NationalRateReference,
  RATE_FIELDS,
  type RateKey,
  centsToDollars,
  centsToInput,
  compareToReference,
  dollarsToCents,
  fiscalYearLabel,
  fiscalYearStartingOf,
  nonCompliantUpdatePct,
  referenceColumn,
} from "./rate-reference";

/** GET /billing/rate-tables → `rateTables[]`. */
interface RateTableVersion {
  rateTableId: string;
  providerEntityId: string;
  fiscalYearStarting: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  rhcDays1to60PerDiemCents: number;
  rhcDays61PlusPerDiemCents: number;
  chcPerDiemCents: number;
  chcHourlyRateCents: number;
  ircPerDiemCents: number;
  gipPerDiemCents: number;
  laborShareRhc: string | null;
  laborShareChc: string | null;
  laborShareIrc: string | null;
  laborShareGip: string | null;
  hqrpCompliant: boolean | null;
  nationalReferenceWarnings: string[];
  enteredByMembershipId: string;
  entryReason: string | null;
  supersededAt: string | null;
  createdAt: string;
}

type DrawerMode =
  | { kind: "view"; id: string }
  | { kind: "enter" }
  | { kind: "supersede"; id: string };

const NOW_FY = fiscalYearStartingOf(new Date());
const FY_OPTIONS = [NOW_FY + 1, NOW_FY, NOW_FY - 1, NOW_FY - 2].map((fy) => ({
  value: String(fy),
  label: `${fiscalYearLabel(fy)} (Oct ${fy} – Sep ${fy + 1})`,
}));

function usDate(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "—";
}

function hqrpLabel(v: boolean | null): string {
  return v === null ? "Undeclared" : v ? "HQRP compliant" : "Non-compliant (−4 pp)";
}

/** The KPI value (short — the tile is narrow on a phone). */
function hqrpShort(v: boolean | null): string {
  return v === null ? "Undeclared" : v ? "Compliant" : "Not compliant";
}

/** The server's warnings are a header sentence plus one line per field; the pill only says whether it differs. */
function referencePill(v: RateTableVersion): { label: string; tone: "success" | "warning" } {
  return v.nationalReferenceWarnings.length === 0
    ? { label: "Matches", tone: "success" }
    : { label: "Differs from CMS", tone: "warning" };
}

export function RateTables(): JSX.Element {
  const client = useApiClient();
  const canAdmin = useSession()?.permissions?.includes("billing.rate_table.admin") ?? false;
  const [providerEntityId, setProviderEntityId] = useState("");
  const [loadedPe, setLoadedPe] = useState<string | null>(null);
  const [fy, setFy] = useState(NOW_FY);
  const [versions, setVersions] = useState<RateTableVersion[] | null>(null);
  const [reference, setReference] = useState<NationalRateReference | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the read after a save.
  useEffect(() => {
    if (!loadedPe) return;
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const [list, ref] = await Promise.all([
        client.GET("/api/v1/billing/rate-tables", {
          params: { query: { providerEntityId: loadedPe, includeSuperseded: true } },
        }),
        client.GET("/api/v1/billing/rate-tables/national-reference", {
          params: { query: { providerEntityId: loadedPe, fiscalYearStarting: fy } },
        }),
      ]);
      if (!active) return;
      if (list.error) {
        setError(
          list.response?.status === 403 || list.response?.status === 404
            ? "This provider entity is outside your billing scope, or you lack billing.rate_table.read."
            : "The rate table could not be loaded.",
        );
        setVersions([]);
      } else {
        setVersions((list.data?.rateTables ?? []) as RateTableVersion[]);
      }
      setReference(
        ref.error ? null : ((ref.data?.reference ?? null) as NationalRateReference | null),
      );
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, loadedPe, fy, reloadKey]);

  const forFy = useMemo(
    () => (versions ?? []).filter((v) => v.fiscalYearStarting === fy),
    [versions, fy],
  );
  const live = forFy.find((v) => v.supersededAt === null) ?? null;
  const selected =
    drawer && drawer.kind !== "enter"
      ? ((versions ?? []).find((v) => v.rateTableId === drawer.id) ?? null)
      : null;
  const hasDrawer = drawer !== null && (drawer.kind === "enter" || selected !== null);

  return (
    <div className={`wx-rates${hasDrawer ? " has-drawer" : ""}`}>
      <div className="wx-rates-main">
        <header className="wx-page-head">
          <div>
            <h1>Hospice Rates</h1>
            <p>
              National per-diem base rates per provider entity and fiscal year, with the HQRP status
              they were keyed under. Claim assembly prices from the live version.
            </p>
          </div>
          {canAdmin && loadedPe ? (
            <Button onClick={() => setDrawer({ kind: "enter" })}>
              <Glyph name="plus" size={16} /> Enter {fiscalYearLabel(fy)} rates
            </Button>
          ) : null}
        </header>

        <BillingTabs />

        <form
          className="wx-filter-panel"
          onSubmit={(e) => {
            e.preventDefault();
            const id = providerEntityId.trim();
            if (id) {
              setDrawer(null);
              setLoadedPe(id);
            }
          }}
        >
          <div className="wx-rates-pe">
            <ProviderEntityLookupField
              label="Provider entity"
              value={providerEntityId}
              onChange={setProviderEntityId}
            />
          </div>
          <SelectField
            label="Fiscal year"
            value={String(fy)}
            options={FY_OPTIONS}
            onChange={(e) => {
              setFy(Number(e.target.value));
              setDrawer(null);
            }}
          />
          <Button type="submit" tone="secondary" disabled={!providerEntityId.trim()}>
            Load rates
          </Button>
        </form>

        <div className="wx-stat-grid" aria-label="Rate table summary">
          <KpiCard
            icon="calendar-check"
            label="Live version"
            value={loadedPe ? (live ? fiscalYearLabel(live.fiscalYearStarting) : "None") : "—"}
            detail={
              live
                ? `${usDate(live.effectiveFrom)} – ${usDate(live.effectiveTo)}`
                : "No live rates for this year"
            }
            accentColor={live ? t.success : undefined}
          />
          <KpiCard
            icon="shield-check"
            label="HQRP status"
            value={live ? hqrpShort(live.hqrpCompliant) : "—"}
            detail={
              reference
                ? `+${reference.paymentUpdatePct}% compliant · ${nonCompliantUpdatePct(reference)}% if not`
                : "Declared on each version"
            }
            accentColor={live?.hqrpCompliant === false ? t.warning : undefined}
          />
          <KpiCard
            icon="file-check"
            label="CMS reference check"
            value={
              !live
                ? "—"
                : reference === null
                  ? "No reference"
                  : referencePill(live).label === "Matches"
                    ? "Matches"
                    : "Differs"
            }
            detail={reference ? reference.sources[0]?.cite.split(",")[0] : "No CMS rates on file"}
            accentColor={
              live && live.nationalReferenceWarnings.length > 0
                ? t.warning
                : live
                  ? t.success
                  : undefined
            }
          />
          <KpiCard
            icon="clipboard-list"
            label="Versions on file"
            value={versions ? String(forFy.length) : "—"}
            detail={`${forFy.filter((v) => v.supersededAt !== null).length} superseded`}
          />
        </div>

        {!loadedPe ? (
          <div className="wx-list-state">
            <EmptyState
              title="Choose a provider entity"
              description="Rates are keyed per provider entity (CCN) and federal fiscal year."
            />
          </div>
        ) : loading && versions === null ? (
          <LoadingSpinner />
        ) : error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Rates unavailable" description={error} />
            <Button tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          </div>
        ) : forFy.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title={`No ${fiscalYearLabel(fy)} rates`}
              description={
                reference
                  ? `Claims for ${fiscalYearLabel(fy)} service dates cannot be priced until rates are entered. Prefill from the CMS national rates.`
                  : `Claims for ${fiscalYearLabel(fy)} service dates cannot be priced until rates are entered.`
              }
            />
          </div>
        ) : (
          <VersionTable
            versions={forFy}
            selectedId={selected?.rateTableId ?? null}
            onSelect={(id) => setDrawer({ kind: "view", id })}
          />
        )}
      </div>

      {drawer?.kind === "enter" && loadedPe ? (
        <RateEntryDrawer
          key={`enter-${fy}`}
          providerEntityId={loadedPe}
          fiscalYearStarting={fy}
          reference={reference ?? null}
          onClose={() => setDrawer(null)}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      ) : drawer?.kind === "supersede" && selected && loadedPe ? (
        <RateEntryDrawer
          key={`sup-${selected.rateTableId}`}
          providerEntityId={loadedPe}
          fiscalYearStarting={selected.fiscalYearStarting}
          reference={reference ?? null}
          supersedes={selected}
          onClose={() => setDrawer({ kind: "view", id: selected.rateTableId })}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      ) : selected ? (
        <VersionDrawer
          version={selected}
          reference={reference ?? null}
          canSupersede={canAdmin && selected.supersededAt === null}
          onSupersede={() => setDrawer({ kind: "supersede", id: selected.rateTableId })}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </div>
  );
}

function VersionTable({
  versions,
  selectedId,
  onSelect,
}: {
  versions: RateTableVersion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Rate-table versions</caption>
        <thead>
          <tr>
            <th scope="col">Effective</th>
            <th scope="col">HQRP</th>
            <th scope="col" className="wx-num-col">
              RHC 1–60
            </th>
            <th scope="col" className="wx-num-col">
              RHC 61+
            </th>
            <th scope="col" className="wx-num-col">
              GIP
            </th>
            <th scope="col">CMS reference</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const isSelected = v.rateTableId === selectedId;
            return (
              <tr
                key={v.rateTableId}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(() => onSelect(v.rateTableId), isSelected)}
              >
                <td className="wx-nums">
                  <span className="wx-row-title">{fiscalYearLabel(v.fiscalYearStarting)}</span>
                  <span className="wx-row-sub">
                    {usDate(v.effectiveFrom)} – {usDate(v.effectiveTo)}
                  </span>
                </td>
                <td>
                  <StatusPill
                    label={hqrpLabel(v.hqrpCompliant)}
                    tone={
                      v.hqrpCompliant === null ? "neutral" : v.hqrpCompliant ? "success" : "warning"
                    }
                  />
                </td>
                <td className="wx-nums wx-num-col">{centsToDollars(v.rhcDays1to60PerDiemCents)}</td>
                <td className="wx-nums wx-num-col">
                  {centsToDollars(v.rhcDays61PlusPerDiemCents)}
                </td>
                <td className="wx-nums wx-num-col">{centsToDollars(v.gipPerDiemCents)}</td>
                <td>
                  <StatusPill {...referencePill(v)} />
                </td>
                <td>
                  {v.supersededAt ? (
                    <StatusPill label="Superseded" tone="neutral" />
                  ) : (
                    <StatusPill label="Live" tone="success" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DrawerHead({
  icon,
  title,
  subtitle,
  onClose,
}: {
  icon: "receipt" | "pencil";
  title: string;
  subtitle: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <header className="wx-drawer-head">
      <span className="wx-rail-icon" aria-hidden>
        <Glyph name={icon} size={20} />
      </span>
      <div className="wx-rates-drawer-title">
        <h2>{title}</h2>
        <div className="wx-row-sub">{subtitle}</div>
      </div>
      <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
        <Glyph name="close" size={16} />
      </Button>
    </header>
  );
}

function VersionDrawer({
  version: v,
  reference,
  canSupersede,
  onSupersede,
  onClose,
}: {
  version: RateTableVersion;
  reference: NationalRateReference | null;
  canSupersede: boolean;
  onSupersede: () => void;
  onClose: () => void;
}): JSX.Element {
  const column =
    reference && v.hqrpCompliant !== null ? referenceColumn(reference, v.hqrpCompliant) : null;
  return (
    <aside
      className="wx-admission-drawer"
      aria-label={`${fiscalYearLabel(v.fiscalYearStarting)} rates`}
    >
      <DrawerHead
        icon="receipt"
        title={`${fiscalYearLabel(v.fiscalYearStarting)} rates`}
        subtitle={`${usDate(v.effectiveFrom)} – ${usDate(v.effectiveTo)} · ${hqrpLabel(v.hqrpCompliant)}`}
        onClose={onClose}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>National base rates</h3>
            {v.supersededAt ? (
              <StatusPill label="Superseded" tone="neutral" />
            ) : (
              <StatusPill label="Live" tone="success" />
            )}
          </div>
          <dl className="wx-kv">
            {RATE_FIELDS.map((f) => (
              <div key={f.key}>
                <dt>
                  {f.label} <span className="wx-muted-code">{f.revenueCode}</span>
                </dt>
                <dd className="wx-nums">
                  <span className="wx-locked-amount">
                    {centsToDollars(v[f.key])} <Glyph name="lock" size={12} />
                  </span>
                  {column && column[f.key] !== v[f.key] ? (
                    <span className="wx-row-sub">CMS {centsToDollars(column[f.key])}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="wx-source-line">
            <Glyph name="lock" size={12} /> Append-only · entered {usDate(v.createdAt)}
            {v.entryReason ? ` · ${v.entryReason}` : ""}
          </p>
        </section>

        <section className="wx-drawer-card">
          <h3>CMS reference check</h3>
          {reference === null ? (
            <p className="wx-row-sub">
              No CMS national rates are on file for {fiscalYearLabel(v.fiscalYearStarting)}.
            </p>
          ) : v.nationalReferenceWarnings.length === 0 ? (
            <InlineAlert tone="success">
              Matches the {reference.fiscalYearLabel}{" "}
              {v.hqrpCompliant === false ? "HQRP non-compliant" : "HQRP-compliant"} national rates.
            </InlineAlert>
          ) : (
            <InlineAlert tone="warning">
              <span className="wx-warning-list">
                {v.nationalReferenceWarnings.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </span>
            </InlineAlert>
          )}
          {reference ? (
            <p className="wx-source-line">
              Source: {reference.sources.map((s) => s.cite).join("; ")}
            </p>
          ) : null}
        </section>

        <section className="wx-drawer-card">
          <h3>Labor shares</h3>
          <dl className="wx-kv">
            <dt>RHC</dt>
            <dd className="wx-nums">{v.laborShareRhc ?? "Not entered"}</dd>
            <dt>CHC</dt>
            <dd className="wx-nums">{v.laborShareChc ?? "Not entered"}</dd>
            <dt>IRC</dt>
            <dd className="wx-nums">{v.laborShareIrc ?? "Not entered"}</dd>
            <dt>GIP</dt>
            <dd className="wx-nums">{v.laborShareGip ?? "Not entered"}</dd>
          </dl>
        </section>

        {canSupersede ? (
          <Button tone="secondary" onClick={onSupersede}>
            <Glyph name="pencil" size={15} /> Supersede with corrected rates
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

type RateText = Record<RateKey, string>;
const LABOR_KEYS = ["laborShareRhc", "laborShareChc", "laborShareIrc", "laborShareGip"] as const;
type LaborKey = (typeof LABOR_KEYS)[number];
const LABOR_LABEL: Record<LaborKey, string> = {
  laborShareRhc: "Labor share RHC",
  laborShareChc: "Labor share CHC",
  laborShareIrc: "Labor share IRC",
  laborShareGip: "Labor share GIP",
};

function emptyRates(): RateText {
  return Object.fromEntries(RATE_FIELDS.map((f) => [f.key, ""])) as RateText;
}

function RateEntryDrawer({
  providerEntityId,
  fiscalYearStarting,
  reference,
  supersedes,
  onClose,
  onSaved,
}: {
  providerEntityId: string;
  fiscalYearStarting: number;
  reference: NationalRateReference | null;
  supersedes?: RateTableVersion;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [hqrpCompliant, setHqrpCompliant] = useState<boolean>(supersedes?.hqrpCompliant ?? true);
  const [rates, setRates] = useState<RateText>(() =>
    supersedes
      ? (Object.fromEntries(
          RATE_FIELDS.map((f) => [f.key, centsToInput(supersedes[f.key])]),
        ) as RateText)
      : emptyRates(),
  );
  const [labor, setLabor] = useState<Record<LaborKey, string>>({
    laborShareRhc: supersedes?.laborShareRhc ?? "",
    laborShareChc: supersedes?.laborShareChc ?? "",
    laborShareIrc: supersedes?.laborShareIrc ?? "",
    laborShareGip: supersedes?.laborShareGip ?? "",
  });
  const [effectiveFrom, setEffectiveFrom] = useState(
    supersedes?.effectiveFrom ?? `${fiscalYearStarting}-10-01`,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { tone: "error"; text: string } | { tone: "saved"; warnings: string[] } | null
  >(null);

  const cents = useMemo(
    () =>
      Object.fromEntries(
        RATE_FIELDS.map((f) => [f.key, rates[f.key].trim() ? dollarsToCents(rates[f.key]) : null]),
      ) as Record<RateKey, number | null>,
    [rates],
  );
  const comparison = reference ? compareToReference(cents, reference, hqrpCompliant) : null;

  const prefill = useCallback(() => {
    if (!reference) return;
    const column = referenceColumn(reference, hqrpCompliant);
    setRates(
      Object.fromEntries(RATE_FIELDS.map((f) => [f.key, centsToInput(column[f.key])])) as RateText,
    );
  }, [reference, hqrpCompliant]);

  const invalid = RATE_FIELDS.filter((f) => cents[f.key] === null);

  async function save(): Promise<void> {
    if (invalid.length > 0) {
      setResult({
        tone: "error",
        text: `Enter a dollar amount for ${invalid.map((f) => f.label).join(", ")}.`,
      });
      return;
    }
    setBusy(true);
    setResult(null);
    const body = {
      providerEntityId,
      fiscalYearStarting,
      effectiveFrom,
      ...Object.fromEntries(RATE_FIELDS.map((f) => [f.key, cents[f.key]])),
      ...labor,
      hqrpCompliant,
      ...(reason.trim() ? { entryReason: reason.trim() } : {}),
    };
    const init = { params: { header: { "Idempotency-Key": crypto.randomUUID() } }, body };
    const res = (
      supersedes
        ? await client.POST("/api/v1/billing/rate-tables/{id}/supersede", {
            ...init,
            params: { ...init.params, path: { id: supersedes.rateTableId } },
          } as never)
        : await client.POST("/api/v1/billing/rate-tables", init as never)
    ) as {
      data?: { nationalReferenceWarnings?: string[] };
      error?: { message?: string };
      response?: Response;
    };
    setBusy(false);
    if (res.error) {
      const status = res.response?.status;
      setResult({
        tone: "error",
        text:
          status === 409
            ? "These dates overlap a live version for this provider entity — supersede it instead."
            : status === 422
              ? (res.error.message ?? "The server rejected the rates as invalid.")
              : status === 403
                ? "Not permitted — entering rates needs billing.rate_table.admin for this provider entity."
                : "The rates could not be saved.",
      });
      return;
    }
    setResult({ tone: "saved", warnings: res.data?.nationalReferenceWarnings ?? [] });
    onSaved();
  }

  const label = fiscalYearLabel(fiscalYearStarting);
  return (
    <aside
      className="wx-admission-drawer"
      aria-label={supersedes ? "Supersede rates" : "Enter rates"}
    >
      <DrawerHead
        icon="pencil"
        title={supersedes ? `Correct ${label} rates` : `Enter ${label} rates`}
        subtitle="Pre-wage-index national amounts · append-only"
        onClose={onClose}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <h3>HQRP status for {label}</h3>
          <fieldset className="wx-segmented" aria-label="HQRP compliance">
            <Button
              size="sm"
              tone={hqrpCompliant ? "primary" : "secondary"}
              aria-pressed={hqrpCompliant}
              onClick={() => setHqrpCompliant(true)}
            >
              HQRP compliant
            </Button>
            <Button
              size="sm"
              tone={hqrpCompliant ? "secondary" : "primary"}
              aria-pressed={!hqrpCompliant}
              onClick={() => setHqrpCompliant(false)}
            >
              Not compliant
            </Button>
          </fieldset>
          <p className="wx-source-line">
            {reference
              ? `${reference.fiscalYearLabel}: +${reference.paymentUpdatePct}% update; a hospice that failed HQRP reporting gets ${nonCompliantUpdatePct(reference)}% (−${reference.hqrpReductionPctPoints} percentage points).`
              : "A hospice that failed HQRP reporting is paid 4 percentage points less (42 CFR 418.306(b)(2))."}
          </p>
          <Button tone="secondary" disabled={!reference} onClick={prefill}>
            <Glyph name="download" size={15} /> Prefill from CMS national {label} rates
          </Button>
          {!reference ? (
            <p className="wx-row-sub">No CMS national rates are on file for {label}.</p>
          ) : null}
        </section>

        <section className="wx-drawer-card">
          <h3>Base rates</h3>
          <div className="wx-rate-grid">
            {RATE_FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={
                  <>
                    {f.label} <span className="wx-muted-code">{f.revenueCode}</span>
                  </>
                }
                inputMode="decimal"
                value={rates[f.key]}
                onChange={(e) => setRates({ ...rates, [f.key]: e.target.value })}
                error={
                  rates[f.key].trim() && cents[f.key] === null ? "Dollars, e.g. 236.33" : undefined
                }
                hint={
                  reference &&
                  cents[f.key] !== null &&
                  cents[f.key] !== referenceColumn(reference, hqrpCompliant)[f.key]
                    ? `CMS ${centsToDollars(referenceColumn(reference, hqrpCompliant)[f.key])}`
                    : undefined
                }
              />
            ))}
          </div>
          {comparison && comparison.filled > 0 && comparison.mismatches.length > 0 ? (
            <InlineAlert tone="warning">
              {comparison.matchesOtherColumn
                ? hqrpCompliant
                  ? `These are the ${reference?.fiscalYearLabel} NON-compliant national rates, but the provider is marked HQRP compliant. Check the status or the rates.`
                  : `These are the ${reference?.fiscalYearLabel} compliant national rates, but the provider is marked not compliant — it is paid ${reference?.hqrpReductionPctPoints} percentage points less.`
                : `${comparison.mismatches.length} rate${comparison.mismatches.length === 1 ? " differs" : "s differ"} from the ${reference?.fiscalYearLabel} ${hqrpCompliant ? "compliant" : "non-compliant"} national rates: ${comparison.mismatches.map((m) => `${m.label} ${centsToDollars(m.enteredCents)} vs ${centsToDollars(m.referenceCents)}`).join("; ")}. You can still save.`}
            </InlineAlert>
          ) : comparison && comparison.filled === RATE_FIELDS.length ? (
            <InlineAlert tone="success">
              Matches the {reference?.fiscalYearLabel}{" "}
              {hqrpCompliant ? "compliant" : "non-compliant"} national rates.
            </InlineAlert>
          ) : null}
        </section>

        <section className="wx-drawer-card">
          <h3>Labor shares and dates</h3>
          <div className="wx-rate-grid">
            {LABOR_KEYS.map((k) => (
              <TextField
                key={k}
                label={LABOR_LABEL[k]}
                inputMode="decimal"
                placeholder="0.6600"
                value={labor[k]}
                onChange={(e) => setLabor({ ...labor, [k]: e.target.value })}
              />
            ))}
            <TextField
              label="Effective from"
              type="date"
              value={effectiveFrom}
              min={`${fiscalYearStarting}-10-01`}
              max={`${fiscalYearStarting + 1}-09-30`}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>
          <p className="wx-source-line">
            Labor shares are the CMS-published share per level of care the wage index adjusts; enter
            them from the final rule.
          </p>
          <TextAreaField
            label={supersedes ? "Reason for the correction" : "Note (optional)"}
            value={reason}
            rows={2}
            onChange={(e) => setReason(e.target.value)}
          />
        </section>

        {result?.tone === "error" ? <InlineAlert tone="error">{result.text}</InlineAlert> : null}
        {result?.tone === "saved" ? (
          <InlineAlert tone={result.warnings.length > 0 ? "warning" : "success"}>
            {result.warnings.length > 0
              ? `Saved with ${result.warnings.length} reference warning${result.warnings.length === 1 ? "" : "s"}: ${result.warnings.join(" ")}`
              : "Saved. The rates match the CMS national reference."}
          </InlineAlert>
        ) : null}
        <Button loading={busy} disabled={busy} onClick={() => void save()}>
          {supersedes ? "Supersede version" : "Save rates"}
        </Button>
      </div>
    </aside>
  );
}
