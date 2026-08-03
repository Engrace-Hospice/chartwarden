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
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type BereavementPlanStatus,
  type PlanListItem,
  assignCounselor,
  assignVolunteer,
  errorMessage,
  listPlans,
} from "./bereavement-api";
import {
  Card,
  FilterRow,
  Modal,
  Notice,
  RiskTierPill,
  SelectField,
  TextField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./bereavement-ui";
import {
  PLAN_STATUS_TONE,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";

const STATUSES = [
  { value: "eligible", label: "Eligible — awaiting counselor" },
  { value: "initiating", label: "Initiating — awaiting roster" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

type Ceremony = { plan: PlanListItem; kind: "counselor" | "volunteer" } | null;

export function BereavementIntakeQueue(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState("eligible");
  const [rows, setRows] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);

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

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Bereavement intake</span>}
        breadcrumb="Bereavement — plans awaiting assignment"
        actions={
          <Link to="/bereavement/supervisor" style={ghostButtonStyle}>
            Program rollups
          </Link>
        }
      />

      {pendingCosign.length > 0 ? (
        <Notice tone="warning">
          PENDING MEDICAL DIRECTOR COSIGN —{" "}
          {pendingCosign.length === 1 ? "one plan in this queue" : `${pendingCosign.length} plans in this queue`}{" "}
          came from an external (HL7 ADT) death notice. You may assign a counselor and a volunteer now;
          counselor first contact stays refused by the server until the cosign is received.
        </Notice>
      ) : null}

      <FilterRow>
        <SelectField label="Status" value={status} options={STATUSES} onChange={setStatus} />
      </FilterRow>

      <Card title={`Plans — ${humanize(status)}`}>
        {rows.length === 0 ? (
          <span style={mutedStyle}>No bereavement plans are in this state.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Plan</th>
                <th style={th}>Status</th>
                <th style={th}>Death date</th>
                <th style={th}>Window ends</th>
                <th style={th}>Counselor</th>
                <th style={th}>Volunteer</th>
                <th style={th}>Risk</th>
                <th style={th}>Assign</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.planId} style={rowLine}>
                  <td style={td}>
                    <Link to={`/bereavement/plans/${p.planId}`} style={linkStyle}>
                      {shortId(p.planId)}
                    </Link>
                    {p.externalSourceCosignPending ? (
                      <div style={mutedStyle}>Pending medical-director cosign</div>
                    ) : null}
                  </td>
                  <td style={td}>
                    <StatusPill label={humanize(p.status)} tone={toneOf(PLAN_STATUS_TONE, p.status)} />
                  </td>
                  <td style={td}>{shortDate(p.deathDate)}</td>
                  <td style={td}>{shortDate(p.windowEndsAt)}</td>
                  <td style={td}>{shortId(p.assignedCounselorUserId)}</td>
                  <td style={td}>{shortId(p.assignedVolunteerUserId)}</td>
                  <td style={td}>
                    <RiskTierPill tier={p.currentRiskTier} />
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() => setCeremony({ plan: p, kind: "counselor" })}
                      >
                        Counselor
                      </button>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() => setCeremony({ plan: p, kind: "volunteer" })}
                      >
                        Volunteer
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

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
        ? await assignCounselor(client, planId, version, { counselorUserId: userId, effectiveAt: at })
        : await assignVolunteer(client, planId, version, { volunteerUserId: userId, effectiveAt: at });
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
        <button type="button" style={primaryButtonStyle} disabled={busy || !userId} onClick={submit}>
          {busy ? "Assigning…" : "Assign"}
        </button>
      }
    >
      <span style={mutedStyle}>
        Plan {shortId(planId)} · read at version {version}. The assignment is applied with `If-Match`; if
        the plan moved under you the server answers 412 and nothing is written.
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
          compliance seam. This screen does not pre-judge them — a refusal below is the real gate answer.
        </Notice>
      ) : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
