// M36 WP 3.5 - one handoff. The receiver chooses the specific items to accept (nothing is pre-selected) and can decline
// some or all; the sender can withdraw the offer; a closed handoff is read-only. Buttons come ONLY from the server's
// allowed_actions. A restricted, gone or unavailable item shows fixed wording and cannot be selected for acceptance.
import type { HandoffDto, HandoffItemDto } from "@wardenx/types";
import { Button, LoadingSpinner, Modal, StatusPill } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  CHOOSE_ACCEPT_TEXT,
  HANDOFF_NOTICE,
  HANDOFF_STATE_LABELS,
  ITEM_KIND_LABELS,
  ITEM_STATE_LABELS,
  RESTRICTED_PATIENT_LABEL,
  SUMMARY_TEXT,
  formatWhen,
  handoffActionErrorText,
  isStaleRefusal,
} from "./handoff-wording";
import { type HandoffResult, useHandoffActions } from "./use-handoffs";
import "./tasks.css";
import "./handoffs.css";

const humanize = (value: string): string => value.replace(/_/g, " ");

export function itemSummaryText(item: HandoffItemDto): string {
  const { summary } = item;
  if (summary.state === "gone") return SUMMARY_TEXT.gone;
  if (summary.state === "unavailable") return SUMMARY_TEXT.unavailable;
  if (summary.state === "restricted") return SUMMARY_TEXT.restricted;
  const parts = [
    summary.status ? humanize(summary.status) : null,
    summary.occurred_at ? formatWhen(summary.occurred_at) || null : null,
    summary.still_open === false ? SUMMARY_TEXT.closedOut : null,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}

const selectable = (item: HandoffItemDto): boolean =>
  item.state === "pending" && item.summary.state === "ok";

interface PatientGroup {
  readonly key: string;
  readonly title: string;
  readonly items: readonly HandoffItemDto[];
}

function groupByPatient(items: readonly HandoffItemDto[]): readonly PatientGroup[] {
  const groups = new Map<string, HandoffItemDto[]>();
  for (const item of items) {
    // A restricted item shares one unlabelled group: whatever identity fields it carries are ignored.
    const key =
      item.summary.state === "restricted" ? "restricted" : (item.patient_id ?? "restricted");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const first = rows[0];
    const name = first?.summary.state === "restricted" ? null : first?.patient_display_name;
    return {
      key,
      title: name
        ? `${name}${first?.mrn_suffix ? ` (MRN ...${first.mrn_suffix})` : ""}`
        : RESTRICTED_PATIENT_LABEL,
      items: rows,
    };
  });
}

