// apps/web/src/modules/08-encounters — the SUPERVISOR OVERDUE-NOTES BOARD (ADR-0113). Spec:
// docs/design/screens/clinical/CHARTWARDEN_UI_NOTE_CLOSURE_OVERDUE_BOARD.md — "Use Work Queue."
// The org's (or the supervisor's sites') clocked open visit notes that are at risk, overdue or escalated, oldest first:
//   GET /api/v1/encounters/overdue-notes?limit   (encounter.closure_override; the server decides scope, stage and hours — nothing here
//   recomputes a deadline, so the board can never disagree with the alerts or the gate)
// A row's action opens the grant-override drawer (override-grant-drawer.tsx). Overrides only matter while the tenant policy BLOCKS, so in
// `warn` and `off` the board is read-only and says why. A supervisor cannot override their own note (the server refuses it): that row
// offers no action. Listing existing overrides is a later route, so the drawer revokes only grants made in this session. A failed read
// is an error with a retry, never an empty board.
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
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { usePatientNames } from "../../shell/patient-names";
import type { PatientNames } from "../../shell/patient-names";
import { useSession } from "../../shell/session";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import {
  type ClosureOverrideView,
  type OverdueBoardView,
  type OverdueNote,
  loadOverdueNotes,
} from "./closure-api";
import {
  STAGE_LABEL,
  STAGE_TONE,
  countByStage,
  formatInstant,
  isGrantActive,
  timingLabel,
} from "./closure-model";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import { CLOSURE_DRAFT_ACTIONS, OverrideGrantDrawer } from "./override-grant-drawer";
import { clinicianLabel, useStaffNames } from "./use-staff-names";
import type { StaffNames } from "./use-staff-names";

type Load =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly forbidden: boolean }
  | { readonly status: "ready"; readonly board: OverdueBoardView };

const NOTE_PARAM = "note";
const PAGE_SIZES = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 10;
const FORBIDDEN_STATUS = 403;

type Grants = Readonly<Record<string, ClosureOverrideView>>;

const patientLabelOf = (names: PatientNames, patientId: string): string =>
  names[patientId]?.name ?? "Patient";

export function OverdueBoard(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const owner = useStepUpOwner();
  // Back from /step-up: the grant form restores its stashed draft. An abandoned draft is discarded, never restored.
  const returning = useStepUpReturn(owner, CLOSURE_DRAFT_ACTIONS);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [grants, setGrants] = useState<Grants>({});
  const staffNames = useStaffNames();
  const viewerMembershipId = session?.membershipId ?? null;
  const noteParam = params.get(NOTE_PARAM) ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    let active = true;
    // Stale-while-revalidate: a refresh keeps the rows (and an open drawer) mounted.
    setLoad((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    void loadOverdueNotes(client).then((outcome) => {
      if (!active) return;
      setLoad(
        outcome.ok
          ? { status: "ready", board: outcome.data }
          : { status: "error", forbidden: outcome.status === FORBIDDEN_STATUS },
      );
    });
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  const board = load.status === "ready" ? load.board : null;
  const items = board?.items ?? [];
  const canGrant = board?.mode === "block";
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = items.slice((activePage - 1) * pageSize, activePage * pageSize);
  // Names are looked up for the page on screen only: one request per patient, so a 200-row board never fans out.
  const patientNames = usePatientNames(pagedItems.map((i) => i.patientId));
  const isOwnNote = (note: OverdueNote): boolean =>
    note.authoredByMembershipId === viewerMembershipId;
  const selected = canGrant
    ? (items.find((i) => i.encounterId === noteParam && !isOwnNote(i)) ?? null)
    : null;

  const select = (encounterId: string): void =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set(NOTE_PARAM, encounterId);
        return next;
      },
      { replace: true },
    );
  const deselect = (): void =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(NOTE_PARAM);
        return next;
      },
      { replace: true },
    );
  const keepGrant = (grant: ClosureOverrideView): void =>
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
          <Button
            tone="secondary"
            loading={load.status === "loading"}
            onClick={() => setReloadKey((key) => key + 1)}
          >
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

        <div aria-live="polite">
          {load.status === "loading" ? (
            <output className="wx-list-state">
              <LoadingSpinner />
            </output>
          ) : load.status === "error" ? (
            <div className="wx-list-state" role="alert">
              <EmptyState
                title={load.forbidden ? "Not available" : "Overdue notes unavailable"}
                description={
                  load.forbidden
                    ? "You do not have access to the overdue notes board."
                    : "The overdue notes could not be loaded. Nothing is being hidden: try again."
                }
              />
              {load.forbidden ? null : (
                <Button tone="secondary" onClick={() => setReloadKey((key) => key + 1)}>
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
      </div>

      {selected ? (
        <OverrideGrantDrawer
          key={selected.encounterId}
          note={selected}
          patientName={patientLabelOf(patientNames, selected.patientId)}
          clinicianName={clinicianLabel(staffNames, selected.authoredByMembershipId)}
          grant={grants[selected.authoredByMembershipId] ?? null}
          resume={returning}
          onClose={deselect}
          onGranted={keepGrant}
          onRevoked={keepGrant}
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
  isOwnNote,
  onSelect,
}: {
  notes: readonly OverdueNote[];
  canGrant: boolean;
  selectedId: string | null;
  patientNames: PatientNames;
  staffNames: StaffNames;
  grants: Grants;
  isOwnNote: (note: OverdueNote) => boolean;
  onSelect: (encounterId: string) => void;
}): JSX.Element {
  const now = new Date();
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
              <td className="wx-nums">{formatInstant(note.clockStartedAt)}</td>
              <td className="wx-nums">{formatInstant(note.deadlineAt)}</td>
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
