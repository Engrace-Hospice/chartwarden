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
// apps/web/src/modules/23-billing-medicare — HOSPICE WAGE INDEX (M23 F-211; GAP-125). The tenant-entered CMS hospice
// wage index `POST /claims/assemble` prices from, per CCN + federal fiscal year. Built on the Hospice Rates screen's
// layout (rate-tables.tsx: the billing tab bar, a filter panel, KPI tiles, the flat list table and the right-hand
// admissions drawer for the selected value).
//
//   GET  /api/v1/billing/wage-indexes?ccn=&fiscalYearStarting=&includeSuperseded=true — list + history
//   POST /api/v1/billing/wage-indexes                                                  — enter (201)
//   POST /api/v1/billing/wage-indexes/:id/supersede                                    — append-only correction (201)
//
// Reads gate billing.wage_index.read; writes gate billing.wage_index.admin + the §D13 AI block + an Idempotency-Key.
// The server is the only authz point (ADR-0030): hiding the write buttons from a reader is a UX cue, nothing more.
// The factor travels as a decimal STRING ("1.0342"), never a float — the server rejects a JSON number outright.
// `GET /wage-indexes/effective` and `GET /wage-indexes/:id` are not called: the list (with history) already holds
// every row the drawer shows, and which value is live is the `supersededAt === null` row.
// The platform-shared CMS file load (`POST /api/v1/admin/billing/wage-indexes/load`) is a platform-admin action: it
// lives in the Platform-Ops console (apps/admin/src/modules/23-billing-medicare/wage-index-load.tsx), not here.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import { fiscalYearLabel, fiscalYearStartingOf } from "./rate-reference";
import {
  type DraftErrors,
  EMPTY_DRAFT,
  type WageIndexDraft,
  type WageIndexView,
  bodyFrom,
  draftFrom,
  validateDraft,
  wageIndexReadError,
  wageIndexWriteError,
} from "./wage-index-model";

type DrawerMode =
  | { kind: "view"; id: string }
  | { kind: "enter" }
  | { kind: "supersede"; id: string };

const NOW_FY = fiscalYearStartingOf(new Date());
const FY_YEARS = [NOW_FY + 1, NOW_FY, NOW_FY - 1, NOW_FY - 2];
const FY_OPTIONS = FY_YEARS.map((fy) => ({
  value: String(fy),
  label: `${fiscalYearLabel(fy)} (Oct ${fy} – Sep ${fy + 1})`,
}));
const FY_FILTER_OPTIONS = [{ value: "", label: "All fiscal years" }, ...FY_OPTIONS];

function usDate(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "—";
}

function LivePill({ v }: { v: WageIndexView }): JSX.Element {
  return v.supersededAt ? (
    <StatusPill label="Superseded" tone="neutral" />
  ) : (
    <StatusPill label="Live" tone="success" />
  );
}

interface Filter {
  readonly ccn: string;
  readonly fy: string;
}

