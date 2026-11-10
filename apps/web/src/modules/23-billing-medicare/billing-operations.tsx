import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import {
  BillingInvestigationPanel,
  type InvestigationSourceRef,
} from "./billing-investigation-panel";

type ModuleKey = "M23" | "M24" | "M25" | "M41";
type Item = {
  key: string;
  module: ModuleKey;
  reference: string;
  payer: string;
  status: string;
  updatedAt: string | null;
  context: string;
  amount: string;
  amountLabel: string;
  href: string;
  attention: boolean;
  investigationSource?: InvestigationSourceRef;
};
type Raw = Record<string, unknown>;
type Page = { items?: Raw[]; nextCursor?: string | null; hasMore?: boolean };
type Source = {
  state: "loading" | "error" | "denied" | "ready";
  items: Item[];
  cursor: string | null;
  inDoubtCursor: string | null;
};
type Sources = Record<ModuleKey, Source>;

const initial: Sources = {
  M23: { state: "loading", items: [], cursor: null, inDoubtCursor: null },
  M24: { state: "loading", items: [], cursor: null, inDoubtCursor: null },
  M25: { state: "loading", items: [], cursor: null, inDoubtCursor: null },
  M41: { state: "loading", items: [], cursor: null, inDoubtCursor: null },
};
const PAGE_SIZE = 30;
const text = (row: Raw, key: string, fallback = "—") =>
  typeof row[key] === "string" && row[key] ? String(row[key]) : fallback;
const attentionStates = new Set([
  "denied",
  "rejected",
  "ack_rejected",
  "ack_partial",
  "partially_paid",
  "held",
  "in_doubt",
  "draft",
]);

function rowsFor(module: ModuleKey, page: Page): Item[] {
  return (page.items ?? []).map((row) => {
    if (module === "M25") {
      const count = Number(row.identityExceptionCount ?? 0);
      const state = text(row, "state", "unknown");
      const id = text(row, "id", "");
      return {
        key: `M25:${id}`,
        module,
        reference: `ERA ${text(row, "eraId", id.slice(0, 8))}`,
        payer: text((row.payer as Raw | undefined) ?? {}, "name"),
        status: count > 0 ? "Matching review required" : state,
        updatedAt: text(row, "createdAt", "") || null,
        context: `${Number(row.claimCount ?? 0)} claims · ${count} identity exceptions${row.possibleDuplicate ? " · possible duplicate" : ""}${row.holdReason ? ` · ${String(row.holdReason).replaceAll("_", " ")}` : ""}`,
        amount:
          typeof (row.payment as Raw | undefined)?.amount === "number"
            ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                Number((row.payment as Raw).amount),
              )
            : "—",
        amountLabel: "ERA payment",
        href: `/remittance/claimmd-era-review?stage=${encodeURIComponent(id)}`,
        attention:
          count > 0 || row.possibleDuplicate === true || state === "staged" || state === "held",
      };
    }
    const id = text(row, module === "M23" ? "claimId" : "id", "");
    const state = text(row, "state", "unknown");
    const isAttention = attentionStates.has(state);
    const payer =
      module === "M41"
        ? text(row, "planName", "Commercial")
        : module === "M24"
          ? text(row, "kind", "Medicaid")
          : "Medicare";
    const date = text(row, "updatedAt", text(row, "createdAt", ""));
    return {
      key: `${module}:${id}`,
      module,
      reference: text(
        row,
        "claimControlNumber",
        text(row, "medicaidClaimControlNumber", `Claim ${id.slice(0, 8)}`),
      ),
      payer,
      status: state,
      updatedAt: date || null,
      context:
        module === "M23"
          ? `${text(row, "tob", "Claim")} · ${text(row, "serviceFrom", "Service dates unavailable")}`
          : `${text(row, "serviceFrom", "Service dates unavailable")} · ${text(row, "serviceTo", "")}`,
      amount:
        typeof row.totalChargeCents === "number"
          ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
              Number(row.totalChargeCents) / 100,
            )
          : "—",
      amountLabel: "Billed charge",
      href:
        module === "M23"
          ? `/billing/claims/${id}`
          : module === "M41"
            ? `/commercial/billing/claims/${id}`
            : `/medicaid/billing/claims/${id}`,
      attention: isAttention,
    };
  });
}

function sourceStatus(error: unknown, response: { status?: number } | undefined): Source["state"] {
  return response?.status === 403 ? "denied" : error ? "error" : "ready";
}

