// M36 WP 6.9 (ADR-0098, PROPOSED) - "Death follow-up": the coordination board for the work that follows a patient's death. One section per patient,
// one flat row per checklist item with ONE named owner, a state that is a word (never colour alone), and two actions the SERVER says the caller may
// take: the owner marks an item complete, the owner or a supervisor reassigns it. The board is coordination only: nothing here writes to the chart,
// and the item wording is fixed by the platform template. While the tenant flag is off the list says so and the screen says "not turned on".
// Known limit: the item history route exists but has no screen. A new owner is chosen from the active-staff lookup.
import type { DeathBoardDto, DeathBoardItemDto } from "@chartwarden/types";
import {
  Button,
  EmptyState,
  EntityLookupField,
  type EntityLookupLoadInput,
  type EntityLookupLoadResult,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";
import { LoadGate, formatTime, useFailureText } from "./export-common";
import { useOnlineStatus } from "./offline-banner";
import { useDeathBoardActions, useDeathBoards } from "./use-death-board";
import type { ExportResult } from "./use-export";
import "./export.css";

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

const NEEDS_COLLEAGUE = "Choose a colleague to take this item.";

function ReassignDialog({
  busy,
  error,
  currentOwnerId,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly currentOwnerId: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (userId: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [userId, setUserId] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Same active-staff lookup as the handoff picker; the server still decides who may take the item (422).
  const loadOptions = useCallback(
    async ({ query }: EntityLookupLoadInput): Promise<EntityLookupLoadResult> => {
      const { data } = await client.GET("/api/v1/messaging/dm/staff", {
        params: { query: { q: query.trim() || undefined } },
      });
      if (!data) throw new Error("staff lookup failed");
      return {
        options: data.staff
          .filter((person) => person.userId !== currentOwnerId)
          .map((person) => ({
            id: person.userId,
            label: person.displayName,
            searchLabel: person.displayName,
          })),
      };
    },
    [client, currentOwnerId],
  );
  return (
    <Modal
      open
      ariaLabel="Reassign checklist item"
      onClose={busy ? undefined : onCancel}
      dismissOnScrim={userId === ""}
      width="32rem"
    >
      <form
        className="wx-export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!userId) {
            setProblem(NEEDS_COLLEAGUE);
            return;
          }
          if (!busy) onSubmit(userId);
        }}
      >
        <h2>Reassign checklist item</h2>
        <p>The new owner is told in their inbox. The change is recorded with your name.</p>
        <EntityLookupField
          label="New owner"
          value={userId}
          valueLabel={label || undefined}
          placeholder="Search colleagues"
          appearance="modal"
          disabled={busy}
          error={problem ?? undefined}
          onChange={(value, option) => {
            setProblem(null);
            setUserId(value);
            setLabel(option ? option.searchLabel : "");
          }}
          loadOptions={loadOptions}
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

type RunOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly error: string };

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

  /** "skipped" = another action was still in flight, so nothing was sent and nothing about the dialog or message changes. */
  const run = async (
    work: () => Promise<ExportResult<unknown>>,
    done: string,
  ): Promise<RunOutcome> => {
    if (inFlight.current) return { kind: "skipped" }; // two fast clicks before the disabled state paints send one request
    inFlight.current = true;
    setBusy(true);
    say(null);
    const result = await work();
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") {
      say(done);
      reload();
      return { kind: "done" };
    }
    if (result.kind === "conflict" || result.kind === "not_available") reload();
    return { kind: "failed", error: failureText(result) ?? "The change could not be saved." };
  };

  const complete = (item: DeathBoardItemDto): void => {
    void run(() => actions.complete(item.id), `“${item.label}” marked complete.`).then((out) => {
      if (out.kind === "skipped") return;
      if (out.kind === "failed") say(out.error);
      statusRef.current?.focus();
    });
  };

  const reassign = (userId: string): void => {
    const item = reassigning;
    if (!item) return;
    setDialogError(null);
    void run(() => actions.reassign(item.id, userId), `“${item.label}” reassigned.`).then(
      (out) => {
        if (out.kind === "skipped") return;
        if (out.kind === "failed") {
          setDialogError(out.error);
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
          currentOwnerId={reassigning.owner_user_id}
          onCancel={() => !busy && setReassigning(null)}
          onSubmit={reassign}
        />
      ) : null}
    </>
  );
}
