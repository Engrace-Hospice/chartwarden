import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the AUDIT REQUEST work rail (milestone 7a-1): the request, its linked claims
// (added through the shared claim lookup), its recorded deadlines (each typed from a notice, with a source note), and
// the state moves. The authority kind is a label only. A request with no recorded deadline says so loudly; the app
// never supplies a due date. The server owns every rule and its refusal is shown verbatim.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ClaimLookupField } from "../../shell/entity-lookups";
import {
  ActionRail,
  ButtonRow,
  ErrorAlert,
  Facts,
  FormButtons,
  Hint,
  NoticeAlert,
  RetryAlert,
} from "./action-ui";
import {
  type AuditRequestDetail,
  type AuditRequestState,
  isConflict,
  linkAuditClaim,
  loadAuditRequest,
  moveAuditRequest,
  unlinkAuditClaim,
} from "./audit-api";
import { AuditResponsePanel } from "./audit-response-panel";
import { CaseViewPanel } from "./case-view-panel";
import { RecordedDeadlines } from "./recorded-deadlines";
import { AUDIT_DUE_TONE, AUDIT_STATE_TONE, formatDay, humanize, toneOf } from "./remittance-status";

/** Mirrors the backend machine only to offer the legal moves; the server still decides. */
const MOVES: Record<string, readonly AuditRequestState[]> = {
  received: ["in_assembly", "withdrawn"],
  in_assembly: ["in_review", "withdrawn"],
  // A response is recorded by filing the signed-off packet (Response packet below), never by a bare move.
  in_review: ["withdrawn"],
  responded: ["closed", "withdrawn"],
};
const TERMINAL = new Set(["closed", "withdrawn"]);

/** The detail carries each claim's control number (resolved server-side); the id prefix is the fallback. */
function LinkedClaim({
  claimId,
  claimControlNumber,
  dateOfServiceNote,
  canUnlink,
  busy,
  onUnlink,
}: {
  readonly claimId: string;
  readonly claimControlNumber: string | null;
  readonly dateOfServiceNote: string | null;
  readonly canUnlink: boolean;
  readonly busy: boolean;
  readonly onUnlink: () => void;
}): JSX.Element {
  const name = claimControlNumber ?? claimId.slice(0, 8);
  return (
    <li>
      {name}
      {dateOfServiceNote ? ` · ${dateOfServiceNote}` : ""}{" "}
      {canUnlink ? (
        <Button
          size="sm"
          tone="tertiary"
          aria-label={`Unlink claim ${name}`}
          disabled={busy}
          onClick={onUnlink}
        >
          Unlink
        </Button>
      ) : null}
    </li>
  );
}

