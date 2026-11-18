// apps/web/src/modules/08-encounters — the SUPERVISOR OVERDUE-NOTES BOARD (ADR-0113). Spec:
// docs/design/screens/clinical/CHARTWARDEN_UI_NOTE_CLOSURE_OVERDUE_BOARD.md — "Use Work Queue."
// The org's (or the supervisor's sites') clocked open visit notes that are at risk, overdue or escalated, oldest first:
//   GET /api/v1/encounters/overdue-notes?limit   (encounter.closure_override; the server decides scope, stage and hours — nothing here
//   recomputes a deadline, so the board can never disagree with the alerts or the gate)
// A row's action opens the grant-override drawer (override-grant-drawer.tsx). Overrides only matter while the tenant policy BLOCKS, so in
// `warn` and `off` the board is read-only and says why. A supervisor cannot override their own note (the server refuses it): that row
// offers no action. Listing existing overrides is a later route, so the drawer revokes only grants made in this session.
// READING: the first read and the Refresh button are the person's (ordinary requests, a spinner on the button); the board also reads
// itself again every minute and when the tab is visited again (background requests, no spinner, visible tab only; the shared cues in
// shell/use-refresh-cues.ts), because a note's stage moves with the clock and a row must not stay "At risk" under a stale count. A failed
// first read is an error with a retry, never an empty board. A refresh that fails with a 5xx or no answer keeps the rows already on screen
// (and an open drawer, with what was typed in it) and says the board could not be refreshed; a REFUSAL (403) is final: the rows and the
// drawer go (its stashed step-up draft too), because the person may no longer see them. A note that drops off the board while its
// drawer is open (it was closed), or a mode that no longer blocks, keeps the drawer until the supervisor closes it, and the drawer says
// so. Only the status line is a live region, never the table: it names the board's counts when a read lands.
import {
  Button,
  EmptyState,
  InlineAlert,
  KpiCard,
  LoadingSpinner,
  OffsetPagination,
  StatusPill,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { formatClosureInstant } from "../../shell/closure-instant";
import { usePatientNames } from "../../shell/patient-names";
import type { PatientNames } from "../../shell/patient-names";
import { useSession } from "../../shell/session";
import { clearStepUpDraft } from "../../shell/step-up-redirect";
import { useRefreshCues } from "../../shell/use-refresh-cues";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import {
  type HeldOverride,
  type OverdueBoardView,
  type OverdueNote,
  loadOverdueNotes,
} from "./closure-api";
import {
  STAGE_LABEL,
  STAGE_TONE,
  boardStatusLine,
  countByStage,
  isGrantActive,
  timingLabel,
} from "./closure-model";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import {
  CLOSURE_DRAFT_ACTIONS,
  type NoteBoardState,
  OverrideGrantDrawer,
  grantDraftKey,
} from "./override-grant-drawer";
import { useIsMounted } from "./use-is-mounted";
import { useNow } from "./use-now";
import { clinicianLabel, useStaffNames } from "./use-staff-names";
import type { StaffNames } from "./use-staff-names";

/** Why the last read of the board failed: a refusal is final ("not available"), anything else is worth a retry. */
interface ReadFailure {
  readonly forbidden: boolean;
}

const NOTE_PARAM = "note";
const PAGE_SIZES = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 10;
const FORBIDDEN_STATUS = 403;
/** How often the "Due in Xh" countdowns are recomputed from the clock (they are the only client-side arithmetic on the board). */
const COUNTDOWN_TICK_MS = 60_000;
/** How often the board reads itself again while its tab is visible: a stage can only move with the clock, so a minute is plenty. */
export const OVERDUE_BOARD_REFRESH_MS = 60_000;

type Grants = Readonly<Record<string, HeldOverride>>;

const patientLabelOf = (names: PatientNames, patientId: string): string =>
  names[patientId]?.name ?? "Patient";

export function OverdueBoard(): JSX.Element {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const owner = useStepUpOwner();
  // Back from /step-up: the grant form restores its stashed draft. An abandoned draft is discarded, never restored.
  const returning = useStepUpReturn(owner, CLOSURE_DRAFT_ACTIONS);
  const [board, setBoard] = useState<OverdueBoardView | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [grants, setGrants] = useState<Grants>({});
  const [kept, setKept] = useState<OverdueNote | null>(null);
  const staffNames = useStaffNames();
  const now = useNow(COUNTDOWN_TICK_MS);
  const viewerMembershipId = session?.membershipId ?? null;
  const noteParam = params.get(NOTE_PARAM) ?? "";
  // Which read's answer still counts, and how many are in flight: a newer read supersedes an older one, and a background read never
  // starts while another is going (an in-flight guard, as in use-my-notes).
  const latestRead = useRef(0);
  const pending = useRef(0);

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (background && pending.current > 0) return;
      latestRead.current += 1;
      const mine = latestRead.current;
      pending.current += 1;
      if (!background) {
        // The person's own read: a spinner on the button, and a clean slate so a second failure is announced afresh and an unchanged
        // answer is announced again (a live region only speaks when its content changes).
        setLoading(true);
        setFailure(null);
        setAnnouncement("");
      }
      const outcome = await loadOverdueNotes(client, { background });
      pending.current -= 1;
      if (!mounted.current || latestRead.current !== mine) return;
      setLoading(false);
      if (outcome.ok) {
        setBoard(outcome.data);
        setFailure(null);
        setAnnouncement(boardStatusLine(outcome.data));
        return;
      }
      const forbidden = outcome.status === FORBIDDEN_STATUS;
      setFailure({ forbidden });
      // Stale-while-revalidate holds for a 5xx or no answer; a refusal is final, so rows the person may no longer see go.
      if (forbidden) setBoard(null);
    },
    [client, mounted],
  );
  useEffect(() => {
    void read(false);
  }, [read]);
  useRefreshCues(() => void read(true), OVERDUE_BOARD_REFRESH_MS);
  const refresh = (): void => void read(false);

  // A refusal also closes an open drawer and discards the step-up draft stashed for it: nothing typed there may outlive the access.
  const forbidden = failure?.forbidden === true;
  useEffect(() => {
    if (!forbidden || noteParam === "") return;
    clearStepUpDraft(grantDraftKey(owner, noteParam));
    setKept(null);
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(NOTE_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [forbidden, noteParam, owner, setParams]);

  const items = board?.items ?? [];
  const canGrant = board?.mode === "block";
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = items.slice((activePage - 1) * pageSize, activePage * pageSize);
  // Names are looked up for the page on screen only: one request per patient, so a 200-row board never fans out.
  const patientNames = usePatientNames(pagedItems.map((i) => i.patientId));
  const isOwnNote = (note: OverdueNote): boolean =>
    note.authoredByMembershipId === viewerMembershipId;
  const listed = canGrant
    ? (items.find((i) => i.encounterId === noteParam && !isOwnNote(i)) ?? null)
    : null;
  // A refresh that no longer lists the open note (it was closed), or a mode that no longer blocks, must not pull the drawer away with a
  // half-typed reason in it: the last row seen stands in until the supervisor closes the panel. A drawer is never OPENED that way: it
  // needs a listed note, which only a board that blocks offers.
  useEffect(() => {
    if (listed !== null) setKept(listed);
  }, [listed]);
  const selected = forbidden ? null : (listed ?? (kept?.encounterId === noteParam ? kept : null));
  const boardState: NoteBoardState =
    listed !== null ? "listed" : canGrant ? "gone" : "not-blocking";

  const select = (encounterId: string): void =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set(NOTE_PARAM, encounterId);
        return next;
      },
      { replace: true },
    );
  const deselect = (): void => {
    setKept(null);
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(NOTE_PARAM);
        return next;
      },
      { replace: true },
    );
  };
  const keepGrant = (grant: HeldOverride): void =>
    setGrants((previous) => ({ ...previous, [grant.subjectMembershipId]: grant }));

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Overdue notes</h1>
            <p>
              Visit notes that are close to, or past, the time limit for closing them, oldest first.
              Grant a clinician a short override when they must keep working while a note stays
              open.
            </p>
          </div>
          <Button tone="secondary" loading={loading} onClick={refresh}>
            Refresh
          </Button>
        </header>

        <ModeNotice board={board} />
        <Summary board={board} />
        {board?.truncated ? (
          <InlineAlert tone="warning">
            {`Showing the oldest ${items.length} notes. More are at risk or overdue than fit on this board: work the oldest first.`}
          </InlineAlert>
        ) : null}

        <output className="wx-sr-only">{announcement}</output>
        {failure !== null && board !== null ? (
          <InlineAlert tone="error">
            The board could not be refreshed. The rows below are as of the last time it loaded: try
            Refresh again.
          </InlineAlert>
        ) : null}

        {board === null && loading ? (
          <div className="wx-list-state">
            <LoadingSpinner />
          </div>
        ) : board === null && failure !== null ? (
          <div className="wx-list-state" role="alert">
            <EmptyState
              title={failure.forbidden ? "Not available" : "Overdue notes unavailable"}
              description={
                failure.forbidden
                  ? "You do not have access to the overdue notes board."
                  : "The overdue notes could not be loaded. Nothing is being hidden: try again."
              }
            />
            {failure.forbidden ? null : (
              <Button tone="secondary" onClick={refresh}>
                Try again
              </Button>
            )}
          </div>
        ) : items.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title="No notes need attention"
              description={
                board?.mode === "off"
                  ? "Note closure is switched off for your organization."
                  : "No visit note is at risk, overdue or escalated."
              }
            />
          </div>
        ) : (
          <>
            <section
              className="wx-list-table-wrap"
              aria-label="Overdue visit notes"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
              tabIndex={0}
            >
              <NotesTable
                notes={pagedItems}
                canGrant={canGrant}
                selectedId={selected?.encounterId ?? null}
                patientNames={patientNames}
                staffNames={staffNames}
                grants={grants}
                now={now}
                isOwnNote={isOwnNote}
                onSelect={select}
              />
            </section>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={items.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="notes"
            />
          </>
        )}
      </div>

      {selected ? (
        <OverrideGrantDrawer
          key={selected.encounterId}
          note={selected}
          patientName={patientLabelOf(patientNames, selected.patientId)}
          clinicianName={clinicianLabel(staffNames, selected.authoredByMembershipId)}
          grant={grants[selected.authoredByMembershipId] ?? null}
          boardState={boardState}
          resume={returning}
          onClose={deselect}
          onGranted={keepGrant}
          onRevoked={keepGrant}
          onStale={refresh}
        />
      ) : null}
    </div>
  );
}

