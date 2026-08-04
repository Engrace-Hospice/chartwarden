// apps/web/src/modules/19-oncall — S19.6 SINGLE-SHIFT DETAIL (`/triage/shifts/:shiftId`, §5.1, Track B /
// ADR-0030). The "go on shift" CTA lives here — the `scheduled → active` transition that puts the
// clinician into M36's `on_call` channel and makes them the recipient M20's after-hours SOS path resolves.
//
// THE ROW IS FOUND IN THE LIST, NOT FETCHED BY ID, and that is a real §4.1 gap rather than a shortcut:
// M19 publishes no `GET /oncall/shifts/:shiftId`. The schedule list is the only read, so this screen pages
// it and picks the row out. Two consequences the screen states rather than hides: a shift outside the
// first page window is reported as not found in range (never as "does not exist"), and the `version` used
// for `If-Match` is the one from that same read, which is exactly the stamp the optimistic-concurrency
// guard wants.
//
// THE TWO TRANSITIONS ARE THE MANUAL PATH FOR THE NIGHT THE CRON DID NOT RUN. §4.8's worker normally opens
// and closes shifts; routes 22/23 exist for when it did not, and both run the SAME §2.2.2 machine — so a
// manual open cannot claim coverage from before the window began. Cancelling emits NO event, deliberately:
// a shift that never activated was never in M36's channel, so a `cancelled` emit would ask M36 to remove a
// member it never added; the hole the cancellation leaves is the coverage-gap watchdog's finding.
//
// §5.1's "handoff notes" field is not built — `on_call_shift` has no such column and M19 publishes no
// route that would carry one. A note box that discarded what was typed is worse than no note box.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type OnCallShiftView,
  cancelShift,
  closeShift,
  errorMessage,
  listShifts,
  openShift,
} from "./oncall-api";
import {
  SHIFT_STATUS_TONE,
  dateTime,
  disciplineLabel,
  durationLabel,
  humanize,
  isWithinWindow,
  minutesSince,
  shortId,
  toneOf,
} from "./oncall-status";
import {
  Card,
  Field,
  Modal,
  Notice,
  SummaryGrid,
  TextAreaField,
  Timeline,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./oncall-ui";

const SHIFT_PAGE = 200;

export function OnCallShiftDetailScreen(): JSX.Element {
  const client = useApiClient();
  const { shiftId = "" } = useParams<{ shiftId: string }>();
  const [shift, setShift] = useState<OnCallShiftView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listShifts(client, { limit: SHIFT_PAGE });
    if (res.error) {
      setError(errorMessage(res.error, "The roster could not be read."));
      setLoading(false);
      return;
    }
    const found = (res.page?.data ?? []).find((s) => s.id === shiftId) ?? null;
    if (!found) {
      setError(
        "This shift is not in the current roster window. M19 publishes no per-shift read, so the schedule list is the only way to reach one — widen the roster view and try again. This is not the same as the shift not existing.",
      );
      setLoading(false);
      return;
    }
    setShift(found);
    setLoading(false);
  }, [client, shiftId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !shift) {
    return (
      <EmptyState title="Not in range" description={error ?? "This shift could not be read."} />
    );
  }

  const inWindow = isWithinWindow(shift.shiftStartsAt, shift.shiftEndsAt);
  const canOpen = shift.status === "scheduled" && !busy;
  const canClose = shift.status === "active" && !busy;
  const canCancel = shift.status === "scheduled" && !busy;

  async function run(fn: () => Promise<{ error: unknown }>, fallback: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await fn();
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, fallback));
      return;
    }
    setCancelling(false);
    await load();
  }

  const timeline = [
    { label: "Window opens", at: dateTime(shift.shiftStartsAt) },
    ...(shift.openedAt ? [{ label: "Went on shift", at: dateTime(shift.openedAt) }] : []),
    ...(shift.closedAt ? [{ label: "Came off shift", at: dateTime(shift.closedAt) }] : []),
    { label: "Window closes", at: dateTime(shift.shiftEndsAt) },
  ];

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Shift {shortId(shift.id)}</span>}
        breadcrumb="On-call triage · coverage"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <StatusPill
              label={humanize(shift.status)}
              tone={toneOf(SHIFT_STATUS_TONE, shift.status)}
            />
            <Link to="/triage/shifts" style={ghostButtonStyle}>
              Roster
            </Link>
          </div>
        }
      />

      {shift.status === "scheduled" && !inWindow ? (
        <Notice tone="info">
          The window has not started. Going on shift early is refused by the same machine the cron
          runs through — a shift cannot claim coverage from before its window began.
        </Notice>
      ) : null}

      {shift.status === "cancelled" ? (
        <Notice tone="error">
          This shift was cancelled{shift.cancellationReason ? `: ${shift.cancellationReason}` : "."}{" "}
          Nothing was emitted to the messaging channel, because a shift that never activated was
          never in it. The hole it leaves is the coverage-gap watchdog's finding, on its own
          cadence.
        </Notice>
      ) : null}

      <Card title="Shift">
        <SummaryGrid>
          <Field label="Provider entity" value={shortId(shift.providerEntityId)} mono />
          <Field label="Discipline" value={disciplineLabel(shift.discipline)} />
          <Field label="Starts" value={dateTime(shift.shiftStartsAt)} />
          <Field label="Ends" value={dateTime(shift.shiftEndsAt)} />
          <Field
            label="Primary on-call"
            value={
              shift.externalActorId
                ? (shift.externalActorLabel ?? "external vendor")
                : shortId(shift.primaryOnCallMembershipId)
            }
            mono={!shift.externalActorId}
          />
          <Field label="Backup" value={shortId(shift.backupMembershipId)} mono />
          <Field
            label="External vendor binding"
            value={shift.externalActorId ? shortId(shift.externalActorId) : "—"}
            mono={Boolean(shift.externalActorId)}
          />
          <Field
            label="M17 roster back-reference"
            value={shift.m17VisitAssignmentRef ? shortId(shift.m17VisitAssignmentRef) : "manual"}
            mono={Boolean(shift.m17VisitAssignmentRef)}
          />
          <Field label="Went on shift" value={dateTime(shift.openedAt)} />
          <Field label="Came off shift" value={dateTime(shift.closedAt)} />
          <Field
            label="On shift for"
            value={
              shift.openedAt && !shift.closedAt
                ? durationLabel(minutesSince(shift.openedAt))
                : shift.openedAt && shift.closedAt
                  ? durationLabel(minutesSince(shift.openedAt, Date.parse(shift.closedAt)))
                  : "—"
            }
          />
          <Field label="Version (If-Match)" value={String(shift.version)} mono />
        </SummaryGrid>
      </Card>

      <Card title="Window">
        <Timeline entries={timeline} />
      </Card>

      <Card title="Actions">
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={!canOpen}
            style={canOpen ? primaryButtonStyle : disabledButtonStyle}
            title={canOpen ? undefined : "Only a scheduled shift can be opened."}
            onClick={() =>
              void run(
                () => openShift(client, shift.id, shift.version),
                "The shift could not be opened.",
              )
            }
          >
            Go on shift
          </button>
          <button
            type="button"
            disabled={!canClose}
            style={canClose ? ghostButtonStyle : disabledButtonStyle}
            title={canClose ? undefined : "Only an active shift can be closed."}
            onClick={() =>
              void run(
                () => closeShift(client, shift.id, shift.version),
                "The shift could not be closed.",
              )
            }
          >
            Come off shift
          </button>
          <button
            type="button"
            disabled={!canCancel}
            style={canCancel ? ghostButtonStyle : disabledButtonStyle}
            title={canCancel ? undefined : "Only a scheduled shift can be cancelled."}
            onClick={() => setCancelling(true)}
          >
            Cancel the shift
          </button>
        </div>
        <span style={mutedStyle}>
          Going on shift adds this clinician to the on-call messaging channel and makes them the
          recipient the after-hours safety path resolves. Coming off removes them — messages sent
          during their tenure stay attributed to them.
        </span>
      </Card>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {cancelling ? (
        <Modal
          title="Cancel this shift"
          onClose={() => setCancelling(false)}
          footer={
            <button
              type="button"
              disabled={busy || reason.trim().length < 1}
              style={busy || reason.trim().length < 1 ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () => cancelShift(client, shift.id, shift.version, { reason }),
                  "The shift could not be cancelled.",
                )
              }
            >
              Cancel the shift
            </button>
          }
        >
          <Notice tone="warning">
            Cancelling leaves a hole in the coverage record until another shift fills it. Nothing is
            emitted; the watchdog is what finds the gap.
          </Notice>
          <TextAreaField label="Why" value={reason} onChange={setReason} rows={3} />
        </Modal>
      ) : null}
    </div>
  );
}
