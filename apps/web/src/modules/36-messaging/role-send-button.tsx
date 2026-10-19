// M36 role-based send (ADR-0081, PROPOSED) - the composer's "Message on-call role" action, beside Urgent clinical and Needs a response.
// Offered only when ALL of these hold: the tenant flag `messaging.role_send` is on (no flag provider mounted reads as OFF), the person
// holds messaging.send + messaging.urgent.send + messaging.oncall.send, the conversation is a patient's care-team conversation, and the
// Urgent clinical options route (shared: it supplies the patient and says the urgent mode is on) allows it. The server stays the
// authority on every one of them. The draft and the send attempt live here, keyed by channel, so a close/reopen keeps them; the outcome
// stays on screen in a focusable status that clears after a while or when the composer text changes.
import type { OnCallDirectoryRole } from "@chartwarden/types";
import {
  ROLE_SEND_FLAG_KEY,
  ROLE_SEND_PERMISSION,
  URGENT_SEND_PERMISSION,
} from "@chartwarden/types";
import { Button, useFeatureFlag } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import type { ChannelKind } from "./messaging-types";
import { RoleSendDialog, type RoleSent } from "./role-send-dialog";
import { ROLE_SEND_BUTTON_LABEL, SENT_REPLAY_TEXT, sentText } from "./role-send-wording";
import { useOfflineGate } from "./use-offline-gate";
import { useUrgentDraft } from "./use-urgent-draft";
import { useUrgentOptions } from "./use-urgent-options";
import "./urgent.css";

const SEND_PERMISSION = "messaging.send";
/** How long the "sent" status stays on screen. */
export const ROLE_SEND_STATUS_MS = 20_000;

function useFlag(key: string): boolean {
  try {
    return useFeatureFlag(key);
  } catch {
    return false; // no provider mounted: fail closed
  }
}

interface ButtonProps {
  channelId: string;
  kind: ChannelKind;
  disabled?: boolean;
  /** The conversation's message list is re-read (a message was sent, or a failed send may have stored one). */
  onThreadChanged?: () => void;
  /** Changes whenever the composer text changes: the previous outcome is no longer news. */
  statusResetKey?: string;
}

/** Keyed by channel so every piece of state (options, draft, ids, status, open dialog) starts clean on a switch. */
export function RoleSendButton(props: ButtonProps): JSX.Element | null {
  const permissions = useSession()?.permissions;
  const allowed = [SEND_PERMISSION, URGENT_SEND_PERMISSION, ROLE_SEND_PERMISSION].every((key) =>
    permissions?.includes(key),
  );
  const flagOn = useFlag(ROLE_SEND_FLAG_KEY);
  if (!(flagOn && allowed && props.kind === "care_team")) return null;
  return <RoleSendControl key={props.channelId} {...props} />;
}

function RoleSendControl({
  channelId,
  disabled = false,
  onThreadChanged,
  statusResetKey,
}: ButtonProps): JSX.Element | null {
  const options = useUrgentOptions(channelId, false);
  const draft = useUrgentDraft();
  const gate = useOfflineGate();
  const { online } = gate;
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<OnCallDirectoryRole | null>(null);
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      // A send still in flight when the person leaves this conversation must not touch the next one.
      mounted.current = false;
    };
  }, []);
  // The trigger is the one stable control: focus returns to it whenever the dialog closes.
  useEffect(() => {
    if (wasOpen.current && !open) rootRef.current?.querySelector("button")?.focus();
    wasOpen.current = open;
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusResetKey is the trigger
  useEffect(() => setStatus(""), [statusResetKey]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), ROLE_SEND_STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // A definitive "no" (urgent mode off, no patient, 401/403/404) reads as hidden; the patient comes from the same read.
  if (options.status !== "ready" || !options.options.patient_id) return null;
  const patientId = options.options.patient_id;
  const sentLine = (sent: RoleSent): string =>
    sent.created ? sentText(sent.role, sent.name) : SENT_REPLAY_TEXT;
  return (
    <div className="wx-urgent" ref={rootRef}>
      <Button
        type="button"
        tone="secondary"
        size="lg"
        disabled={disabled}
        {...gate.controlProps}
        onClick={() => {
          if (!online) return gate.onBlocked();
          setStatus("");
          setOpen(true);
        }}
      >
        {ROLE_SEND_BUTTON_LABEL}
      </Button>
      {gate.hint}
      {open ? (
        <RoleSendDialog
          channelId={channelId}
          patientId={patientId}
          draft={draft}
          role={role}
          onRoleChange={setRole}
          onClose={() => setOpen(false)}
          onSent={(sent) => {
            if (!mounted.current) return;
            draft.reset();
            setRole(null);
            setStatus(sentLine(sent));
            setOpen(false);
            onThreadChanged?.();
          }}
          onIndeterminate={() => {
            if (mounted.current) onThreadChanged?.();
          }}
        />
      ) : null}
      <output className="wx-urgent-status" tabIndex={status ? 0 : undefined}>
        {status}
      </output>
    </div>
  );
}
