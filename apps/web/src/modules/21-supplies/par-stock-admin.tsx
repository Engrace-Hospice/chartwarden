// apps/web/src/modules/21-supplies — S21.6 PAR-STOCK ADMIN (`/supplies/par-stock`, §5.7,
// Track B / ADR-0030). Spec: docs/design/screens/clinical/CHARTWARDEN_UI_SUPPLY_DME_INVENTORY.md —
// "Use Work Queue."
//
// NO PATIENT APPEARS ON THIS SURFACE. A par row is agency inventory at a Location; §3.1.6 is explicit that
// the threshold payload carries no patient id at all, which is why these routes are `admin` category and
// carry an explicit read-audit WAIVER rather than an emission.
//
// TWO DEPARTURES FROM §5.7, both because the columns win over the sketch:
//   • §5.7 edits "par_min and par_target". The columns are `reorder_point`, `reorder_quantity` and
//     `min_safety_stock` (§3.1.6), with the ordering CHECK `min_safety_stock ≤ reorder_point`. Editing two
//     fields that do not exist would have been a form that always 422s.
//   • §5.7's observation modal uploads a photo to MinIO. `ObserveParStockBody` has no document field, so
//     there is nothing to write the URI to — the note field is what the observation actually carries.
//
// AN OBSERVATION SETS THE SHELF; IT DOES NOT ADJUST IT. A hub worker counting a shelf knows what is on it,
// not what changed since the last count, and an adjustment-shaped form drifts from the shelf every time a
// count is missed. The server derives the delta and runs it through the §2.7 rule, so a count that would
// drive the shelf negative is a typed refusal rather than a silent clamp.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { FormDrawer } from "../../shell/form-drawer";
import {
  type ParStockView,
  errorMessage,
  listParStock,
  observeParStock,
  updateParStock,
} from "./supplies-api";
import { PAR_SEVERITY_RANK, dateTime, shortId } from "./supplies-status";
import {
  CheckboxField,
  FilterRow,
  Notice,
  ParSeverityPill,
  SelectField,
  TextAreaField,
  TextField,
  ghostButtonStyle,
  inputNarrowStyle,
  pageTitleStyle,
  tdQty,
  thNum,
} from "./supplies-ui";
import { useWrite } from "./use-write";

const PAGE = 200;

const SEVERITY_FILTERS = [
  { value: "", label: "all bands" },
  { value: "below_threshold", label: "Below reorder point" },
  { value: "critical_low", label: "Critical low" },
  { value: "depleted", label: "Depleted" },
  { value: "ok", label: "At par" },
];

/** The three editable thresholds on one row, as strings — they are `numeric` columns on the wire. */
interface ThresholdDraft {
  reorderPoint: string;
  reorderQuantity: string;
  minSafetyStock: string;
}

