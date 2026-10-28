// apps/web/src/modules/24-billing-medicaid — the MEDICAID WORK QUEUE: claims that need a person (draft, ready, failed
// validation, rejected, timed out, denied, partial) and the org-wide validation worklist, in one list, most stuck first
// and then longest-waiting. Medicaid has no server deadline, so nothing is called "at risk" or "overdue". It only reads:
// every action is a link into the claim screen that owns it, so If-Match, step-up and permissions stay there. A source
// that failed or was refused says so and shows "—", never 0, and "Nothing needs attention" appears only when every
// source answered whole.
import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
import { useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import { patientLabel, usePatientNames } from "../23-billing-medicare/use-patient-names";
import { type SourceState, countLabel } from "../23-billing-medicare/work-queue-model";
import { Field } from "./medicaid-ui";
import { type MedicaidWorkItem, buildMedicaidWork, isUrgentMedicaid } from "./medicaid-work-model";
import { type MedicaidWorkSources, useMedicaidWorkSources } from "./use-medicaid-work-sources";

type TypeFilter = "all" | "blocked" | "denied";
const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All work" },
  { value: "blocked", label: "Blocked by validation" },
  { value: "denied", label: "Denied claims" },
];

const SOURCE_NOUN: Record<keyof MedicaidWorkSources, string> = {
  claims: "Medicaid claims",
  blocked: "the validation worklist",
};

export const itemsOf = <T,>(s: SourceState<T>): T[] => (s.status === "ok" ? s.items : []);

function matchesType(item: MedicaidWorkItem, type: TypeFilter): boolean {
  if (type === "blocked") return item.blocked;
  if (type === "denied") return item.state === "DENIED";
  return true;
}

/** The problems banner shared by the queue and Billing Home: failed sources with a retry, refused sources named. */
export function MedicaidSourceProblems({
  sources,
  onRetry,
}: { sources: MedicaidWorkSources; onRetry: () => void }): JSX.Element | null {
  const states = Object.entries(sources) as [keyof MedicaidWorkSources, SourceState<unknown>][];
  const failed = states.filter(([, s]) => s.status === "error").map(([k]) => SOURCE_NOUN[k]);
  const refused = states.filter(([, s]) => s.status === "denied").map(([k]) => SOURCE_NOUN[k]);
  const paged = states
    .filter(([, s]) => s.status === "ok" && s.hasMore)
    .map(([k]) => SOURCE_NOUN[k]);
  if (failed.length === 0 && refused.length === 0 && paged.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {failed.length > 0 ? (
        <div
          role="alert"
          style={{ ...bannerStyle, color: "var(--color-error)", alignItems: "center" }}
        >
          <span>
            {failed.map((n) => `${capitalize(n)} could not be loaded.`).join(" ")} Counts for them
            are not shown, and the list may be incomplete.
          </span>
          <Button tone="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {refused.length > 0 ? (
        <output style={bannerStyle}>
          {refused.map((n) => `You do not have access to ${n}, so it is not shown.`).join(" ")}
        </output>
      ) : null}
      {paged.length > 0 ? (
        <output style={bannerStyle}>
          {paged.map((n) => capitalize(n)).join(" and ")} have more entries than were loaded, so
          counts show "+" and the list is not complete.
        </output>
      ) : null}
    </div>
  );
}

/** What a source's card says under its count: why there is no count, or how many are stuck. */
export function sourceDetail(source: SourceState<unknown>, stuck: number, quiet: string): string {
  if (source.status === "loading") return "Loading…";
  if (source.status === "error") return "Could not be loaded";
  if (source.status === "denied") return "No access";
  return stuck > 0 ? `${stuck} stuck` : quiet;
}

