// apps/web/src/modules/23-billing-medicare — the BILLING WORK QUEUE (Billing Home): claims that need a person, NOE/NOTR
// notices in their filing window and DDE items, in one list ordered by what is most urgent, with the next step for each.
// It only reads. Every action is a link into the screen that already owns it (the claim editor, the notice detail, the
// DDE queue), so version checks (If-Match), step-up, reason capture and permissions stay exactly where they are. Each
// source is read on its own: a source that failed or was refused says so and shows "—", never 0, and "Nothing needs
// attention" appears only when every source answered. A notice and the DDE item that files it are one row.
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
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { fmtDay } from "./dde-queue-model";
import { patientLabel, usePatientNames } from "./use-patient-names";
import { type WorkQueueSources, useWorkQueueSources } from "./use-work-queue-sources";
import {
  type SourceState,
  type Urgency,
  type WorkItem,
  buildWorkItems,
  countLabel,
} from "./work-queue-model";

type TypeFilter = "all" | "claim" | "noe" | "notr" | "dde";
const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All work" },
  { value: "claim", label: "Claims" },
  { value: "noe", label: "NOE" },
  { value: "notr", label: "NOTR" },
  { value: "dde", label: "DDE" },
];

const SOURCE_NOUN: Record<keyof WorkQueueSources, string> = {
  claims: "claims",
  noe: "NOE notices",
  notr: "NOTR notices",
  dde: "DDE items",
};

const URGENCY_PILL: Partial<Record<Urgency, { label: string; tone: "error" | "warning" }>> = {
  overdue: { label: "Overdue", tone: "error" },
  at_risk: { label: "At risk", tone: "warning" },
};
const isUrgent = (i: WorkItem) => i.urgency === "overdue" || i.urgency === "at_risk";

function matchesType(item: WorkItem, type: TypeFilter): boolean {
  if (type === "all") return true;
  if (type === "dde") return item.dde !== null;
  return item.kind === type;
}

const itemsOf = <T,>(s: SourceState<T>): T[] => (s.status === "ok" ? s.items : []);

