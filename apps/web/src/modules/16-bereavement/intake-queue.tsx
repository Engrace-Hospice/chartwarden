// apps/web/src/modules/16-bereavement — the INTAKE QUEUE (§5.1 #4) with the §5.1 #5 volunteer-assignment
// modal. Track B / ADR-0030. Spec: docs/design/screens/clinical — "Use Worklist."
//
// Plans in `eligible` awaiting a counselor. Both assignment ceremonies live HERE rather than as separate
// registry entries because each one needs the plan row `version` this screen already read for its
// `If-Match` — a modal that had to re-read the row could act on a version that moved in between.
//
// D18 — an external-source plan carries the "PENDING MEDICAL DIRECTOR COSIGN" banner and a DISABLED
// first-contact button, but its ASSIGNMENT buttons stay live: the cosign gates contacting the family, not
// staffing the plan. Locking assignment too would leave the coordinator unable to do the one thing they
// can legitimately do while the cosign is outstanding.
//
// §5.1 #5's "live `volunteer_gates_satisfied` status" is NOT rendered as a pre-flight badge: M16 publishes
// no route that reads M15's 418.78 gate status for one volunteer, so the honest surface is to attempt the
// assignment and render the server's refusal verbatim. A green badge this screen could only have guessed
// at would be worse than the server's actual answer.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type BereavementPlanStatus,
  type PlanListItem,
  assignCounselor,
  assignVolunteer,
  errorMessage,
  listPlans,
} from "./bereavement-api";
import { PLAN_STATUS_TONE, humanize, shortDate, shortId, toneOf } from "./bereavement-status";
import {
  Field,
  Modal,
  Notice,
  RiskTierPill,
  TextField,
  alertStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  primaryButtonStyle,
} from "./bereavement-ui";

const STATUSES = [
  { value: "eligible", label: "Eligible — awaiting counselor" },
  { value: "initiating", label: "Initiating — awaiting roster" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

type Ceremony = { plan: PlanListItem; kind: "counselor" | "volunteer" } | null;
type RiskFilter = "all" | "low" | "moderate" | "high" | "complicated" | "unscored" | "withheld";

const INTAKE_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const thStyle: CSSProperties = {
  padding: "0.625rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
};

const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
};

const drawerGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0.75rem",
};

const drawerActionStyle: CSSProperties = {
  ...ghostButtonStyle,
  display: "flex",
  justifyContent: "center",
};

