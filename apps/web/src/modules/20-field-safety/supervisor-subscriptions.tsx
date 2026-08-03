// apps/web/src/modules/20-field-safety — §5.1 "SUPERVISOR SUBSCRIPTIONS"
// (`/safety/supervisor-subscriptions`, Track B / ADR-0030).
//
// D8's layered paging configuration: who gets woken when a clinician presses SOS, goes overdue, files an
// incident, or walks into a flagged area.
//
// ── §5.1 ASKS FOR A MATRIX; THIS IS A LEDGER, AND THE DIFFERENCE IS NOT COSMETIC ─────────────────────
//
// §5.1 sketches "rows = clinicians, cols = supervisors, click-to-add/remove". A matrix needs a clinician
// roster and a supervisor roster, and M20 publishes NEITHER — M2/M40 own the membership directory and M20
// holds no reader for it. A grid built from the subscription rows alone would have axes made of only the
// people who already appear in one, which is exactly backwards: the whole point of D8 is to find the
// clinician who appears in NO row. That clinician is invisible on such a matrix and is the one the §7.8
// coverage watchdog wakes the DON about.
//
// So the surface is a ledger of the rows that exist, plus the one thing the matrix was for: the
// **coverage gaps the server reports when a row is deactivated**. `DELETE` returns
// `coverageGapsCreated` precisely so the DON learns at the only moment it is cheap to fix.
//
// ── DEACTIVATION SUCCEEDS EVEN WHEN IT UNCOVERS SOMEBODY, AND THAT IS DELIBERATE ─────────────────────
//
// Refusing would leave a departed supervisor's row in place, which is the `all_subscriptions_deactivated`
// failure one step earlier and harder to see. The call goes through and the gaps ride the response; they
// also reach the §7.8 watchdog's own critical alert, so a DON who closed this tab still gets woken.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
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
  Card,
  ChipMultiSelect,
  CountGrid,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./safety-ui";

export function SupervisorSubscriptionsScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<SafetySubscriptionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clinicianFilter, setClinicianFilter] = useState("");
  const [supervisorFilter, setSupervisorFilter] = useState("");

  const [adding, setAdding] = useState(false);
  const [supervisor, setSupervisor] = useState("");
  const [scopeKind, setScopeKind] = useState(DEFAULT_SUBSCRIPTION_SCOPE_KIND);
  const [clinician, setClinician] = useState("");
  const [locationId, setLocationId] = useState("");
  const [providerEntityId, setProviderEntityId] = useState("");
  const [alertKinds, setAlertKinds] = useState<string[]>([...ALERT_KINDS]);
  const [forwarding, setForwarding] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  /** The gaps the LAST deactivation reported — kept on screen until the DON acts or reloads. */
  const [gaps, setGaps] = useState<{ clinicianMembershipId: string; reason: string }[] | null>(null);

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
      // `scopeKind`/`alertKinds` are always drawn from the closed vocabularies the SelectField /
      // checkbox list below offer.
      scopeKind: scopeKind as SafetySubscriptionScopeKind,
      ...(clinician.trim() ? { clinicianMembershipId: clinician.trim() } : {}),
      ...(locationId.trim() ? { locationId: locationId.trim() } : {}),
      ...(providerEntityId.trim() ? { providerEntityId: providerEntityId.trim() } : {}),
      alertKinds: alertKinds as SafetySubscriptionAlertKind[],
      isVacationForwarding: forwarding,
      ...(forwarding && forwardTo.trim() ? { vacationForwardToMembershipId: forwardTo.trim() } : {}),
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

  if (loading) return <LoadingSpinner />;
  if (error && rows.length === 0)
    return <EmptyState title="Subscriptions unavailable" description={error} />;

  const explicit = rows.filter((r) => r.scopeKind === "explicit").length;
  const onVacation = rows.filter((r) => r.isVacationForwarding).length;
  const sosCovering = rows.filter((r) => r.alertKinds.includes("sos")).length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Supervisor subscriptions</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
            <button
              type="button"
              onClick={() => {
                setModalError(null);
                setAdding(true);
              }}
              style={primaryButtonStyle}
            >
              Add a subscription
            </button>
          </div>
        }
      />

      {gaps !== null ? (
        gaps.length === 0 ? (
          <Notice tone="success" live>
            That subscription was deactivated and <strong>uncovered nobody</strong> — the server checked
            every clinician it was the cover for and each still has another.
          </Notice>
        ) : (
          <Notice tone="error" assertive>
            <strong>
              That deactivation left {gaps.length} clinician{gaps.length === 1 ? "" : "s"} with nobody
              watching:
            </strong>
            <ul style={{ margin: `${t.space2} 0 0`, paddingLeft: "1.1rem" }}>
              {gaps.map((g) => (
                <li key={`${g.clinicianMembershipId}-${g.reason}`}>
                  <span style={{ fontFamily: t.fontMono }}>{shortId(g.clinicianMembershipId)}</span> —{" "}
                  {coverageGapLabel(g.reason)}{" "}
                  {/* Every gap reason is a FINDING; none is informational, so each carries its own
                      severity rather than all three reading alike. */}
                  <StatusPill
                    label={humanize(g.reason)}
                    tone={toneOf(COVERAGE_GAP_REASON_TONE, g.reason)}
                  />
                </li>
              ))}
            </ul>
            The deactivation went through anyway, on purpose: refusing it would have left a departed
            supervisor's row in place, which is the same hole one step earlier and much harder to see. Fix
            it now — the §7.8 watchdog will also raise this, but not before somebody presses a button.
          </Notice>
        )
      ) : null}

      <Card title="Rows in force">
        <CountGrid
          entries={[
            { label: "Subscriptions", value: rows.length },
            { label: "Named clinician (explicit)", value: explicit },
            { label: "Cover SOS", value: sosCovering, tone: sosCovering === 0 ? "error" : undefined },
            {
              label: "Vacation-forwarded",
              value: onVacation,
              tone: onVacation > 0 ? "warning" : undefined,
            },
          ]}
        />
        <FilterRow>
          <TextField
            label="Clinician membership id"
            value={clinicianFilter}
            onChange={setClinicianFilter}
            mono
          />
          <TextField
            label="Supervisor membership id"
            value={supervisorFilter}
            onChange={setSupervisorFilter}
            mono
          />
          <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
            Apply
          </button>
        </FilterRow>
      </Card>

      <Card title="Subscriptions">
        {rows.length === 0 ? (
          <Notice tone="error" assertive>
            <strong>No subscription rows at all.</strong> Nobody is configured to be paged for anything.
            An SOS raised right now would resolve to whatever M19's after-hours on-call path returns and
            to nothing else — check this before tonight.
          </Notice>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Supervisor</th>
                <th style={th}>Scope</th>
                <th style={th}>Covers</th>
                <th style={th}>Alert kinds</th>
                <th style={th}>Forwarding</th>
                <th style={th}>Added</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={rowLine}>
                  <td style={tdMono}>{shortId(r.supervisorMembershipId)}</td>
                  <td style={td}>{humanize(r.scopeKind)}</td>
                  <td style={tdMono}>
                    {r.clinicianMembershipId
                      ? shortId(r.clinicianMembershipId)
                      : r.locationId
                        ? `location ${shortId(r.locationId)}`
                        : r.providerEntityId
                          ? `PE ${shortId(r.providerEntityId)}`
                          : "every clinician in the role"}
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                      {r.alertKinds.map((k) => (
                        <StatusPill
                          key={k}
                          label={humanize(k)}
                          tone={k === "sos" ? "critical" : "neutral"}
                        />
                      ))}
                    </div>
                  </td>
                  <td style={td}>
                    {r.isVacationForwarding ? (
                      <>
                        <StatusPill label="Forwarded" tone="warning" />
                        <div style={{ ...mutedStyle, fontFamily: t.fontMono }}>
                          → {shortId(r.vacationForwardToMembershipId)}
                        </div>
                      </>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={td}>{dateTime(r.createdAt)}</td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      style={ghostButtonStyle}
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          Deactivating is a soft stop, never a row delete: §3.7 keeps the paging configuration as evidence
          of who was watching whom on the night an incident happened. A forwarded row still pages — M36
          delivers to the FORWARD target, not to the supervisor who is on a plane.
        </span>
      </Card>

      <Card title="Why this is a ledger and not the matrix §5.1 sketches">
        <span style={mutedStyle}>
          A clinicians × supervisors grid needs both rosters, and M20 publishes neither — M2 and M40 own
          the membership directory and M20 holds no reader for it. A grid built from these rows alone
          would have axes made only of people who already appear in one, so the clinician nobody is
          subscribed to — the entire point of D8 and of the §7.8 watchdog — would be the one name the grid
          cannot show. The coverage-gap report above is that missing axis, delivered at the moment it is
          cheapest to act on.
        </span>
      </Card>

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
              {saving ? "Adding…" : "Add subscription"}
            </button>
          }
        >
          <TextField
            label="Supervisor membership id"
            value={supervisor}
            onChange={setSupervisor}
            mono
          />
          <SelectField
            label="Scope"
            value={scopeKind}
            options={SUBSCRIPTION_SCOPE_KINDS.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setScopeKind}
          />
          {/* Exactly the selector this scope requires is shown — §3.3's `m20_sss_scope_integrity` is the
              authority, and offering all four would invite a row the database refuses. */}
          {selector === "clinician" ? (
            <TextField
              label="Clinician membership id"
              value={clinician}
              onChange={setClinician}
              mono
              hint="A supervisor may not subscribe to herself — the database refuses that pairing outright."
            />
          ) : null}
          {selector === "location" ? (
            <TextField label="Location id" value={locationId} onChange={setLocationId} mono />
          ) : null}
          {selector === "providerEntity" ? (
            <TextField
              label="Provider entity id"
              value={providerEntityId}
              onChange={setProviderEntityId}
              mono
            />
          ) : null}
          {selector === null ? (
            <span style={mutedStyle}>
              A role-scoped row needs no selector — it covers every clinician the role reaches.
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
              This row will <strong>not</strong> page for an SOS. That is a legitimate configuration — a
              compliance officer may want incidents only — but make sure somebody else covers the SOS for
              these clinicians.
            </Notice>
          ) : null}
          <SelectField
            label="Is this a vacation forward?"
            value={forwarding ? "yes" : "no"}
            options={[
              { value: "no", label: "No" },
              { value: "yes", label: "Yes — send these pages to somebody else" },
            ]}
            onChange={(v) => setForwarding(v === "yes")}
          />
          {forwarding ? (
            <TextField
              label="Forward to (membership id)"
              value={forwardTo}
              onChange={setForwardTo}
              mono
              hint="Cannot be the same supervisor — a row that forwards to itself is a page that goes nowhere."
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
  );
}
