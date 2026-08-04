import { StatusPill, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the VOLUNTEER PLAN VIEW + ASSIGNMENT MODAL (§5.1 #9/#10).
//
// The 42 CFR §418.78 surface over the shared plan spine, plus the coordinator's assignment ledger and the
// gate-checked assignment ceremony.
//
// The §7.4 gate check is the point of this screen. The modal reads the candidate volunteer's LIVE gate
// grid (route 19, status re-derived over the validity window) and shows every failing gate BEFORE the
// write — but the block itself is the server's: route 17 composes `volunteer_compliance_active`, and it is
// composed only when NO documented override is supplied (§8.6). That is why a failing gate here does not
// disable the button: it swaps the ceremony for the audited override path with its ≥40-character reason.
// A frontend that simply greyed the button out would make the spec's audited override unreachable.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  type AssignmentView,
  type GateView,
  type PlanDetail,
  errorMessage,
  listGates,
  writeHeaders,
} from "./discipline-api";
import {
  FAILING_GATE_STATUSES,
  GATE_STATUS_TONE,
  dateTime,
  gateKindLabel,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./discipline-status";
import {
  Card,
  Modal,
  Notice,
  TextAreaField,
  TextField,
  alertStyle,
  ghostButtonStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";
import { DisciplinePlanWorkspace } from "./plan-workspace";

/** §8.6 — the documented-override floor the pure guard enforces server-side. */
const OVERRIDE_REASON_MIN = 40;

function AssignmentModal({
  plan,
  onClose,
  onCreated,
}: { plan: PlanDetail; onClose: () => void; onCreated: () => void }): JSX.Element {
  const client = useApiClient();
  const [volunteerMembershipId, setVolunteer] = useState("");
  const [activities, setActivities] = useState("");
  const [startsAt, setStartsAt] = useState(new Date().toISOString().slice(0, 10));
  const [endsAt, setEndsAt] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [gates, setGates] = useState<GateView[] | null>(null);
  const [gatesError, setGatesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The gate grid is read live as the coordinator types the volunteer id — the same rows route 19 serves.
  useEffect(() => {
    const id = volunteerMembershipId.trim();
    if (id.length < 8) {
      setGates(null);
      setGatesError(null);
      return;
    }
    let active = true;
    (async () => {
      const { page, error: err } = await listGates(client, { volunteerMembershipId: id });
      if (!active) return;
      if (err) {
        setGates(null);
        // A gate read the coordinator cannot make is NOT a pass — say so; the server still blocks.
        setGatesError("The compliance gates for this volunteer could not be read in this session.");
        return;
      }
      setGatesError(null);
      setGates(page?.data ?? []);
    })();
    return () => {
      active = false;
    };
  }, [client, volunteerMembershipId]);

  const failing = (gates ?? []).filter((g) => FAILING_GATE_STATUSES.includes(g.effectiveStatus));
  const needsOverride = failing.length > 0;
  const activityList = activities
    .split("\n")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const canSubmit =
    volunteerMembershipId.trim().length > 0 &&
    activityList.length > 0 &&
    (!needsOverride || overrideReason.trim().length >= OVERRIDE_REASON_MIN) &&
    !busy;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/volunteer-assignments", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        volunteerMembershipId,
        activities: activityList,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt === "" ? null : new Date(endsAt).toISOString(),
        ...(overrideReason.trim() === "" ? {} : { overrideReason }),
      },
    } as never);
    setBusy(false);
    if (res.error) {
      setError(
        errorMessage(
          res.error,
          "The assignment was refused. A volunteer with an unmet 418.78 gate cannot be assigned without a documented override.",
        ),
      );
      return;
    }
    onCreated();
  }

  return (
    <Modal
      title="Assign volunteer"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5 }}
        >
          {busy ? "Assigning…" : needsOverride ? "Assign with override" : "Assign"}
        </button>
      }
    >
      <TextField
        label="Volunteer membership id"
        value={volunteerMembershipId}
        onChange={setVolunteer}
      />

      {gatesError ? <Notice tone="warning">{gatesError}</Notice> : null}
      {gates ? (
        gates.length === 0 ? (
          <Notice tone="error">
            No 418.78 compliance gate is recorded for this volunteer. Every required gate must be
            satisfied before an assignment, or the assignment needs a documented override.
          </Notice>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: t.space2 }}>
            {gates.map((g) => (
              <StatusPill
                key={g.gateId}
                label={`${gateKindLabel(g.gateKind)} · ${humanize(g.effectiveStatus)}`}
                tone={toneOf(GATE_STATUS_TONE, g.effectiveStatus)}
              />
            ))}
          </div>
        )
      ) : null}

      <TextAreaField
        label="Allowable activities (one per line)"
        value={activities}
        onChange={setActivities}
        rows={4}
        hint="Companionship, errands, respite, vigil presence, life review, pet therapy, reading/music. No clinical care, medications, body care, transport, or clinical-document signing."
      />
      <TextField label="Starts" type="date" value={startsAt} onChange={setStartsAt} />
      <TextField label="Ends (optional)" type="date" value={endsAt} onChange={setEndsAt} />

      {needsOverride ? (
        <>
          <Notice tone="error">
            {failing.length === 1 ? "One gate is" : `${failing.length} gates are`} unmet:{" "}
            {failing.map((g) => gateKindLabel(g.gateKind)).join(", ")}. Assigning anyway requires a
            documented reason and is recorded against your membership.
          </Notice>
          <TextAreaField
            label="Override reason"
            value={overrideReason}
            onChange={setOverrideReason}
            rows={3}
            hint={`At least ${OVERRIDE_REASON_MIN} characters.`}
          />
        </>
      ) : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

function AssignmentLedger({
  plan,
  reload,
}: { plan: PlanDetail; reload: () => Promise<void> }): JSX.Element {
  const client = useApiClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inactivating, setInactivating] = useState<AssignmentView | null>(null);
  const [reason, setReason] = useState("");

  /** Route 18 — acknowledge / inactivate / reactivate. Reactivation is ALWAYS manual (§7.5). */
  const patch = useCallback(
    async (assignment: AssignmentView, body: Record<string, unknown>, fallback: string) => {
      setError(null);
      const res = await client.PATCH(
        "/api/v1/discipline-plans/{planId}/volunteer-assignments/{assignmentId}",
        {
          params: {
            path: { planId: plan.planId, assignmentId: assignment.assignmentId },
            header: writeHeaders(assignment.version),
          },
          body,
        } as never,
      );
      if (res.error) {
        setError(errorMessage(res.error, fallback));
        return false;
      }
      await reload();
      return true;
    },
    [client, plan.planId, reload],
  );

  return (
    <>
      <Card
        title="Volunteer assignments"
        actions={
          <button type="button" style={ghostButtonStyle} onClick={() => setOpen(true)}>
            Assign volunteer
          </button>
        }
      >
        {error ? <p style={alertStyle}>{error}</p> : null}
        {plan.volunteerAssignments.length === 0 ? (
          <span style={mutedStyle}>No active volunteer assignments.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Volunteer</th>
                <th style={th}>Activities</th>
                <th style={th}>Window</th>
                <th style={th}>Acknowledged</th>
                <th style={th}>State</th>
                <th style={th}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {plan.volunteerAssignments.map((a) => (
                <tr key={a.assignmentId} style={rowLine}>
                  <td style={td}>{shortId(a.volunteerMembershipId)}</td>
                  <td style={td}>{a.activities.join(", ")}</td>
                  <td style={td}>
                    {shortDate(a.startsAt)} → {a.endsAt ? shortDate(a.endsAt) : "open"}
                  </td>
                  <td style={td}>{dateTime(a.coordinatorAcknowledgedAt)}</td>
                  <td style={td}>
                    <StatusPill
                      label={a.inactivatedAt ? "Inactive" : "Active"}
                      tone={a.inactivatedAt ? "neutral" : "success"}
                    />
                    {a.inactivationReason ? (
                      <div style={mutedStyle}>{a.inactivationReason}</div>
                    ) : null}
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
                      {a.coordinatorAcknowledgedAt ? null : (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          onClick={() =>
                            void patch(
                              a,
                              { coordinatorAcknowledged: true },
                              "The acknowledgement was not recorded.",
                            )
                          }
                        >
                          Acknowledge
                        </button>
                      )}
                      {a.inactivatedAt ? (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          onClick={() =>
                            void patch(
                              a,
                              { reactivate: true },
                              "The assignment was not reactivated — every gate must be satisfied first.",
                            )
                          }
                        >
                          Reactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          onClick={() => {
                            setReason("");
                            setInactivating(a);
                          }}
                        >
                          Inactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {open ? (
        <AssignmentModal
          plan={plan}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            void reload();
          }}
        />
      ) : null}

      {inactivating ? (
        <Modal
          title="Inactivate assignment"
          onClose={() => setInactivating(null)}
          footer={
            <button
              type="button"
              disabled={reason.trim().length === 0}
              style={{ ...primaryButtonStyle, opacity: reason.trim().length === 0 ? 0.5 : 1 }}
              onClick={() => {
                void patch(
                  inactivating,
                  { inactivate: { reason } },
                  "The assignment was not inactivated.",
                ).then((ok) => {
                  if (ok) setInactivating(null);
                });
              }}
            >
              Inactivate
            </button>
          }
        >
          <TextAreaField
            label="Reason"
            value={reason}
            onChange={setReason}
            rows={3}
            hint="Recorded on the assignment. Reactivation is always manual — an expiry cascade never re-activates on its own (§7.5)."
          />
        </Modal>
      ) : null}
    </>
  );
}

export function VolunteerPlanView(): JSX.Element {
  return (
    <DisciplinePlanWorkspace
      kind="volunteer_plan"
      renderExtras={(plan, reload) => <AssignmentLedger plan={plan} reload={reload} />}
    />
  );
}