export function BillingWorkQueue(): JSX.Element {
  const client = useApiClient();
  const { sources, reload } = useWorkQueueSources(client);
  const [type, setType] = useState<TypeFilter>("all");
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const items = useMemo(
    () =>
      buildWorkItems(
        {
          claims: itemsOf(sources.claims),
          noe: itemsOf(sources.noe),
          notr: itemsOf(sources.notr),
          dde: itemsOf(sources.dde),
        },
        new Date(),
      ),
    [sources],
  );
  const visible = useMemo(
    () => items.filter((i) => matchesType(i, type) && (!urgentOnly || isUrgent(i))),
    [items, type, urgentOnly],
  );
  const selected = visible.find((i) => i.key === selectedKey) ?? null;

  const patientIds = useMemo(
    () => [...new Set(visible.flatMap((i) => (i.patientId ? [i.patientId] : [])))],
    [visible],
  );
  const names = usePatientNames(client, patientIds);
  const nameOf = (i: WorkItem) =>
    i.patientId ? patientLabel(names[i.patientId], i.patientId) : "—";

  const states = Object.entries(sources) as [keyof WorkQueueSources, SourceState<unknown>][];
  const settled = states.every(([, s]) => s.status !== "loading");
  const failed = states.filter(([, s]) => s.status === "error");
  const refused = states.filter(([, s]) => s.status === "denied");

  const clearFilters = () => {
    setType("all");
    setUrgentOnly(false);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Billing Work Queue"
          breadcrumb="Billing"
          actions={
            <Link to="/billing/claims/new" style={ghostButtonStyle}>
              Assemble claim
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Claims, notices and DDE work that needs a person, most urgent first. A notice and the
            DDE item that files it are one row.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <BillingTabs />
          </div>
        </PageHeader>
      }
      kpis={
        <>
          <SourceProblems failed={failed} refused={refused} onRetry={reload} />
          <KpiStrip>
            <SourceCard
              label="Claims"
              source={sources.claims}
              rows={items.filter((i) => i.kind === "claim")}
              quietDetail="need action"
              onSelect={() => setType("claim")}
            />
            <SourceCard
              label="NOE"
              source={sources.noe}
              rows={items.filter((i) => i.kind === "noe")}
              onSelect={() => setType("noe")}
            />
            <SourceCard
              label="NOTR"
              source={sources.notr}
              rows={items.filter((i) => i.kind === "notr")}
              onSelect={() => setType("notr")}
            />
            <SourceCard
              label="DDE items"
              source={sources.dde}
              rows={items.filter((i) => i.dde !== null)}
              onSelect={() => setType("dde")}
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
              onChange={(e) => setType(e.target.value as TypeFilter)}
              style={selectStyle}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wx-filter-field" style={{ flexDirection: "row", gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={urgentOnly}
              onChange={(e) => setUrgentOnly(e.target.checked)}
            />
            <span>At risk or overdue only</span>
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
            anyProblem={failed.length + refused.length > 0}
            hasWork={items.length > 0}
            onClear={clearFilters}
          />
        )
      }
      detail={
        selected ? (
          <RightDetailPanel title="Work item" onClose={() => setSelectedKey(null)} hideScrollbar>
            <WorkItemPanel item={selected} patient={nameOf(selected)} />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

function SourceProblems({
  failed,
  refused,
  onRetry,
}: {
  failed: [keyof WorkQueueSources, SourceState<unknown>][];
  refused: [keyof WorkQueueSources, SourceState<unknown>][];
  onRetry: () => void;
}): JSX.Element | null {
  if (failed.length === 0 && refused.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: "0.5rem", padding: "0 1.5rem" }}>
      {failed.length > 0 ? (
        <div
          role="alert"
          style={{ ...bannerStyle, color: "var(--color-error)", alignItems: "center" }}
        >
          <span>
            {failed.map(([k]) => `${capitalize(SOURCE_NOUN[k])} could not be loaded.`).join(" ")}{" "}
            Counts for them are not shown, and the list may be incomplete.
          </span>
          <Button tone="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {refused.length > 0 ? (
        <output style={bannerStyle}>
          {refused
            .map(([k]) => `You do not have access to ${SOURCE_NOUN[k]}, so they are not shown.`)
            .join(" ")}
        </output>
      ) : null}
    </div>
  );
}

function SourceCard({
  label,
  source,
  rows,
  quietDetail,
  onSelect,
}: {
  label: string;
  source: SourceState<unknown>;
  rows: WorkItem[];
  quietDetail?: string;
  onSelect: () => void;
}): JSX.Element {
  const urgent = rows.filter(isUrgent).length;
  const detail =
    source.status === "loading"
      ? "Loading…"
      : source.status === "error"
        ? "Could not be loaded"
        : source.status === "denied"
          ? "No access"
          : urgent > 0
            ? `${urgent} at risk or overdue`
            : (quietDetail ?? "none at risk");
  return (
    <KpiCard
      label={label}
      value={countLabel(source, rows.length)}
      detail={detail}
      tone={source.status === "ok" && urgent > 0 ? "warning" : "neutral"}
      onSelect={onSelect}
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
          description="Nothing matches the current filters."
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
          description="Some sources could not be read, so this is not a complete picture."
        />
      ) : (
        <EmptyState
          title="Nothing needs attention"
          description="Every source answered and has no claims, notices or DDE items waiting on a person."
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
  rows: WorkItem[];
  nameOf: (i: WorkItem) => string;
  selectedKey: string | null;
  onSelect: (i: WorkItem) => void;
}): JSX.Element {
  return (
    <table
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
          <th style={thStyle}>Patient</th>
          <th style={thStyle}>Work</th>
          <th style={thStyle}>Deadline</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Next step</th>
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
            <td style={tdStyle}>
              <div style={{ display: "grid", gap: "0.25rem" }}>
                <span>{i.what}</span>
                <DdeChips item={i} />
              </div>
            </td>
            <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
              <div style={{ display: "grid", gap: "0.25rem", justifyItems: "start" }}>
                <span>{fmtDay(i.deadlineAt)}</span>
                <UrgencyPill urgency={i.urgency} />
              </div>
            </td>
            <td style={tdStyle}>
              <StatusPill label={i.statusLabel} tone={i.statusTone} />
            </td>
            <td style={tdStyle}>
              <Link
                to={i.href}
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

function UrgencyPill({ urgency }: { urgency: Urgency }): JSX.Element | null {
  const pill = URGENCY_PILL[urgency];
  return pill ? <StatusPill label={pill.label} tone={pill.tone} /> : null;
}

/** Who filed the DDE item is said only once a submission is recorded; before that nothing is claimed. */
function DdeChips({ item }: { item: WorkItem }): JSX.Element | null {
  const dde = item.dde;
  if (!dde) return null;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
      <StatusPill label={`DDE ${dde.stateLabel.toLowerCase()}`} tone="progress" />
      {dde.viaProvider === true ? <StatusPill label="Via provider" tone="progress" /> : null}
      {dde.viaProvider === false ? <StatusPill label="Keyed by hand" tone="neutral" /> : null}
      {dde.inDoubt ? <StatusPill label="Send may have reached DDE" tone="warning" /> : null}
    </span>
  );
}

function WorkItemPanel({ item, patient }: { item: WorkItem; patient: string }): JSX.Element {
  const subjectLabel = item.kind === "claim" ? "Open the claim" : "Open the notice";
  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <Field label="Patient" value={patient} />
      <Field label="Work" value={item.what} />
      <Field
        label="Status"
        value={<StatusPill label={item.statusLabel} tone={item.statusTone} />}
      />
      <Field
        label="Deadline"
        value={
          <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
            {fmtDay(item.deadlineAt)}
            <UrgencyPill urgency={item.urgency} />
          </span>
        }
      />
      {item.dde ? <Field label="DDE" value={<DdeChips item={item} />} /> : null}
      <Field label="Next step" value={item.nextAction} />
      <div style={{ display: "grid", gap: "0.35rem" }}>
        <Link to={item.href} style={primaryLinkStyle}>
          {item.dde ? "Open the DDE item" : subjectLabel}
        </Link>
        {item.dde && item.subjectHref ? (
          <Link to={item.subjectHref} style={{ color: "var(--color-primary)", fontSize: "0.8rem" }}>
            {subjectLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface)" }}>{value}</span>
    </div>
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
const ghostButtonStyle: CSSProperties = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
  fontWeight: 600,
  textDecoration: "none",
};
const primaryLinkStyle: CSSProperties = {
  ...ghostButtonStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  textAlign: "center",
};
