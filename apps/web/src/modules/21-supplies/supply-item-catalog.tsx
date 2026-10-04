// apps/web/src/modules/21-supplies — S21.9 SUPPLY ITEM CATALOG (`/supplies/items`, §5.10,
// Track B / ADR-0030). Spec: docs/design/screens/clinical/WARDENX_UI_SUPPLY_DME_INVENTORY.md —
// "Use Work Queue."
//
// D11's two halves in one browsable list: the PLATFORM catalog (HCPCS-keyed, org-less, the same answer for
// every tenant) and the TENANT overlay (agency-local, non-billable, never carrying a HCPCS code). The id
// space is disjoint, so one list and one detail route serve both.
//
// NOTHING HERE IS PHI. A hospital bed and a brief are the same facts for every patient, which is why these
// routes carry an explicit read-audit waiver rather than an emission. The one sensitive attribute is a SKU's
// controlled-substance classification — and that is a property of the drug, not of a person.
//
// THE THREE CLINICAL FLAGS ARE TRI-STATE, AND THE TABLE KEEPS THEM THAT WAY. `isControlledSubstance`,
// `requiresLotTracking` and `requiresExpirationTracking` are NULLABLE on the platform row: "unclassified"
// and "definitely not controlled" are different facts, and the dispatch path must tell them apart before
// deciding whether a lot number is mandatory. Rendering null as "No" would quietly declassify every SKU the
// annual HCPCS loader has not yet been told about.
//
// §5.10's per-row "detail drawer listing tenant extensions" is not built: the list already returns the
// overlay rows as first-class entries (they are what `localSkuCode` marks), and M21 publishes no
// "extensions of this canonical SKU" read to hang a drawer on.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SupplyItemSkuClass,
  type SupplyItemView,
  createTenantSupplyItem,
  errorMessage,
  listSupplyItems,
  updateTenantSupplyItem,
} from "./supplies-api";
import { SKU_CLASSES, shortDate } from "./supplies-status";
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
} from "./supplies-ui";

const PAGE = 200;

/** A tri-state clinical flag: `true` / `false` / not yet classified. The third is not the second. */
function triState(value: boolean | null): JSX.Element {
  if (value === null) return <StatusPill label="Unclassified" tone="warning" />;
  return <StatusPill label={value ? "Yes" : "No"} tone={value ? "progress" : "neutral"} />;
}

interface TenantItemDraft {
  name: string;
  localSkuCode: string;
  defaultUnit: string;
  isBillable: boolean;
  isActive: boolean;
}

const EMPTY_TENANT_ITEM: TenantItemDraft = {
  name: "",
  localSkuCode: "",
  defaultUnit: "each",
  isBillable: false,
  isActive: true,
};

