import {
  AdminSplitLayout,
  CeremonyModal,
  EmptyState,
  LoadingSpinner,
  MaskedIdentifier,
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
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UpsertDraft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/billing/mac-credentials", {
      params: { query: { limit: 200 } },
    } as never);
    if (err) {
      setError(
        "MAC credentials unavailable — the billing read seam is not bound, or you lack scope.",
      );
      setLoading(false);
      return;
    }
    const items = ((data as unknown as MacCredentialPage)?.items ?? []) as MacCredentialView[];
    setCreds(items);
    setSelectedId((cur) => cur ?? items[0]?.credentialId ?? null);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = creds.find((c) => c.credentialId === selectedId) ?? null;

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
            breadcrumb="Billing — Medicare · Submitter credentials"
            actions={
              <button
                type="button"
                onClick={() => setDraft(emptyDraft())}
                style={primaryButtonStyle}
              >
                Add credential
              </button>
            }
          />
        }
        list={<CredentialRail creds={creds} selectedId={selectedId} onSelect={setSelectedId} />}
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
            void load();
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
  onSelect,
}: {
  creds: MacCredentialView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  if (creds.length === 0)
    return <EmptyState title="No credentials" description="No MAC credentials in your scope." />;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {creds.map((c) => {
        const active = c.credentialId === selectedId;
        const expired = c.credentialExpiresAt
          ? new Date(c.credentialExpiresAt).getTime() < Date.now()
          : false;
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
                padding: "0.6rem 0.85rem",
                borderBottom: ghostBorder,
              }}
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
        <button type="button" onClick={onEdit} style={primaryButtonStyle}>
          Edit credential
        </button>
        <button
          type="button"
          disabled
          title="No sandbox-test route is exposed by the billing API."
          style={disabledButtonStyle}
        >
          Test sandbox
        </button>
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
    <div role="dialog" aria-label="MAC credential upsert" style={drawerStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", maxWidth: "30rem" }}>
        <h2
          style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.25rem", color: t.onSurface }}
        >
          {isEdit ? "Edit MAC credential" : "Add MAC credential"}
        </h2>

        <Labeled id="mc-pe" label="Provider entity id">
          <input
            id="mc-pe"
            value={draft.providerEntityId}
            disabled={isEdit}
            onChange={(e) => onChange({ ...draft, providerEntityId: e.target.value })}
            placeholder="Provider entity UUID…"
            style={{ ...inputStyle, fontFamily: t.fontMono }}
          />
        </Labeled>
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
          <button
            type="button"
            disabled={!fieldsReady}
            onClick={() => setCeremonyOpen(true)}
            style={fieldsReady ? primaryButtonStyle : disabledButtonStyle}
          >
            Save with step-up
          </button>
          <button type="button" onClick={onCancel} style={ghostButtonStyle}>
            Cancel
          </button>
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
    </div>
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
const primaryButtonStyle = {
  padding: "0.5rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8rem",
  fontWeight: 600,
};
const ghostButtonStyle = {
  padding: "0.5rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.8rem",
  fontWeight: 600,
};
const disabledButtonStyle = { ...ghostButtonStyle, cursor: "not-allowed", opacity: 0.5 };
const drawerStyle = {
  position: "fixed" as const,
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(34rem, 100vw)",
  background: t.surfaceLowest,
  boxShadow: t.shadowFloat,
  padding: "1.5rem",
  overflow: "auto",
  zIndex: 40,
};