function ItemRow({
  item,
  pickable,
  checked,
  disabled,
  onToggle,
}: {
  item: HandoffItemDto;
  pickable: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  const text = (
    <span>
      {ITEM_KIND_LABELS[item.kind]}: {itemSummaryText(item) || "No details"}.{" "}
      {ITEM_STATE_LABELS[item.state]}
      {item.state === "accepted" && item.accountable_display_name
        ? ` by ${item.accountable_display_name}`
        : ""}
    </span>
  );
  if (!pickable)
    return (
      <li>
        <div className="wx-handoff-check">{text}</div>
      </li>
    );
  return (
    <li>
      <label className="wx-handoff-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || !selectable(item)}
          onChange={onToggle}
        />
        {text}
      </label>
    </li>
  );
}

export interface HandoffReviewDialogProps {
  readonly handoffId: string;
  readonly onClose: () => void;
  /** The list behind should re-read (something changed, or the server said this handoff is gone or changed). */
  readonly onChanged: () => void;
}

export function HandoffReviewDialog({
  handoffId,
  onClose,
  onChanged,
}: HandoffReviewDialogProps): JSX.Element {
  const actions = useHandoffActions();
  const [handoff, setHandoff] = useState<HandoffDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  // The handoff this dialog currently shows; null once unmounted. A response for any other id is dropped.
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    activeId.current = handoffId;
    inFlight.current = false;
    setHandoff(null);
    setLoadFailed(false);
    setSelected(new Set());
    setBusy(false);
    setError(null);
    return () => {
      activeId.current = null;
    };
  }, [handoffId]);

  const load = useCallback(async (): Promise<void> => {
    const result = await actions.get(handoffId);
    if (activeId.current !== handoffId) return;
    if (result.ok) {
      setHandoff(result.data.handoff);
      setLoadFailed(false);
    } else {
      // Never leave the previous allowed_actions usable once the server can no longer confirm them.
      setHandoff(null);
      setSelected(new Set());
      setLoadFailed(true);
    }
  }, [actions, handoffId]);

  useEffect(() => {
    void load();
  }, [load]);

  // After a reload or an action the control that had focus may be gone: land on the heading, not <body>.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the handoff is replaced
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (!document.activeElement || document.activeElement === document.body)
      headingRef.current?.focus();
  }, [handoff]);

  async function run(
    work: () => Promise<HandoffResult<{ handoff: HandoffDto }>>,
    done: string,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMessage("");
    const result = await work();
    if (activeId.current !== handoffId) {
      if (result.ok || isStaleRefusal(result.status)) onChanged();
      return;
    }
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      refocus.current = true;
      setSelected(new Set());
      setMessage(done);
      onChanged();
      if (result.data.handoff.items) setHandoff(result.data.handoff);
      else await load();
      return;
    }
    setError(handoffActionErrorText(result.status, result.code));
    // A task that cannot move keeps the dialog and the selection as they are; a stale answer reloads both views.
    if (isStaleRefusal(result.status)) {
      refocus.current = true;
      setSelected(new Set());
      onChanged();
      await load();
    }
  }

  const items = handoff?.items ?? [];
  const can = (action: "accept" | "decline" | "cancel"): boolean =>
    handoff?.allowed_actions.includes(action) ?? false;
  const chosen = [...selected];

  function accept(): void {
    if (chosen.length === 0) {
      setError(CHOOSE_ACCEPT_TEXT);
      return;
    }
    void run(() => actions.accept(handoffId, chosen), "Selected items accepted.");
  }

  return (
    <Modal open onClose={busy ? undefined : onClose} ariaLabel="Handoff" width="40rem">
      <div className="wx-task-form">
        <h2 ref={headingRef} tabIndex={-1}>
          Handoff
        </h2>
        {!handoff && !loadFailed ? <LoadingSpinner /> : null}
        {loadFailed && !handoff ? (
          <p className="wx-task-error" role={error ? undefined : "alert"}>
            {handoffActionErrorText(404, undefined)}
          </p>
        ) : null}
        {handoff ? (
          <>
            <p className="wx-task-notice">{HANDOFF_NOTICE}</p>
            <div className="wx-task-badges">
              <StatusPill
                label={HANDOFF_STATE_LABELS[handoff.state]}
                tone={
                  handoff.state === "accepted"
                    ? "success"
                    : handoff.state === "offered"
                      ? "progress"
                      : "neutral"
                }
              />
            </div>
            {can("accept") ? (
              <p className="wx-handoff-muted">
                Choose the items you are taking over. Nothing is selected for you.
              </p>
            ) : null}
            <div className="wx-handoff-scroll">
              {groupByPatient(items).map((group) => (
                <div key={group.key} className="wx-handoff-patient">
                  <h4>{group.title}</h4>
                  <ul className="wx-handoff-checks">
                    {group.items.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        pickable={can("accept")}
                        checked={selected.has(item.id)}
                        disabled={busy}
                        onToggle={() =>
                          setSelected((now) => {
                            const next = new Set(now);
                            if (!next.delete(item.id)) next.add(item.id);
                            return next;
                          })
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        ) : null}
        <output className="sr-only" aria-live="polite">
          {message}
        </output>
        {error ? (
          <p className="wx-task-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={busy} onClick={onClose}>
            Close
          </Button>
          {can("cancel") ? (
            <Button
              type="button"
              tone="secondary"
              disabled={busy}
              onClick={() => void run(() => actions.cancel(handoffId), "Offer withdrawn.")}
            >
              Cancel offer
            </Button>
          ) : null}
          {can("decline") ? (
            <Button
              type="button"
              tone="secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => actions.decline(handoffId, chosen.length > 0 ? chosen : undefined),
                  "Declined. The items stay with the sender.",
                )
              }
            >
              {chosen.length > 0 ? `Decline selected (${chosen.length})` : "Decline remaining"}
            </Button>
          ) : null}
          {can("accept") ? (
            <Button type="button" loading={busy} onClick={accept}>
              Accept selected ({chosen.length})
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
