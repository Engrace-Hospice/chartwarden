import { Button, Modal, TextAreaField } from "@wardenx/ui";
// apps/web/src/modules/26-cap — GAP-079: the write half of the M26 screens. Every cap mutation (settlement
// propose / finalize, period close / reopen, PS&R variance resolve, threshold-event acknowledge) is the same
// shape — a confirm dialog, an optional required reason, one request, a refusal rendered in place — so they
// share this one dialog + request helper instead of six near-copies. The SERVER stays authoritative for every
// permission, ABAC and step-up rule (cap.*.manage / cap_period_* predicates / STEP_UP): this file only turns a
// `STEP_UP_REQUIRED` refusal into the existing `/step-up?returnTo=` ceremony and shows any other refusal.
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";

/** `PATCH`/`POST` with a path template + params, as the typed client accepts them (casts live here only). */
type CapMethod = "POST" | "PATCH";
interface LooseClient {
  POST(path: string, init: unknown): Promise<{ error?: unknown }>;
  PATCH(path: string, init: unknown): Promise<{ error?: unknown }>;
}

/** Send one cap mutation. Returns the refusal body, or `null` on success. */
export async function sendCapMutation(
  client: unknown,
  method: CapMethod,
  path: string,
  pathParams: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<unknown | null> {
  const init = { params: { path: pathParams }, ...(body ? { body } : {}) };
  const res = await (client as LooseClient)[method](path, init);
  return res.error ?? null;
}

/** A human line for a refusal body (RFC 7807 `detail`/`title` first, then a status-based fallback). */
export function capErrorMessage(error: unknown, fallback: string): string {
  const body = error as { detail?: string; title?: string; status?: number } | null | undefined;
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 403) return "You do not hold the authority this cap action requires.";
  if (body?.status === 409) return "The period or settlement is not in a state that allows this.";
  return fallback;
}

export interface CapActionChoice {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export interface CapActionDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly hint: string;
  readonly submitLabel: string;
  readonly tone?: "primary" | "danger";
  /** When set the dialog collects a REQUIRED free-text entry (reason / attestation / notes). */
  readonly textLabel?: string;
  readonly textMinLength?: number;
  /** When set the dialog collects a required choice (e.g. a variance reason). */
  readonly choice?: CapActionChoice;
  readonly onClose: () => void;
  /** Runs the request; resolve the refusal body (shown in place / step-up redirected) or `null` on success. */
  readonly onSubmit: (input: { text: string; choice: string }) => Promise<unknown | null>;
  /** Called after a successful request (the screen reloads). */
  readonly onDone: () => void;
  readonly children?: ReactNode;
}

const FALLBACK_ERROR = "The action could not be completed.";

export function CapActionDialog(props: CapActionDialogProps): JSX.Element {
  const { open, title, hint, submitLabel, tone = "primary", textLabel, choice } = props;
  const minLength = props.textMinLength ?? 1;
  const navigate = useNavigate();
  const location = useLocation();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textReady = textLabel === undefined || text.trim().length >= minLength;
  const choiceReady = choice === undefined || picked !== "";
  const ready = !busy && textReady && choiceReady;

  const close = (): void => {
    setText("");
    setPicked("");
    setError(null);
    props.onClose();
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const refusal = await props.onSubmit({ text: text.trim(), choice: picked });
    setBusy(false);
    if (refusal === null) {
      setText("");
      setPicked("");
      props.onDone();
      return;
    }
    const stepUp = stepUpRedirectFor(refusal, `${location.pathname}${location.search}`);
    if (stepUp) {
      navigate(stepUp);
      return;
    }
    setError(capErrorMessage(refusal, FALLBACK_ERROR));
  };

  return (
    <Modal open={open} onClose={busy ? undefined : close} ariaLabel={title} width="30rem">
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={titleStyle}>{title}</h2>
        <p style={hintStyle}>{hint}</p>
        {props.children}
        {choice ? (
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span style={hintStyle}>{choice.label}</span>
            <select
              aria-label={choice.label}
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              style={{ height: "2.25rem", fontSize: "0.85rem" }}
            >
              <option value="">Select…</option>
              {choice.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {textLabel ? (
          <TextAreaField
            label={textLabel}
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : null}
        {textLabel && minLength > 1 ? (
          <p style={hintStyle}>
            At least {minLength} characters ({Math.max(0, minLength - text.trim().length)} to go).
          </p>
        ) : null}
        {error ? (
          <p role="alert" style={{ ...hintStyle, color: "var(--color-error)" }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button tone={tone} disabled={!ready} loading={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const titleStyle = { margin: 0, fontSize: "1.1rem", fontWeight: 600 } as const;
const hintStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
