// apps/web/src/modules/14-idg — WP 3.7 "Proposed from secure messages" section of the meeting detail. Metadata only: the
// patient, who proposed it and when. "Add to agenda" puts an `other` item (a pointer) on the agenda; "Decline" records a
// reason. Hidden while the tenant has proposals off (`enabled:false`) or there are none; every owner-route refusal reads
// as one neutral "no longer available" line. (No "Open message" link: agenda items do not carry the channel id.)
import { Button, Panel, SelectField, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type MeetingPromotionView,
  PROMOTION_REJECT_REASONS,
  type PromotionRejectReason,
  addAgendaItemFromPromotion,
  loadMeetingPromotions,
  rejectMeetingPromotion,
} from "./idg-api";
import { PatientLabel } from "./idg-people";
import {
  ADDED_TEXT,
  DECLINED_TEXT,
  GENERIC_FAILURE,
  LOAD_FAILED,
  NOT_AVAILABLE,
  PROPOSER_TEXT,
  REJECT_LABELS,
  SECTION_NOTICE,
  SECTION_TITLE,
} from "./promotion-wording";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly proposals: readonly MeetingPromotionView[] };

export interface MeetingPromotionsProps {
  readonly meetingId: string;
  /** Re-read the agenda after an item was added. */
  readonly onAgendaChanged: () => void;
}

const when = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

export function MeetingPromotions({
  meetingId,
  onAgendaChanged,
}: MeetingPromotionsProps): JSX.Element | null {
  const client = useApiClient();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [code, setCode] = useState<PromotionRejectReason>("not_clinically_relevant");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const statusRef = useRef<HTMLOutputElement>(null);
  const restoreFocusTo = useRef<string | null>(null);

  // The Decline button is unmounted while its form is open: focus it once the form has closed.
  useEffect(() => {
    if (decliningId || !restoreFocusTo.current) return;
    document.getElementById(restoreFocusTo.current)?.focus();
    restoreFocusTo.current = null;
  }, [decliningId]);

  const read = useCallback(async (): Promise<void> => {
    try {
      const res = await loadMeetingPromotions(client, meetingId);
      setLoad(
        res.ok
          ? { kind: "ready", proposals: res.value.enabled === true ? res.value.promotions : [] }
          : { kind: "error" },
      );
    } catch {
      setLoad({ kind: "error" });
    }
  }, [client, meetingId]);

  useEffect(() => {
    void read();
  }, [read]);

  /** Run one decision; a refused or finished proposal leaves the list, so re-read and land on the heading. */
  async function decide(
    id: string,
    run: () => Promise<{ ok: boolean; code?: string | null }>,
    success: string,
  ): Promise<void> {
    setBusyId(id);
    setMessage("");
    const res = await run().catch(() => ({ ok: false, code: null }));
    setBusyId(null);
    setDecliningId(null);
    setFailed(!res.ok);
    setMessage(
      res.ok ? success : res.code === "PROMOTION_NOT_AVAILABLE" ? NOT_AVAILABLE : GENERIC_FAILURE,
    );
    if (res.ok || res.code === "PROMOTION_NOT_AVAILABLE") {
      await read();
      statusRef.current?.focus();
    }
  }

  if (load.kind === "loading") return null;
  if (load.kind === "error") {
    return (
      <p role="alert" style={errorText}>
        {LOAD_FAILED}
      </p>
    );
  }
  if (load.proposals.length === 0 && !message) return null;

  return (
    <Panel title={SECTION_TITLE} icon="message-square" description={SECTION_NOTICE} flush>
      <div style={section}>
        <output
          ref={statusRef}
          tabIndex={-1}
          aria-live="polite"
          role={failed ? "alert" : undefined}
          style={failed ? errorText : meta}
        >
          {message}
        </output>
        <ul style={list}>
          {load.proposals.map((p) => (
            <li key={p.request_id} style={item} aria-label={`Proposal ${p.request_id}`}>
              <PatientLabel patientId={p.patientId} patient={p.patient} />
              <p style={meta}>
                Proposed by {PROPOSER_TEXT} on {when(p.requested_at)}. Message sent{" "}
                {when(p.source_sent_at)}.
              </p>
              {decliningId === p.request_id ? (
                <div style={stack}>
                  <SelectField
                    label="Reason for declining"
                    value={code}
                    autoFocus
                    onChange={(event) => setCode(event.target.value as PromotionRejectReason)}
                    options={PROMOTION_REJECT_REASONS.map((r) => ({
                      value: r,
                      label: REJECT_LABELS[r],
                    }))}
                  />
                  <div style={actions}>
                    <Button
                      tone="secondary"
                      size="sm"
                      disabled={busyId === p.request_id}
                      onClick={() => {
                        restoreFocusTo.current = `m14-promo-decline-${p.request_id}`;
                        setDecliningId(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={busyId === p.request_id}
                      onClick={() =>
                        void decide(
                          p.request_id,
                          () => rejectMeetingPromotion(client, meetingId, p.request_id, code),
                          DECLINED_TEXT,
                        )
                      }
                    >
                      Decline proposal
                    </Button>
                  </div>
                </div>
              ) : (
                <div style={actions}>
                  <Button
                    size="sm"
                    disabled={busyId === p.request_id}
                    onClick={() =>
                      void decide(
                        p.request_id,
                        async () => {
                          const res = await addAgendaItemFromPromotion(
                            client,
                            meetingId,
                            p.request_id,
                          );
                          if (res.ok) onAgendaChanged();
                          return res;
                        },
                        ADDED_TEXT,
                      )
                    }
                  >
                    Add to agenda
                  </Button>
                  <Button
                    id={`m14-promo-decline-${p.request_id}`}
                    tone="secondary"
                    size="sm"
                    disabled={busyId === p.request_id}
                    onClick={() => {
                      setMessage("");
                      setDecliningId(p.request_id);
                    }}
                  >
                    Decline
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.5rem" };
const section: CSSProperties = { ...stack, padding: "0.5rem 1.125rem 1rem" };
const meta: CSSProperties = { margin: 0, fontSize: "0.72rem", color: t.onSurfaceVariant };
const errorText: CSSProperties = { ...meta, color: t.error };
const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const item: CSSProperties = {
  ...stack,
  padding: "0.75rem 0",
  borderTop: `1px solid ${t.outlineVariant}`,
};
const actions: CSSProperties = { display: "flex", gap: "0.5rem", flexWrap: "wrap" };