export function WageIndexes(): JSX.Element {
  const client = useApiClient();
  const canAdmin = useSession()?.permissions?.includes("billing.wage_index.admin") ?? false;
  const [ccnInput, setCcnInput] = useState("");
  const [fyInput, setFyInput] = useState("");
  const [filter, setFilter] = useState<Filter>({ ccn: "", fy: "" });
  const [rows, setRows] = useState<WageIndexView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the read after a save.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const res = await client.GET("/api/v1/billing/wage-indexes", {
        params: {
          query: {
            includeSuperseded: true,
            ...(filter.ccn ? { ccn: filter.ccn } : {}),
            ...(filter.fy ? { fiscalYearStarting: Number(filter.fy) } : {}),
          },
        },
      });
      if (!active) return;
      if (res.error) {
        setError(wageIndexReadError(res.response?.status));
        setRows([]);
      } else {
        setRows(res.data?.wageIndexes ?? []);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, filter, reloadKey]);

  const all = rows ?? [];
  const live = useMemo(() => all.filter((v) => v.supersededAt === null), [all]);
  const selected =
    drawer && drawer.kind !== "enter"
      ? (all.find((v) => v.wageIndexId === drawer.id) ?? null)
      : null;
  const hasDrawer = drawer !== null && (drawer.kind === "enter" || selected !== null);
  const onSaved = (): void => setReloadKey((k) => k + 1);

  return (
    <div className={`wx-rates${hasDrawer ? " has-drawer" : ""}`}>
      <div className="wx-rates-main">
        <header className="wx-page-head">
          <div>
            <h1>Wage Index</h1>
            <p>
              The CMS hospice wage index per CCN and federal fiscal year, keyed from the published
              table. Claim assembly adjusts the labor share of each rate by the live value.
            </p>
          </div>
          {canAdmin ? (
            <Button onClick={() => setDrawer({ kind: "enter" })}>
              <Glyph name="plus" size={16} /> Enter wage index
            </Button>
          ) : null}
        </header>

        <BillingTabs />

        <form
          className="wx-filter-panel"
          onSubmit={(e) => {
            e.preventDefault();
            setDrawer(null);
            setFilter({ ccn: ccnInput.trim().toUpperCase(), fy: fyInput });
          }}
        >
          <div className="wx-rates-pe">
            <TextField
              label="Filter by CCN"
              value={ccnInput}
              maxLength={6}
              placeholder="e.g. 381588"
              onChange={(e) => setCcnInput(e.target.value)}
            />
          </div>
          <SelectField
            label="Fiscal year"
            value={fyInput}
            options={FY_FILTER_OPTIONS}
            onChange={(e) => setFyInput(e.target.value)}
          />
          <Button type="submit" tone="secondary">
            Apply
          </Button>
        </form>

        <div className="wx-stat-grid" aria-label="Wage index summary">
          <KpiCard
            icon="calendar-check"
            label="Live values"
            value={rows ? String(live.length) : "—"}
            detail="One per CCN and fiscal year"
            accentColor={live.length > 0 ? t.success : undefined}
          />
          <KpiCard
            icon="building"
            label="CCNs"
            value={rows ? String(new Set(live.map((v) => v.ccn)).size) : "—"}
            detail="With a live value"
          />
          <KpiCard
            icon="clipboard-list"
            label="Superseded"
            value={rows ? String(all.length - live.length) : "—"}
            detail="Corrections kept as history"
          />
        </div>

        {loading && rows === null ? (
          <LoadingSpinner />
        ) : error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Wage indexes unavailable" description={error} />
            <Button tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          </div>
        ) : all.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title="No wage indexes"
              description="Claims for a CCN cannot be wage-adjusted until its fiscal-year wage index is entered."
            />
          </div>
        ) : (
          <WageIndexTable
            rows={all}
            selectedId={selected?.wageIndexId ?? null}
            onSelect={(id) => setDrawer({ kind: "view", id })}
          />
        )}
      </div>

      {drawer?.kind === "enter" ? (
        <WageIndexEntryDrawer key="enter" onClose={() => setDrawer(null)} onSaved={onSaved} />
      ) : drawer?.kind === "supersede" && selected ? (
        <WageIndexEntryDrawer
          key={`sup-${selected.wageIndexId}`}
          supersedes={selected}
          onClose={() => setDrawer({ kind: "view", id: selected.wageIndexId })}
          onSaved={onSaved}
        />
      ) : selected ? (
        <WageIndexDrawer
          value={selected}
          canSupersede={canAdmin && selected.supersededAt === null}
          onSupersede={() => setDrawer({ kind: "supersede", id: selected.wageIndexId })}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </div>
  );
}

function WageIndexTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: WageIndexView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Wage-index values</caption>
        <thead>
          <tr>
            <th scope="col">CCN</th>
            <th scope="col">Fiscal year</th>
            <th scope="col">CBSA</th>
            <th scope="col" className="wx-num-col">
              Wage index
            </th>
            <th scope="col">Entered</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const isSelected = v.wageIndexId === selectedId;
            return (
              <tr
                key={v.wageIndexId}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(() => onSelect(v.wageIndexId), isSelected)}
              >
                <td>
                  <span className="wx-row-title wx-data-md">{v.ccn}</span>
                </td>
                <td className="wx-nums">{fiscalYearLabel(v.fiscalYearStarting)}</td>
                <td className="wx-nums">{v.cbsaCode ?? "—"}</td>
                <td className="wx-nums wx-num-col">{v.factorDecimal}</td>
                <td className="wx-nums">{usDate(v.createdAt)}</td>
                <td>
                  <LivePill v={v} />
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

