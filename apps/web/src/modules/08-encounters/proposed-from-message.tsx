// apps/web/src/modules/08-encounters — WP 3.7 "Proposed from a secure message" section of the addenda panel.
// Lists the pending proposals for this encounter. The quoted text is read-only and is NEVER copied into the addendum:
// "Start my addendum" opens a form where the reviewer writes their own reason, and the draft is linked to the proposal.
// Signing that addendum (existing flow, step-up) is the accept; "Decline" records a reason. Hidden while the tenant has
// proposals off (`enabled:false`) or there are none; any server refusal reads as "no longer available".
import { Button, SelectField, TextAreaField, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  PROMOTION_REJECT_REASONS,
  type PromotionProposalView,
  type PromotionRejectReason,
  createAddendumFromPromotion,
  loadEncounterPromotions,
  rejectEncounterPromotion,
} from "./addenda-api";
import {
  CREATE_CONFLICT,
  DECLINED,
  DRAFT_CREATED,
  EDITED_SINCE_WARNING,
  GENERIC_FAILURE,
  LOAD_FAILED,
  MIN_REASON_LENGTH,
  NOT_AVAILABLE,
  NO_TEXT_AVAILABLE,
  PROPOSER_TEXT,
  REASON_LABEL,
  REASON_TOO_SHORT,
  REJECT_LABELS,
  SECTION_NOTICE,
  SECTION_TITLE,
  SNAPSHOT_LABEL,
} from "./promotion-wording";

/** `hidden`: the viewer may not read proposals (the read route needs encounter.addendum_author) - show nothing. */
const HIDDEN_STATUSES: readonly (number | null)[] = [401, 403, 404];

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "hidden" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly proposals: readonly PromotionProposalView[] };

type Mode = { readonly id: string; readonly kind: "start" | "decline" } | null;

export interface ProposedFromMessageProps {
  readonly encounterId: string;
  /** Re-read the encounter after a draft addendum is created. */
  readonly onChanged: () => void;
}

const when = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

