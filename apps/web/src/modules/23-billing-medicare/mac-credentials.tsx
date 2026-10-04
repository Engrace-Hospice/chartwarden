import {
  AdminSplitLayout,
  Button,
  CeremonyModal,
  CursorPagination,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  MaskedIdentifier,
  Modal,
  PageHeader,
  StatusPill,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the MAC CREDENTIALS admin (R2, §5.1
// admin / §4.1 #34-35, §3.6). The per-ProviderEntity MAC submitter-credential surface: a selectable
// credential rail over a per-credential detail (matrix). The `client_secret_cipher` is NEVER projected —
// the view carries only the safe identifiers + a `hasSecret` flag (§3.6); the secret is WRITE-ONLY and is
// encrypted at the persistence boundary. An upsert is a PRIVILEGED config act gated by a §D14 step-up
// assertion at the route layer — the UI gates it behind a CeremonyModal (the §7.4 attestation with a step-up
// challenge). The first insert omits If-Match; an update carries the §2.5 version (412 on stale). Every
// mutation carries an Idempotency-Key (§4.1.1). The server is the only authz point (ADR-0030): a 401/403
// surfaces inline as "step-up required", a 412 as "reopen to retry", a 503 as a seam notice — never a toast.
// Identifiers render through MaskedIdentifier (read-only mask; no reveal seam is exposed). The Test-Sandbox
// affordance is shown but inert — no sandbox-test route is exposed by the M23 API (no backend changes here).
// Lantern: AdminSplitLayout, No-Line rail, §6.6 StatusPills, CSS-var tokens only. openapi emits no billing
// schemas → reads cast, inits `as never`.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { ProviderEntityLookupField } from "../../shell/entity-lookups";
import { statusLabel } from "./billing-status";

type MacJurisdiction =
  | "ngs_j6"
  | "ngs_jk"
  | "cgs_j15"
  | "palmetto_jj"
  | "palmetto_jm"
  | "noridian_jf"
  | "noridian_je";
const MAC_JURISDICTIONS: MacJurisdiction[] = [
  "ngs_j6",
  "ngs_jk",
  "cgs_j15",
  "palmetto_jj",
  "palmetto_jm",
  "noridian_jf",
  "noridian_je",
];

interface MacCredentialView {
  credentialId: string;
  providerEntityId: string;
  macJurisdiction: string;
  submitterId: string;
  tradingPartnerId: string;
  clientId: string;
  hasSecret: boolean;
  baaRecordRef: string | null;
  credentialExpiresAt: string | null;
  lastSandboxTestAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface MacCredentialPage {
  items: MacCredentialView[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface UpsertDraft {
  providerEntityId: string;
  macJurisdiction: MacJurisdiction;
  submitterId: string;
  tradingPartnerId: string;
  clientId: string;
  clientSecret: string;
  baaRecordRef: string;
  credentialExpiresAt: string;
  /** Present only when editing an existing credential (drives the If-Match version on PUT-like upsert). */
  version: number | null;
}

function idemKey(): string {
  return crypto.randomUUID();
}

function emptyDraft(): UpsertDraft {
  return {
    providerEntityId: "",
    macJurisdiction: "ngs_j6",
    submitterId: "",
    tradingPartnerId: "",
    clientId: "",
    clientSecret: "",
    baaRecordRef: "",
    credentialExpiresAt: "",
    version: null,
  };
}

export function MacCredentials(): JSX.Element {
  const client = useApiClient();
  const [creds, setCreds] = useState<MacCredentialView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UpsertDraft | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [jurisdictionFilter, setJurisdictionFilter] = useState("all");
  const [secretFilter, setSecretFilter] = useState("all");
  const [expiryFilter, setExpiryFilter] = useState("all");

  const load = useCallback(
    async (cursor?: string | null, append = false) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/billing/mac-credentials", {
        params: { query: { limit: 50, ...(cursor ? { cursor } : {}) } },
      } as never);
      if (err) {
        setError(
          "MAC credentials unavailable — the billing read seam is not bound, or you lack scope.",
        );
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      const page = (data as unknown as MacCredentialPage) ?? {
        items: [],
        nextCursor: null,
        hasMore: false,
      };
      const items = (page.items ?? []) as MacCredentialView[];
      setCreds((current) => (append ? [...current, ...items] : items));
      setSelectedId((cur) => cur ?? items[0]?.credentialId ?? null);
      setNextCursor(page.nextCursor ?? null);
      setHasMore(Boolean(page.hasMore));
      setLoading(false);
      setLoadingMore(false);
    },
    [client],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const selected = creds.find((c) => c.credentialId === selectedId) ?? null;
  const filteredCreds = creds.filter((credential) => {
    const q = searchQuery.trim().toLowerCase();
    const expired = isExpired(credential);
    const matchesSearch =
      q.length === 0 ||
      credential.providerEntityId.toLowerCase().includes(q) ||
      credential.submitterId.toLowerCase().includes(q) ||
      credential.tradingPartnerId.toLowerCase().includes(q) ||
      credential.clientId.toLowerCase().includes(q) ||
      macLabel(credential.macJurisdiction).toLowerCase().includes(q);
    const matchesJurisdiction =
      jurisdictionFilter === "all" || credential.macJurisdiction === jurisdictionFilter;
    const matchesSecret =
      secretFilter === "all" ||
      (secretFilter === "present" && credential.hasSecret) ||
      (secretFilter === "missing" && !credential.hasSecret);
    const matchesExpiry =
      expiryFilter === "all" ||
      (expiryFilter === "expired" && expired) ||
      (expiryFilter === "active" && !expired && credential.credentialExpiresAt !== null) ||
      (expiryFilter === "none" && credential.credentialExpiresAt === null);
    return matchesSearch && matchesJurisdiction && matchesSecret && matchesExpiry;
  });
  const activeFilterCount =
    (searchQuery.trim() ? 1 : 0) +
    (jurisdictionFilter !== "all" ? 1 : 0) +
    (secretFilter !== "all" ? 1 : 0) +
    (expiryFilter !== "all" ? 1 : 0);

  const editSelected = useCallback((c: MacCredentialView) => {
    setDraft({
      providerEntityId: c.providerEntityId,
      macJurisdiction: c.macJurisdiction as MacJurisdiction,
      submitterId: c.submitterId,
      tradingPartnerId: c.tradingPartnerId,
      clientId: c.clientId,
      clientSecret: "",
      baaRecordRef: c.baaRecordRef ?? "",
      credentialExpiresAt: c.credentialExpiresAt ?? "",
      version: c.version,
    });
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <>
      <AdminSplitLayout
        header={
          <PageHeader
            title="MAC Credentials"
            breadcrumb="Billing / Medicare / Submitter credentials"
            actions={
              <>
                <a href="/billing" style={linkButtonStyle}>
                  AR dashboard
                </a>
                <Button size="sm" onClick={() => setDraft(emptyDraft())}>
                  Add credential
                </Button>
              </>
            }
          >
            <div style={{ color: t.onSurfaceVariant, fontSize: "0.875rem" }}>
              Manage provider MAC submitter credentials without exposing write-only secrets.
            </div>
          </PageHeader>
        }
        list={
          <CredentialRail
            creds={filteredCreds}
            selectedId={selectedId}
            totalLoaded={creds.length}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={() => void load(nextCursor, true)}
            onSelect={setSelectedId}
            filters={
              <FilterBar
                activeFilterCount={activeFilterCount}
                onClear={
                  activeFilterCount > 0
                    ? () => {
                        setSearchQuery("");
                        setJurisdictionFilter("all");
                        setSecretFilter("all");
                        setExpiryFilter("all");
                      }
                    : undefined
                }
              >
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search credentials…"
                    aria-label="Search credentials"
                  />
                </label>
                <label className="wx-filter-field">
                  <span>MAC</span>
                  <select
                    className="wx-select"
                    value={jurisdictionFilter}
                    onChange={(e) => setJurisdictionFilter(e.target.value)}
                    aria-label="Filter by MAC jurisdiction"
                  >
                    <option value="all">All</option>
                    {MAC_JURISDICTIONS.map((m) => (
                      <option key={m} value={m}>
                        {macLabel(m)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Secret</span>
                  <select
                    className="wx-select"
                    value={secretFilter}
                    onChange={(e) => setSecretFilter(e.target.value)}
                    aria-label="Filter by secret status"
                  >
                    <option value="all">All</option>
                    <option value="present">Secret on file</option>
                    <option value="missing">No secret</option>
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Expiry</span>
                  <select
                    className="wx-select"
                    value={expiryFilter}
                    onChange={(e) => setExpiryFilter(e.target.value)}
                    aria-label="Filter by expiry"
                  >
                    <option value="all">All</option>
                    <option value="active">Dated active</option>
                    <option value="expired">Expired</option>
                    <option value="none">No expiry</option>
                  </select>
                </label>
              </FilterBar>
            }
          />
        }
        fullPageScroll
      >
        {selected ? (
          <CredentialDetail credential={selected} onEdit={() => editSelected(selected)} />
        ) : (
          <EmptyState
            title="No credential selected"
            description="Pick a provider entity's MAC credential, or add a new one."
          />
        )}
      </AdminSplitLayout>
      {draft ? (
        <UpsertCeremony
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            void load(null, false);
          }}
        />
      ) : null}
    </>
  );
}

// ── credential rail (No-Line; secret-presence + expiry posture chips) ─────────────────────────────────
function CredentialRail({
  creds,
  selectedId,
  totalLoaded,
  hasMore,
  loadingMore,
  onLoadMore,
  onSelect,
  filters,
}: {
  creds: MacCredentialView[];
  selectedId: string | null;
  totalLoaded: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  filters: JSX.Element;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {filters}
      {creds.length === 0 ? (
        <div style={{ padding: "2rem 1rem" }}>
          <EmptyState
            title={totalLoaded === 0 ? "No credentials" : "No matching credentials"}
            description={
              totalLoaded === 0
                ? "No MAC credentials in your scope."
                : "Adjust or clear filters to return to the loaded credential list."
            }
          />
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {creds.map((c) => {
            const active = c.credentialId === selectedId;
            const expired = isExpired(c);
            return (
              <li key={c.credentialId}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(c.credentialId)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.3rem",
                    width: "100%",
                    textAlign: "left",
                    cursor: "pointer",
                    border: "none",
                    background: active ? t.primaryTint : "transparent",
                    padding: "0.75rem 0.85rem",
                    borderBottom: ghostBorder,
                  }}
                  className="wx-data-row-interactive"
                >
                  <span style={{ fontSize: "0.85rem", fontWeight: 600, color: t.onSurface }}>
                    {macLabel(c.macJurisdiction)}
                  </span>
                  <span
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: "0.72rem",
                      color: t.onSurfaceVariant,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {c.providerEntityId}
                  </span>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                    <StatusPill
                      label={c.hasSecret ? "Secret on file" : "No secret"}
                      tone={c.hasSecret ? "success" : "warning"}
                    />
                    {expired ? <StatusPill label="Expired" tone="error" /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <CursorPagination
        loadedCount={totalLoaded}
        hasNextPage={hasMore}
        onNextPage={onLoadMore}
        loading={loadingMore}
        noun="credentials"
      />
    </div>
  );
}

// ── per-credential detail (matrix; masked identifiers, sealed secret, sandbox state) ──────────────────
function CredentialDetail({
  credential,
  onEdit,
}: { credential: MacCredentialView; onEdit: () => void }): JSX.Element {
  const expired = credential.credentialExpiresAt
    ? new Date(credential.credentialExpiresAt).getTime() < Date.now()
    : false;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "40rem" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <h2
          style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.25rem", color: t.onSurface }}
        >
          {macLabel(credential.macJurisdiction)}
        </h2>
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: "0.78rem",
            color: t.onSurfaceVariant,
            overflowWrap: "anywhere",
          }}
        >
          {credential.providerEntityId}
        </span>
      </header>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.6rem 1.25rem",
          margin: 0,
        }}
      >
        <Term label="Submitter id" />
        <Desc>
          <MaskedIdentifier value={credential.submitterId} label="MAC submitter id" />
        </Desc>
        <Term label="Trading partner id" />
        <Desc>
          <MaskedIdentifier value={credential.tradingPartnerId} label="Trading partner id" />
        </Desc>
        <Term label="Client id" />
        <Desc>
          <MaskedIdentifier value={credential.clientId} label="OAuth client id" />
        </Desc>
        <Term label="Client secret" />
        <Desc>
          <StatusPill
            label={credential.hasSecret ? "Stored (encrypted)" : "Not set"}
            tone={credential.hasSecret ? "success" : "warning"}
          />
        </Desc>
        <Term label="BAA reference" />
        <Desc>
          <span style={{ fontFamily: t.fontMono, fontSize: "0.82rem" }}>
            {credential.baaRecordRef ?? "—"}
          </span>
        </Desc>
        <Term label="Expires" />
        <Desc>
          {credential.credentialExpiresAt ? (
            <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {new Date(credential.credentialExpiresAt).toLocaleDateString()}
              </span>
              {expired ? <StatusPill label="Expired" tone="error" /> : null}
            </span>
          ) : (
            "—"
          )}
        </Desc>
        <Term label="Last sandbox test" />
        <Desc>
          <span style={{ fontVariantNumeric: "tabular-nums", color: t.onSurfaceVariant }}>
            {credential.lastSandboxTestAt
              ? new Date(credential.lastSandboxTestAt).toLocaleString()
              : "Never"}
          </span>
        </Desc>
      </dl>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <Button onClick={onEdit}>Edit credential</Button>
        <Button
          disabled
          title="No sandbox-test route is exposed by the billing API."
          tone="secondary"
        >
          Test sandbox
        </Button>
      </div>
    </section>
  );
}

// ── upsert ceremony — collects the credential, then a step-up attestation commits the write ───────────
function UpsertCeremony({
  draft,
  onChange,
  onCancel,
  onSaved,
}: {
  draft: UpsertDraft;
  onChange: (d: UpsertDraft) => void;
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const isEdit = draft.version !== null;

  const fieldsReady =
    draft.providerEntityId.trim().length > 0 &&
    draft.submitterId.trim().length > 0 &&
    draft.tradingPartnerId.trim().length > 0 &&
    draft.clientId.trim().length > 0 &&
    draft.clientSecret.trim().length > 0;

  const commit = useCallback(async () => {
    setActionError(null);
    const header: Record<string, string> = { "Idempotency-Key": idemKey() };
    if (draft.version !== null) header["If-Match"] = String(draft.version);
    const init = {
      params: { header },
      body: {
        providerEntityId: draft.providerEntityId.trim(),
        macJurisdiction: draft.macJurisdiction,
        submitterId: draft.submitterId.trim(),
        tradingPartnerId: draft.tradingPartnerId.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
        ...(draft.baaRecordRef.trim().length > 0
          ? { baaRecordRef: draft.baaRecordRef.trim() }
          : {}),
        ...(draft.credentialExpiresAt.trim().length > 0
          ? { credentialExpiresAt: new Date(draft.credentialExpiresAt).toISOString() }
          : {}),
      },
    };
    const { error: err, response } = (await client.POST(
      "/api/v1/billing/mac-credentials",
      init as never,
    )) as { error?: unknown; response?: Response };
    if (err) {
      const s = response?.status;
      setActionError(
        s === 401 || s === 403
          ? "Re-authentication (step-up) is required to save credentials."
          : s === 412
            ? "This credential changed since you opened it — reopen to retry."
            : s === 422
              ? "The credential was rejected — review the fields."
              : s === 503
                ? "Billing write seam unavailable — try again shortly."
                : "The credential could not be saved.",
      );
      setCeremonyOpen(false);
      return;
    }
    setCeremonyOpen(false);
    onSaved();
  }, [client, draft, onSaved]);

  return (
    // WX-PR-022 (UI-002): was a bespoke `role="dialog"` div with no focus trap/Escape/restore —
    // migrated to the canonical Modal (packages/ui/src/web/system/modal.tsx), same accessible shell
    // every other blocking dialog in the app uses.
    <Modal open onClose={onCancel} ariaLabel="MAC credential upsert" width="34rem">
      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", padding: "1.5rem" }}>
        <h2
          style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.25rem", color: t.onSurface }}
        >
          {isEdit ? "Edit MAC credential" : "Add MAC credential"}
        </h2>

        <ProviderEntityLookupField
          label="Provider entity"
          value={draft.providerEntityId}
          disabled={isEdit}
          onChange={(value) => onChange({ ...draft, providerEntityId: value })}
        />
        <Labeled id="mc-mac" label="MAC jurisdiction">
          <select
            id="mc-mac"
            value={draft.macJurisdiction}
            onChange={(e) =>
              onChange({ ...draft, macJurisdiction: e.target.value as MacJurisdiction })
            }
            style={selectStyle}
          >
            {MAC_JURISDICTIONS.map((m) => (
              <option key={m} value={m}>
                {macLabel(m)}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled id="mc-sub" label="Submitter id">
          <input
            id="mc-sub"
            value={draft.submitterId}
            onChange={(e) => onChange({ ...draft, submitterId: e.target.value })}
            style={inputStyle}
          />
        </Labeled>
        <Labeled id="mc-tp" label="Trading partner id">
          <input
            id="mc-tp"
            value={draft.tradingPartnerId}
            onChange={(e) => onChange({ ...draft, tradingPartnerId: e.target.value })}
            style={inputStyle}
          />
        </Labeled>
        <Labeled id="mc-cid" label="Client id">
          <input
            id="mc-cid"
            value={draft.clientId}
            onChange={(e) => onChange({ ...draft, clientId: e.target.value })}
            style={{ ...inputStyle, fontFamily: t.fontMono }}
          />
        </Labeled>
        <Labeled id="mc-secret" label="Client secret (write-only)">
          <input
            id="mc-secret"
            type="password"
            value={draft.clientSecret}
            autoComplete="off"
            onChange={(e) => onChange({ ...draft, clientSecret: e.target.value })}
            placeholder="Encrypted at rest — never displayed back"
            style={inputStyle}
          />
        </Labeled>
        <Labeled id="mc-baa" label="BAA reference (optional)">
          <input
            id="mc-baa"
            value={draft.baaRecordRef}
            onChange={(e) => onChange({ ...draft, baaRecordRef: e.target.value })}
            style={{ ...inputStyle, fontFamily: t.fontMono }}
          />
        </Labeled>
        <Labeled id="mc-exp" label="Expires (optional)">
          <input
            id="mc-exp"
            type="date"
            value={draft.credentialExpiresAt ? draft.credentialExpiresAt.slice(0, 10) : ""}
            onChange={(e) => onChange({ ...draft, credentialExpiresAt: e.target.value })}
            style={inputStyle}
          />
        </Labeled>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button disabled={!fieldsReady} onClick={() => setCeremonyOpen(true)}>
            Save with step-up
          </Button>
          <Button tone="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {actionError ? (
          <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: t.error }}>
            {actionError}
          </p>
        ) : null}
      </div>

      <CeremonyModal
        open={ceremonyOpen}
        title="Save MAC credential"
        attestation={
          <span>
            You are {isEdit ? "updating" : "creating"} the MAC submitter credential for{" "}
            <strong style={{ fontFamily: t.fontMono }}>{draft.providerEntityId}</strong> (
            {macLabel(draft.macJurisdiction)}). The client secret is encrypted at rest and never
            displayed.
          </span>
        }
        legalText="I confirm I am authorized to manage this provider entity's clearinghouse credentials."
        signer={{ name: "You", role: "Billing administrator" }}
        stepUp={{ label: "Re-enter your password to continue", type: "password" }}
        commitLabel="Sign & save"
        onCommit={() => void commit()}
        onCancel={() => setCeremonyOpen(false)}
      />
    </Modal>
  );
}

function Labeled({
  id,
  label,
  children,
}: { id: string; label: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Term({ label }: { label: string }): JSX.Element {
  return (
    <dt style={{ fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant }}>{label}</dt>
  );
}
function Desc({ children }: { children: JSX.Element | string }): JSX.Element {
  return <dd style={{ margin: 0, fontSize: "0.85rem", color: t.onSurface }}>{children}</dd>;
}

const MAC_LABELS: Record<string, string> = {
  ngs_j6: "NGS · J6",
  ngs_jk: "NGS · JK",
  cgs_j15: "CGS · J15",
  palmetto_jj: "Palmetto · JJ",
  palmetto_jm: "Palmetto · JM",
  noridian_jf: "Noridian · JF",
  noridian_je: "Noridian · JE",
};
function macLabel(j: string): string {
  return MAC_LABELS[j] ?? statusLabel(j);
}

const labelStyle = { fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant };
const inputStyle = {
  padding: "0.5rem 0.6rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
};
const selectStyle = { ...inputStyle, maxWidth: "16rem" };
const linkButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
};

function isExpired(credential: MacCredentialView): boolean {
  return credential.credentialExpiresAt
    ? new Date(credential.credentialExpiresAt).getTime() < Date.now()
    : false;
}
