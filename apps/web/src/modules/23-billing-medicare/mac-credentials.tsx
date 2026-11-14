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
  useAttemptKey,
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the MAC CREDENTIALS admin (R2, §5.1
// admin / §4.1 #34-35, §3.6). The per-ProviderEntity MAC submitter-credential surface: a selectable
// credential rail over a per-credential detail (matrix). The `client_secret_cipher` is NEVER projected —
// the view carries only the safe identifiers + a `hasSecret` flag (§3.6); the secret is WRITE-ONLY and is
// encrypted at the persistence boundary. An upsert is a PRIVILEGED config act gated by a §D14 step-up
// assertion at the route layer — the UI gates it behind a CeremonyModal (the §7.4 attestation with a step-up
// challenge). The first insert omits If-Match; an update carries the §2.5 version (409 STALE_VERSION on stale). Every
// mutation carries an Idempotency-Key (§4.1.1). The server is the only authz point (ADR-0030): a 401/403
// surfaces inline as "step-up required", a 409 as "reopen to retry", a 503 as a seam notice — never a toast.
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
      <MedicareProviderRoutingPanel />
      <ClaimMdMedicareRoutingPanel />
      <AdminSplitLayout
        header={
          <PageHeader
            title="MAC Credentials"
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

interface MedicareRoutingItem {
  id: string;
  macJurisdiction: MacJurisdiction;
  effectiveFrom: string;
  effectiveTo: string | null;
  provenance: "manual" | "legacy_mac_credential";
  setReason: string;
}

function MedicareProviderRoutingPanel(): JSX.Element {
  const client = useApiClient();
  const attempt = useAttemptKey();
  const [providerEntityId, setProviderEntityId] = useState("");
  const [jurisdiction, setJurisdiction] = useState<MacJurisdiction>("ngs_j6");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reason, setReason] = useState("provider_documentation");
  const [items, setItems] = useState<MedicareRoutingItem[]>([]);
  const [issues, setIssues] = useState<{ reasonCode: string; candidateJurisdictions: string[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!providerEntityId) return;
    setLoading(true); setMessage(null);
    const result = await client.GET("/api/v1/billing/medicare-provider-routing/{providerEntityId}" as never,
      { params: { path: { providerEntityId } } } as never) as unknown as { data?: { items?: MedicareRoutingItem[]; migrationIssues?: typeof issues }; error?: unknown };
    setLoading(false);
    if (result.error) { setMessage("Routing configuration is unavailable or outside your provider scope."); return; }
    setItems(result.data?.items ?? []); setIssues(result.data?.migrationIssues ?? []);
  }, [client, providerEntityId]);

  const save = useCallback(async () => {
    if (!providerEntityId) return;
    setBusy(true);
    const payload = { providerEntityId, macJurisdiction: jurisdiction, effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}), reason };
    try {
      const result = await attempt.run(JSON.stringify(payload), async (key) =>
        await client.POST("/api/v1/billing/medicare-provider-routing" as never,
          { body: payload, params: { header: { "Idempotency-Key": key } } } as never) as never) as unknown as { error?: unknown; response?: Response };
      if (result.error) { setMessage(result.response?.status === 409 ? "The interval overlaps existing routing; review the history and dates." : result.response?.status === 401 || result.response?.status === 403 ? "Step-up or provider scope is required." : "Routing could not be saved."); }
      else { setMessage("Medicare routing saved. This does not configure payer enrollment or portal credentials."); setReason("provider_documentation"); await load(); }
    } catch { setMessage("Routing could not be saved. No submission was attempted."); }
    setBusy(false); setConfirm(false);
  }, [attempt.run, client, effectiveFrom, effectiveTo, jurisdiction, load, providerEntityId, reason]);

  return (
    <section aria-labelledby="medicare-routing-heading" style={{ marginBottom: "1rem", padding: "1rem", border: `1px solid ${t.outlineVariant}`, borderRadius: "0.75rem", background: t.surface }}>
      <h2 id="medicare-routing-heading" style={{ margin: "0 0 .35rem", fontFamily: t.fontDisplay, color: t.onSurface }}>Medicare provider routing</h2>
      <p style={{ margin: "0 0 .8rem", color: t.onSurfaceVariant, fontSize: ".875rem" }}>
        MAC jurisdiction is an effective-dated Medicare billing fact. It is separate from direct-MAC portal credentials and does not indicate payer enrollment or transmission readiness.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: ".75rem", alignItems: "end" }}>
        <ProviderEntityLookupField label="Provider entity" value={providerEntityId} onChange={setProviderEntityId} />
        <Button size="sm" disabled={!providerEntityId || loading} onClick={() => void load()}>{loading ? "Loading…" : "Load routing history"}</Button>
        <Labeled id="mpr-jurisdiction" label="MAC jurisdiction"><select id="mpr-jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as MacJurisdiction)} style={selectStyle}>{MAC_JURISDICTIONS.map((v) => <option key={v} value={v}>{macLabel(v)}</option>)}</select></Labeled>
        <Labeled id="mpr-from" label="Effective from (inclusive)"><input id="mpr-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} style={inputStyle} /></Labeled>
        <Labeled id="mpr-to" label="Effective to (inclusive, optional)"><input id="mpr-to" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} style={inputStyle} /></Labeled>
        <Labeled id="mpr-reason" label="Reason (no free text)" ><select id="mpr-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={selectStyle}><option value="provider_documentation">Provider documentation</option><option value="cms_notice">CMS/MAC notice</option><option value="legacy_review">Legacy record review</option><option value="correction">Correction</option></select></Labeled>
        <Button size="sm" disabled={!providerEntityId || busy} onClick={() => setConfirm(true)}>Save routing with step-up</Button>
      </div>
      {message ? <p role="status" style={{ color: t.onSurfaceVariant }}>{message}</p> : null}
      {issues.length > 0 ? <div role="alert"><strong>Legacy routing needs review</strong><ul>{issues.map((issue, i) => <li key={`${issue.reasonCode}-${i}`}>{issue.reasonCode}: {issue.candidateJurisdictions.join(", ") || "no jurisdiction candidate"}</li>)}</ul></div> : null}
      {providerEntityId && !loading && items.length === 0 ? <p role="status" style={{ color: t.error }}>No Medicare jurisdiction is configured for this provider. Claim assembly will remain blocked until an effective interval is recorded.</p> : null}
      {items.length > 0 ? <div style={{ overflowX: "auto", marginTop: ".75rem" }}><table><thead><tr><th>Jurisdiction</th><th>Effective from</th><th>Effective to</th><th>Source</th><th>Reason</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{macLabel(item.macJurisdiction)}</td><td>{item.effectiveFrom}</td><td>{item.effectiveTo ?? "Open"}</td><td>{item.provenance === "manual" ? "Administrator" : "Legacy credential import"}</td><td>{item.setReason}</td></tr>)}</tbody></table></div> : null}
      <CeremonyModal open={confirm} title="Save Medicare provider routing" attestation={<span>Set {macLabel(jurisdiction)} for provider <strong style={{ fontFamily: t.fontMono }}>{providerEntityId}</strong>, effective {effectiveFrom}{effectiveTo ? ` through ${effectiveTo}` : " onward"}. This is not an enrollment approval.</span>} legalText="I confirm this Medicare jurisdiction and effective period are supported by provider billing records." signer={{ name: "You", role: "Billing administrator" }} stepUp={{ label: "Re-enter your password to continue", type: "password" }} commitLabel="Confirm & save" onCommit={() => void save()} onCancel={() => setConfirm(false)} />
    </section>
  );
}