export function MedicaidWorkQueue(): JSX.Element {
  const client = useApiClient();
  const { sources, reload } = useMedicaidWorkSources(client);
  // The filters live in the URL, so Billing Home links, the "All work" tab, Back/Forward and bookmarks agree.
  const [params, setParams] = useSearchParams();
  const type: TypeFilter = TYPE_OPTIONS.find((o) => o.value === params.get("type"))?.value ?? "all";
  const stuckOnly = params.get("urgent") === "1";
  const setFilters = (nextType: TypeFilter, nextStuck: boolean) => {
    const next = new URLSearchParams();
    if (nextType !== "all") next.set("type", nextType);
    if (nextStuck) next.set("urgent", "1");
    setParams(next, { replace: true });
  };
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const items = useMemo(
    () => buildMedicaidWork({ claims: itemsOf(sources.claims), blocked: itemsOf(sources.blocked) }),
    [sources],
  );
  const visible = useMemo(
    () => items.filter((i) => matchesType(i, type) && (!stuckOnly || isUrgentMedicaid(i))),
    [items, type, stuckOnly],
  );
  const selected = visible.find((i) => i.key === selectedKey) ?? null;

  const patientIds = useMemo(
    () => [...new Set(visible.flatMap((i) => (i.patientId ? [i.patientId] : [])))],
    [visible],
  );
  const names = usePatientNames(client, patientIds);
  const nameOf = (i: MedicaidWorkItem) =>
    i.patientId ? patientLabel(names[i.patientId], i.patientId) : "Unknown patient";

  const states = Object.entries(sources) as [keyof MedicaidWorkSources, SourceState<unknown>][];
  const settled = states.every(([, s]) => s.status !== "loading");
  const anyProblem = states.some(
    ([, s]) => s.status === "error" || s.status === "denied" || (s.status === "ok" && s.hasMore),
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Medicaid Work Queue"
          actions={
            <Link to="/medicaid/billing/claims/new" style={ghostLinkStyle}>
              Assemble claim
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Claims that need a person, most stuck first, then longest waiting. Medicaid has no
            filing deadline, so nothing here is marked overdue.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <MedicaidBillingTabs />
          </div>
        </PageHeader>
      }
      kpis={
        <>
          <MedicaidSourceProblems sources={sources} onRetry={reload} />
          <KpiStrip>
            <KpiCard
              label="Needing action"
              value={countLabel(sources.claims, items.length)}
              detail={sourceDetail(
                sources.claims,
                items.filter(isUrgentMedicaid).length,
                "none stuck",
              )}
              tone={items.some(isUrgentMedicaid) ? "warning" : "neutral"}
              onSelect={() => setFilters("all", false)}
            />
            <KpiCard
              label="Blocked by validation"
              value={countLabel(sources.blocked, items.filter((i) => i.blocked).length)}
              detail={sourceDetail(sources.blocked, 0, "fix the blocking rules")}
              tone={items.some((i) => i.blocked) ? "warning" : "neutral"}
              onSelect={() => setFilters("blocked", stuckOnly)}
            />
            <KpiCard
              label="Denied claims"
              value={countLabel(
                sources.claims,
                items.filter((i) => matchesType(i, "denied")).length,
              )}
              detail={sourceDetail(sources.claims, 0, "see denials")}
              onSelect={() => setFilters("denied", stuckOnly)}
            />
          </KpiStrip>
        </>
      }
      filters={
        <>
          <label className="wx-filter-field">
            <span>Type</span>
            <select
              className="wx-select"
              aria-label="Type"
              value={type}
              onChange={(e) => setFilters(e.target.value as TypeFilter, stuckOnly)}
              style={selectStyle}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              alignSelf: "flex-end",
              fontSize: "0.85rem",
            }}
          >
            <input
              type="checkbox"
              checked={stuckOnly}
              onChange={(e) => setFilters(type, e.target.checked)}
            />
            <span>Stuck claims only</span>
          </label>
        </>
      }
      table={
        visible.length > 0 ? (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <WorkTable
              rows={visible}
              nameOf={nameOf}
              selectedKey={selected?.key ?? null}
              onSelect={(i) => setSelectedKey(i.key)}
            />
          </div>
        ) : (
          <EmptyRegion
            settled={settled}
            anyProblem={anyProblem}
            hasWork={items.length > 0}
            onClear={() => setFilters("all", false)}
          />
        )
      }
      detail={
        selected ? (
          <RightDetailPanel title="Work item" onClose={() => setSelectedKey(null)} hideScrollbar>
            <div style={{ display: "grid", gap: "0.85rem" }}>
              <Field label="Patient" value={nameOf(selected)} />
              <Field label="Work" value={selected.what} />
              <Field
                label="Status"
                value={<StatusPill label={selected.statusLabel} tone={selected.statusTone} />}
              />
              <Field label="Next step" value={selected.nextAction} />
              <Link to={selected.href} style={primaryLinkStyle}>
                {selected.nextAction}
              </Link>
            </div>
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

function EmptyRegion({
  settled,
  anyProblem,
  hasWork,
  onClear,
}: {
  settled: boolean;
  anyProblem: boolean;
  hasWork: boolean;
  onClear: () => void;
}): JSX.Element {
  if (!settled)
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  if (hasWork)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="No matching work"
          description={
            anyProblem
              ? "Nothing loaded matches the current filters, but some sources failed, were refused or have more entries than were loaded."
              : "Nothing matches the current filters."
          }
          action={
            <Button tone="secondary" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          }
        />
      </div>
    );
  return (
    <div style={{ padding: "2rem 1.5rem" }}>
      {anyProblem ? (
        <EmptyState
          title="Nothing to show yet"
          description="Some sources could not be read or have more pages than were loaded, so this is not a complete picture."
        />
      ) : (
        <EmptyState
          title="Nothing needs attention"
          description="Every source answered and no Medicaid claims are waiting on a person."
        />
      )}
    </div>
  );
}

function WorkTable({
  rows,
  nameOf,
  selectedKey,
  onSelect,
}: {
  rows: MedicaidWorkItem[];
  nameOf: (i: MedicaidWorkItem) => string;
  selectedKey: string | null;
  onSelect: (i: MedicaidWorkItem) => void;
}): JSX.Element {
  return (
    <table
      aria-label="Medicaid work"
      style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
    >
      <thead>
        <tr
          style={{
            textAlign: "left",
            color: "var(--color-on-surface-variant)",
            borderBottom:
              "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
            background: "var(--color-surface-low)",
          }}
        >
          <th scope="col" style={thStyle}>
            Patient
          </th>
          <th scope="col" style={thStyle}>
            Work
          </th>
          <th scope="col" style={thStyle}>
            Status
          </th>
          <th scope="col" style={thStyle}>
            Next step
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => (
          <tr
            key={i.key}
            {...interactiveRowProps(() => onSelect(i), i.key === selectedKey, true)}
            className="wx-data-row-interactive"
            style={{
              borderBottom:
                "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
              cursor: "pointer",
              background: i.key === selectedKey ? "var(--color-primary-tint)" : "transparent",
            }}
          >
            <td style={{ ...tdStyle, fontWeight: 600 }}>{nameOf(i)}</td>
            <td style={tdStyle}>{i.what}</td>
            <td style={tdStyle}>
              <span style={{ display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
                <StatusPill label={i.statusLabel} tone={i.statusTone} />
                {i.blocked ? <StatusPill label="Blocked by validation" tone="warning" /> : null}
              </span>
            </td>
            <td style={tdStyle}>
              <Link
                to={i.href}
                aria-label={`${i.nextAction} — ${nameOf(i)}`}
                style={{ color: "var(--color-primary)", fontWeight: 600 }}
                onClick={(event) => event.stopPropagation()}
              >
                {i.nextAction}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const thStyle: CSSProperties = { padding: "0.625rem 0.75rem", fontSize: "0.7rem", fontWeight: 600 };
const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
};
const selectStyle: CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const bannerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.75rem",
  justifyContent: "space-between",
  padding: "0.6rem 0.9rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  fontSize: "0.85rem",
};
const ghostLinkStyle: CSSProperties = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
  fontWeight: 600,
  textDecoration: "none",
};
const primaryLinkStyle: CSSProperties = {
  ...ghostLinkStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  textAlign: "center",
};
