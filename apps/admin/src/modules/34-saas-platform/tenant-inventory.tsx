import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  TextField,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/admin/src/modules/34-saas-platform — M34 SaaS Tenant Platform, the MARQUEE platform-ops inventory (R2).
// Spec §5.1 (`/tenants` row) — the cross-tenant inventory with status filter, legal-name search, and a
// "New tenant" CTA. Backed by GET /api/v1/platform/tenants (cursor-paginated CursorPage<TenantSummary>)
// via the generated typed client; reads run under withPlatformContext server-side (F03/F09 audited).
// The redesign's list + right drawer: a row opens the tenant's summary in the drawer, kept in
// `?tenant=<orgSlug>`; the drawer links on to the full §5.2 overview at `/tenants/:orgSlug`.
// Status pills resolve through the shared §6.6 tone map (saas-status.ts).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { lifecycleTone, statusLabel } from "./saas-status";
import { TenantProvisionDrawer } from "./tenant-provision";

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

const PAGE_LIMIT = 50;
const NEW_TENANT = "new";

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
  const [params, setParams] = useSearchParams();
  const selectedSlug = params.get("tenant");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: NonNullable<paths["/api/v1/platform/tenants"]["get"]["parameters"]["query"]> = {
      limit: PAGE_LIMIT,
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

  const onSearch = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void load();
  };

  const provisioning = selectedSlug === NEW_TENANT;
  const selected =
    selectedSlug && !provisioning ? items.find((t) => t.orgSlug === selectedSlug) : undefined;

  return (
    <div className={`wx-list-drawer${selected || provisioning ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Tenants</h1>
            <p>Every hospice tenant on the platform, by lifecycle status.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button onClick={() => setParams({ tenant: NEW_TENANT })}>New tenant</Button>
          </div>
        </header>

        <form className="wx-list-toolbar" onSubmit={onSearch}>
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
          <div className="min-w-60 flex-1">
            <TextField
              type="search"
              label={<span className="wx-sr-only">Search legal business name</span>}
              placeholder="Legal business name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit" tone="secondary">
            Search
          </Button>
        </form>

        <TenantTable
          items={items}
          loading={loading}
          error={error}
          selectedSlug={selectedSlug}
          onSelect={(slug) => setParams({ tenant: slug })}
          onRetry={() => void load()}
        />
      </div>
      {provisioning ? (
        <TenantProvisionDrawer onClose={() => setParams({})} onAccepted={() => void load()} />
      ) : null}
      {selected ? <TenantDrawer tenant={selected} onClose={() => setParams({})} /> : null}
    </div>
  );
}

function TenantTable({
  items,
  loading,
  error,
  selectedSlug,
  onSelect,
  onRetry,
}: {
  items: TenantSummary[];
  loading: boolean;
  error: string | null;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading tenants…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="search" size={24} />
        <span>No tenants match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Tenants</caption>
        <thead>
          <tr>
            <th scope="col">Tenant</th>
            <th scope="col">Plan</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tenant) => {
            const isSelected = tenant.orgSlug === selectedSlug;
            const open = (): void => onSelect(tenant.orgSlug);
            return (
              <tr
                key={tenant.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                tabIndex={0}
                aria-selected={isSelected}
                onClick={open}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    open();
                  }
                }}
              >
                <td>
                  <span className="wx-row-title">{tenant.legalBusinessName}</span>
                  <span className="wx-row-sub wx-data-md">{tenant.orgSlug}</span>
                </td>
                <td>{tenant.planLabel}</td>
                <td>
                  <StatusPill
                    label={statusLabel(tenant.status)}
                    tone={lifecycleTone(tenant.status)}
                  />
                </td>
                <td className="wx-nums">{new Date(tenant.createdAt).toLocaleDateString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TenantDrawer({
  tenant,
  onClose,
}: {
  tenant: TenantSummary;
  onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  return (
    <aside className="wx-admission-drawer" aria-label="Tenant">
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="building" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>{tenant.legalBusinessName}</h2>
          <span className="wx-row-sub wx-data-md">{tenant.orgSlug}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Tenant</h3>
            <StatusPill label={statusLabel(tenant.status)} tone={lifecycleTone(tenant.status)} />
          </div>
          <dl className="wx-kv">
            <dt>Plan</dt>
            <dd>{tenant.planLabel}</dd>
            <dt>Tenant id</dt>
            <dd className="wx-data-md">{tenant.id}</dd>
            <dt>Organization id</dt>
            <dd className="wx-data-md">{tenant.organizationId}</dd>
            <dt>Created</dt>
            <dd className="wx-nums">{new Date(tenant.createdAt).toLocaleString()}</dd>
            <dt>Updated</dt>
            <dd className="wx-nums">{new Date(tenant.updatedAt).toLocaleString()}</dd>
          </dl>
          <div className="wx-drawer-actions">
            <Button
              tone="secondary"
              onClick={() => navigate(`/tenants/${encodeURIComponent(tenant.orgSlug)}`)}
            >
              Open tenant overview
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}
