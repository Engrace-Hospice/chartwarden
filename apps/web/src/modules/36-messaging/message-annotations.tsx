// WP 2.4: reactions and pin on one message row. Self-contained: it owns its optimistic-free state (the answer of the
// server replaces the view), so the timeline and the thread panel use it without any wiring.
//
// A reaction is NOT a sign-off: separate controls, separate wording, and the picker says so out loud. There is
// no control here (or anywhere in the row) that confirms a message was read or acted on.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Message } from "./messaging-types";
import { notifyPinsChanged } from "./pin-events";
import { REACTION_NOT_ACK_COPY, REACTION_PALETTE, paletteEntry } from "./reaction-palette";
import "./message-annotations.css";

type Reactions = NonNullable<Message["reactions"]>;
interface View {
  readonly reactions: Reactions;
  readonly pinned: boolean;
}

const BASE = "/api/v1/messaging/channels/{id}/messages/{messageId}";

type Kind = "reaction" | "pin";

function failureCopy(status: number | undefined, kind: Kind): string {
  if (status === 410) return "This conversation is archived and read only.";
  if (status === 404 || status === 403) return "This message is no longer available.";
  if (status === 409) {
    return kind === "pin"
      ? "This conversation already has the most pinned messages it can hold."
      : "That reaction could not be saved right now. Try again.";
  }
  return "That did not work. Try again.";
}

interface MessageAnnotationsProps {
  readonly message: Message;
  /** False in an archived channel or on a deleted message: the existing reactions still show, nothing changes. */
  readonly canAnnotate: boolean;
  /** Pin/unpin is offered in the conversation timeline only. */
  readonly canPin: boolean;
}

export function MessageAnnotations({
  message,
  canAnnotate,
  canPin,
}: MessageAnnotationsProps): JSX.Element | null {
  const client = useApiClient();
  const [override, setOverride] = useState<View | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLFieldSetElement>(null);
  const busyRef = useRef(false);

  // A fresh read of the message (poll, hint) is the truth; drop whatever our last answer said.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the server's values change identity
  useEffect(() => setOverride(null), [message.reactions, message.pinned]);

  const view: View = override ?? {
    reactions: message.reactions ?? [],
    pinned: message.pinned === true,
  };
  const path = { id: message.channelId, messageId: message.messageId };

  useEffect(() => {
    if (!pickerOpen) return;
    pickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointer = (event: MouseEvent): void => {
      const root = pickerRef.current?.parentElement;
      if (root && !root.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [pickerOpen]);

  async function run(
    kind: Kind,
    work: () => Promise<{ ok: true; note: string } | { ok: false; status?: number }>,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await work();
      if (result.ok) setAnnouncement(result.note);
      else {
        const text = failureCopy(result.status, kind);
        setFailure(text);
        setAnnouncement(text);
      }
    } catch {
      const text = failureCopy(undefined, kind);
      setFailure(text);
      setAnnouncement(text);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function toggleReaction(emoji: Reactions[number]["emoji"], present: boolean): Promise<void> {
    const label = paletteEntry(emoji)?.label ?? emoji;
    return run("reaction", async () => {
      const params = { params: { path: { ...path, emoji } } };
      const { data, error, response } = present
        ? await client.PUT(`${BASE}/reactions/{emoji}`, params)
        : await client.DELETE(`${BASE}/reactions/{emoji}`, params);
      if (error || !data) return { ok: false, status: response?.status };
      setOverride({ reactions: data.reactions as Reactions, pinned: view.pinned });
      return { ok: true, note: `${label} reaction ${present ? "added" : "removed"}.` };
    });
  }

  function togglePin(pin: boolean): Promise<void> {
    return run("pin", async () => {
      const params = { params: { path } };
      const { error, response } = pin
        ? await client.PUT(`${BASE}/pin`, params)
        : await client.DELETE(`${BASE}/pin`, params);
      if (error) return { ok: false, status: response?.status };
      setOverride({ reactions: view.reactions, pinned: pin });
      notifyPinsChanged(message.channelId);
      return { ok: true, note: pin ? "Message pinned." : "Message unpinned." };
    });
  }

  function closePicker(restoreFocus: boolean): void {
    setPickerOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function onPickerKeyDown(event: KeyboardEvent<HTMLFieldSetElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePicker(true);
    }
  }

  if (!canAnnotate && view.reactions.length === 0 && !view.pinned) return null;

  return (
    <div className="wx-message-annotations">
      {view.pinned ? <span className="wx-pinned-badge">Pinned</span> : null}
      {view.reactions.map((reaction) => {
        const entry = paletteEntry(reaction.emoji);
        if (!entry) return null;
        const count = `${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}`;
        return (
          <button
            key={reaction.emoji}
            type="button"
            className="wx-reaction-chip"
            aria-pressed={reaction.reactedByMe}
            aria-label={`${entry.label}, ${count}${
              reaction.reactedByMe ? ", including yours" : ""
            }. ${canAnnotate ? (reaction.reactedByMe ? "Remove your reaction" : "Add your reaction") : "Read only"}`}
            aria-disabled={!canAnnotate || busy}
            onClick={() => {
              if (!canAnnotate || busyRef.current) return;
              void toggleReaction(reaction.emoji, !reaction.reactedByMe);
            }}
          >
            <span aria-hidden="true">{entry.glyph}</span>
            <span aria-hidden="true">{reaction.count}</span>
          </button>
        );
      })}
      {canAnnotate ? (
        <span className="wx-reaction-picker-anchor">
          <button
            ref={triggerRef}
            type="button"
            className="wx-reaction-add"
            aria-haspopup="true"
            aria-expanded={pickerOpen}
            aria-label="Add a reaction"
            title={REACTION_NOT_ACK_COPY}
            aria-disabled={busy}
            onClick={() => {
              if (busyRef.current) return;
              setPickerOpen((open) => !open);
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
          {pickerOpen ? (
            <fieldset ref={pickerRef} className="wx-reaction-picker" onKeyDown={onPickerKeyDown}>
              <legend className="sr-only">Choose a reaction</legend>
              <div className="wx-reaction-picker-options">
                {REACTION_PALETTE.map((entry) => {
                  const mine = view.reactions.find((r) => r.emoji === entry.key)?.reactedByMe;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      aria-pressed={mine === true}
                      aria-label={entry.label}
                      onClick={() => {
                        closePicker(true);
                        void toggleReaction(entry.key, mine !== true);
                      }}
                    >
                      <span aria-hidden="true">{entry.glyph}</span>
                    </button>
                  );
                })}
              </div>
              <small>{REACTION_NOT_ACK_COPY}</small>
            </fieldset>
          ) : null}
        </span>
      ) : null}
      {canAnnotate && canPin ? (
        <button
          type="button"
          className="wx-pin-toggle"
          aria-label={view.pinned ? "Unpin this message" : "Pin this message"}
          aria-disabled={busy}
          onClick={() => {
            if (busyRef.current) return;
            void togglePin(!view.pinned);
          }}
        >
          {view.pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      {failure ? (
        <span className="wx-annotation-error" role="alert">
          {failure}
        </span>
      ) : null}
    </div>
  );
}
