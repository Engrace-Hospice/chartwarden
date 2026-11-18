// apps/web/src/modules/21-supplies — S21.9 SUPPLY ITEM CATALOG (`/supplies/items`, §5.10,
// Track B / ADR-0030). Spec: docs/design/screens/clinical/CHARTWARDEN_UI_SUPPLY_DME_INVENTORY.md —
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
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { FormDrawer } from "../../shell/form-drawer";
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
  CheckboxField,
  FilterRow,
  LoadFailure,
  Notice,
  SelectField,
  TextField,
  enumOptions,
  ghostButtonStyle,
  pageTitleStyle,
} from "./supplies-ui";
import { useLatestRead } from "./use-latest-read";
import { useWrite } from "./use-write";

const PAGE = 200;
const LOAD_FAILURE = "The supply catalog could not be loaded.";

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
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every write on this screen is the drawer's, so its refusal shows in the drawer.
  const [actionError, setActionError] = useState<string | null>(null);
  const { busy, run: runWrite } = useWrite();
  const startRead = useLatestRead();
  const [editing, setEditing] = useState<SupplyItemView | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TenantItemDraft>(EMPTY_TENANT_ITEM);

  // `keepRowsOnFailure` is for a refresh after a write (or a retry): the rows on screen still match the filter. A read
  // for a CHANGED filter that fails clears them, so a stale list never sits under a filter it does not match.
  const load = useCallback(
    async (keepRowsOnFailure = false) => {
      const isLatest = startRead();
      setLoading(true);
      setError(null);
      try {
        const { page, error: err } = await listSupplyItems(client, {
          limit: PAGE,
          ...(query.trim() ? { q: query.trim() } : {}),
          // `skuClass` is always "" or one of the catalog's SKU classes — the SelectField below offers no
          // other value.
          ...(skuClass ? { skuClass: skuClass as SupplyItemSkuClass } : {}),
          ...(includeRetired ? { includeRetired: true } : {}),
        });
        if (!isLatest()) return;
        if (err) {
          setError(errorMessage(err, LOAD_FAILURE));
          if (!keepRowsOnFailure) setItems([]);
          return;
        }
        setItems(page?.data ?? []);
        setLoadedOnce(true);
      } catch {
        if (isLatest()) {
          setError(LOAD_FAILURE);
          if (!keepRowsOnFailure) setItems([]);
        }
      } finally {
        if (isLatest()) setLoading(false);
      }
    },
    [client, query, skuClass, includeRetired, startRead],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The spinner is for the first load only. A reload (a search keystroke, a save) keeps the page and any open drawer
  // mounted, with the previous rows showing, so the drawer's typed text, focus and opener survive it.
  if (loading && !loadedOnce) return <LoadingSpinner />;
  // A failed FIRST load has nothing to show. A failed reload keeps the page (and any open drawer) and says so inline.
  if (error && !loadedOnce) return <EmptyState title="Unavailable" description={error} />;

  const closeDrawer = () => {
    setCreating(false);
    setEditing(null);
    setActionError(null);
  };

  const save = async () => {
    setActionError(null);
    const body = {
      name: draft.name.trim(),
      localSkuCode: draft.localSkuCode.trim(),
      defaultUnit: draft.defaultUnit.trim(),
      isBillable: draft.isBillable,
      isActive: draft.isActive,
    };
    const failed = await runWrite(
      () =>
        editing
          ? updateTenantSupplyItem(client, editing.supplyItemId, body)
          : createTenantSupplyItem(client, body),
      "The tenant item could not be saved.",
    );
    if (failed) {
      setActionError(failed);
      return;
    }
    closeDrawer();
    void load(true);
  };

  const platform = items.filter((i) => i.isPlatform);
  const overlay = items.filter((i) => !i.isPlatform);
  const ready =
    draft.name.trim() !== "" && draft.localSkuCode.trim() !== "" && draft.defaultUnit.trim() !== "";

  return (
    <div className={`wx-list-drawer${creating || editing ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main wx-kit-column" aria-busy={loading}>
        <PageHeader
          title={<span style={pageTitleStyle}>Supply catalog</span>}
          actions={
            <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
              <Button
                tone="primary"
                type="button"
                onClick={() => {
                  setDraft(EMPTY_TENANT_ITEM);
                  setEditing(null);
                  setCreating(true);
                  setActionError(null);
                }}
              >
                New tenant item
              </Button>
              <Link to="/supplies" style={ghostButtonStyle}>
                Back to queue
              </Link>
            </div>
          }
        />

        {error ? <LoadFailure message={error} onReload={() => void load(true)} /> : null}

        <Notice tone="info">
          The platform catalog is rewritten wholesale by the annual HCPCS loader and cannot be
          edited from a tenant session — the permission refuses it and the database write policy
          refuses it again. Your agency's own shelf items live in the overlay below, and never carry
          a HCPCS code.
        </Notice>

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

        <Panel stack headingLevel={3} title={`Platform catalog (${platform.length})`}>
          {platform.length === 0 ? (
            <span className="wx-text-muted">No canonical SKU matches this search.</span>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>HCPCS</th>
                  <th>Class</th>
                  <th>Unit</th>
                  <th>Billable</th>
                  <th>Controlled</th>
                  <th>Lot tracked</th>
                  <th>Expiry tracked</th>
                  <th>Effective</th>
                </tr>
              </thead>
              <tbody>
                {platform.map((i) => (
                  <tr key={i.supplyItemId}>
                    <td>
                      {i.name}
                      {i.isActive ? null : <div className="wx-text-muted">retired</div>}
                    </td>
                    <td className="wx-data-md">{i.hcpcs ?? "—"}</td>
                    <td>{i.skuClass}</td>
                    <td>{i.defaultUnit}</td>
                    <td>{i.isBillable ? "Yes" : "No"}</td>
                    <td>{triState(i.isControlledSubstance)}</td>
                    <td>{triState(i.requiresLotTracking)}</td>
                    <td>{triState(i.requiresExpirationTracking)}</td>
                    <td>
                      {shortDate(i.effectiveFrom)}
                      {i.effectiveTo ? ` → ${shortDate(i.effectiveTo)}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <span className="wx-text-muted">
            "Unclassified" is not "No". A SKU the loader has not yet classified is treated as
            needing a decision before a controlled dispatch, not as safe.
          </span>
        </Panel>

        <Panel stack headingLevel={3} title={`Tenant overlay (${overlay.length})`}>
          {overlay.length === 0 ? (
            <span className="wx-text-muted">
              Your agency has no local shelf items. These are the non-billable things that will
              never have a HCPCS code.
            </span>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Local SKU</th>
                  <th>Unit</th>
                  <th>Billable</th>
                  <th>Active</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overlay.map((i) => (
                  <tr key={i.supplyItemId}>
                    <td>{i.name}</td>
                    <td className="wx-data-md">{i.localSkuCode ?? "—"}</td>
                    <td>{i.defaultUnit}</td>
                    <td>{i.isBillable ? "Yes" : "No"}</td>
                    <td>{i.isActive ? "Yes" : "No"}</td>
                    <td>{shortDate(i.updatedAt)}</td>
                    <td>
                      <Button
                        tone="secondary"
                        type="button"
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
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {creating || editing ? (
        <FormDrawer
          key={editing ? editing.supplyItemId : "new"}
          title={editing ? "Edit tenant item" : "New tenant item"}
          busy={busy}
          error={actionError}
          onClose={closeDrawer}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={!ready || busy}
              onClick={() => void save()}
            >
              Save item
            </Button>
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
        </FormDrawer>
      ) : null}
    </div>
  );
}