export function ParStockAdmin(): JSX.Element {
  const client = useApiClient();
  const [locationId, setLocationId] = useState("");
  const [severity, setSeverity] = useState("");
  const [belowOnly, setBelowOnly] = useState(false);
  const [rows, setRows] = useState<ParStockView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal of the count drawer shows in the drawer; an inline threshold edit has no drawer, so its own refusal
  // shows on the page.
  const [actionError, setActionError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const { busy, run: runWrite } = useWrite();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ThresholdDraft>({
    reorderPoint: "",
    reorderQuantity: "",
    minSafetyStock: "",
  });
  const [observing, setObserving] = useState<ParStockView | null>(null);
  const [observedQuantity, setObservedQuantity] = useState("");
  const [observationNote, setObservationNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { page, error: err } = await listParStock(client, {
      limit: PAGE,
      ...(locationId.trim() ? { locationId: locationId.trim() } : {}),
      ...(belowOnly ? { belowThresholdOnly: true } : {}),
    });
    if (err) {
      setError(errorMessage(err, "The par shelf could not be loaded."));
      setLoading(false);
      return;
    }
    setRows(page?.data ?? []);
    setLoadedOnce(true);
    setLoading(false);
  }, [client, locationId, belowOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  // The spinner is for the first load only. A reload (a filter keystroke, a save) keeps the page and any open drawer
  // mounted, with the previous rows showing, so the drawer's typed text, focus and opener survive it.
  if (loading && !loadedOnce) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  // The band filter is applied CLIENT-side because §4.1 publishes no `severity` query param — only the
  // coarser `belowThresholdOnly`. Narrowing a fetched page is honest; inventing a server filter is not.
  const visible = (severity ? rows.filter((r) => r.severity === severity) : rows)
    .slice()
    .sort(
      (a, b) =>
        (PAR_SEVERITY_RANK[a.severity] ?? 9) - (PAR_SEVERITY_RANK[b.severity] ?? 9) ||
        a.skuName.localeCompare(b.skuName),
    );

  const startEdit = (row: ParStockView) => {
    setEditing(row.parStockId);
    setEditError(null);
    setDraft({
      reorderPoint: row.reorderPoint,
      reorderQuantity: row.reorderQuantity,
      minSafetyStock: row.minSafetyStock,
    });
  };

  const saveEdit = async (row: ParStockView) => {
    setEditError(null);
    const failed = await runWrite(
      () =>
        updateParStock(client, row.parStockId, row.updatedAt, {
          reorderPoint: draft.reorderPoint.trim(),
          reorderQuantity: draft.reorderQuantity.trim(),
          minSafetyStock: draft.minSafetyStock.trim(),
        }),
      "The thresholds could not be saved.",
    );
    if (failed) {
      setEditError(failed);
      return;
    }
    setEditing(null);
    void load();
  };

  const closeObserving = () => {
    setObserving(null);
    setActionError(null);
  };

  const saveObservation = async (row: ParStockView) => {
    setActionError(null);
    const failed = await runWrite(
      () =>
        observeParStock(client, {
          parStockId: row.parStockId,
          observedQuantity: observedQuantity.trim(),
          ...(observationNote.trim() ? { reorderNotes: observationNote.trim() } : {}),
        }),
      "The count could not be recorded.",
    );
    if (failed) {
      setActionError(failed);
      return;
    }
    closeObserving();
    void load();
  };

  return (
    <div className={`wx-list-drawer${observing ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main wx-kit-column" aria-busy={loading}>
        <PageHeader
          title={<span style={pageTitleStyle}>Par stock</span>}
          actions={
            <Link to="/supplies" style={ghostButtonStyle}>
              Back to queue
            </Link>
          }
        />

        <Notice tone="info">
          The band on each row is DERIVED at read time from the current quantity and the thresholds
          beside it — it is never stored. A stored band goes stale the moment a threshold is edited,
          and the screen reading it would show a green shelf that is actually empty.
        </Notice>

        {editError ? (
          <p className="wx-text-error" role="alert">
            {editError}
          </p>
        ) : null}

        <FilterRow>
          <TextField label="Location id" value={locationId} onChange={setLocationId} mono />
          <SelectField
            label="Band"
            value={severity}
            options={SEVERITY_FILTERS}
            onChange={setSeverity}
          />
          <CheckboxField
            label="Only rows at or below the reorder point"
            checked={belowOnly}
            onChange={setBelowOnly}
          />
        </FilterRow>

        <Panel stack headingLevel={3} title={`Shelf (${visible.length})`}>
          {visible.length === 0 ? (
            <span className="wx-text-muted">
              No par row matches. A Location with no par rows has no monitored shelf — the nightly
              par monitor has nothing to raise for it.
            </span>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Location</th>
                  <th>Band</th>
                  <th style={thNum}>On hand</th>
                  <th style={thNum}>Reorder point</th>
                  <th style={thNum}>Reorder qty</th>
                  <th style={thNum}>Safety stock</th>
                  <th>Last counted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const isEditing = editing === row.parStockId;
                  return (
                    <tr key={row.parStockId}>
                      <td>
                        {row.skuName}
                        <div className="wx-text-muted">
                          {row.skuId ? "platform SKU" : "tenant item"} · {row.unit}
                          {row.isActive ? "" : " · inactive"}
                        </div>
                      </td>
                      <td className="wx-data-md">{shortId(row.locationId)}</td>
                      <td>
                        <ParSeverityPill severity={row.severity} />
                      </td>
                      <td style={tdQty}>{row.currentQuantity}</td>
                      <td style={isEditing ? undefined : tdQty}>
                        {isEditing ? (
                          <input
                            aria-label={`Reorder point for ${row.skuName}`}
                            value={draft.reorderPoint}
                            onChange={(e) => setDraft({ ...draft, reorderPoint: e.target.value })}
                            style={inputNarrowStyle}
                          />
                        ) : (
                          row.reorderPoint
                        )}
                      </td>
                      <td style={isEditing ? undefined : tdQty}>
                        {isEditing ? (
                          <input
                            aria-label={`Reorder quantity for ${row.skuName}`}
                            value={draft.reorderQuantity}
                            onChange={(e) =>
                              setDraft({ ...draft, reorderQuantity: e.target.value })
                            }
                            style={inputNarrowStyle}
                          />
                        ) : (
                          row.reorderQuantity
                        )}
                      </td>
                      <td style={isEditing ? undefined : tdQty}>
                        {isEditing ? (
                          <input
                            aria-label={`Safety stock for ${row.skuName}`}
                            value={draft.minSafetyStock}
                            onChange={(e) => setDraft({ ...draft, minSafetyStock: e.target.value })}
                            style={inputNarrowStyle}
                          />
                        ) : (
                          row.minSafetyStock
                        )}
                      </td>
                      <td>{dateTime(row.lastParReviewAt)}</td>
                      <td>
                        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
                          {isEditing ? (
                            <>
                              <Button
                                tone="primary"
                                type="button"
                                disabled={busy || loading}
                                onClick={() => void saveEdit(row)}
                              >
                                Save
                              </Button>
                              <Button
                                tone="secondary"
                                type="button"
                                onClick={() => setEditing(null)}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button tone="secondary" type="button" onClick={() => startEdit(row)}>
                                Edit thresholds
                              </Button>
                              <Button
                                tone="secondary"
                                type="button"
                                onClick={() => {
                                  setObserving(row);
                                  setObservedQuantity(row.currentQuantity);
                                  setObservationNote("");
                                  setActionError(null);
                                }}
                              >
                                {/* The ellipsis marks the opener: the open drawer's save button carries the plain name. */}
                                Record count…
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <span className="wx-text-muted">
            The band filter narrows the page you fetched — M21 publishes no per-band query
            parameter, only the coarser "below reorder point".
          </span>
        </Panel>
      </div>

      {observing ? (
        <FormDrawer
          key={observing.parStockId}
          title={`Record an on-hand count — ${observing.skuName}`}
          busy={busy}
          error={actionError}
          onClose={closeObserving}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy || observedQuantity.trim() === ""}
              onClick={() => void saveObservation(observing)}
            >
              Record count
            </Button>
          }
        >
          <Notice tone="info">
            This SETS the shelf to what you counted; it is not an adjustment. The nightly monitor —
            not this form — is what raises the below-threshold alert, so a busy Location gets one
            alert a night rather than one per count.
          </Notice>
          <TextField
            label={`Counted quantity (${observing.unit})`}
            value={observedQuantity}
            onChange={setObservedQuantity}
            mono
          />
          <TextAreaField
            label="Note"
            value={observationNote}
            onChange={setObservationNote}
            rows={3}
            hint="Audit-denylisted free text. §5.7's photo capture is not built — the observation carries no document column to write a URI to."
          />
        </FormDrawer>
      ) : null}
    </div>
  );
}
