import {
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.4 invocation search (`/admin/ai-platform/invocations`,
// `ai.invocation.read`). Also embedded, pre-filtered, as the capability detail's Invocations tab.
//
// PHI. §5.1.4 requires a PERSISTENT header banner stating that the encrypted columns (chart_context,
// prompt_payload, response_payload) are masked. The route itself returns `phiMasked` per page, so the
// banner reflects what the SERVER did rather than what the client assumed — if a future elevated-read
// path ever returns unmasked rows, the banner stops claiming they are masked without a UI change. The
// row projection carries no payload columns at all, so there is nothing here to reveal: the §5.1.4
// "reveal" affordance is deliberately NOT built, because `ai.invocation.read` does not carry it and a
// button that always 403s is worse than no button. The banner names the M2 elevated-access flow instead.
//
// PAGING is keyset, not offset: the route returns `nextInvokedAtBefore` and the next page feeds it back
// as the `to` bound, so an invocation arriving mid-walk cannot shift a page boundary under the operator.
//
// NOT CROSS-TENANT, despite §5.1.4's "organization (cross-tenant for safety owner)". R16 is org-scoped by
// construction — it takes no `organizationId` parameter and its ABAC guard resolves the caller's own org
// — because it is the one M32 surface that reads PHI and emits a §164.528 read-audit entry. So there is
// no organization filter here and no column claiming one; a genuinely cross-tenant disclosure ledger is a
// backend change (a new route, a new guard, and a decision about what a platform operator may see of a
// tenant's patients), not something a console should fake with a fan-out.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { invocationTone } from "./status";
import {
  StandingNotice,
  actionButtonStyle,
  bodyRow,
  cap,
  cardStyle,
  cell,
  cellRight,
  formatDate,
  formatInt,
  inputStyle,
  pageStyle,
  tableStyle,
  theadRow,
} from "./ui";

type InvocationPage =
  operations["getApiV1AiInvocations"]["responses"][200]["content"]["application/json"];
export type Invocation = InvocationPage["rows"][number];

const STATUSES = ["completed", "failed", "timed_out", "killed", "capability_unavailable"] as const;

export interface InvocationSearchProps {
  /** When set, the capability filter is fixed and hidden — the capability detail's Invocations tab. */
  capabilityId?: string;
  /** Embedded mode drops the page chrome (the detail screen supplies its own header). */
  embedded?: boolean;
}

export function InvocationSearch({
  capabilityId,
  embedded = false,
}: InvocationSearchProps): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Invocation[]>([]);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [phiMasked, setPhiMasked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Invocation | null>(null);

  const load = useCallback(
    async (before: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: 50 };
      if (capabilityId) query.capabilityId = capabilityId;
      if (status) query.status = status;
      if (from) query.from = new Date(from).toISOString();
      // The keyset cursor IS the upper bound — a later page asks for "older than the last row I saw",
      // which is the same parameter the operator's own `to` filter sets. `before` wins when both exist.
      const upper = before ?? (to ? new Date(to).toISOString() : null);
      if (upper) query.to = upper;
      const res = await client.GET("/api/v1/ai/invocations", { params: { query } });
      if (res.error) {
        setError("Invocation log unavailable.");
        setLoading(false);
        return;
      }
      setRows((prev) => (append ? [...prev, ...res.data.rows] : res.data.rows));
      setCursor(res.data.nextInvokedAtBefore);
      setPhiMasked(res.data.phiMasked);
      setLoading(false);
    },
    [client, capabilityId, status, from, to],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const body = (
    <>
      {/* The server's own verdict, not an assumption — see the header note. */}
      {phiMasked ? (
        <StandingNotice tone="warning">
          PHI fields (chart context, prompt payload, response payload) are masked and are not
          returned to this console. Request elevated access through the M2 audit-grade access flow.
        </StandingNotice>
      ) : (
        <StandingNotice tone="critical">
          This page is serving UNMASKED invocation payloads. Every read is audited.
        </StandingNotice>
      )}
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No invocations"
          description="No invocations match these filters in the selected window."
        />
      ) : (
        <>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Invoked at</th>
                <th style={cell}>Capability</th>
                <th style={cell}>Backend</th>
                <th style={cell}>Routing</th>
                <th style={cellRight}>In</th>
                <th style={cellRight}>Out</th>
                <th style={cellRight}>Latency</th>
                <th style={cell}>Status</th>
                <th style={cell}>HITL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.invocationId} style={bodyRow}>
                  <td style={cell} className="tabular-nums">
                    <button
                      type="button"
                      onClick={() => setSelected(r)}
                      style={{ ...actionButtonStyle(false), padding: "0.2rem 0.4rem" }}
                    >
                      {formatDate(r.invokedAt)}
                    </button>
                  </td>
                  <td style={cell}>
                    <code>{r.capabilityKey}</code>
                  </td>
                  <td style={cell}>
                    <code>{r.backendKey}</code>
                  </td>
                  <td style={cell}>{cap(r.routingDecision)}</td>
                  <td style={cellRight} className="tabular-nums">
                    {formatInt(r.inputTokenCount)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatInt(r.outputTokenCount)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatInt(r.durationMs)} ms
                  </td>
                  <td style={cell}>
                    <StatusPill label={cap(r.status)} tone={invocationTone(r.status)} />
                  </td>
                  <td style={cell}>{r.hitlOutcome ? cap(r.hitlOutcome) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor ? (
            <div style={{ padding: "0.75rem", textAlign: "center" }}>
              <button
                type="button"
                onClick={() => void load(cursor, true)}
                disabled={loading}
                style={actionButtonStyle(false, loading)}
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      )}
      <InvocationDrawer invocation={selected} onClose={() => setSelected(null)} />
    </>
  );

  const filters = (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        style={inputStyle}
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {cap(s)}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        style={inputStyle}
        aria-label="From date"
      />
      <input
        type="date"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        style={inputStyle}
        aria-label="To date"
      />
    </div>
  );

  if (embedded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {filters}
        {body}
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <PageHeader title="AI invocations" breadcrumb="AI Platform" actions={filters} />
      {body}
    </div>
  );
}

/** §5.1.4 row drawer — the full (already-masked) invocation projection. */
function InvocationDrawer({
  invocation,
  onClose,
}: { invocation: Invocation | null; onClose: () => void }): JSX.Element | null {
  if (!invocation) return null;
  const fields: [string, string][] = [
    ["Invocation", invocation.invocationId],
    ["Capability", invocation.capabilityKey],
    ["Backend", invocation.backendKey],
    ["Model pin", invocation.modelVersionPin],
    ["Prompt version", invocation.promptTemplateVersion ?? "—"],
    ["Routing", `${cap(invocation.routingDecision)} — ${invocation.routingReason}`],
    ["Actor role", invocation.actorRole],
    ["Touched chart", invocation.touchedPatientChart ? "Yes" : "No"],
    ["Disclosed to vendor", invocation.disclosedToVendor ? "Yes" : "No"],
    ["ZDR confirmed", invocation.zdrConfirmed ? "Yes" : "No"],
    ["Error class", invocation.errorClass ?? "—"],
    ["Invoked at", formatDate(invocation.invokedAt)],
    ["Completed at", formatDate(invocation.completedAt)],
  ];
  return (
    <Modal open ariaLabel="Invocation detail" onClose={onClose} width="40rem">
      <div style={{ ...cardStyle, border: "none" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Invocation detail</h2>
        {/* Neither the patient id nor the actor membership id is shown: this is a platform-ops console
            reading across every tenant, and the operational question ("did this capability behave?")
            is answerable without either. */}
        <dl style={{ display: "grid", gridTemplateColumns: "10rem 1fr", gap: "0.4rem 1rem" }}>
          {fields.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>{k}</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0, wordBreak: "break-all" }}>{v}</dd>
            </div>
          ))}
        </dl>
        <button type="button" onClick={onClose} style={actionButtonStyle(true)}>
          Close
        </button>
      </div>
    </Modal>
  );
}