export function AuditDetailPanel({
  auditId,
  onClose,
  onChanged,
}: {
  readonly auditId: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [audit, setAudit] = useState<AuditRequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [move, setMove] = useState<AuditRequestState | null>(null);
  const [busy, setBusy] = useState(false);
  // A packet command is in flight: a state move waits, as both use the request's one If-Match version.
  const [packetBusy, setPacketBusy] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  // Claim link/unlink in flight (one at a time): disables the picker and the Unlink buttons.
  const [claimBusy, setClaimBusy] = useState(false);
  const claimsHeading = useRef<HTMLHeadingElement>(null);
  const moveHeading = useRef<HTMLHeadingElement>(null);
  const moveSeen = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A failed reload keeps the last good request on screen; the error shows inline (Retry only when nothing loaded yet).
  const load = useCallback(async () => {
    const res = await loadAuditRequest(client, auditId);
    if (!mounted.current) return;
    if (res.ok) {
      setAudit(res.value);
      setLoadError(null);
    } else setLoadError(res.message);
  }, [client, auditId]);

  // A remounted claim picker (and a collapsed move form) drops focus to <body>: hand it to the section heading.
  useEffect(() => {
    if (pickerKey > 0) claimsHeading.current?.focus();
  }, [pickerKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `move` is the trigger; the effect only moves focus
  useEffect(() => {
    if (!moveSeen.current) {
      moveSeen.current = true;
      return;
    }
    moveHeading.current?.focus();
  }, [move]);

  // After a terminal move the "Move this request" heading unmounts (and takes focus with it): hand focus to the
  // stable Claims heading, which stays on screen for every state.
  const wasTerminal = useRef(false);
  const isTerminal = audit ? TERMINAL.has(audit.state) : false;
  useEffect(() => {
    if (isTerminal && !wasTerminal.current) claimsHeading.current?.focus();
    wasTerminal.current = isTerminal;
  }, [isTerminal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh(): Promise<void> {
    await load();
    onChanged();
  }

  async function addClaim(claimId: string): Promise<void> {
    if (claimBusy || !audit) return;
    setError(null);
    setNotice(null);
    setClaimBusy(true);
    const res = await linkAuditClaim(client, auditId, audit.version, claimId);
    if (!mounted.current) return;
    setPickerKey((k) => k + 1);
    if (!res.ok) {
      setError(res.message);
      // A stale version: reload so the next attempt carries the request's new version.
      if (isConflict(res)) await load();
    } else await refresh();
    if (mounted.current) setClaimBusy(false);
  }

  async function removeClaim(claimId: string): Promise<void> {
    if (claimBusy || !audit) return;
    setError(null);
    setClaimBusy(true);
    const res = await unlinkAuditClaim(client, auditId, audit.version, claimId);
    if (!mounted.current) return;
    if (!res.ok) {
      setError(res.message);
      if (isConflict(res)) await load();
    } else await refresh();
    if (mounted.current) {
      setClaimBusy(false);
      claimsHeading.current?.focus();
    }
  }

  async function submitMove(): Promise<void> {
    if (!audit || !move) return;
    setBusy(true);
    setError(null);
    const res = await moveAuditRequest(client, auditId, audit.version, move);
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      // The request moved under us: fetch its new version; the chosen move and typed time stay for the retry.
      if (isConflict(res)) await load();
      return;
    }
    setNotice(`Moved to ${humanize(move)}.`);
    setMove(null);
    await refresh();
  }

  const terminal = audit ? TERMINAL.has(audit.state) : true;
  const firstClaim = audit?.claims[0]?.claimId;
  // Anything that bumps a version (the request or a deadline) or the claim count changes the case timeline.
  const caseViewKey = audit
    ? `${audit.version}:${audit.deadlines.map((d) => d.version).join(",")}:${audit.claims.length}`
    : "";

  return (
    <ActionRail ariaLabel="Audit request" onClose={onClose}>
      {!audit ? (
        loadError ? (
          <RetryAlert message={loadError} onRetry={() => void load()} />
        ) : (
          <LoadingSpinner />
        )
      ) : (
        <>
          {loadError ? <ErrorAlert message={loadError} /> : null}
          <Facts
            items={[
              [
                "Authority",
                `${humanize(audit.authorityKind)}${audit.authorityName ? ` · ${audit.authorityName}` : ""}`,
              ],
              ["Reference", audit.requestReference ?? "—"],
              ["Letter dated", formatDay(audit.requestDatedOn)],
              ["Received", formatDay(audit.receivedOn)],
              ["Scope", audit.scopeNote ?? "—"],
              [
                "State",
                <StatusPill
                  key="s"
                  label={humanize(audit.state)}
                  tone={toneOf(AUDIT_STATE_TONE, audit.state)}
                />,
              ],
              [
                "Deadline",
                <StatusPill
                  key="d"
                  label={humanize(audit.dueState)}
                  tone={toneOf(AUDIT_DUE_TONE, audit.dueState)}
                />,
              ],
              ["Responded", audit.respondedAt ? new Date(audit.respondedAt).toLocaleString() : "—"],
            ]}
          />
          <NoticeAlert message={notice} />
          <ErrorAlert message={error} />
          <RecordedDeadlines
            subject={{ kind: "audit", id: auditId }}
            deadlines={audit.deadlines}
            allowNoticeDocument
            noticeClaims={audit.claims.map((c) => ({
              value: c.claimId,
              label: c.claimControlNumber ?? c.claimId.slice(0, 8),
            }))}
            noneStatedAt={audit.response.deadlineNoneStatedAt}
            editable={!terminal}
            onChanged={() => void refresh()}
          />
          <section aria-label="Linked claims">
            <h3 className="wx-action-title" ref={claimsHeading} tabIndex={-1}>
              Claims
            </h3>
            {audit.claims.length === 0 ? (
              <Hint>No claims linked.</Hint>
            ) : (
              <ul className="wx-action-hint wx-action-list">
                {audit.claims.map((c) => (
                  <LinkedClaim
                    key={c.id}
                    claimId={c.claimId}
                    claimControlNumber={c.claimControlNumber}
                    dateOfServiceNote={c.dateOfServiceNote}
                    canUnlink={!terminal}
                    busy={claimBusy}
                    onUnlink={() => void removeClaim(c.claimId)}
                  />
                ))}
              </ul>
            )}
            {terminal ? null : (
              <ClaimLookupField
                key={pickerKey}
                label="Link a claim"
                value=""
                disabled={claimBusy}
                onChange={(id) => {
                  if (id) void addClaim(id);
                }}
              />
            )}
          </section>
          <AuditResponsePanel
            audit={audit}
            onChanged={refresh}
            onBusyChange={setPacketBusy}
            locked={busy}
          />
          {firstClaim ? (
            <CaseViewPanel key={firstClaim} claimId={firstClaim} refreshKey={caseViewKey} />
          ) : null}
          {audit.events.length > 0 ? (
            <section aria-label="Audit events">
              <h3 className="wx-action-title">Events</h3>
              <ul className="wx-action-hint wx-action-list">
                {audit.events.map((e) => (
                  <li key={e.id}>
                    {humanize(e.eventKind)} — {new Date(e.occurredAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {terminal ? null : (
            <h3 className="wx-action-title" ref={moveHeading} tabIndex={-1}>
              {move === null ? "Move this request" : `Moving to ${humanize(move)}`}
            </h3>
          )}
          {terminal ? null : move === null ? (
            <ButtonRow>
              {(MOVES[audit.state] ?? []).map((to) => (
                <Button
                  key={to}
                  tone="secondary"
                  size="sm"
                  disabled={packetBusy}
                  onClick={() => setMove(to)}
                >
                  {`Move to ${humanize(to)}`}
                </Button>
              ))}
            </ButtonRow>
          ) : (
            <>
              <FormButtons
                submitLabel={`Move to ${humanize(move)}`}
                busy={busy}
                blocked={false}
                danger={move === "withdrawn"}
                onSubmit={() => void submitMove()}
                onCancel={() => setMove(null)}
              />
            </>
          )}
        </>
      )}
      <ButtonRow end>
        <Button tone="tertiary" onClick={onClose}>
          Close panel
        </Button>
      </ButtonRow>
    </ActionRail>
  );
}
