// apps/web/src/modules/21-supplies — S21.7 VENDOR ROUTING ADMIN (`/supplies/vendor-routing`, §5.8,
// Track B / ADR-0030). Spec: docs/design/screens/admin — "Use Admin Split Layout."
//
// The D4 precedence ladder: sku > location > tenant > platform, then `precedence_priority`. Org+Location
// configuration, no patient anywhere on it.
//
// THREE DEPARTURES FROM §5.8, each because the contract says something different from the sketch:
//   • §5.8 shows a "fallback chain" column. There is no fallback chain — §3.0 REMOVED the draft's
//     `fallback_vendor_ids_jsonb`, because a fallback list means two coordinators reading the same rules can
//     dispatch to different vendors, and a survey asking "why did this bed come from Apria" expects exactly
//     one answer. The ladder resolves to one rule or to none.
//   • §5.8's "simulate routing" panel is not built: M21 publishes no dry-run route. Simulating client-side
//     would mean re-implementing the resolver in the browser — a second copy of the rule that decides which
//     vendor gets a controlled-substance order, which is the last thing that should exist twice. The frozen
//     `routingRuleResolved` trace on each supply request is the real answer, and it is rendered there.
//   • "Delete" RETIRES. `is_active = false`, `effective_to = now`; the row survives because every historical
//     `routing_rule_resolved_jsonb` names its id. The verb stays DELETE because §4.1's table says so.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type PharmacyDispatchMode,
  type VendorRoutingFulfillmentMode,
  type VendorRoutingRuleView,
  type VendorRoutingScopeKind,
  createVendorRoutingRule,
  errorMessage,
  listVendorRoutingRules,
  retireVendorRoutingRule,
  updateVendorRoutingRule,
} from "./supplies-api";
import {
  DEFAULT_FULFILLMENT_MODE,
  DEFAULT_ROUTING_SCOPE,
  FULFILLMENT_MODES,
  PHARMACY_DISPATCH_MODES,
  ROUTING_SCOPES,
  TENANT_ROUTING_SCOPES,
  humanize,
  shortDate,
  shortId,
} from "./supplies-status";
import {
  Card,
  CheckboxField,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  thNum,
} from "./supplies-ui";

const PAGE = 200;

/** The rule editor's fields. `assignedVendorId` is nullable, not absent-or-uuid: on the three non-vendor
 *  modes a null vendor is CORRECT, not an unresolved routing failure (§3.1.5's CHECK). */
interface RuleDraft {
  scopeKind: string;
  scopeId: string;
  skuClassPattern: string;
  assignedVendorId: string;
  assignedFulfillmentMode: string;
  defaultPharmacyDispatchMode: string;
  precedencePriority: string;
}

const EMPTY_DRAFT: RuleDraft = {
  scopeKind: DEFAULT_ROUTING_SCOPE,
  scopeId: "",
  skuClassPattern: "",
  assignedVendorId: "",
  assignedFulfillmentMode: DEFAULT_FULFILLMENT_MODE,
  defaultPharmacyDispatchMode: "",
  precedencePriority: "100",
};