interface ClaimMdRouteRow { id: string; payerId: string; macJurisdiction: MacJurisdiction; externalPayerId: string; accountReference: string; usage: string; effectiveFrom: string; effectiveTo: string | null; status: string }
interface ClaimMdEnrollmentRow { id: string; payerId: string; status: string; transactionType: string; effectiveFrom: string; effectiveTo: string | null; verificationSource: string | null }
function ClaimMdMedicareRoutingPanel(): JSX.Element {
  const client = useApiClient(); const attempt = useAttemptKey();
  const [providerEntityId, setProvider] = useState(""); const [payerId, setPayer] = useState("");
  const [externalPayerId, setExternal] = useState(""); const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [routes, setRoutes] = useState<ClaimMdRouteRow[]>([]); const [enrollments, setEnrollments] = useState<ClaimMdEnrollmentRow[]>([]);
  const [status, setStatus] = useState<"pending"|"verified"|"not_required"|"rejected"|"suspended"|"expired">("pending");
  const [source, setSource] = useState<"vendor_portal"|"vendor_written_confirmation"|"documented_policy">("vendor_portal");
  const [reference, setReference] = useState(""); const [notice, setNotice] = useState<string|null>(null); const [busy, setBusy] = useState(false);
  const [closeTarget, setCloseTarget] = useState<ClaimMdRouteRow|null>(null); const [closeDate, setCloseDate] = useState(new Date().toISOString().slice(0, 10));
  const load = useCallback(async () => {
    if (!providerEntityId) return;
    const result = await client.GET("/api/v1/billing/claimmd-medicare-routing/{providerEntityId}" as never, { params: { path: { providerEntityId } } } as never) as unknown as { data?: { routes?: ClaimMdRouteRow[]; enrollments?: ClaimMdEnrollmentRow[] }; error?: unknown };
    if (result.error) { setNotice("Claim.MD route readiness is unavailable or outside your provider scope."); return; }
    setRoutes(result.data?.routes ?? []); setEnrollments(result.data?.enrollments ?? []); setNotice(null);
  }, [client, providerEntityId]);
  const submit = useCallback(async (kind: "route"|"enrollment") => {
    if (!providerEntityId || !payerId) return;
    setBusy(true); setNotice(null);
    const body = kind === "route" ? { providerEntityId, payerId, externalPayerId, effectiveFrom: from } : { providerEntityId, payerId, status, effectiveFrom: from, ...(status === "verified" || status === "not_required" ? { verificationSource: source, verificationRef: reference } : {}) };
    const path = kind === "route" ? "/api/v1/billing/claimmd-medicare-routing/routes" : "/api/v1/billing/claimmd-medicare-routing/enrollments";
    try {
      const result = await attempt.run(JSON.stringify({ kind, ...body }), async (key) => await client.POST(path as never, { body, params: { header: { "Idempotency-Key": key } } } as never) as never) as unknown as { error?: unknown; response?: Response };
      if (result.error) setNotice(result.response?.status === 403 ? "This organization is not authorized for the selected Claim.MD account." : result.response?.status === 409 ? "Account, payer, or effective dates conflict with existing configuration." : "Configuration was refused; confirm provider, payer, account, and evidence.");
      else { setNotice(kind === "route" ? "Payer route recorded. Enrollment remains a separate required readiness check." : "Enrollment evidence recorded. This does not prove vendor-wide production readiness."); await load(); }
    } catch { setNotice("Configuration could not be saved. No claim was submitted."); }
    setBusy(false);
  }, [attempt.run, client, externalPayerId, from, load, payerId, providerEntityId, reference, source, status]);
  const closeRoute = useCallback(async () => {
    if (!closeTarget || !providerEntityId) return;
    setBusy(true);
    const body = { providerEntityId, routeId: closeTarget.id, effectiveTo: closeDate };
    try {
      const result = await attempt.run(JSON.stringify({ close: body }), async (key) => await client.POST("/api/v1/billing/claimmd-medicare-routing/routes/close" as never, { body, params: { header: { "Idempotency-Key": key } } } as never) as never) as unknown as { error?: unknown; response?: Response };
      if (result.error) setNotice(result.response?.status === 409 ? "The route cannot end on that date; review the interval and refresh." : "The payer route could not be closed.");
      else { setNotice("Route end date recorded; historical effective periods remain available."); setCloseTarget(null); await load(); }
    } catch { setNotice("The route could not be updated. No claim was submitted."); }
    setBusy(false);
  }, [attempt.run, client, closeDate, closeTarget, load, providerEntityId]);
  return <section aria-labelledby="claimmd-medicare-heading" style={{ marginBottom: "1rem", padding: "1rem", border: `1px solid ${t.outlineVariant}`, borderRadius: ".75rem", background: t.surface }}>
    <h2 id="claimmd-medicare-heading" style={{ margin: "0 0 .35rem", fontFamily: t.fontDisplay, color: t.onSurface }}>Claim.MD Medicare payer route & enrollment</h2>
    <p style={{ margin: "0 0 .8rem", color: t.onSurfaceVariant, fontSize: ".875rem" }}>Routes are account- and usage-scoped. Enrollment is transaction-specific evidence and is never approved by creating a route. Production remains blocked without verified authorization or a documented exemption.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: ".75rem", alignItems: "end" }}>
      <ProviderEntityLookupField label="Provider entity" value={providerEntityId} onChange={setProvider} />
      <Labeled id="cm3-payer" label="Canonical M40 Medicare payer ID"><input id="cm3-payer" value={payerId} onChange={(e) => setPayer(e.target.value)} style={inputStyle} /></Labeled>
      <Labeled id="cm3-ext-payer" label="Claim.MD payer ID (text)"><input id="cm3-ext-payer" value={externalPayerId} onChange={(e) => setExternal(e.target.value)} style={inputStyle} /></Labeled>
      <Labeled id="cm3-from" label="Effective from"><input id="cm3-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} /></Labeled>
      <Button size="sm" disabled={!providerEntityId || !payerId || !externalPayerId || busy} onClick={() => void submit("route")}>Save payer route</Button>
      <Button size="sm" disabled={!providerEntityId} onClick={() => void load()}>Load route history</Button>
      <Labeled id="cm3-enrollment-status" label="837I enrollment status"><select id="cm3-enrollment-status" value={status} onChange={(e) => { const next = e.target.value as typeof status; setStatus(next); if (next === "not_required") setSource("documented_policy"); }} style={selectStyle}>{["pending","verified","not_required","rejected","suspended","expired"].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select></Labeled>
      <Labeled id="cm3-enrollment-source" label="Evidence source"><select id="cm3-enrollment-source" value={source} onChange={(e) => setSource(e.target.value as typeof source)} style={selectStyle}>{status !== "not_required" ? <><option value="vendor_portal">Vendor portal</option><option value="vendor_written_confirmation">Vendor written confirmation</option></> : null}<option value="documented_policy">Documented policy</option></select></Labeled>
      <Labeled id="cm3-enrollment-ref" label="Evidence reference (no PHI)"><input id="cm3-enrollment-ref" value={reference} onChange={(e) => setReference(e.target.value)} style={inputStyle} /></Labeled>
      <Button size="sm" disabled={!providerEntityId || !payerId || busy || ((status === "verified" || status === "not_required") && !reference)} onClick={() => void submit("enrollment")}>Record enrollment evidence</Button>
    </div>
    {notice ? <p role="status" style={{ color: t.onSurfaceVariant }}>{notice}</p> : null}
    {routes.length || enrollments.length ? <div style={{ overflowX: "auto", marginTop: ".75rem" }}><table><thead><tr><th>M40 payer</th><th>Jurisdiction</th><th>Claim.MD payer ID</th><th>Account</th><th>Usage</th><th>837I route dates</th><th>Enrollment</th><th>Action</th></tr></thead><tbody>{routes.map((route) => <tr key={route.id}><td>{route.payerId}</td><td>{macLabel(route.macJurisdiction)}</td><td>{route.externalPayerId}</td><td>{route.accountReference}</td><td>{route.usage}</td><td>{route.effectiveFrom} – {route.effectiveTo ?? "open"}</td><td>{enrollments.filter((entry) => entry.payerId === route.payerId).map((entry) => `${entry.status} (${entry.effectiveFrom})`).join(", ") || "verification required"}</td><td>{route.effectiveTo === null ? <Button size="sm" tone="secondary" onClick={() => { setCloseDate(new Date().toISOString().slice(0, 10)); setCloseTarget(route); }}>End interval…</Button> : "Historical"}</td></tr>)}</tbody></table></div> : null}
    <CeremonyModal open={Boolean(closeTarget)} title="End Claim.MD payer route" attestation={<div><span>End the route for external payer ID <strong>{closeTarget?.externalPayerId}</strong>. Earlier effective claim history is retained.</span><Labeled id="cm3-close-date" label="Effective through (inclusive)"><input id="cm3-close-date" type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} style={inputStyle} disabled={busy} /></Labeled></div>} legalText="I confirm this route should no longer be used after the selected date." signer={{ name: "You", role: "Billing administrator" }} stepUp={{ label: "Re-enter your password to continue", type: "password" }} commitLabel="Confirm route end" onCommit={() => void closeRoute()} onCancel={() => setCloseTarget(null)} />
  </section>;
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
  const attempt = useAttemptKey();
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
    const header: Record<string, string> = {};
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
    let result: { error?: unknown; response?: Response };
    try {
      result = await attempt.run(
        JSON.stringify(init),
        async (key) =>
          (await client.POST("/api/v1/billing/mac-credentials", {
            ...init,
            params: { header: { ...header, "Idempotency-Key": key } },
          } as never)) as { error?: unknown; response?: Response },
      );
    } catch {
      setActionError("That did not go through. Check your connection and try again.");
      setCeremonyOpen(false);
      return;
    }
    const { error: err, response } = result;
    if (err) {
      const s = response?.status;
      setActionError(
        s === 401 || s === 403
          ? "Re-authentication (step-up) is required to save credentials."
          : s === 409
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
  }, [client, attempt.run, draft, onSaved]);

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
