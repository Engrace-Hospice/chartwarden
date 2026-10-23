// apps/web/src/modules/20-field-safety - §5.1 "SUPERVISOR SUBSCRIPTIONS"
// (`/safety/supervisor-subscriptions`, Track B / ADR-0030).
//
// D8's layered paging configuration: who gets woken when a clinician presses SOS, goes overdue, files an
// incident, or walks into a flagged area.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  LocationLookupField,
  MembershipLookupField,
  ProviderEntityLookupField,
} from "../../shell/entity-lookups";
import {
  type SafetySubscriptionAlertKind,
  type SafetySubscriptionScopeKind,
  type SafetySubscriptionView,
  createSubscription,
  deleteSubscription,
  errorMessage,
  listSubscriptions,
} from "./safety-api";
import {
  ALERT_KINDS,
  COVERAGE_GAP_REASON_TONE,
  DEFAULT_SUBSCRIPTION_SCOPE_KIND,
  SUBSCRIPTION_SCOPE_KINDS,
  SUBSCRIPTION_SCOPE_SELECTOR,
  coverageGapLabel,
  dateTime,
  humanize,
  shortId,
  toneOf,
} from "./safety-status";
import {
  ChipMultiSelect,
  Modal,
  Notice,
  SelectField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function SupervisorSubscriptionsScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<SafetySubscriptionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clinicianFilter, setClinicianFilter] = useState("");
  const [supervisorFilter, setSupervisorFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [adding, setAdding] = useState(false);
  const [supervisor, setSupervisor] = useState("");
  const [scopeKind, setScopeKind] = useState(DEFAULT_SUBSCRIPTION_SCOPE_KIND);
  const [clinician, setClinician] = useState("");
  const [locationId, setLocationId] = useState("");
  const [providerEntityId, setProviderEntityId] = useState("");
  // The provider entity that scopes the location picker; it is not part of the row.
  const [locationEntityId, setLocationEntityId] = useState("");
  const [alertKinds, setAlertKinds] = useState<string[]>([...ALERT_KINDS]);
  const [forwarding, setForwarding] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [gaps, setGaps] = useState<{ clinicianMembershipId: string; reason: string }[] | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listSubscriptions(client, {
      limit: 200,
      ...(clinicianFilter.trim() ? { clinicianMembershipId: clinicianFilter.trim() } : {}),
      ...(supervisorFilter.trim() ? { supervisorMembershipId: supervisorFilter.trim() } : {}),
    });
    if (res.error || !res.page) {
      setError(errorMessage(res.error, "The subscription list could not be read."));
      setRows([]);
    } else {
      setRows(res.page.data);
      setError(null);
    }
    setLoading(false);
  }, [client, clinicianFilter, supervisorFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const selector = SUBSCRIPTION_SCOPE_SELECTOR[scopeKind] ?? null;
  const selectorFilled =
    selector === null ||
    (selector === "clinician" && clinician.trim().length > 0) ||
    (selector === "location" && locationId.trim().length > 0) ||
    (selector === "providerEntity" && providerEntityId.trim().length > 0);

  const add = useCallback(async () => {
    setSaving(true);
    setModalError(null);
    const res = await createSubscription(client, {
      supervisorMembershipId: supervisor.trim(),
      scopeKind: scopeKind as SafetySubscriptionScopeKind,
      // Only the selector the chosen scope names: a value left from a previously picked scope must not ride along.
      ...(selector === "clinician" && clinician.trim()
        ? { clinicianMembershipId: clinician.trim() }
        : {}),
      ...(selector === "location" && locationId.trim() ? { locationId: locationId.trim() } : {}),
      ...(selector === "providerEntity" && providerEntityId.trim()
        ? { providerEntityId: providerEntityId.trim() }
        : {}),
      alertKinds: alertKinds as SafetySubscriptionAlertKind[],
      isVacationForwarding: forwarding,
      ...(forwarding && forwardTo.trim()
        ? { vacationForwardToMembershipId: forwardTo.trim() }
        : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The subscription was not created."));
      return;
    }
    setAdding(false);
    await load();
  }, [
    alertKinds,
    client,
    clinician,
    forwardTo,
    forwarding,
    load,
    locationId,
    providerEntityId,
    scopeKind,
    selector,
    supervisor,
  ]);

  const remove = useCallback(
    async (id: string) => {
      const res = await deleteSubscription(client, id);
      if (res.error || !res.result) {
        setError(errorMessage(res.error, "The subscription was not deactivated."));
        return;
      }
      setGaps(res.result.coverageGapsCreated);
      await load();
    },
    [client, load],
  );

  const activePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pagedRows = useMemo(
    () => rows.slice((activePage - 1) * pageSize, activePage * pageSize),
    [activePage, pageSize, rows],
  );
  const activeFilters = [clinicianFilter.trim() !== "", supervisorFilter.trim() !== ""].filter(
    Boolean,
  ).length;

  const clearFilters = (): void => {
    setClinicianFilter("");
    setSupervisorFilter("");
    setPage(1);
  };

  if (loading && rows.length === 0) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="Subscriptions unavailable" description={error} />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Supervisor Subscriptions"
          breadcrumb="Field safety"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/safety" style={linkButtonStyle}>
                Safety board
              </Link>
              <Button
                type="button"
                tone="primary"
                onClick={() => {
                  setModalError(null);
                  setAdding(true);
                }}
              >
                Add subscription
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Ledger of active paging rows. Coverage gaps are reported by the server after
            deactivation.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error} The table below is the last subscription list that answered.
            </Notice>
          ) : null}
          {gaps !== null ? <CoverageGapNotice gaps={gaps} /> : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Subscription ledger</span>
              <strong>Filter by clinician or supervisor membership id</strong>
            </div>
            <div style={controlGroupStyle}>
              <input
                type="text"
                value={clinicianFilter}
                onChange={(event) => {
                  setClinicianFilter(event.target.value);
                  setPage(1);
                }}
                placeholder="Clinician membership id"
                aria-label="Clinician membership id"
                style={monoInputStyle}
              />
              <input
                type="text"
                value={supervisorFilter}
                onChange={(event) => {
                  setSupervisorFilter(event.target.value);
                  setPage(1);
                }}
                placeholder="Supervisor membership id"
                aria-label="Supervisor membership id"
                style={monoInputStyle}
              />
              <Button size="sm" tone="secondary" onClick={() => void load()} loading={loading}>
                Apply
              </Button>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        <div style={tableWrapStyle}>
          {rows.length === 0 ? (
            <div style={{ padding: "2rem 0" }}>
              <EmptyState
                title="No subscription rows"
                description="No supervisor subscription matches this read. Check the filters or add a row before relying on this paging path."
                action={
                  activeFilters > 0 ? (
                    <Button size="sm" tone="secondary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "15%" }}>Supervisor</th>
                    <th style={{ ...thStyle, width: "13%" }}>Scope</th>
                    <th style={{ ...thStyle, width: "18%" }}>Covers</th>
                    <th style={{ ...thStyle, width: "22%" }}>Alert kinds</th>
                    <th style={{ ...thStyle, width: "14%" }}>Forwarding</th>
                    <th style={{ ...thStyle, width: "11%" }}>Added</th>
                    <th style={{ ...thStyle, width: "7%", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <SubscriptionRow key={row.id} row={row} onRemove={remove} />
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={rows.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="subscriptions"
              />
            </>
          )}
          <div role="note" style={noteStyle}>
            <StatusPill label="Ledger only" tone="neutral" />
            <span>
              M20 does not publish the clinician and supervisor rosters needed for a full matrix.
              The server reports coverage gaps when a row is deactivated.
            </span>
          </div>
          {adding ? (
            <Modal
              title="Add a subscription"
              onClose={() => setAdding(false)}
              footer={
                <button
                  type="button"
                  onClick={() => void add()}
                  disabled={
                    saving ||
                    supervisor.trim().length === 0 ||
                    alertKinds.length === 0 ||
                    !selectorFilled ||
                    (forwarding && forwardTo.trim().length === 0)
                  }
                  style={
                    saving ||
                    supervisor.trim().length === 0 ||
                    alertKinds.length === 0 ||
                    !selectorFilled ||
                    (forwarding && forwardTo.trim().length === 0)
                      ? disabledButtonStyle
                      : primaryButtonStyle
                  }
                >
                  {saving ? "Adding..." : "Add subscription"}
                </button>
              }
            >
              <MembershipLookupField
                label="Supervisor"
                value={supervisor}
                onChange={setSupervisor}
                appearance="modal"
              />
              <SelectField
                label="Scope"
                value={scopeKind}
                options={SUBSCRIPTION_SCOPE_KINDS.map((value) => ({
                  value,
                  label: humanize(value),
                }))}
                onChange={setScopeKind}
              />
              {selector === "clinician" ? (
                <MembershipLookupField
                  label="Clinician"
                  value={clinician}
                  onChange={setClinician}
                  appearance="modal"
                  hint="A supervisor may not subscribe to herself."
                />
              ) : null}
              {selector === "location" ? (
                <>
                  <ProviderEntityLookupField
                    label="Provider entity"
                    value={locationEntityId}
                    onChange={(id) => {
                      setLocationEntityId(id);
                      setLocationId("");
                    }}
                    appearance="modal"
                  />
                  <LocationLookupField
                    label="Location"
                    value={locationId}
                    providerEntityId={locationEntityId}
                    onChange={setLocationId}
                    appearance="modal"
                  />
                </>
              ) : null}
              {selector === "providerEntity" ? (
                <ProviderEntityLookupField
                  label="Provider entity"
                  value={providerEntityId}
                  onChange={setProviderEntityId}
                  appearance="modal"
                />
              ) : null}
              {selector === null ? (
                <span style={secondaryTextStyle}>
                  A role-scoped row needs no selector; it covers every clinician the role reaches.
                </span>
              ) : null}
              <ChipMultiSelect
                label="Page this supervisor for"
                values={ALERT_KINDS}
                selected={alertKinds}
                onChange={setAlertKinds}
              />
              {!alertKinds.includes("sos") ? (
                <Notice tone="warning">
                  This row will not page for SOS. Make sure another subscription covers those
                  alerts.
                </Notice>
              ) : null}
              <SelectField
                label="Is this a vacation forward?"
                value={forwarding ? "yes" : "no"}
                options={[
                  { value: "no", label: "No" },
                  { value: "yes", label: "Yes - send pages elsewhere" },
                ]}
                onChange={(value) => setForwarding(value === "yes")}
              />
              {forwarding ? (
                <MembershipLookupField
                  label="Forward to"
                  value={forwardTo}
                  onChange={setForwardTo}
                  appearance="modal"
                  hint="Cannot be the same supervisor."
                />
              ) : null}
              {modalError ? (
                <Notice tone="error" assertive>
                  {modalError}
                </Notice>
              ) : null}
            </Modal>
          ) : null}
        </div>
      }
      fullPageScroll
    />
  );
}

function CoverageGapNotice({
  gaps,
}: {
  gaps: { clinicianMembershipId: string; reason: string }[];
}): JSX.Element {
  if (gaps.length === 0) {
    return (
      <Notice tone="success" live>
        That subscription was deactivated and uncovered nobody.
      </Notice>
    );
  }

  return (
    <Notice tone="error" assertive>
      <strong>
        That deactivation left {gaps.length} clinician{gaps.length === 1 ? "" : "s"} without
        coverage:
      </strong>
      <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
        {gaps.map((gap) => (
          <li key={`${gap.clinicianMembershipId}-${gap.reason}`}>
            <code className="wx-data-md" style={inlineCodeStyle}>
              {shortId(gap.clinicianMembershipId)}
            </code>{" "}
            - {coverageGapLabel(gap.reason)}{" "}
            <StatusPill
              label={humanize(gap.reason)}
              tone={toneOf(COVERAGE_GAP_REASON_TONE, gap.reason)}
            />
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function SubscriptionRow({
  row,
  onRemove,
}: {
  row: SafetySubscriptionView;
  onRemove: (id: string) => Promise<void>;
}): JSX.Element {
  return (
    <tr style={rowStyle}>
      <td style={tdMonoStyle}>{shortId(row.supervisorMembershipId)}</td>
      <td style={tdStyle}>{humanize(row.scopeKind)}</td>
      <td style={tdMonoStyle}>{scopeTarget(row)}</td>
      <td style={tdStyle}>
        <div style={chipListStyle}>
          {row.alertKinds.map((kind) => (
            <StatusPill
              key={kind}
              label={humanize(kind)}
              tone={kind === "sos" ? "critical" : "neutral"}
            />
          ))}
        </div>
      </td>
      <td style={tdStyle}>
        {row.isVacationForwarding ? (
          <div style={primaryCellStyle}>
            <StatusPill label="Forwarded" tone="warning" />
            {row.vacationForwardToMembershipId ? (
              <code className="wx-data-md" style={inlineCodeStyle}>
                {shortId(row.vacationForwardToMembershipId)}
              </code>
            ) : null}
          </div>
        ) : (
          <span style={secondaryTextStyle}>-</span>
        )}
      </td>
      <td style={tdStyle}>{dateTime(row.createdAt)}</td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        <Button size="sm" tone="tertiary" onClick={() => void onRemove(row.id)}>
          Deactivate
        </Button>
      </td>
    </tr>
  );
}

function scopeTarget(row: SafetySubscriptionView): string {
  if (row.clinicianMembershipId) return shortId(row.clinicianMembershipId);
  if (row.locationId) return `location ${shortId(row.locationId)}`;
  if (row.providerEntityId) return `PE ${shortId(row.providerEntityId)}`;
  return "every clinician in role";
}

const actionGroupStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.5rem",
};
const linkButtonStyle = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};
const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const monoInputStyle = {
  minWidth: "15rem",
  height: "2.25rem",
  fontSize: "0.85rem",
  fontFamily: "var(--font-mono)",
};
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const tdMonoStyle = {
  ...tdStyle,
  fontFamily: "var(--font-mono)",
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "flex-start",
  gap: "0.25rem",
  minWidth: 0,
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const inlineCodeStyle = {
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
const chipListStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.375rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  marginTop: "1rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