export function VendorRoutingAdmin(): JSX.Element {
  const client = useApiClient();
  const [scopeFilter, setScopeFilter] = useState("");
  const [includeRetired, setIncludeRetired] = useState(false);
  const [rules, setRules] = useState<VendorRoutingRuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<VendorRoutingRuleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { page, error: err } = await listVendorRoutingRules(client, {
      limit: PAGE,
      // `scopeFilter` is always "" or one of the closed scope-kind vocabulary the SelectField below offers.
      ...(scopeFilter ? { scopeKind: scopeFilter as VendorRoutingScopeKind } : {}),
      ...(includeRetired ? { includeRetired: true } : {}),
    });
    if (err) {
      setError(errorMessage(err, "The vendor routing rules could not be loaded."));
      setLoading(false);
      return;
    }
    setRules(page?.data ?? []);
    setLoading(false);
  }, [client, scopeFilter, includeRetired]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  // `draft.scopeKind`/`assignedFulfillmentMode`/`defaultPharmacyDispatchMode` are always one of the
  // closed vocabularies the SelectFields below offer.
  const body = () => ({
    scopeKind: draft.scopeKind as VendorRoutingScopeKind,
    // §3.1.5's CHECK: `sku` and `location` carry a target, `tenant` does not.
    ...(draft.scopeKind === "tenant" || draft.scopeId.trim() === ""
      ? {}
      : { scopeId: draft.scopeId.trim() }),
    ...(draft.skuClassPattern.trim() ? { skuClassPattern: draft.skuClassPattern.trim() } : {}),
    assignedVendorId: draft.assignedVendorId.trim() === "" ? null : draft.assignedVendorId.trim(),
    assignedFulfillmentMode: draft.assignedFulfillmentMode as VendorRoutingFulfillmentMode,
    ...(draft.defaultPharmacyDispatchMode
      ? { defaultPharmacyDispatchMode: draft.defaultPharmacyDispatchMode as PharmacyDispatchMode }
      : {}),
    ...(draft.precedencePriority.trim()
      ? { precedencePriority: Number(draft.precedencePriority) }
      : {}),
  });

  const save = async () => {
    setBusy(true);
    setActionError(null);
    const { error: err } = editing
      ? await updateVendorRoutingRule(client, editing.ruleId, body())
      : await createVendorRoutingRule(client, body());
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The routing rule could not be saved."));
      return;
    }
    setEditing(null);
    setCreating(false);
    void load();
  };

  const retire = async (rule: VendorRoutingRuleView) => {
    setBusy(true);
    setActionError(null);
    const { error: err } = await retireVendorRoutingRule(client, rule.ruleId);
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The rule could not be retired."));
      return;
    }
    void load();
  };

  // Group by scope so the ladder reads top-down, most specific first. The ROUTING_SCOPES order IS the
  // precedence order and must not be re-sorted.
  const byScope = ROUTING_SCOPES.map((scope) => ({
    scope,
    rows: rules
      .filter((r) => r.scopeKind === scope)
      .sort((a, b) => a.precedencePriority - b.precedencePriority),
  })).filter((g) => g.rows.length > 0 || scopeFilter === "" || scopeFilter === g.scope);

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Vendor routing</span>}
        breadcrumb="Supplies — the D4 precedence ladder"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setEditing(null);
                setCreating(true);
                setActionError(null);
              }}
            >
              New rule
            </button>
            <Link to="/supplies" style={ghostButtonStyle}>
              Back to queue
            </Link>
          </div>
        }
      />

      <Notice tone="info">
        Resolution is deterministic: the most specific matching scope wins (SKU, then Location, then
        tenant, then platform), and inside a scope the lowest priority number wins. There is no
        fallback list — the ladder resolves to exactly one rule, so "why this vendor" has exactly
        one answer.
      </Notice>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <FilterRow>
        <SelectField
          label="Scope"
          value={scopeFilter}
          options={[{ value: "", label: "all scopes" }, ...enumOptions(ROUTING_SCOPES)]}
          onChange={setScopeFilter}
        />
        <CheckboxField
          label="Include retired rules"
          checked={includeRetired}
          onChange={setIncludeRetired}
        />
      </FilterRow>

      {byScope.map(({ scope, rows }) => (
        <Card
          key={scope}
          title={`${humanize(scope)} scope`}
          actions={
            scope === "platform" ? <StatusPill label="Read-only" tone="neutral" /> : undefined
          }
        >
          {scope === "platform" ? (
            <span style={mutedStyle}>
              Platform rules are the floor every tenant reads and none may write. A tenant cannot
              author one: the request schema omits the scope and the database write policy would
              refuse it anyway.
            </span>
          ) : null}
          {rows.length === 0 ? (
            <span style={mutedStyle}>
              {scope === "tenant"
                ? "No tenant default is configured. Boot validation refuses a tenant with no tenant-scope rule — a request with nothing to resolve against cannot be routed."
                : "No rule at this scope."}
            </span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Rule</th>
                  <th style={th}>Target</th>
                  <th style={th}>SKU pattern</th>
                  <th style={th}>Vendor</th>
                  <th style={th}>Fulfillment</th>
                  <th style={thNum}>Priority</th>
                  <th style={th}>Effective</th>
                  <th style={th}>State</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ruleId} style={rowLine}>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(r.ruleId)}</td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(r.scopeId)}</td>
                    <td style={td}>{r.skuClassPattern ?? "any"}</td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>
                      {r.assignedVendorId ? shortId(r.assignedVendorId) : "internal hub"}
                    </td>
                    <td style={td}>
                      {humanize(r.assignedFulfillmentMode)}
                      {r.defaultPharmacyDispatchMode ? (
                        <div style={mutedStyle}>{humanize(r.defaultPharmacyDispatchMode)}</div>
                      ) : null}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.precedencePriority}
                    </td>
                    <td style={td}>
                      {shortDate(r.effectiveFrom)}
                      {r.effectiveTo ? ` → ${shortDate(r.effectiveTo)}` : ""}
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={r.isActive ? "Active" : "Retired"}
                        tone={r.isActive ? "success" : "neutral"}
                      />
                    </td>
                    <td style={td}>
                      {r.isPlatform ? (
                        <span style={mutedStyle}>platform</span>
                      ) : (
                        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            style={ghostButtonStyle}
                            onClick={() => {
                              setEditing(r);
                              setCreating(false);
                              setActionError(null);
                              setDraft({
                                scopeKind: r.scopeKind,
                                scopeId: r.scopeId ?? "",
                                skuClassPattern: r.skuClassPattern ?? "",
                                assignedVendorId: r.assignedVendorId ?? "",
                                assignedFulfillmentMode: r.assignedFulfillmentMode,
                                defaultPharmacyDispatchMode: r.defaultPharmacyDispatchMode ?? "",
                                precedencePriority: String(r.precedencePriority),
                              });
                            }}
                          >
                            Edit
                          </button>
                          {r.isActive ? (
                            <button
                              type="button"
                              disabled={busy}
                              style={busy ? disabledButtonStyle : ghostButtonStyle}
                              onClick={() => void retire(r)}
                            >
                              Retire
                            </button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ))}

      {creating || editing ? (
        <Modal
          title={editing ? "Edit routing rule" : "New routing rule"}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() => void save()}
            >
              Save rule
            </button>
          }
        >
          <SelectField
            label="Scope"
            value={draft.scopeKind}
            options={enumOptions(TENANT_ROUTING_SCOPES)}
            onChange={(v) => setDraft({ ...draft, scopeKind: v })}
          />
          {draft.scopeKind !== "tenant" ? (
            <TextField
              label={draft.scopeKind === "sku" ? "SKU id" : "Location id"}
              value={draft.scopeId}
              onChange={(v) => setDraft({ ...draft, scopeId: v })}
              mono
            />
          ) : (
            <Notice tone="info">
              A tenant-scope rule has no target — it is the agency's default, the last rung before
              the platform floor.
            </Notice>
          )}
          <TextField
            label="SKU class pattern (blank matches any)"
            value={draft.skuClassPattern}
            onChange={(v) => setDraft({ ...draft, skuClassPattern: v })}
          />
          <TextField
            label="Vendor id (blank routes to the internal supply hub)"
            value={draft.assignedVendorId}
            onChange={(v) => setDraft({ ...draft, assignedVendorId: v })}
            mono
          />
          <SelectField
            label="Fulfillment mode"
            value={draft.assignedFulfillmentMode}
            options={enumOptions(FULFILLMENT_MODES)}
            onChange={(v) => setDraft({ ...draft, assignedFulfillmentMode: v })}
          />
          {draft.assignedFulfillmentMode === "vendor" && draft.assignedVendorId.trim() === "" ? (
            <Notice tone="warning">
              "Vendor" is the one mode that requires a vendor id — the database refuses the pair. On
              the other three a blank vendor is correct, not an unresolved routing failure.
            </Notice>
          ) : null}
          <SelectField
            label="Default pharmacy dispatch mode"
            value={draft.defaultPharmacyDispatchMode}
            options={[{ value: "", label: "none" }, ...enumOptions(PHARMACY_DISPATCH_MODES)]}
            onChange={(v) => setDraft({ ...draft, defaultPharmacyDispatchMode: v })}
          />
          <TextField
            label="Precedence priority (lower wins inside a scope)"
            value={draft.precedencePriority}
            onChange={(v) => setDraft({ ...draft, precedencePriority: v })}
            type="number"
          />
        </Modal>
      ) : null}
    </div>
  );
}