export function BillingOperations(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const authorizedProviders = session?.providerEntityIds ?? [];
  const authorizedLocations = session?.locationIds ?? [];
  const [params, setParams] = useSearchParams();
  const selectedProvider = params.get("entity") ?? "";
  const providerId = authorizedProviders.includes(selectedProvider)
    ? selectedProvider
    : (authorizedProviders[0] ?? "");
  const locationId = params.get("location") ?? "";
  const effectiveLocationId = authorizedLocations.includes(locationId) ? locationId : "";
  const eraPayer = params.get("eraPayer") ?? "";
  const eraFrom = params.get("eraFrom") ?? "";
  const eraTo = params.get("eraTo") ?? "";
  const eraState = params.get("eraState") ?? "";
  const [providers, setProviders] = useState<Record<string, string>>({});
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [sources, setSources] = useState<Sources>(initial);
  const sourcesRef = useRef(sources);
  const requestSequence = useRef(0);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);
  const [type, setType] = useState<"all" | ModuleKey>("all");
  const [attentionOnly, setAttentionOnly] = useState(true);
  const [payerDraft, setPayerDraft] = useState(eraPayer);
  const [loadingMore, setLoadingMore] = useState(false);
  const [investigationSource, setInvestigationSource] = useState<InvestigationSourceRef | null>(
    null,
  );

  const load = useCallback(
    async (append = false) => {
      const requestId = ++requestSequence.current;
      if (!providerId) {
        setSources({
          M23: { state: "ready", items: [], cursor: null, inDoubtCursor: null },
          M24: { state: "ready", items: [], cursor: null, inDoubtCursor: null },
          M25: { state: "ready", items: [], cursor: null, inDoubtCursor: null },
          M41: { state: "ready", items: [], cursor: null, inDoubtCursor: null },
        });
        return;
      }
      if (!append) setSources(initial);
      else setLoadingMore(true);
      const specs = [
        ["M23", "/api/v1/billing/claims", { providerEntityId: providerId, limit: PAGE_SIZE }],
        ["M24", "/api/v1/medicaid-claims", { providerEntityId: providerId, limit: PAGE_SIZE }],
        [
          "M41",
          "/api/v1/billing/commercial/claims",
          { providerEntityId: providerId, limit: PAGE_SIZE },
        ],
        [
          "M25",
          "/api/v1/remittance/claimmd-era",
          {
            providerEntityId: providerId,
            ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
            ...(eraPayer ? { payer: eraPayer } : {}),
            ...(eraFrom ? { fromDate: eraFrom } : {}),
            ...(eraTo ? { toDate: eraTo } : {}),
            ...(eraState ? { state: eraState } : {}),
            limit: String(PAGE_SIZE),
          },
        ],
      ] as const;
      const results: [ModuleKey, Source][] = await Promise.all(
        specs.map(async ([module, path, query]) => {
          const cursor = append ? sourcesRef.current[module].cursor : null;
          if (append && !cursor) return [module, sourcesRef.current[module]] as [ModuleKey, Source];
          try {
            const response = await (
              client.GET as (
                path: string,
                options: unknown,
              ) => Promise<{ data?: Page; error?: unknown; response?: { status?: number } }>
            )(path, {
              params: { query: { ...query, ...(cursor ? { cursor } : {}) } },
            });
            const state = sourceStatus(response.error, response.response);
            if (state !== "ready" || !response.data)
              return [
                module,
                { state, items: [], cursor: null, inDoubtCursor: null } as Source,
              ] as [ModuleKey, Source];
            return [
              module,
              {
                state,
                items: rowsFor(module, response.data),
                cursor: response.data.nextCursor ?? null,
                inDoubtCursor: append ? sourcesRef.current[module].inDoubtCursor : null,
              },
            ] as [ModuleKey, Source];
          } catch {
            return [module, { state: "error", items: [], cursor: null, inDoubtCursor: null }] as [
              ModuleKey,
              Source,
            ];
          }
        }),
      );
      const doubtResults = await Promise.all(
        (
          [
            ["M23", "/api/v1/billing/claims/in-doubt-submissions"],
            ["M41", "/api/v1/billing/commercial/submissions/in-doubt"],
          ] as const
        ).map(async ([module, path]) => {
          const old = sourcesRef.current[module];
          const cursor = append ? old.inDoubtCursor : null;
          if (append && !cursor) return { module, items: [] as Item[], cursor: null, error: null };
          try {
            const response = await (
              client.GET as (
                path: string,
                options: unknown,
              ) => Promise<{ data?: Page; error?: unknown; response?: { status?: number } }>
            )(path, {
              params: {
                query: {
                  providerEntityId: providerId,
                  limit: PAGE_SIZE,
                  ...(cursor ? { cursor } : {}),
                },
              },
            });
            if (response.error || !response.data)
              return {
                module,
                items: [] as Item[],
                cursor,
                error: response.error ?? response.response,
              };
            return {
              module,
              cursor: response.data.nextCursor ?? null,
              error: null,
              items: (response.data.items ?? []).map((row): Item => {
                const claimId = text(row, "claimId", "");
                const submissionId = text(row, "submissionId", "");
                const sourceProviderEntityId = text(row, "providerEntityId", providerId);
                return {
                  key: `${module}:submission:${submissionId}`,
                  module,
                  reference: text(row, "claimControlNumber", `Claim ${claimId.slice(0, 8)}`),
                  payer: text(row, "payer", module === "M23" ? "Medicare" : "Commercial"),
                  status: "Submission outcome in doubt",
                  updatedAt: text(row, "occurredAt", "") || null,
                  context: `Attempt ${text(row, "attemptIndex", text(row, "attemptCount", "—"))}. The request may have reached the payer; check submission history before any next step.${text(row, "reasonCode", "") ? ` Reason: ${text(row, "reasonCode", "")}.` : ""}`,
                  amount: "—",
                  amountLabel: "",
                  href:
                    module === "M23"
                      ? `/billing/claims/${claimId}`
                      : `/commercial/billing/claims/${claimId}`,
                  attention: true,
                  investigationSource: {
                    sourceModule: module,
                    submissionId,
                    providerEntityId: sourceProviderEntityId,
                  },
                };
              }),
            };
          } catch (error) {
            return { module, items: [] as Item[], cursor, error };
          }
        }),
      );
      for (const doubt of doubtResults) {
        const index = results.findIndex(([module]) => module === doubt.module);
        if (index < 0) continue;
        const [module, source] = results[index]!;
        results[index] = [
          module,
          {
            ...source,
            items: [...source.items, ...doubt.items],
            inDoubtCursor: doubt.cursor,
            ...(doubt.error
              ? { state: source.state === "ready" ? ("error" as const) : source.state }
              : {}),
          },
        ];
      }
      if (requestId !== requestSequence.current) return;
      setSources((previous) => {
        const next = { ...previous };
        for (const [module, source] of results) {
          const old = append ? previous[module] : null;
          if (!old) {
            next[module] = source;
            continue;
          }
          if (source.state !== "ready") {
            // Keep the same source cursor on a failed continuation so the operator can retry that page.
            next[module] = { ...source, items: old.items, cursor: old.cursor };
            continue;
          }
          const unique = new Map(old.items.map((item) => [item.key, item]));
          for (const item of source.items) unique.set(item.key, item);
          next[module] = { ...source, items: [...unique.values()] };
        }
        return next;
      });
      setLoadingMore(false);
    },
    [client, effectiveLocationId, eraFrom, eraPayer, eraState, eraTo, providerId],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const [entityResponse, locationResponse] = await Promise.all([
        client.GET("/api/v1/provider-entities", { params: { query: { limit: 100 } } }),
        providerId
          ? client.GET("/api/v1/locations", {
              params: { query: { providerEntityId: providerId, limit: 100 } },
            })
          : Promise.resolve({ data: undefined }),
      ]);
      if (!active) return;
      const names: Record<string, string> = {};
      for (const entity of entityResponse.data?.items ?? [])
        if (authorizedProviders.includes(entity.id)) names[entity.id] = entity.legalName;
      setProviders(names);
      const items =
        (locationResponse.data as { items?: { id: string; name: string }[] } | undefined)?.items ??
        [];
      setLocations(items.filter((location) => authorizedLocations.includes(location.id)));
    })();
    return () => {
      active = false;
    };
  }, [authorizedLocations, authorizedProviders, client, providerId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const allItems = useMemo(
    () =>
      Object.values(sources)
        .flatMap((source) => source.items)
        .sort(
          (a, b) =>
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.key.localeCompare(b.key),
        ),
    [sources],
  );
  const visible = allItems.filter(
    (item) => (type === "all" || item.module === type) && (!attentionOnly || item.attention),
  );
  const issues = (Object.entries(sources) as [ModuleKey, Source][]).filter(
    ([, source]) => source.state === "error" || source.state === "denied",
  );
  const hasMore = Object.values(sources).some(
    (source) => source.cursor !== null || source.inDoubtCursor !== null,
  );
  const setContext = (entity: string, location: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        entity ? next.set("entity", entity) : next.delete("entity");
        location ? next.set("location", location) : next.delete("location");
        return next;
      },
      { replace: true },
    );
  const setEraFilter = useCallback(
    (key: string, value: string) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  useEffect(() => setPayerDraft(eraPayer), [eraPayer]);
  useEffect(() => {
    if (payerDraft.trim() === eraPayer) return;
    const timer = window.setTimeout(() => setEraFilter("eraPayer", payerDraft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [eraPayer, payerDraft, setEraFilter]);

  return (
    <main style={{ display: "grid", gap: "1rem", paddingBottom: "2rem" }}>
      <PageHeader title="Billing Operations">
        <p style={{ color: "var(--color-on-surface-variant)", maxWidth: 800 }}>
          A scoped view of work from Medicare, Medicaid, Commercial Billing and staged ERAs. Each
          source remains authoritative for its status and actions.
        </p>
        <BillingTabs />
      </PageHeader>
      <section
        aria-label="Billing scope"
        style={{ display: "flex", flexWrap: "wrap", gap: "1rem", padding: "0 1.5rem" }}
      >
        <label>
          Provider entity
          <select
            aria-label="Provider entity"
            value={providerId}
            onChange={(event) => setContext(event.target.value, "")}
          >
            <option value="">No authorized provider scope</option>
            {authorizedProviders.map((id) => (
              <option key={id} value={id}>
                {providers[id] ?? `Provider ${id.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          ERA payer
          <input
            aria-label="ERA payer"
            value={payerDraft}
            maxLength={100}
            onChange={(event) => setPayerDraft(event.target.value)}
            placeholder="Filter ERA payer"
          />
        </label>
        <label>
          ERA received from
          <input
            aria-label="ERA received from"
            type="date"
            value={eraFrom}
            onChange={(event) => setEraFilter("eraFrom", event.target.value)}
          />
        </label>
        <label>
          ERA received to
          <input
            aria-label="ERA received to"
            type="date"
            value={eraTo}
            onChange={(event) => setEraFilter("eraTo", event.target.value)}
          />
        </label>
        <label>
          ERA status
          <select
            aria-label="ERA status"
            value={eraState}
            onChange={(event) => setEraFilter("eraState", event.target.value)}
          >
            <option value="">All ERA states</option>
            <option value="staged">Staged</option>
            <option value="held">Held</option>
            <option value="possible_duplicate">Possible duplicate</option>
          </select>
        </label>
        <label>
          Location (ERA stages)
          <select
            aria-label="Location (ERA stages)"
            value={authorizedLocations.includes(locationId) ? locationId : ""}
            onChange={(event) => setContext(providerId, event.target.value)}
            disabled={!providerId}
          >
            <option value="">All locations</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select
            aria-label="Source"
            value={type}
            onChange={(event) => setType(event.target.value as "all" | ModuleKey)}
          >
            <option value="all">All sources</option>
            <option value="M23">Medicare</option>
            <option value="M24">Medicaid</option>
            <option value="M25">ERAs</option>
            <option value="M41">Commercial</option>
          </select>
        </label>
        <label style={{ alignSelf: "end" }}>
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(event) => setAttentionOnly(event.target.checked)}
          />{" "}
          Needs attention (loaded items)
        </label>
        <Button tone="secondary" size="sm" onClick={() => void load(false)}>
          Refresh
        </Button>
      </section>
      <section
        aria-label="Operational summary"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: ".75rem",
          padding: "0 1.5rem",
        }}
      >
        {(["M23", "M24", "M25", "M41"] as const).map((module) => (
          <div
            key={module}
            style={{
              border: "1px solid var(--color-outline-variant)",
              borderRadius: ".5rem",
              padding: ".8rem 1rem",
            }}
          >
            <strong>{module}</strong>
            <div style={{ fontSize: "1.35rem", fontVariantNumeric: "tabular-nums" }}>
              {sources[module].state === "ready" ? sources[module].items.length : "—"}
            </div>
            <small>
              {sources[module].state === "ready"
                ? `${sources[module].items.filter((item) => item.attention).length} need attention · ${sources[module].items.length} loaded${sources[module].cursor ? "; more available" : "; no further page"}`
                : sources[module].state === "loading"
                  ? "Loading"
                  : "Unavailable or not permitted"}
            </small>
          </div>
        ))}
      </section>
      {issues.length > 0 ? (
        <output
          style={{
            display: "block",
            padding: "0 1.5rem",
            color: "var(--color-on-surface-variant)",
          }}
        >
          {issues
            .map(
              ([module, source]) =>
                `${module}: ${source.state === "denied" ? "access not granted" : "source unavailable"}`,
            )
            .join(" · ")}
          . Other authorized sources remain available; unavailable sources are not counted as empty.
        </output>
      ) : null}
      <section aria-label="Billing worklist" style={{ padding: "0 1.5rem" }}>
        {Object.values(sources).some((source) => source.state === "loading") ? (
          <LoadingSpinner />
        ) : visible.length === 0 ? (
          <EmptyState
            title={providerId ? "No work in this view" : "Choose an authorized provider"}
            description={
              providerId
                ? "No records on the loaded source pages match these filters. A source may be unavailable; check the status above."
                : "Your session has no provider entity scope available for this workspace."
            }
          />
        ) : (
          <div className="billing-operations-desktop-list" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead>
                <tr>
                  <th align="left">Source</th>
                  <th align="left">Reference</th>
                  <th align="left">Payer</th>
                  <th align="right">Source amount</th>
                  <th align="left">Status</th>
                  <th align="left">Context</th>
                  <th align="left">Updated</th>
                  <th align="left">Next step</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr
                    key={item.key}
                    style={{ borderTop: "1px solid var(--color-outline-variant)" }}
                  >
                    <td>
                      <StatusPill label={item.module} tone="neutral" />
                    </td>
                    <td>{item.reference}</td>
                    <td>{item.payer}</td>
                    <td align="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      <div>{item.amount}</div>
                      <small>{item.amountLabel}</small>
                    </td>
                    <td>
                      <StatusPill
                        label={item.status.replaceAll("_", " ")}
                        tone={item.attention ? "warning" : "progress"}
                      />
                    </td>
                    <td>{item.context}</td>
                    <td>
                      {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString("en-US") : "—"}
                    </td>
                    <td>
                      <Link to={item.href}>
                        {item.module === "M25" ? "Open ERA review" : "Open claim"}
                      </Link>
                      {item.investigationSource ? (
                        <Button
                          tone="secondary"
                          size="sm"
                          onClick={() => setInvestigationSource(item.investigationSource!)}
                        >
                          Open investigation
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {visible.length > 0 ? (
          <ul className="billing-operations-mobile-list" aria-label="Billing work items">
            {visible.map((item) => (
              <li key={item.key}>
                <article className="billing-operations-mobile-item">
                  <div className="billing-operations-mobile-heading">
                    <StatusPill label={item.module} tone="neutral" />
                    <StatusPill
                      label={item.status.replaceAll("_", " ")}
                      tone={item.attention ? "warning" : "progress"}
                    />
                  </div>
                  <h2>{item.reference}</h2>
                  <p>{item.payer}</p>
                  <p>{item.context}</p>
                  <p>
                    <strong>{item.amount}</strong> <small>{item.amountLabel}</small>
                  </p>
                  <p>
                    {item.updatedAt
                      ? new Date(item.updatedAt).toLocaleString("en-US")
                      : "Date unavailable"}
                  </p>
                  <Link to={item.href}>
                    {item.module === "M25" ? "Open ERA review" : "Open claim"}
                  </Link>
                  {item.investigationSource ? (
                    <Button
                      tone="secondary"
                      size="sm"
                      onClick={() => setInvestigationSource(item.investigationSource!)}
                    >
                      Open investigation
                    </Button>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        ) : null}
        {hasMore ? (
          <div style={{ paddingTop: "1rem" }}>
            <Button
              tone="secondary"
              size="sm"
              disabled={loadingMore}
              onClick={() => void load(true)}
            >
              {loadingMore ? "Loading…" : "Load next source pages"}
            </Button>
            <p>
              Each source advances its own server cursor; items are merged by source update time.
            </p>
          </div>
        ) : null}
      </section>
      <p style={{ padding: "0 1.5rem", color: "var(--color-on-surface-variant)" }}>
        This workspace is for operational review and navigation. It does not post payments, approve
        posting, replay submissions, or confirm bank settlement.
      </p>
      {investigationSource ? (
        <BillingInvestigationPanel
          source={investigationSource}
          onClose={() => setInvestigationSource(null)}
        />
      ) : null}
    </main>
  );
}
