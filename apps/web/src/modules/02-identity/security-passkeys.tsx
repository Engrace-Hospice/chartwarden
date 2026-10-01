import type { PasskeyInfo } from "@wardenx/auth/client";
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
} from "@wardenx/ui";
// apps/web/src/modules/02-identity — Passkey enrollment & management (M2 Auth, ADR-0034 follow-up).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "passkey enrollment". An authenticated user registers a
// WebAuthn passkey (authClient.passkey.addPasskey) and lists/removes them. The WebAuthn ceremony is
// browser-only (a real authenticator) — not CI-testable — so this is build-/e2e-verified.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { authClient } from "./auth-client";

const PASSKEY_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function SecurityPasskeys(): JSX.Element {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [deviceFilter, setDeviceFilter] = useState<
    "all" | "platform" | "cross-platform" | "unknown"
  >("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    const { data, error: err } = await authClient.passkey.listUserPasskeys();
    if (err) {
      setError("Could not load your passkeys.");
      // `passkeys === null` is the "still loading" state (drives the spinner below) — leaving it
      // null on a load error kept the spinner spinning forever alongside the error message instead
      // of settling into the empty state.
      setPasskeys([]);
      return;
    }
    setPasskeys(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function register(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.passkey.addPasskey(
      name.trim() ? { name: name.trim() } : undefined,
    );
    setBusy(false);
    if (err) {
      setError("Passkey registration failed or was cancelled.");
      return;
    }
    setName("");
    void load();
  }

  async function remove(id: string): Promise<void> {
    const { error: err } = await authClient.passkey.deletePasskey({ id });
    if (err) {
      setError("Could not remove that passkey.");
      return;
    }
    void load();
  }

  const filteredPasskeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (passkeys ?? []).filter((passkey) => {
      const device = normalizeDeviceType(passkey.deviceType);
      const matchesDevice = deviceFilter === "all" || device === deviceFilter;
      const matchesSearch =
        q.length === 0 ||
        (passkey.name ?? "Passkey").toLowerCase().includes(q) ||
        (passkey.deviceType ?? "unknown").toLowerCase().includes(q) ||
        passkey.id.toLowerCase().includes(q);
      return matchesDevice && matchesSearch;
    });
  }, [deviceFilter, passkeys, searchQuery]);

  const hasActiveFilters = searchQuery.trim() !== "" || deviceFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredPasskeys.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedPasskeys = filteredPasskeys.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setDeviceFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Passkeys" breadcrumb="Security / Account">
          <div
            style={{
              color: "var(--color-on-surface-variant)",
              fontSize: "0.875rem",
            }}
          >
            Manage device biometrics and security keys used for passwordless sign-in.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={inlineClusterStyle}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <Button size="sm" tone="tertiary" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </div>
          ) : null}

          <div style={toolbarStyle}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void register();
              }}
              style={registerFormStyle}
            >
              <div style={passkeyNameFieldStyle}>
                <label htmlFor="passkey-name" style={fieldLabelStyle}>
                  Passkey name <span style={optionalLabelStyle}>(optional)</span>
                </label>

                <input
                  id="passkey-name"
                  placeholder="e.g. Work laptop"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  maxLength={100}
                  style={searchInputStyle}
                />
              </div>
              <Button type="submit" tone="primary" disabled={busy}>
                {busy ? "Registering..." : "Register passkey"}
              </Button>
            </form>

            <div style={controlGroupStyle}>
              <div style={searchBoxStyle}>
                <Glyph name="eye" size={14} />
                <input
                  type="search"
                  placeholder="Search passkeys..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search passkeys"
                  style={embeddedSearchInputStyle}
                />
              </div>
              <select
                value={deviceFilter}
                onChange={(e) => {
                  setDeviceFilter(e.target.value as typeof deviceFilter);
                  setPage(1);
                }}
                aria-label="Filter by authenticator type"
                style={selectStyle}
              >
                <option value="all">Device: All</option>
                <option value="platform">This device</option>
                <option value="cross-platform">Security key</option>
                <option value="unknown">Unknown</option>
              </select>
              {hasActiveFilters ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        passkeys === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filteredPasskeys.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching passkeys" : "No passkeys"}
              description={
                hasActiveFilters
                  ? "Try a different name or clear the active filters."
                  : "Register a passkey to sign in without a password."
              }
              action={
                hasActiveFilters ? (
                  <Button tone="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headRowStyle}>
                  <th style={{ ...thStyle, width: "38%" }}>Passkey</th>
                  <th style={{ ...thStyle, width: "22%" }}>Device</th>
                  <th style={{ ...thStyle, width: "20%" }}>Created</th>
                  <th style={{ ...thStyle, width: "20%", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedPasskeys.map((passkey) => (
                  <tr key={passkey.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <PasskeyCell passkey={passkey} />
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={deviceLabel(passkey.deviceType)}
                        tone={
                          normalizeDeviceType(passkey.deviceType) === "unknown"
                            ? "neutral"
                            : "progress"
                        }
                      />
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(passkey.createdAt)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <Button size="sm" tone="danger" onClick={() => void remove(passkey.id)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredPasskeys.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={PASSKEY_PAGE_SIZES}
              noun="passkeys"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function PasskeyCell({ passkey }: { passkey: PasskeyInfo }): JSX.Element {
  return (
    <div style={passkeyCellStyle}>
      <div style={avatarStyle} aria-hidden>
        <Glyph name="lock" size={16} />
      </div>
      <div style={cellTextStyle}>
        <span style={primaryTextStyle}>{passkey.name ?? "Passkey"}</span>
        <code className="wx-data-md" style={secondaryCodeStyle}>
          {shortId(passkey.id)}
        </code>
      </div>
    </div>
  );
}

function normalizeDeviceType(
  value: string | null | undefined,
): "platform" | "cross-platform" | "unknown" {
  if (value === "platform" || value === "cross-platform") return value;
  return "unknown";
}

function deviceLabel(value: string | null | undefined): string {
  switch (normalizeDeviceType(value)) {
    case "platform":
      return "This device";
    case "cross-platform":
      return "Security key";
    case "unknown":
      return "Unknown";
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const registerFormStyle: CSSProperties = {
  display: "flex",
  flex: "1 1 24rem",
  alignItems: "center",
  gap: "0.5rem",
  minWidth: "18rem",
};
const controlGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const inlineClusterStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error-pill-fg)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};
const searchInputStyle: CSSProperties = {
  // flex: 1,
  width: "100%",
  minWidth: "12rem",
  height: "2.25rem",
  padding: "0.45rem 0.65rem",
  fontSize: "0.85rem",
};
const searchBoxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  minWidth: "15rem",
  height: "2.25rem",
  padding: "0 0.65rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
};
const embeddedSearchInputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "none",
  background: "transparent",
  outline: "none",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const selectStyle: CSSProperties = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};
const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};
const headRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const tdStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle",
};
const passkeyCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};
const avatarStyle: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
const cellTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
};
const primaryTextStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const secondaryCodeStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const passkeyNameFieldStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  alignItems: "center",
  minWidth: "12rem",
  flexDirection: "column",
  gap: "0.3rem",
};

const fieldLabelStyle: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const optionalLabelStyle: CSSProperties = {
  fontWeight: 400,
  color: "var(--color-on-surface-variant)",
};