export function SupplyItemCatalog(): JSX.Element {
  const client = useApiClient();
  const [query, setQuery] = useState("");
  const [skuClass, setSkuClass] = useState("");
  const [includeRetired, setIncludeRetired] = useState(false);
  const [items, setItems] = useState<SupplyItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<SupplyItemView | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TenantItemDraft>(EMPTY_TENANT_ITEM);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { page, error: err } = await listSupplyItems(client, {
      limit: PAGE,
      ...(query.trim() ? { q: query.trim() } : {}),
      // `skuClass` is always "" or one of the catalog's SKU classes — the SelectField below offers no
      // other value.
      ...(skuClass ? { skuClass: skuClass as SupplyItemSkuClass } : {}),
      ...(includeRetired ? { includeRetired: true } : {}),
    });
    if (err) {
      setError(errorMessage(err, "The supply catalog could not be loaded."));
      setLoading(false);
      return;
    }
    setItems(page?.data ?? []);
    setLoading(false);
  }, [client, query, skuClass, includeRetired]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const save = async () => {
    setBusy(true);
    setActionError(null);
    const body = {
      name: draft.name.trim(),
      localSkuCode: draft.localSkuCode.trim(),
      defaultUnit: draft.defaultUnit.trim(),
      isBillable: draft.isBillable,
      isActive: draft.isActive,
    };
    const { error: err } = editing
      ? await updateTenantSupplyItem(client, editing.supplyItemId, body)
      : await createTenantSupplyItem(client, body);
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The tenant item could not be saved."));
      return;
    }
    setEditing(null);
    setCreating(false);
    void load();
  };

  const platform = items.filter((i) => i.isPlatform);
  const overlay = items.filter((i) => !i.isPlatform);
  const ready =
    draft.name.trim() !== "" && draft.localSkuCode.trim() !== "" && draft.defaultUnit.trim() !== "";

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Supply catalog</span>}
        breadcrumb="Supplies — platform SKUs and the tenant overlay"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => {
                setDraft(EMPTY_TENANT_ITEM);
                setEditing(null);
                setCreating(true);
                setActionError(null);
              }}
            >
              New tenant item
            </button>
            <Link to="/supplies" style={ghostButtonStyle}>
              Back to queue
            </Link>
          </div>
        }
      />

      <Notice tone="info">
        The platform catalog is rewritten wholesale by the annual HCPCS loader and cannot be edited
        from a tenant session — the permission refuses it and the database write policy refuses it
        again. Your agency's own shelf items live in the overlay below, and never carry a HCPCS
        code.
      </Notice>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <FilterRow>
        <TextField label="Search name or HCPCS" value={query} onChange={setQuery} />
        <SelectField
          label="SKU class"
          value={skuClass}
          options={[{ value: "", label: "all classes" }, ...enumOptions(SKU_CLASSES, (c) => c)]}
          onChange={setSkuClass}
        />
        <CheckboxField
          label="Include retired items"
          checked={includeRetired}
          onChange={setIncludeRetired}
        />
      </FilterRow>

      <Card title={`Platform catalog (${platform.length})`}>
        {platform.length === 0 ? (
          <span style={mutedStyle}>No canonical SKU matches this search.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>HCPCS</th>
                <th style={th}>Class</th>
                <th style={th}>Unit</th>
                <th style={th}>Billable</th>
                <th style={th}>Controlled</th>
                <th style={th}>Lot tracked</th>
                <th style={th}>Expiry tracked</th>
                <th style={th}>Effective</th>
              </tr>
            </thead>
            <tbody>
              {platform.map((i) => (
                <tr key={i.supplyItemId} style={rowLine}>
                  <td style={td}>
                    {i.name}
                    {i.isActive ? null : <div style={mutedStyle}>retired</div>}
                  </td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{i.hcpcs ?? "—"}</td>
                  <td style={td}>{i.skuClass}</td>
                  <td style={td}>{i.defaultUnit}</td>
                  <td style={td}>{i.isBillable ? "Yes" : "No"}</td>
                  <td style={td}>{triState(i.isControlledSubstance)}</td>
                  <td style={td}>{triState(i.requiresLotTracking)}</td>
                  <td style={td}>{triState(i.requiresExpirationTracking)}</td>
                  <td style={td}>
                    {shortDate(i.effectiveFrom)}
                    {i.effectiveTo ? ` → ${shortDate(i.effectiveTo)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          "Unclassified" is not "No". A SKU the loader has not yet classified is treated as needing
          a decision before a controlled dispatch, not as safe.
        </span>
      </Card>

      <Card title={`Tenant overlay (${overlay.length})`}>
        {overlay.length === 0 ? (
          <span style={mutedStyle}>
            Your agency has no local shelf items. These are the non-billable things that will never
            have a HCPCS code.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Local SKU</th>
                <th style={th}>Unit</th>
                <th style={th}>Billable</th>
                <th style={th}>Active</th>
                <th style={th}>Updated</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {overlay.map((i) => (
                <tr key={i.supplyItemId} style={rowLine}>
                  <td style={td}>{i.name}</td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{i.localSkuCode ?? "—"}</td>
                  <td style={td}>{i.defaultUnit}</td>
                  <td style={td}>{i.isBillable ? "Yes" : "No"}</td>
                  <td style={td}>{i.isActive ? "Yes" : "No"}</td>
                  <td style={td}>{shortDate(i.updatedAt)}</td>
                  <td style={td}>
                    <button
                      type="button"
                      style={ghostButtonStyle}
                      onClick={() => {
                        setEditing(i);
                        setCreating(false);
                        setActionError(null);
                        setDraft({
                          name: i.name,
                          localSkuCode: i.localSkuCode ?? "",
                          defaultUnit: i.defaultUnit,
                          isBillable: i.isBillable,
                          isActive: i.isActive,
                        });
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {creating || editing ? (
        <Modal
          title={editing ? "Edit tenant item" : "New tenant item"}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          footer={
            <button
              type="button"
              disabled={!ready || busy}
              style={!ready || busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() => void save()}
            >
              Save item
            </button>
          }
        >
          <TextField
            label="Name"
            value={draft.name}
            onChange={(v) => setDraft({ ...draft, name: v })}
          />
          <TextField
            label="Local SKU code"
            value={draft.localSkuCode}
            onChange={(v) => setDraft({ ...draft, localSkuCode: v })}
            mono
          />
          <TextField
            label="Default unit"
            value={draft.defaultUnit}
            onChange={(v) => setDraft({ ...draft, defaultUnit: v })}
          />
          <CheckboxField
            label="Billable"
            checked={draft.isBillable}
            onChange={(v) => setDraft({ ...draft, isBillable: v })}
          />
          <CheckboxField
            label="Active"
            checked={draft.isActive}
            onChange={(v) => setDraft({ ...draft, isActive: v })}
          />
          <Notice tone="info">
            An overlay item is agency-local by construction: it has no HCPCS code and defaults to
            non-billable, because a billable line needs a code the platform catalog owns.
          </Notice>
        </Modal>
      ) : null}
    </div>
  );
}
