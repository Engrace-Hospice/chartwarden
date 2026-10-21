// apps/web/src/modules/34-saas — M34 tenant-facing Support Consent Grants (`/admin/support-grants`).
// Spec §5.1 (lines 2091,2097): "Support consent grants — issue new grant, list active/historical".
// withOrgContext (org_admin / compliance_officer). A tenant compliance_officer files a
// `support_consent_grant` (scope + ≤72h expiry) that a DISTINCT platform-ops actor may later start a
// support_session against (the with-consent break-glass variant, M34-F01). Backed by the typed client:
//   GET  /api/v1/tenant/support-consent-grants  (list_own — every view is a §164.528 disclosure surface)
//   POST /api/v1/tenant/support-consent-grants   (issue — compliance_officer-gated + §6/D10 passkey step-up)
// Issue is therefore a §7.4 Guardrail Ceremony (CeremonyModal) — the consequence (granting platform PHI
// access) is surfaced BEFORE the step-up credential (§5.3). Lantern: No-Line table, primary-tint selected
// row, mono identifiers, CountdownChip for the ≤72h expiry, CSS-var tokens only. Mirrors the M40
// mdm-console / M36 messaging exemplars (useApiClient + WorkQueueLayout).
import {
  Button,
  CeremonyModal,
  CountdownChip,
  CursorPagination,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { SUPPORT_SESSION_TONE, cap, statusLabel } from "./saas-status";

// The §4.1 list response (CursorPage<SupportConsentGrantView>), as the tenant route projects it.
interface SupportConsentGrantView {
  id: string;
  tenantAccountId: string;
  scope: "organization_scoped" | "patient_scoped";
  grantReason: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  createdAt: string;
}
interface GrantPage {
  items: SupportConsentGrantView[];
  nextCursor: string | null;
  hasMore: boolean;
}

type Lane = "active" | "historical";

// A grant's lifecycle posture → the §6.6 support-session palette (active consented access is the gold
// 'critical' controlled state; revoked is error; an elapsed/expired grant is inert neutral).
function grantState(g: SupportConsentGrantView): string {
  if (g.revokedAt) return "revoked";
  if (!g.active) return "closed";
  if (new Date(g.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

const scopeLabel = (s: SupportConsentGrantView["scope"]): string =>
  s === "patient_scoped" ? "Patient-scoped" : "Organization-scoped";

export function SupportGrants(): JSX.Element {
  const client = useApiClient();
  const [grants, setGrants] = useState<SupportConsentGrantView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<(string | null)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("active");
  const [selected, setSelected] = useState<SupportConsentGrantView | null>(null);
  const [ceremonyOpen, setCeremonyOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/tenant/support-consent-grants", {
      params: { query: { ...(cursor ? { cursor } : {}), limit: 25 } },
    } as never);
    if (err) {
      setError("Could not load support consent grants.");
      setGrants([]);
      setLoading(false);
      return;
    }
    const page = data as unknown as GrantPage | undefined;
    setGrants((page?.items ?? []) as SupportConsentGrantView[]);
    setNextCursor(page?.nextCursor ?? null);
    setHasMore(Boolean(page?.hasMore));
    setLoading(false);
  }, [client, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!grants) return null;
    return grants.filter((g) =>
      lane === "active" ? grantState(g) === "active" : grantState(g) !== "active",
    );
  }, [grants, lane]);

  function nextPage(): void {
    if (!nextCursor) return;
    setPreviousCursors((stack) => [...stack, cursor]);
    setCursor(nextCursor);
  }

  function previousPage(): void {
    setPreviousCursors((stack) => {
      const nextStack = [...stack];
      const previous = nextStack.pop() ?? null;
      setCursor(previous);
      return nextStack;
    });
  }

  const issue = useCallback(
    async (_stepUpValue?: string) => {
      // Issue a 72h organization-scoped grant. The §6/D10 step-up is enforced server-side; the
      // ceremony surfaces the consequence + credential prompt before this commit fires.
      await client.POST("/api/v1/tenant/support-consent-grants", {
        body: {
          scope: "organization_scoped",
          grantReason: "Tenant-initiated support access grant",
          expiresAtIsoOffsetHours: 72,
        },
      });
      setCeremonyOpen(false);
      await load();
    },
    [client, load],
  );

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Support Consent Grants"
            breadcrumb="Admin / Organization"
            actions={
              <Button type="button" onClick={() => setCeremonyOpen(true)}>
                Issue grant
              </Button>
            }
          >
            <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
              A consent grant lets a ChartWarden support engineer access your tenant for up to 72 hours.
              Issuing requires a compliance officer and a step-up challenge.
            </p>
          </PageHeader>
        }
        filters={
          <FilterBar>
            <select
              aria-label="Grant lane"
              value={lane}
              onChange={(e) => setLane(e.target.value as Lane)}
              style={selectStyle}
            >
              <option value="active">Active</option>
              <option value="historical">Historical</option>
            </select>
          </FilterBar>
        }
        table={
          <GrantTable
            items={visible}
            loading={loading}
            error={error}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            hasMore={hasMore}
            hasPrevious={previousCursors.length > 0}
            onNext={nextPage}
            onPrevious={previousPage}
          />
        }
        detail={
          selected ? <GrantDetail grant={selected} onClose={() => setSelected(null)} /> : undefined
        }
        fullPageScroll
      />
      <CeremonyModal
        open={ceremonyOpen}
        title="Issue support consent grant"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Organization-scoped · 72 hours</strong>
            </div>
            <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
              A distinct ChartWarden support engineer will be permitted to start a consented support
              session against this organization. PHI reads within that session require a further
              per-session elevation and are recorded for §164.528 disclosure accounting.
            </span>
          </div>
        }
        legalText="I am a compliance officer authorizing this disclosure of access on behalf of the organization."
        signer={{ name: "Compliance officer", role: "This session" }}
        stepUp={{ label: "Re-enter your passkey credential to continue", type: "password" }}
        commitLabel="Issue grant"
        onCommit={(v) => void issue(v)}
        onCancel={() => setCeremonyOpen(false)}
      />
    </>
  );
}

function GrantTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  hasMore,
  hasPrevious,
  onNext,
  onPrevious,
}: {
  items: SupportConsentGrantView[] | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (g: SupportConsentGrantView) => void;
  hasMore: boolean;
  hasPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
}): JSX.Element {
  if (error)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="Unavailable" description={error} />
      </div>
    );
  if (items === null || loading)
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  if (items.length === 0)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="No grants" description="No support consent grants in this lane." />
      </div>
    );
  return (
    <div style={tableWrapStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Scope</th>
            <th style={thStyle}>Reason</th>
            <th style={thStyle}>Expires</th>
            <th style={thStyle}>State</th>
          </tr>
        </thead>
        <tbody>
          {items.map((g) => {
            const state = grantState(g);
            return (
              <tr
                key={g.id}
                // biome-ignore lint/a11y/useSemanticElements: clickable row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                aria-pressed={g.id === selectedId}
                onClick={() => onSelect(g)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(g);
                  }
                }}
                style={{
                  cursor: "pointer",
                  background: g.id === selectedId ? "var(--color-primary-tint)" : undefined,
                  borderTop:
                    "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
                }}
              >
                <td style={tdStyle}>{scopeLabel(g.scope)}</td>
                <td style={tdStyle}>{g.grantReason}</td>
                <td style={tdStyle}>
                  {state === "active" ? (
                    <CountdownChip dueAt={g.expiresAt} label="Expires" />
                  ) : (
                    <span style={{ color: "var(--color-on-surface-variant)" }}>
                      {fmt(g.expiresAt)}
                    </span>
                  )}
                </td>
                <td style={tdStyle}>
                  <StatusPill label={cap(state)} tone={SUPPORT_SESSION_TONE[state] ?? "neutral"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <CursorPagination
        loadedCount={items.length}
        hasNextPage={hasMore}
        hasPreviousPage={hasPrevious}
        onNextPage={onNext}
        onPreviousPage={onPrevious}
        loading={loading}
        noun="support grants"
      />
    </div>
  );
}

function GrantDetail({
  grant,
  onClose,
}: { grant: SupportConsentGrantView; onClose: () => void }): JSX.Element {
  const state = grantState(grant);
  return (
    <RightDetailPanel title="Grant detail" onClose={onClose}>
      <Row label="State">
        <StatusPill label={statusLabel(state)} tone={SUPPORT_SESSION_TONE[state] ?? "neutral"} />
      </Row>
      <Row label="Scope">{scopeLabel(grant.scope)}</Row>
      <Row label="Reason">{grant.grantReason}</Row>
      <Row label="Grant id">
        <span className="wx-data-md">{grant.id}</span>
      </Row>
      <Row label="Issued">
        <span className="tabular-nums">{fmt(grant.issuedAt)}</span>
      </Row>
      <Row label="Expires">
        <span className="tabular-nums">{fmt(grant.expiresAt)}</span>
      </Row>
      {grant.revokedAt ? (
        <Row label="Revoked">
          <span className="tabular-nums">{fmt(grant.revokedAt)}</span>
        </Row>
      ) : null}
    </RightDetailPanel>
  );
}

function Row({ label, children }: { label: string; children: JSX.Element | string }): JSX.Element {
  return (
    <div style={{ marginBottom: "0.6rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
      <div
        style={{ fontSize: "0.85rem", color: "var(--color-on-surface)", wordBreak: "break-word" }}
      >
        {children}
      </div>
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const selectStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
} as const;

const tableWrapStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minWidth: 0,
} as const;

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
} as const;

const thStyle = {
  padding: "0.75rem 1rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
} as const;

const tdStyle = {
  padding: "0.75rem 1rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
} as const;
