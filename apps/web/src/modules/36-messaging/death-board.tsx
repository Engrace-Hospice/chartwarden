// M36 WP 6.9 (ADR-0098, PROPOSED) - "Death follow-up": the coordination board for the work that follows a patient's death. One section per patient,
// one flat row per checklist item with ONE named owner, a state that is a word (never colour alone), and two actions the SERVER says the caller may
// take: the owner marks an item complete, the owner or a supervisor reassigns it. The board is coordination only: nothing here writes to the chart,
// and the item wording is fixed by the platform template. While the tenant flag is off the list says so and the screen says "not turned on".
// Known limits: a new owner is entered as a user id (no picker yet); the item history route exists but has no screen.
import type { DeathBoardDto, DeathBoardItemDto } from "@chartwarden/types";
import { Button, EmptyState, Modal, PageHeader, StatusPill, TextField } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { LoadGate, formatTime, useFailureText } from "./export-common";
import { useOnlineStatus } from "./offline-banner";
import { useDeathBoardActions, useDeathBoards } from "./use-death-board";
import type { ExportResult } from "./use-export";
import "./export.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first thing wrong with the new owner entry, or null when it can be sent. */
export function validateOwnerEntry(value: string): string | null {
  return UUID.test(value.trim()) ? null : "Enter the new owner's user id as a UUID.";
}

type Tone = "success" | "error" | "warning" | "neutral";
/** One word per state; "No owner" outranks "Overdue" because it needs a supervisor now. */
export function itemState(item: DeathBoardItemDto): { label: string; tone: Tone } {
  if (item.status === "done") return { label: "Done", tone: "success" };
  if (item.needs_owner) return { label: "No owner", tone: "error" };
  if (item.overdue) return { label: "Overdue", tone: "warning" };
  return { label: "Open", tone: "neutral" };
}

function useActionFailureText(): (result: ExportResult<unknown>) => string | null {
  const stepUpText = useFailureText();
  return (result) => {
    switch (result.kind) {
      case "ok":
        return null;
      case "step_up":
        return stepUpText(result);
      case "not_available":
        return "That item is no longer available to you.";
      case "conflict":
        return "That item changed or is already finished. The list has been refreshed.";
      case "invalid":
        return "That person cannot take this item. Choose an active colleague who may see this patient.";
      case "denied":
        return result.code === 401
          ? "Your session has ended. Sign in again."
          : "Only the item's owner can mark it complete.";
      case "limit":
        return "Too many requests. Wait a moment and try again.";
      default:
        return "The change could not be saved. Nothing was changed.";
    }
  };
}

function ReassignDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (userId: string) => void;
}): JSX.Element {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Modal
      open
      ariaLabel="Reassign checklist item"
      onClose={busy ? undefined : onCancel}
      width="32rem"
    >
      <form
        className="wx-export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          const found = validateOwnerEntry(value);
          setProblem(found);
          if (!found && !busy) onSubmit(value.trim());
        }}
      >
        <h2>Reassign checklist item</h2>
        <p>The new owner is told in their inbox. The change is recorded with your name.</p>
        <TextField
          id="death-board-new-owner"
          label="New owner (user id)"
          error={problem ?? undefined}
          value={value}
          onChange={(e) => {
            setProblem(null);
            setValue(e.target.value);
          }}
        />
        {error ? (
          <p className="wx-export-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-export-actions">
          <Button type="button" tone="secondary" size="lg" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" tone="primary" size="lg" disabled={busy}>
            {busy ? "Reassigning…" : "Reassign"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ItemRow({
  item,
  busy,
  onComplete,
  onReassign,
}: {
  readonly item: DeathBoardItemDto;
  readonly busy: boolean;
  readonly onComplete: (item: DeathBoardItemDto) => void;
  readonly onReassign: (item: DeathBoardItemDto) => void;
}): JSX.Element {
  const online = useOnlineStatus();
  const titleId = `wx-death-item-${item.id}`;
  const state = itemState(item);
  return (
    <li className="wx-export-row">
      <div className="wx-export-main">
        <span className="wx-export-title" id={titleId}>
          {item.label}
        </span>
        <span className="wx-export-detail">
          Owner: {item.owner_display_name ?? "Unnamed user"} · Due {formatTime(item.due_at)}
          {item.completed_at ? ` · Completed ${formatTime(item.completed_at)}` : ""}
        </span>
        {item.needs_owner ? (
          <span className="wx-export-detail">
            The owner has left and nobody could take this item. A supervisor must assign it.
          </span>
        ) : null}
      </div>
      <div className="wx-export-meta">
        <StatusPill
          tone={state.tone}
          {...(item.status === "done" ? { glyph: "check" as const } : {})}
          label={state.label}
        />
        {item.actions.includes("complete") ? (
          <Button
            type="button"
            tone="primary"
            size="lg"
            disabled={busy || !online}
            aria-describedby={titleId}
            onClick={() => onComplete(item)}
          >
            Mark complete
          </Button>
        ) : null}
        {item.actions.includes("reassign") ? (
          <Button
            type="button"
            tone="secondary"
            size="lg"
            disabled={busy || !online}
            aria-describedby={titleId}
            onClick={() => onReassign(item)}
          >
            Reassign
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function BoardSection(props: {
  readonly board: DeathBoardDto;
  readonly busy: boolean;
  readonly onComplete: (item: DeathBoardItemDto) => void;
  readonly onReassign: (item: DeathBoardItemDto) => void;
}): JSX.Element {
  const { board } = props;
  const headingId = `wx-death-board-${board.id}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="wx-export-title">
        {board.patient_display_name ?? "Patient"}
        {board.mrn_suffix ? ` (MRN …${board.mrn_suffix})` : ""}
        <span className="wx-export-detail">
          {" "}
          · {board.open_count === 0 ? "All items done" : `${board.open_count} open`}
        </span>
      </h2>
      <ul className="wx-export-rows" aria-label="Checklist items">
        {board.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            busy={props.busy}
            onComplete={props.onComplete}
            onReassign={props.onReassign}
          />
        ))}
      </ul>
    </section>
  );
}

export function DeathBoard(): JSX.Element {
  const { view, reload, refreshFailed } = useDeathBoards();
  const actions = useDeathBoardActions();
  const failureText = useActionFailureText();
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLOutputElement>(null);
  const [busy, setBusy] = useState(false);
  const [reassigning, setReassigning] = useState<DeathBoardItemDto | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string | null; seq: number }>({
    text: null,
    seq: 0,
  });
  const say = (text: string | null): void => setMessage((m) => ({ text, seq: m.seq + 1 }));

  const run = async (
    work: () => Promise<ExportResult<unknown>>,
    done: string,
  ): Promise<string | null> => {
    if (inFlight.current) return null; // two fast clicks before the disabled state paints send one request
    inFlight.current = true;
    setBusy(true);
    say(null);
    const result = await work();
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") {
      say(done);
      reload();
      return null;
    }
    if (result.kind === "conflict" || result.kind === "not_available") reload();
    return failureText(result);
  };

  const complete = (item: DeathBoardItemDto): void => {
    void run(() => actions.complete(item.id), `“${item.label}” marked complete.`).then((error) => {
      if (error) say(error);
      statusRef.current?.focus();
    });
  };

  const reassign = (userId: string): void => {
    const item = reassigning;
    if (!item) return;
    setDialogError(null);
    void run(() => actions.reassign(item.id, userId), `“${item.label}” reassigned.`).then(
      (error) => {
        if (error) {
          setDialogError(error);
          return;
        }
        setReassigning(null);
        statusRef.current?.focus();
      },
    );
  };

  return (
    <>
      <PageHeader title="Death follow-up" breadcrumb="Messaging">
        <p className="wx-export-detail">
          The checklist for the work that follows a patient's death. Each item has one owner who
          marks it complete. This board only coordinates people: it does not change the chart.
        </p>
      </PageHeader>
      <div className="wx-export">
        <output
          key={message.seq}
          ref={statusRef}
          tabIndex={-1}
          className="wx-export-status"
          aria-live="polite"
        >
          {message.text}
        </output>
        {refreshFailed && view.status === "ready" ? (
          <div className="wx-export-error" role="alert">
            <p>The list could not be refreshed. The items shown may be out of date.</p>
            <Button type="button" tone="secondary" size="lg" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : null}
        <LoadGate view={view} retry={reload} deniedText="You do not have access to this board.">
          {(list) =>
            !list.enabled ? (
              <EmptyState
                title="Death follow-up is not turned on"
                description="Ask your administrator to turn on the death follow-up board for your organisation."
              />
            ) : list.boards.length === 0 ? (
              <EmptyState
                title="No follow-up lists"
                description="When a patient on your care team dies, the checklist appears here."
              />
            ) : (
              <>
                {list.boards.map((board) => (
                  <BoardSection
                    key={board.id}
                    board={board}
                    busy={busy}
                    onComplete={complete}
                    onReassign={(item) => {
                      setDialogError(null);
                      setReassigning(item);
                    }}
                  />
                ))}
              </>
            )
          }
        </LoadGate>
      </div>
      {reassigning ? (
        <ReassignDialog
          busy={busy}
          error={dialogError}
          onCancel={() => !busy && setReassigning(null)}
          onSubmit={reassign}
        />
      ) : null}
    </>
  );
}