export function BereavementIntakeQueue(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState("eligible");
  const [rows, setRows] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // `status` is always one of the closed vocabulary the SelectField below offers.
    const { page, error: err } = await listPlans(client, {
      status: status as BereavementPlanStatus,
      limit: 100,
    });
    if (err) {
      setError(errorMessage(err, "The bereavement intake queue could not be loaded."));
      setLoading(false);
      return;
    }
    setRows(page?.data ?? []);
    setLoading(false);
  }, [client, status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const pendingCosign = rows.filter((r) => r.externalSourceCosignPending);

  const hasActiveFilters = searchQuery !== "" || riskFilter !== "all";
  const filteredRows = rows.filter((r) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      shortId(r.planId).toLowerCase().includes(q) ||
      r.planId.toLowerCase().includes(q) ||
      shortDate(r.deathDate).toLowerCase().includes(q);
    const matchesRisk =
      riskFilter === "all" ||
      (riskFilter === "unscored" && r.currentRiskTier === null) ||
      (riskFilter === "withheld" && r.currentRiskTier === undefined) ||
      r.currentRiskTier === riskFilter;
    return matchesSearch && matchesRisk;
  });
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const selectedPlan = rows.find((r) => r.planId === selectedPlanId) ?? null;

  const clearFilters = (): void => {
    setSearchQuery("");
    setRiskFilter("all");
    setPage(1);
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Bereavement intake"
            breadcrumb="Bereavement / Eligible"
            actions={
              <Link to="/bereavement/supervisor" style={ghostButtonStyle}>
                Program rollups
              </Link>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Assign counselors and volunteers while preserving server-side version and compliance
              gates.
            </div>
          </PageHeader>
        }
        filters={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              padding: "0 1.5rem 0.75rem",
            }}
          >
            {pendingCosign.length > 0 ? (
              <Notice tone="warning">
                PENDING MEDICAL DIRECTOR COSIGN —{" "}
                {pendingCosign.length === 1
                  ? "one plan in this queue"
                  : `${pendingCosign.length} plans in this queue`}{" "}
                came from an external (HL7 ADT) death notice. You may assign staff now; counselor
                first contact stays refused by the server until the cosign is received.
              </Notice>
            ) : null}

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
              >
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search plans by ID or death date..."
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      setPage(1);
                    }}
                    aria-label="Search bereavement intake plans"
                  />
                </label>

                <label className="wx-filter-field">
                  <span>Status</span>
                  <select
                    className="wx-select"
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      setPage(1);
                      setSelectedPlanId(null);
                    }}
                    aria-label="Filter by intake status"
                    style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                  >
                    {STATUSES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="wx-filter-field">
                  <span>Risk</span>
                  <select
                    className="wx-select"
                    value={riskFilter}
                    onChange={(event) => {
                      setRiskFilter(event.target.value as RiskFilter);
                      setPage(1);
                    }}
                    aria-label="Filter by risk tier"
                  >
                    <option value="all">All</option>
                    <option value="low">Low</option>
                    <option value="moderate">Moderate</option>
                    <option value="high">High</option>
                    <option value="complicated">Complicated</option>
                    <option value="unscored">Not yet scored</option>
                    <option value="withheld">Not disclosed</option>
                  </select>
                </label>

                {hasActiveFilters ? (
                  <Button size="sm" tone="tertiary" onClick={clearFilters}>
                    Clear
                  </Button>
                ) : null}
              </div>

              <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
                {filteredRows.length} of {rows.length} plans
              </span>
            </div>
          </div>
        }
        table={
          rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No plans in this state"
                description="Choose another status or return to program rollups."
              />
            </div>
          ) : filteredRows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No matching plans"
                description="Try adjusting your search criteria or clearing active filters."
                action={
                  <Button tone="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <IntakeTable
                rows={pagedRows}
                selectedPlanId={selectedPlanId}
                onSelectPlan={setSelectedPlanId}
                onAssign={(plan, kind) => setCeremony({ plan, kind })}
              />
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={filteredRows.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={INTAKE_PAGE_SIZES}
                noun="plans"
              />
            </div>
          )
        }
        detail={
          selectedPlan ? (
            <RightDetailPanel
              open={selectedPlan !== null}
              title="Intake Plan"
              onClose={() => setSelectedPlanId(null)}
              hideScrollbar
            >
              <IntakeDrawerContent
                plan={selectedPlan}
                onAssign={(kind) => setCeremony({ plan: selectedPlan, kind })}
              />
            </RightDetailPanel>
          ) : null
        }
        fullPageScroll
      />

      {ceremony ? (
        <AssignModal
          planId={ceremony.plan.planId}
          version={ceremony.plan.version}
          kind={ceremony.kind}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function IntakeTable({
  rows,
  selectedPlanId,
  onSelectPlan,
  onAssign,
}: {
  rows: PlanListItem[];
  selectedPlanId: string | null;
  onSelectPlan: (planId: string) => void;
  onAssign: (plan: PlanListItem, kind: "counselor" | "volunteer") => void;
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
          <th style={{ ...thStyle, width: "21%" }}>Plan</th>
          <th style={{ ...thStyle, width: "13%" }}>Status</th>
          <th style={{ ...thStyle, width: "13%" }}>Risk</th>
          <th style={{ ...thStyle, width: "13%" }}>Death date</th>
          <th style={{ ...thStyle, width: "13%" }}>Counselor</th>
          <th style={{ ...thStyle, width: "13%" }}>Volunteer</th>
          <th style={{ ...thStyle, width: "14%", textAlign: "right" }}>Assign</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const isSelected = selectedPlanId === p.planId;
          return (
            <tr
              key={p.planId}
              {...interactiveRowProps(() => onSelectPlan(p.planId), isSelected, true)}
              className="wx-data-row-interactive"
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                background: isSelected ? "var(--color-primary-tint)" : "transparent",
                cursor: "pointer",
                transition: "background 0.15s ease",
              }}
            >
              <td style={tdStyle}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <Link
                    to={`/bereavement/plans/${p.planId}`}
                    style={{ ...linkStyle, fontWeight: 600 }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {shortId(p.planId)}
                  </Link>
                  {p.externalSourceCosignPending ? (
                    <span style={mutedStyle}>Pending medical-director cosign</span>
                  ) : null}
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill label={humanize(p.status)} tone={toneOf(PLAN_STATUS_TONE, p.status)} />
              </td>
              <td style={tdStyle}>
                <RiskTierPill tier={p.currentRiskTier} />
              </td>
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {shortDate(p.deathDate)}
              </td>
              <td style={{ ...tdStyle, fontFamily: t.fontMono }}>
                {shortId(p.assignedCounselorUserId)}
              </td>
              <td style={{ ...tdStyle, fontFamily: t.fontMono }}>
                {shortId(p.assignedVolunteerUserId)}
              </td>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: not a control — this only stops a
                  click on the assign buttons from ALSO selecting the row. The keyboard path needs
                  no twin, because the row's own handler ignores any key event whose target is not
                  the row itself. */}
              <td
                style={{ ...tdStyle, textAlign: "right" }}
                onClick={(event) => event.stopPropagation()}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.4rem",
                    flexWrap: "wrap",
                  }}
                >
                  <Button size="sm" tone="secondary" onClick={() => onAssign(p, "counselor")}>
                    Counselor
                  </Button>
                  <Button size="sm" tone="secondary" onClick={() => onAssign(p, "volunteer")}>
                    Volunteer
                  </Button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function IntakeDrawerContent({
  plan,
  onAssign,
}: {
  plan: PlanListItem;
  onAssign: (kind: "counselor" | "volunteer") => void;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <StatusPill label={humanize(plan.status)} tone={toneOf(PLAN_STATUS_TONE, plan.status)} />
        <RiskTierPill tier={plan.currentRiskTier} />
      </div>
      <code style={{ fontFamily: t.fontMono, fontSize: "0.75rem", color: t.onSurfaceVariant }}>
        {plan.planId}
      </code>

      <div style={drawerGridStyle}>
        <Field label="Death date" value={shortDate(plan.deathDate)} />
        <Field label="Window ends" value={shortDate(plan.windowEndsAt)} />
        <Field label="Counselor" value={shortId(plan.assignedCounselorUserId)} mono />
        <Field label="Volunteer" value={shortId(plan.assignedVolunteerUserId)} mono />
      </div>

      {plan.externalSourceCosignPending ? (
        <Notice tone="warning">
          First contact stays locked until the medical-director cosign lands.
        </Notice>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <button type="button" style={drawerActionStyle} onClick={() => onAssign("counselor")}>
          Assign counselor
        </button>
        <button type="button" style={drawerActionStyle} onClick={() => onAssign("volunteer")}>
          Assign volunteer
        </button>
        <Link to={`/bereavement/plans/${plan.planId}`} style={drawerActionStyle}>
          Open plan
        </Link>
      </div>
    </div>
  );
}

/** §5.1 #5 — the assignment ceremony (counselor route 3 / volunteer route 4). */
function AssignModal({
  planId,
  version,
  kind,
  onClose,
  onDone,
}: {
  planId: string;
  version: number;
  kind: "counselor" | "volunteer";
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [userId, setUserId] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const at = effectiveAt ? new Date(effectiveAt).toISOString() : undefined;
    const { error: err } =
      kind === "counselor"
        ? await assignCounselor(client, planId, version, {
            counselorUserId: userId,
            effectiveAt: at,
          })
        : await assignVolunteer(client, planId, version, {
            volunteerUserId: userId,
            effectiveAt: at,
          });
    setBusy(false);
    if (err) {
      setError(
        errorMessage(
          err,
          kind === "volunteer"
            ? "The volunteer could not be assigned. The 42 CFR §418.78 compliance gates are evaluated by the server; a refusal here means a gate is not satisfied."
            : "The counselor could not be assigned.",
        ),
      );
      return;
    }
    onDone();
  };

  return (
    <Modal
      title={kind === "counselor" ? "Assign bereavement counselor" : "Assign bereavement volunteer"}
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || !userId}
          onClick={submit}
        >
          {busy ? "Assigning…" : "Assign"}
        </button>
      }
    >
      <span style={mutedStyle}>
        Plan {shortId(planId)} · read at version {version}. The assignment is applied with
        `If-Match`; if the plan moved under you the server answers 412 and nothing is written.
      </span>
      <TextField
        label={kind === "counselor" ? "Counselor membership id" : "Volunteer membership id"}
        value={userId}
        onChange={setUserId}
        placeholder="00000000-0000-0000-0000-000000000000"
      />
      <TextField
        label="Effective at (optional)"
        type="datetime-local"
        value={effectiveAt}
        onChange={setEffectiveAt}
      />
      {kind === "volunteer" ? (
        <Notice tone="info">
          The volunteer's 42 CFR §418.78(b)/(d) gates are checked by the server through Module 15's
          compliance seam. This screen does not pre-judge them — a refusal below is the real gate
          answer.
        </Notice>
      ) : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
