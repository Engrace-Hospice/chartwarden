import { Button, Glyph, InlineAlert, StatusPill, TextField, useApiClient } from "@wardenx/ui";
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
// The redesign's list + right drawer: a row opens the invocation in the drawer, kept in `?invocation=<id>`.
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
import { useSearchParams } from "react-router-dom";
import { invocationTone } from "./status";
import {
  EmptyListState,
  ErrorState,
  LoadingState,
  PageHead,
  StandingNotice,
  cap,
  formatDate,
  formatInt,
  onRowKey,
} from "./ui";

type InvocationPage =
  operations["getApiV1AiInvocations"]["responses"][200]["content"]["application/json"];
export type Invocation = InvocationPage["rows"][number];

const STATUSES = ["completed", "failed", "timed_out", "killed", "capability_unavailable"] as const;
const SELECTED_PARAM = "invocation";

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
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(SELECTED_PARAM);
  const [rows, setRows] = useState<Invocation[]>([]);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [phiMasked, setPhiMasked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const select = (id: string | null): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set(SELECTED_PARAM, id);
        else next.delete(SELECTED_PARAM);
        return next;
      },
      { replace: true },
    );

  const filters = (
    <>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {cap(s)}
          </option>
        ))}
      </select>
      <TextField
        type="date"
        label="From date"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
      />
      <TextField type="date" label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
    </>
  );

  const table = (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">AI invocations</caption>
        <thead>
          <tr>
            <th scope="col">Invoked at</th>
            <th scope="col">Capability</th>
            <th scope="col">Routing</th>
            <th scope="col" className="wx-num-col">
              In
            </th>
            <th scope="col" className="wx-num-col">
              Out
            </th>
            <th scope="col" className="wx-num-col">
              Latency
            </th>
            <th scope="col">Status</th>
            <th scope="col">HITL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSelected = r.invocationId === selectedId;
            const open = (): void => select(r.invocationId);
            return (
              <tr
                key={r.invocationId}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                tabIndex={0}
                aria-selected={isSelected}
                onClick={open}
                onKeyDown={onRowKey(open)}
              >
                <td className="wx-nums">{formatDate(r.invokedAt)}</td>
                <td>
                  <span className="wx-row-title wx-data-md">{r.capabilityKey}</span>
                  <span className="wx-row-sub wx-data-md">{r.backendKey}</span>
                </td>
                <td>{cap(r.routingDecision)}</td>
                <td className="wx-num-col wx-nums">{formatInt(r.inputTokenCount)}</td>
                <td className="wx-num-col wx-nums">{formatInt(r.outputTokenCount)}</td>
                <td className="wx-num-col wx-nums">{formatInt(r.durationMs)} ms</td>
                <td>
                  <StatusPill label={cap(r.status)} tone={invocationTone(r.status)} />
                </td>
                <td>{r.hitlOutcome ? cap(r.hitlOutcome) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

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
        <LoadingState label="Loading invocations…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(null, false)} />
      ) : rows.length === 0 ? (
        <EmptyListState
          glyph="search"
          title="No invocations"
          description="No invocations match these filters in the selected window."
        />
      ) : (
        <>
          {table}
          {cursor ? (
            <div className="flex justify-center">
              <Button
                tone="secondary"
                onClick={() => void load(cursor, true)}
                loading={loading}
                disabled={loading}
              >
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );

  const frame = `wx-list-drawer${embedded ? " p-0" : ""}${selectedId ? " has-drawer" : ""}`;
  return (
    <div className={frame}>
      <div className="wx-list-drawer-main">
        {embedded ? (
          <div className="wx-list-toolbar">
            <div className="wx-list-toolbar-end">{filters}</div>
          </div>
        ) : (
          <PageHead
            title="AI invocations"
            description="The disclosure ledger: every AI call your organization made, with routing, tokens, latency and outcome."
          >
            {filters}
          </PageHead>
        )}
        {body}
      </div>
      {selectedId ? (
        <InvocationDrawer
          id={selectedId}
          invocation={rows.find((r) => r.invocationId === selectedId) ?? null}
          onClose={() => select(null)}
        />
      ) : null}
    </div>
  );
}

/** §5.1.4 row drawer — the full (already-masked) invocation projection. */
function InvocationDrawer({
  id,
  invocation,
  onClose,
}: { id: string; invocation: Invocation | null; onClose: () => void }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="Invocation detail">
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="cpu" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>{invocation?.capabilityKey ?? "Invocation"}</h2>
          <span className="wx-row-sub wx-data-md">{id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        {invocation === null ? (
          <InlineAlert tone="info">
            This invocation is not in the loaded page. Adjust the filters or load more to find it.
          </InlineAlert>
        ) : (
          <>
            {/* Neither the patient id nor the actor membership id is shown: this is a platform-ops console
                reading across every tenant, and the operational question ("did this capability behave?")
                is answerable without either. */}
            <section className="wx-drawer-card">
              <div className="wx-drawer-card-head">
                <h3>Call</h3>
                <StatusPill
                  label={cap(invocation.status)}
                  tone={invocationTone(invocation.status)}
                />
              </div>
              <dl className="wx-kv">
                <dt>Capability</dt>
                <dd className="wx-data-md">{invocation.capabilityKey}</dd>
                <dt>Backend</dt>
                <dd className="wx-data-md">{invocation.backendKey}</dd>
                <dt>Model pin</dt>
                <dd className="wx-data-md break-all">{invocation.modelVersionPin}</dd>
                <dt>Prompt version</dt>
                <dd>{invocation.promptTemplateVersion ?? "—"}</dd>
                <dt>Routing</dt>
                <dd>
                  {cap(invocation.routingDecision)} — {invocation.routingReason}
                </dd>
                <dt>Actor role</dt>
                <dd>{invocation.actorRole}</dd>
                <dt>Error class</dt>
                <dd>{invocation.errorClass ?? "—"}</dd>
              </dl>
            </section>
            <section className="wx-drawer-card">
              <h3>Disclosure</h3>
              <dl className="wx-kv">
                <dt>Touched chart</dt>
                <dd>{invocation.touchedPatientChart ? "Yes" : "No"}</dd>
                <dt>Disclosed to vendor</dt>
                <dd>{invocation.disclosedToVendor ? "Yes" : "No"}</dd>
                <dt>ZDR confirmed</dt>
                <dd>{invocation.zdrConfirmed ? "Yes" : "No"}</dd>
              </dl>
            </section>
            <section className="wx-drawer-card">
              <h3>Timing</h3>
              <dl className="wx-kv">
                <dt>Invoked at</dt>
                <dd className="wx-nums">{formatDate(invocation.invokedAt)}</dd>
                <dt>Completed at</dt>
                <dd className="wx-nums">{formatDate(invocation.completedAt)}</dd>
                <dt>Latency</dt>
                <dd className="wx-nums">{formatInt(invocation.durationMs)} ms</dd>
              </dl>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