export function ProposedFromMessage({
  encounterId,
  onChanged,
}: ProposedFromMessageProps): JSX.Element | null {
  const client = useApiClient();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState("");
  const [code, setCode] = useState<PromotionRejectReason>("not_clinically_relevant");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // The status line stays mounted whenever the section can show, so focus has a stable home when the last proposal leaves.
  const statusRef = useRef<HTMLOutputElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<string | null>(null);
  const focusStatusAfterRead = useRef(false);
  const latestRead = useRef(0);

  // The opener is unmounted while its form is open: focus it once the form has closed.
  useEffect(() => {
    if (mode || !restoreFocusTo.current) return;
    document.getElementById(restoreFocusTo.current)?.focus();
    restoreFocusTo.current = null;
  }, [mode]);

  const read = useCallback(async (): Promise<void> => {
    const id = ++latestRead.current;
    let next: Load;
    try {
      const res = await loadEncounterPromotions(client, encounterId);
      if (res.ok) {
        next = {
          kind: "ready",
          proposals: res.value.enabled === true ? res.value.promotions : [],
        };
      } else {
        next = HIDDEN_STATUSES.includes(res.status) ? { kind: "hidden" } : { kind: "error" };
      }
    } catch {
      next = { kind: "error" };
    }
    // A superseded read, or one that finished after unmount, must not write state.
    if (id === latestRead.current) setLoad(next);
  }, [client, encounterId]);

  useEffect(() => {
    void read();
    return () => {
      latestRead.current += 1;
    };
  }, [read]);

  // Land on the status line once the re-read has rendered (the heading may be gone with the last proposal).
  useEffect(() => {
    if (!focusStatusAfterRead.current || load.kind === "loading") return;
    focusStatusAfterRead.current = false;
    statusRef.current?.focus();
  }, [load]);

  function open(id: string, kind: "start" | "decline"): void {
    setMode({ id, kind });
    setNotice("");
    setText("");
    setError(null);
  }

  function cancel(): void {
    restoreFocusTo.current = mode ? `${OPENER_PREFIX}${mode.id}-${mode.kind}` : null;
    setMode(null);
    setError(null);
  }

  /** The proposal left the list (decided, withdrawn or moved on): re-read and land on the heading. */
  async function settle(message: string | null, done = ""): Promise<void> {
    setMode(null);
    setError(message);
    setNotice(done);
    focusStatusAfterRead.current = true;
    await read();
  }

  async function start(id: string): Promise<void> {
    if (text.trim().length < MIN_REASON_LENGTH) {
      setError(REASON_TOO_SHORT);
      textRef.current?.querySelector("textarea")?.focus();
      return;
    }
    setBusy(true);
    const res = await createAddendumFromPromotion(client, encounterId, text.trim(), id).catch(
      () => null,
    );
    setBusy(false);
    if (res?.ok) {
      onChanged();
      return settle(null, DRAFT_CREATED);
    }
    if (res?.code === "PROMOTION_NOT_AVAILABLE") return settle(NOT_AVAILABLE);
    setError(res?.status === 409 ? CREATE_CONFLICT : GENERIC_FAILURE);
  }

  async function decline(id: string): Promise<void> {
    setBusy(true);
    const res = await rejectEncounterPromotion(client, encounterId, id, code).catch(() => null);
    setBusy(false);
    if (res?.ok) return settle(null, DECLINED);
    if (res?.code === "PROMOTION_NOT_AVAILABLE") return settle(NOT_AVAILABLE);
    setError(GENERIC_FAILURE);
  }

  if (load.kind === "loading" || load.kind === "hidden") return null;
  if (load.kind === "error") {
    return (
      <p role="alert" style={errorText}>
        {LOAD_FAILED}
      </p>
    );
  }
  const status = (
    <output ref={statusRef} tabIndex={-1} style={meta}>
      {notice}
    </output>
  );
  if (load.proposals.length === 0) {
    if (!error && !notice) return null;
    return (
      <div style={stack}>
        {status}
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="m8-proposals-heading" style={section}>
      <h3 id="m8-proposals-heading" style={heading}>
        {SECTION_TITLE}
      </h3>
      <p style={meta}>{SECTION_NOTICE}</p>
      {status}
      {error && !mode ? (
        <p role="alert" style={errorText}>
          {error}
        </p>
      ) : null}
      <ul style={list}>
        {load.proposals.map((p) => (
          <li
            key={p.request_id}
            style={item}
            aria-labelledby={`${OPENER_PREFIX}${p.request_id}-who`}
          >
            <p id={`${OPENER_PREFIX}${p.request_id}-who`} style={meta}>
              Proposed by {PROPOSER_TEXT} on {when(p.requested_at)}. Message sent{" "}
              {when(p.source_sent_at)}.
            </p>
            {p.snapshot_text ? (
              <figure style={quote}>
                <figcaption style={meta}>{SNAPSHOT_LABEL}</figcaption>
                <blockquote style={quoteText}>{p.snapshot_text}</blockquote>
              </figure>
            ) : (
              <p style={meta}>{NO_TEXT_AVAILABLE}</p>
            )}
            {p.source_state === "edited_since" ? (
              <p role="note" style={warning}>
                {EDITED_SINCE_WARNING}
              </p>
            ) : null}
            {mode?.id === p.request_id ? (
              <div style={form} ref={textRef}>
                {mode.kind === "start" ? (
                  <TextAreaField
                    label={REASON_LABEL}
                    value={text}
                    error={error}
                    autoFocus
                    onChange={(event) => setText(event.target.value)}
                  />
                ) : (
                  <SelectField
                    label="Reason for declining"
                    value={code}
                    error={error}
                    autoFocus
                    onChange={(event) => setCode(event.target.value as PromotionRejectReason)}
                    options={PROMOTION_REJECT_REASONS.map((r) => ({
                      value: r,
                      label: REJECT_LABELS[r],
                    }))}
                  />
                )}
                <div style={actions}>
                  <Button tone="secondary" size="sm" disabled={busy} onClick={cancel}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void (mode.kind === "start" ? start(p.request_id) : decline(p.request_id))
                    }
                  >
                    {mode.kind === "start" ? "Create my addendum draft" : "Decline proposal"}
                  </Button>
                </div>
              </div>
            ) : (
              <div style={actions}>
                <Button
                  id={`${OPENER_PREFIX}${p.request_id}-start`}
                  size="sm"
                  onClick={() => open(p.request_id, "start")}
                >
                  Start my addendum
                </Button>
                <Button
                  id={`${OPENER_PREFIX}${p.request_id}-decline`}
                  tone="secondary"
                  size="sm"
                  onClick={() => open(p.request_id, "decline")}
                >
                  Decline
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const OPENER_PREFIX = "m8-promo-";
const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.5rem" };
const section: CSSProperties = { ...stack, paddingTop: "0.85rem" };
const heading: CSSProperties = { margin: 0, fontSize: "0.9rem", color: t.onSurface };
const meta: CSSProperties = { margin: 0, fontSize: "0.72rem", color: t.onSurfaceVariant };
const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const item: CSSProperties = {
  ...stack,
  padding: "0.85rem 0",
  borderTop: `1px solid ${t.outlineVariant}`,
};
const quote: CSSProperties = { margin: 0, ...stack, gap: "0.2rem" };
const quoteText: CSSProperties = {
  margin: 0,
  paddingLeft: "0.7rem",
  borderLeft: `3px solid ${t.outlineVariant}`,
  fontSize: "0.82rem",
  color: t.onSurface,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
const warning: CSSProperties = { ...meta, color: t.error, fontWeight: 650 };
const errorText: CSSProperties = { ...meta, color: t.error };
const form: CSSProperties = { ...stack, gap: "0.6rem" };
const actions: CSSProperties = { display: "flex", gap: "0.5rem", flexWrap: "wrap" };