function ModeNotice({ board }: { board: OverdueBoardView | null }): JSX.Element | null {
  if (board?.mode === "off") {
    return (
      <InlineAlert tone="info">
        Note closure is off for your organization: notes are not tracked against a deadline, no
        alerts are sent and nobody is limited.
      </InlineAlert>
    );
  }
  if (board?.mode === "warn") {
    return (
      <InlineAlert tone="info">
        {`Note closure is set to warn only: clinicians are alerted as the ${board.thresholdHours}-hour deadline approaches and passes, but nobody is limited, so there is nothing to override. Overrides become available if your organization turns blocking on.`}
      </InlineAlert>
    );
  }
  return null;
}

function Summary({ board }: { board: OverdueBoardView | null }): JSX.Element {
  const counts = countByStage(board?.items ?? []);
  const value = (count: number): number | string => (board ? count : "—");
  return (
    <div className="wx-stat-grid" aria-label="Overdue note summary">
      <KpiCard
        icon="alert-circle"
        tone="danger"
        label="Escalated"
        value={value(counts.escalated)}
        detail="Well past the deadline"
      />
      <KpiCard
        icon="clock"
        tone="warning"
        label="Overdue"
        value={value(counts.overdue)}
        detail="Past the deadline"
      />
      <KpiCard
        icon="clipboard-list"
        tone="info"
        label="At risk"
        value={value(counts.atRisk)}
        detail="Close to the deadline"
      />
    </div>
  );
}

