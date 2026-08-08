import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — M34 SaaS Tenant Platform, the MARQUEE platform-ops inventory (R2).
// Spec §5.1 (`/tenants` row) — the cross-tenant inventory with status filter, legal-name search, and a
// "New tenant" CTA. Backed by GET /api/v1/platform/tenants (cursor-paginated CursorPage<TenantSummary>)
// via the generated typed client; reads run under withPlatformContext server-side (F03/F09 audited).
// Lantern: No-Line table, primary-tint selected row, mono org slug (wx-data-md), tabular-nums dates,
// CSS-var tokens only. Status pills resolve through the shared §6.6 tone map (saas-status.ts).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { lifecycleTone, statusLabel } from "./saas-status";

// §5.2 eleven-state tenant lifecycle (the UI owns its copy of the wire enum for the filter options).
const LIFECYCLE_STATUSES = [
  "signup_intent",
  "provisioning",
  "onboarding",
  "active",
  "suspended",
  "at_risk",
  "offboarding_initiated",
  "final_export_pending",
  "retained",
  "destruction_pending",
  "destroyed",
] as const;

interface TenantSummary {
  id: string;
  organizationId: string;
  orgSlug: string;
  legalBusinessName: string;
  status: string;
  planLabel: string;
  createdAt: string;
  updatedAt: string;
}

interface TenantPage {
  items: TenantSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function TenantInventory(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: NonNullable<paths["/api/v1/platform/tenants"]["get"]["parameters"]["query"]> = {
      limit: 50,
    };
    if (status) query.status = status as typeof query.status;
    if (search.trim()) query.search = search.trim();
    const { data, error: err } = await client.GET("/api/v1/platform/tenants", {
      params: { query },
    });
    if (err) {
      setError("Tenant inventory unavailable.");
      setLoading(false);
      return;
    }
    const page = data as unknown as TenantPage | undefined;
    setItems((page?.items ?? []) as TenantSummary[]);
    setLoading(false);
  }, [client, status, search]);

  // Load on mount + whenever the status filter changes; the search applies on submit (Enter / Search).
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Tenants"
          actions={
            <button type="button" onClick={() => alert("New tenant — provisioning ceremony")}>
              New tenant
            </button>
          }
        />
      }
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => void load()}>
              Search
            </button>
          }
        >
          <select
            aria-label="Lifecycle status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {LIFECYCLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <input
            aria-label="Search legal business name"
            placeholder="Legal business name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
          />
        </FilterBar>
      }
      table={
        <TenantTable
          items={items}
          loading={loading}
          error={error}
          selectedSlug={selectedSlug}
          onSelect={setSelectedSlug}
        />
      }
    />
  );
}

function TenantTable({
  items,
  loading,
  error,
  selectedSlug,
  onSelect,
}: {
  items: TenantSummary[];
  loading: boolean;
  error: string | null;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No tenants" description="No tenants match this filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Tenant</th>
            <th>Org slug</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tenant) => (
            <tr
              key={tenant.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={tenant.orgSlug === selectedSlug}
              onClick={() => onSelect(tenant.orgSlug)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(tenant.orgSlug);
                }
              }}
              style={{
                cursor: "pointer",
                background:
                  tenant.orgSlug === selectedSlug ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td>{tenant.legalBusinessName}</td>
              <td className="wx-data-md">{tenant.orgSlug}</td>
              <td>{tenant.planLabel}</td>
              <td>
                <StatusPill
                  label={statusLabel(tenant.status)}
                  tone={lifecycleTone(tenant.status)}
                />
              </td>
              <td className="tabular-nums">{new Date(tenant.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
