// apps/web/src/modules/41-billing-commercial — chrome shared by the commercial screens: the view tabs and the provider-entity
// picker (every read is scoped to one provider entity).
import { Button, EmptyState, LoadingSpinner } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { COMMERCIAL_PATHS } from "./commercial-model";
import type { ProviderEntityState } from "./use-provider-entity";

const VIEWS = [
  { to: COMMERCIAL_PATHS.queue, label: "Claim queue", match: "/commercial/billing/claims" },
  { to: COMMERCIAL_PATHS.payers, label: "Supported payers", match: "/commercial/billing/payers" },
] as const;

export function CommercialTabs(): JSX.Element {
  const { pathname, search } = useLocation();
  const entity = new URLSearchParams(search).get("entity");
  return (
    <nav className="wx-subtabs" aria-label="Commercial billing views">
      {VIEWS.map((v) => {
        const current = pathname === v.match || pathname.startsWith(`${v.match}/`);
        return (
          <Link
            key={v.to}
            to={entity ? `${v.to}?entity=${encodeURIComponent(entity)}` : v.to}
            {...(current ? { "aria-current": "page" as const, className: "is-current" } : {})}
          >
            {v.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function EntityPicker({
  state,
  value,
  onChange,
}: {
  state: ProviderEntityState;
  value: string;
  onChange: (id: string) => void;
}): JSX.Element | null {
  if (state.status !== "ready") return null;
  return (
    <label className="wx-filter-field">
      <span>Provider entity</span>
      <select
        className="wx-select"
        aria-label="Provider entity"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {state.entities.map((p) => (
          <option key={p.id} value={p.id}>
            {p.ccn ? `${p.legalName} (${p.ccn})` : p.legalName}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What the page shows while the provider entity is unknown: loading, a retryable error, or "none visible". */
export function EntityGate({
  state,
  hasEntity,
  onRetry,
  children,
}: {
  state: ProviderEntityState;
  hasEntity: boolean;
  onRetry: () => void;
  children: ReactNode;
}): JSX.Element {
  if (state.status === "loading") {
    return (
      <output className="wx-list-state" aria-live="polite">
        <LoadingSpinner />
      </output>
    );
  }
  if (state.status === "error") {
    return (
      <div className="wx-list-state" role="alert">
        <EmptyState
          title="Provider entities unavailable"
          description="The list of provider entities could not be loaded, so commercial billing cannot be scoped."
        />
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!hasEntity) {
    return (
      <div className="wx-list-state">
        <EmptyState
          title="No provider entity in your scope"
          description="Commercial billing is read per provider entity, and none is visible to you."
        />
      </div>
    );
  }
  return <>{children}</>;
}
