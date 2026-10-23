import { Button, LoadingSpinner, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
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
} from "./action-ui";
import {
  type AuditRequestDetail,
  type AuditRequestState,
  linkAuditClaim,
  loadAuditRequest,
  moveAuditRequest,
  unlinkAuditClaim,
} from "./audit-api";
import { CaseViewPanel } from "./case-view-panel";
import { RecordedDeadlines } from "./recorded-deadlines";
import { AUDIT_DUE_TONE, AUDIT_STATE_TONE, humanize, toneOf } from "./remittance-status";

/** Mirrors the backend machine only to offer the legal moves; the server still decides. */
const MOVES: Record<string, readonly AuditRequestState[]> = {
  received: ["in_assembly", "withdrawn"],
  in_assembly: ["in_review", "withdrawn"],
  in_review: ["responded", "withdrawn"],
  responded: ["closed", "withdrawn"],
};
const TERMINAL = new Set(["closed", "withdrawn"]);

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
  const [respondedAt, setRespondedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadAuditRequest(client, auditId);
    if (!mounted.current) return;
    if (res.ok) {
      setAudit(res.value);
      setLoadError(null);
    } else setLoadError(res.message);
  }, [client, auditId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh(): Promise<void> {
    await load();
    onChanged();
  }

  async function addClaim(claimId: string): Promise<void> {
    setError(null);
    setNotice(null);
    const res = await linkAuditClaim(client, auditId, claimId);
    setPickerKey((k) => k + 1);
    if (!res.ok) setError(res.message);
    else await refresh();
  }

  async function removeClaim(claimId: string): Promise<void> {
    setError(null);
    const res = await unlinkAuditClaim(client, auditId, claimId);
    if (!res.ok) setError(res.message);
    else await refresh();
  }

  async function submitMove(): Promise<void> {
    if (!audit || !move) return;
    setBusy(true);
    setError(null);
    const at =
      move === "responded" && respondedAt ? new Date(respondedAt).toISOString() : undefined;
    const res = await moveAuditRequest(client, auditId, audit.version, move, at);
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice(`Moved to ${humanize(move)}.`);
    setMove(null);
    setRespondedAt("");
    await refresh();
  }

  const terminal = audit ? TERMINAL.has(audit.state) : true;
  const firstClaim = audit?.claims[0]?.claimId;

  return (
    <ActionRail ariaLabel="Audit request" onClose={onClose}>
      {loadError ? (
        <ErrorAlert message={loadError} />
      ) : !audit ? (
        <LoadingSpinner />
      ) : (
        <>
          <Facts
            items={[
              [
                "Authority",
                `${humanize(audit.authorityKind)}${audit.authorityName ? ` · ${audit.authorityName}` : ""}`,
              ],
              ["Reference", audit.requestReference ?? "—"],
              ["Letter dated", audit.requestDatedOn ?? "—"],
              ["Received", audit.receivedOn],
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
            allowNoticeDocument={false}
            editable={!terminal}
            onChanged={() => void refresh()}
          />
          <section aria-label="Linked claims">
            <h3 className="wx-action-title">Claims</h3>
            {audit.claims.length === 0 ? (
              <Hint>No claims linked.</Hint>
            ) : (
              <ul className="wx-action-hint wx-action-list">
                {audit.claims.map((c) => (
                  <li key={c.id}>
                    {c.claimId.slice(0, 8)}
                    {c.dateOfServiceNote ? ` · ${c.dateOfServiceNote}` : ""}{" "}
                    {terminal ? null : (
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Unlink claim ${c.claimId.slice(0, 8)}`}
                        onClick={() => void removeClaim(c.claimId)}
                      >
                        Unlink
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {terminal ? null : (
              <ClaimLookupField
                key={pickerKey}
                label="Link a claim"
                value=""
                onChange={(id) => {
                  if (id) void addClaim(id);
                }}
              />
            )}
          </section>
          {firstClaim ? <CaseViewPanel key={firstClaim} claimId={firstClaim} /> : null}
          {audit.events.length > 0 ? (
            <ul className="wx-action-hint wx-action-list">
              {audit.events.map((e) => (
                <li key={e.id}>
                  {humanize(e.eventKind)} — {new Date(e.occurredAt).toLocaleString()}
                </li>
              ))}
            </ul>
          ) : null}
          {terminal ? null : move === null ? (
            <ButtonRow>
              {(MOVES[audit.state] ?? []).map((to) => (
                <Button key={to} tone="secondary" size="sm" onClick={() => setMove(to)}>
                  {`Move to ${humanize(to)}`}
                </Button>
              ))}
            </ButtonRow>
          ) : (
            <>
              {move === "responded" ? (
                <TextField
                  label="Responded at (optional)"
                  type="datetime-local"
                  value={respondedAt}
                  onChange={(e) => setRespondedAt(e.target.value)}
                />
              ) : null}
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