function WageIndexDrawer({
  value: v,
  canSupersede,
  onSupersede,
  onClose,
}: {
  value: WageIndexView;
  canSupersede: boolean;
  onSupersede: () => void;
  onClose: () => void;
}): JSX.Element {
  const title = `CCN ${v.ccn} · ${fiscalYearLabel(v.fiscalYearStarting)}`;
  return (
    <aside className="wx-admission-drawer" aria-label={title}>
      <DrawerHead
        icon="receipt"
        title={title}
        subtitle={`Wage index ${v.factorDecimal}${v.cbsaCode ? ` · CBSA ${v.cbsaCode}` : ""}`}
        onClose={onClose}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Wage index</h3>
            <LivePill v={v} />
          </div>
          <dl className="wx-kv">
            <dt>CCN</dt>
            <dd className="wx-data-md">{v.ccn}</dd>
            <dt>Fiscal year</dt>
            <dd className="wx-nums">
              {fiscalYearLabel(v.fiscalYearStarting)} (Oct {v.fiscalYearStarting} – Sep{" "}
              {v.fiscalYearStarting + 1})
            </dd>
            <dt>CBSA</dt>
            <dd className="wx-nums">{v.cbsaCode ?? "Not entered"}</dd>
            <dt>Factor</dt>
            <dd className="wx-nums">
              <span className="wx-locked-amount">
                {v.factorDecimal} <Glyph name="lock" size={12} />
              </span>
            </dd>
            <dt>Source</dt>
            <dd>{v.sourceReference}</dd>
            {v.entryReason ? (
              <>
                <dt>Note</dt>
                <dd>{v.entryReason}</dd>
              </>
            ) : null}
            {v.supersededAt ? (
              <>
                <dt>Superseded</dt>
                <dd className="wx-nums">{usDate(v.supersededAt)}</dd>
              </>
            ) : null}
          </dl>
          <p className="wx-source-line">
            <Glyph name="lock" size={12} /> Append-only · entered {usDate(v.createdAt)}
          </p>
        </section>
        {canSupersede ? (
          <Button tone="secondary" onClick={onSupersede}>
            <Glyph name="pencil" size={15} /> Supersede with a corrected value
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

function WageIndexEntryDrawer({
  supersedes,
  onClose,
  onSaved,
}: {
  supersedes?: WageIndexView;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<WageIndexDraft>(
    supersedes ? draftFrom(supersedes) : EMPTY_DRAFT,
  );
  const [fy, setFy] = useState(supersedes?.fiscalYearStarting ?? NOW_FY);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const set = (key: keyof WageIndexDraft) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function save(): Promise<void> {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setResult(null);
      return;
    }
    setBusy(true);
    setResult(null);
    const body = bodyFrom(draft, fy);
    const header = { "Idempotency-Key": crypto.randomUUID() };
    const res = supersedes
      ? await client.POST("/api/v1/billing/wage-indexes/{id}/supersede", {
          params: { header, path: { id: supersedes.wageIndexId } },
          body,
        })
      : await client.POST("/api/v1/billing/wage-indexes", { params: { header }, body });
    setBusy(false);
    if (res.error) {
      setResult({ tone: "error", text: wageIndexWriteError(res.response?.status, res.error) });
      return;
    }
    setResult({
      tone: "success",
      text: supersedes
        ? "Saved. The corrected value is now live; the old one is kept as history."
        : "Saved. Claim assembly prices this CCN and fiscal year from the new value.",
    });
    onSaved();
  }

  const title = supersedes ? "Supersede wage index" : "Enter wage index";
  return (
    <aside className="wx-admission-drawer" aria-label={title}>
      <DrawerHead
        icon="pencil"
        title={title}
        subtitle="CMS hospice wage index · append-only"
        onClose={onClose}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <h3>Value</h3>
          <div className="wx-rate-grid">
            <TextField
              label="CCN"
              value={draft.ccn}
              maxLength={6}
              disabled={Boolean(supersedes)}
              error={errors.ccn}
              onChange={(e) => set("ccn")(e.target.value)}
            />
            <SelectField
              label="Fiscal year"
              value={String(fy)}
              disabled={Boolean(supersedes)}
              options={
                supersedes && !FY_YEARS.includes(fy)
                  ? [...FY_OPTIONS, { value: String(fy), label: fiscalYearLabel(fy) }]
                  : FY_OPTIONS
              }
              onChange={(e) => setFy(Number(e.target.value))}
            />
            <TextField
              label="Wage index (factor)"
              inputMode="decimal"
              placeholder="1.0342"
              value={draft.factorDecimal}
              error={errors.factorDecimal}
              onChange={(e) => set("factorDecimal")(e.target.value)}
            />
            <TextField
              label="CBSA (optional)"
              inputMode="numeric"
              maxLength={5}
              value={draft.cbsaCode}
              error={errors.cbsaCode}
              onChange={(e) => set("cbsaCode")(e.target.value)}
            />
          </div>
          <TextField
            label="Source reference"
            placeholder="CMS FY wage index table / Federal Register notice"
            value={draft.sourceReference}
            error={errors.sourceReference}
            onChange={(e) => set("sourceReference")(e.target.value)}
          />
          <TextAreaField
            label={supersedes ? "Reason for the correction" : "Note (optional)"}
            value={draft.entryReason}
            rows={2}
            onChange={(e) => set("entryReason")(e.target.value)}
          />
          <p className="wx-source-line">
            Key the value exactly as published, up to four decimal places. A correction supersedes
            the live value; nothing is edited in place.
          </p>
        </section>
        {result?.tone === "error" ? <InlineAlert tone="error">{result.text}</InlineAlert> : null}
        {result?.tone === "success" ? (
          <InlineAlert tone="success">{result.text}</InlineAlert>
        ) : null}
        <Button loading={busy} disabled={busy} onClick={() => void save()}>
          {supersedes ? "Supersede value" : "Save wage index"}
        </Button>
      </div>
    </aside>
  );
}