function NotesTable({
  notes,
  canGrant,
  selectedId,
  patientNames,
  staffNames,
  grants,
  now,
  isOwnNote,
  onSelect,
}: {
  notes: readonly OverdueNote[];
  canGrant: boolean;
  selectedId: string | null;
  patientNames: PatientNames;
  staffNames: StaffNames;
  grants: Grants;
  now: Date;
  isOwnNote: (note: OverdueNote) => boolean;
  onSelect: (encounterId: string) => void;
}): JSX.Element {
  return (
    <table className={canGrant ? "wx-list-table" : "wx-list-table wx-list-table-static"}>
      <caption className="wx-sr-only">Visit notes at risk, overdue or escalated</caption>
      <thead>
        <tr>
          <th scope="col">Patient</th>
          <th scope="col">Clinician</th>
          <th scope="col">Visit</th>
          <th scope="col">Service date</th>
          <th scope="col">Status</th>
          <th scope="col">Clock started</th>
          <th scope="col">Deadline</th>
          <th scope="col">Stage</th>
          <th scope="col">Timing</th>
          {canGrant ? <th scope="col">Override</th> : null}
        </tr>
      </thead>
      <tbody>
        {notes.map((note) => {
          const patient = patientLabelOf(patientNames, note.patientId);
          const clinician = clinicianLabel(staffNames, note.authoredByMembershipId);
          const grant = grants[note.authoredByMembershipId];
          const granted = grant !== undefined && isGrantActive(grant, now);
          const own = isOwnNote(note);
          const rowProps =
            canGrant && !own
              ? {
                  className: "wx-data-row-interactive",
                  ...interactiveRowProps(
                    () => onSelect(note.encounterId),
                    note.encounterId === selectedId,
                    true,
                    note.encounterId,
                  ),
                }
              : {};
          return (
            <tr key={note.encounterId} {...rowProps}>
              <td>
                <span className="wx-row-title">{patient}</span>
                {patientNames[note.patientId]?.mrn ? (
                  <div className="wx-row-sub">{patientNames[note.patientId]?.mrn}</div>
                ) : null}
              </td>
              <td>{clinician}</td>
              <td>
                <span className="wx-row-title">{stateLabel(note.encounterType)}</span>
                <div className="wx-row-sub">{stateLabel(note.discipline)}</div>
              </td>
              <td className="wx-nums">{note.serviceDate}</td>
              <td>
                <StatusPill
                  label={stateLabel(note.status)}
                  tone={ENCOUNTER_TONE[note.status] ?? "neutral"}
                />
              </td>
              <td className="wx-nums">{formatClosureInstant(note.clockStartedAt)}</td>
              <td className="wx-nums">{formatClosureInstant(note.deadlineAt)}</td>
              <td>
                <StatusPill label={STAGE_LABEL[note.stage]} tone={STAGE_TONE[note.stage]} />
              </td>
              <td className="wx-nums">
                {timingLabel(note.stage, note.hoursOverdue, note.deadlineAt, now)}
              </td>
              {canGrant ? (
                <td>
                  {own ? (
                    <span className="wx-row-sub">
                      Your own note. Another supervisor can grant it.
                    </span>
                  ) : (
                    <div className="wx-inline-flag">
                      {granted ? <StatusPill label="Override active" tone="success" /> : null}
                      <Button
                        size="sm"
                        tone="secondary"
                        aria-label={`${granted ? "Manage override" : "Grant override"} for ${clinician}, ${patient}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(note.encounterId);
                        }}
                      >
                        {granted ? "Manage override" : "Grant override"}
                      </Button>
                    </div>
                  )}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
