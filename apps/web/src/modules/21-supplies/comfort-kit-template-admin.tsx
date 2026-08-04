// apps/web/src/modules/21-supplies — S21.8 COMFORT-KIT TEMPLATE ADMIN (`/supplies/comfort-kit-templates`,
// §5.9, Track B / ADR-0030). Spec: docs/design/screens/admin — "Use Admin Split Layout."
//
// The D3 floor-plus-overlay recipe: ONE org-less platform-floor template every tenant reads and none may
// write, plus tenant templates that may EXTEND or TIGHTEN it and never drop below it.
//
// AN EDIT IS A SUPERSESSION, NOT A PATCH (§2.3). "Save" on an existing tenant template INSERTS a new row
// pointing back through `replaces_template_id` and closes the predecessor's effective window — which is why
// the editor always carries the FULL definition rather than a diff. A dispatch from three months ago must
// still resolve the recipe it actually used.
//
// TWO DEPARTURES FROM §5.9:
//   • The "add medication" row asks for RxNorm as free text rather than an M38 autocomplete. M21 publishes
//     no terminology lookup of its own and the M38 surface is its own module's screen with its own
//     permission; typing a CUI that the server validates is honest, whereas a picker over a catalog this
//     module cannot read would have been a box that never suggested anything.
//   • Removing a platform-floor medication is not blocked in the form. The server refuses it with
//     `M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR` and names the medication; pre-empting that client-side would
//     mean shipping a second copy of the floor definition, which is exactly the drift D3 exists to prevent.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type ComfortKitTemplateView,
  type TemplateMedicationInput,
  createComfortKitTemplate,
  errorMessage,
  listComfortKitTemplates,
  supersedeComfortKitTemplate,
} from "./supplies-api";
import {
  CONTROLLED_SCHEDULES,
  dateTime,
  fractionAsPct,
  shortDate,
  shortId,
} from "./supplies-status";
import {
  Card,
  CheckboxField,
  Field,
  Notice,
  SchedulePill,
  SelectField,
  SummaryGrid,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  inputStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  thNum,
} from "./supplies-ui";

/** A medication row under edit. Kept as strings — `expectedQuantity` and the threshold are `numeric`. */
interface MedDraft extends TemplateMedicationInput {
  key: string;
}

let draftSeq = 0;
function blankMed(): MedDraft {
  draftSeq += 1;
  return {
    key: `med-${draftSeq}`,
    rxnorm: "",
    drugName: "",
    strength: "",
    dosageForm: "",
    routeOfAdministration: "",
    isControlledSubstance: false,
    expectedQuantity: "1",
    expectedUnit: "mL",
  };
}

export function ComfortKitTemplateAdmin(): JSX.Element {
  const client = useApiClient();
  const [templates, setTemplates] = useState<ComfortKitTemplateView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorMode, setEditorMode] = useState<"none" | "create" | "supersede">("none");
  const [name, setName] = useState("");
  const [meds, setMeds] = useState<MedDraft[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { page, error: err } = await listComfortKitTemplates(client, {
      includePlatformFloor: true,
      limit: 100,
      ...(includeSuperseded ? { includeSuperseded: true } : {}),
    });
    if (err) {
      setError(errorMessage(err, "The comfort-kit templates could not be loaded."));
      setLoading(false);
      return;
    }
    const rows = page?.data ?? [];
    setTemplates(rows);
    setSelectedId((prev) => prev ?? rows[0]?.comfortKitTemplateId ?? null);
    setLoading(false);
  }, [client, includeSuperseded]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  // The floor is pinned at the top of the rail — it is the row every tenant template is measured against.
  const ordered = [...templates].sort((a, b) =>
    a.isPlatformFloor === b.isPlatformFloor
      ? a.name.localeCompare(b.name)
      : a.isPlatformFloor
        ? -1
        : 1,
  );
  const selected = ordered.find((tm) => tm.comfortKitTemplateId === selectedId) ?? null;
  const floor = ordered.find((tm) => tm.isPlatformFloor) ?? null;

  const startCreate = () => {
    setEditorMode("create");
    setActionError(null);
    setName("");
    // Seed from the floor: a tenant template MUST contain every floor medication at or above its quantity,
    // so starting from the floor is the only start that can pass validation.
    setMeds(
      (floor?.medications ?? []).map((m) => {
        draftSeq += 1;
        return {
          key: `floor-${m.templateMedicationId}-${draftSeq}`,
          rxnorm: m.rxnorm,
          ndc: m.ndc ?? undefined,
          drugName: m.drugName,
          strength: m.strength,
          dosageForm: m.dosageForm,
          routeOfAdministration: m.routeOfAdministration,
          isControlledSubstance: m.isControlledSubstance,
          controlledSubstanceSchedule: m.controlledSubstanceSchedule ?? undefined,
          expectedQuantity: m.expectedQuantity,
          expectedUnit: m.expectedUnit,
          replenishmentThresholdPct: m.replenishmentThresholdPct,
          displayOrder: m.displayOrder,
        };
      }),
    );
  };

  const startSupersede = (template: ComfortKitTemplateView) => {
    setEditorMode("supersede");
    setActionError(null);
    setName(template.name);
    setMeds(
      template.medications.map((m) => {
        draftSeq += 1;
        return {
          key: `tm-${m.templateMedicationId}-${draftSeq}`,
          rxnorm: m.rxnorm,
          ndc: m.ndc ?? undefined,
          drugName: m.drugName,
          strength: m.strength,
          dosageForm: m.dosageForm,
          routeOfAdministration: m.routeOfAdministration,
          isControlledSubstance: m.isControlledSubstance,
          controlledSubstanceSchedule: m.controlledSubstanceSchedule ?? undefined,
          expectedQuantity: m.expectedQuantity,
          expectedUnit: m.expectedUnit,
          replenishmentThresholdPct: m.replenishmentThresholdPct,
          displayOrder: m.displayOrder,
        };
      }),
    );
  };

  const patchMed = (key: string, p: Partial<MedDraft>) =>
    setMeds((prev) => prev.map((m) => (m.key === key ? { ...m, ...p } : m)));

  const payload = () => ({
    name: name.trim(),
    medications: meds.map(({ key: _key, ...m }) => ({
      ...m,
      rxnorm: m.rxnorm.trim(),
      drugName: m.drugName.trim(),
      strength: m.strength.trim(),
      dosageForm: m.dosageForm.trim(),
      routeOfAdministration: m.routeOfAdministration.trim(),
      expectedQuantity: m.expectedQuantity.trim(),
      expectedUnit: m.expectedUnit.trim(),
      // The schedule pair is bidirectional in the database: a controlled line needs a schedule and a
      // non-controlled line must not carry one. Sending a stale schedule after unchecking the box would be
      // a CHECK violation with a database error message instead of a field-anchored one.
      ...(m.isControlledSubstance
        ? { controlledSubstanceSchedule: m.controlledSubstanceSchedule ?? "CII" }
        : { controlledSubstanceSchedule: undefined }),
    })),
  });

  const save = async () => {
    setBusy(true);
    setActionError(null);
    const { template, error: err } =
      editorMode === "supersede" && selected
        ? await supersedeComfortKitTemplate(client, selected.comfortKitTemplateId, payload())
        : await createComfortKitTemplate(client, payload());
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The template could not be saved."));
      return;
    }
    setEditorMode("none");
    if (template) setSelectedId(template.comfortKitTemplateId);
    void load();
  };

  const ready =
    name.trim() !== "" &&
    meds.length > 0 &&
    meds.every((m) => m.drugName.trim() !== "" && m.rxnorm.trim() !== "");

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Comfort-kit templates</span>}
        breadcrumb="Supplies — the D3 platform floor and its tenant overlays"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button type="button" style={primaryButtonStyle} onClick={startCreate}>
              New tenant template
            </button>
            <Link to="/supplies" style={ghostButtonStyle}>
              Back to queue
            </Link>
          </div>
        }
      />

      <Notice tone="info">
        A tenant template must contain every platform-floor medication at a quantity at or above the
        floor, and may add more. It may raise a replenishment threshold (which replenishes sooner),
        never lower it. The server validates this before writing anything, so a template that
        violates the floor never exists even briefly.
      </Notice>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <CheckboxField
        label="Include superseded versions"
        checked={includeSuperseded}
        onChange={setIncludeSuperseded}
      />

      <div
        style={{ display: "grid", gridTemplateColumns: "minmax(14rem, 22rem) 1fr", gap: t.space4 }}
      >
        <Card title="Templates">
          {ordered.length === 0 ? (
            <span style={mutedStyle}>No template is visible.</span>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: t.space2,
              }}
            >
              {ordered.map((tm) => (
                <li key={tm.comfortKitTemplateId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(tm.comfortKitTemplateId);
                      setEditorMode("none");
                    }}
                    style={{
                      ...ghostButtonStyle,
                      width: "100%",
                      textAlign: "left",
                      background:
                        tm.comfortKitTemplateId === selectedId ? t.surfaceContainer : t.surfaceLow,
                    }}
                  >
                    {tm.name}
                    <div style={mutedStyle}>
                      {tm.isPlatformFloor ? "Platform floor · read-only" : "Tenant template"}
                      {tm.effectiveTo ? " · superseded" : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: t.space4, minWidth: 0 }}>
          {selected ? (
            <Card
              title={selected.name}
              actions={
                <div style={{ display: "flex", gap: t.space2, alignItems: "center" }}>
                  {selected.isPlatformFloor || selected.systemLocked ? (
                    <StatusPill label="Locked" tone="neutral" />
                  ) : (
                    <button
                      type="button"
                      style={ghostButtonStyle}
                      onClick={() => startSupersede(selected)}
                    >
                      Revise
                    </button>
                  )}
                </div>
              }
            >
              <SummaryGrid>
                <Field label="Template" value={shortId(selected.comfortKitTemplateId)} mono />
                <Field label="Effective from" value={dateTime(selected.effectiveFrom)} />
                <Field
                  label="Effective to"
                  value={selected.effectiveTo ? dateTime(selected.effectiveTo) : "current"}
                />
                <Field label="Replaces" value={shortId(selected.replacesTemplateId)} mono />
                <Field label="Medications" value={selected.medications.length} />
              </SummaryGrid>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Medication</th>
                    <th style={th}>RxNorm</th>
                    <th style={th}>Form / route</th>
                    <th style={th}>Schedule</th>
                    <th style={thNum}>Expected</th>
                    {/* Stored as a FRACTION in [0,1] (§3.1.4's CHECK) despite the column's "_pct" name. */}
                    <th style={thNum}>Replenish below</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.medications.map((m) => (
                    <tr key={m.templateMedicationId} style={rowLine}>
                      <td style={td}>
                        {m.drugName}
                        <div style={mutedStyle}>{m.strength}</div>
                      </td>
                      <td style={{ ...td, fontFamily: t.fontMono }}>{m.rxnorm}</td>
                      <td style={td}>
                        {m.dosageForm} · {m.routeOfAdministration}
                      </td>
                      <td style={td}>
                        <SchedulePill
                          schedule={m.controlledSubstanceSchedule}
                          isControlled={m.isControlledSubstance}
                        />
                      </td>
                      <td style={{ ...td, textAlign: "right", fontFamily: t.fontMono }}>
                        {m.expectedQuantity} {m.expectedUnit}
                      </td>
                      <td style={{ ...td, textAlign: "right", fontFamily: t.fontMono }}>
                        {fractionAsPct(m.replenishmentThresholdPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selected.isPlatformFloor ? (
                <span style={mutedStyle}>
                  Seeded with the migration chain and locked. Every tenant reads it; no tenant can
                  write it — its organization is null and the write policy admits only the platform
                  role.
                </span>
              ) : null}
            </Card>
          ) : null}

          {editorMode !== "none" ? (
            <Card
              title={
                editorMode === "supersede"
                  ? "Revise template (creates a new version)"
                  : "New tenant template"
              }
              actions={
                <div style={{ display: "flex", gap: t.space2 }}>
                  <button
                    type="button"
                    disabled={!ready || busy}
                    style={!ready || busy ? disabledButtonStyle : primaryButtonStyle}
                    onClick={() => void save()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    style={ghostButtonStyle}
                    onClick={() => setEditorMode("none")}
                  >
                    Cancel
                  </button>
                </div>
              }
            >
              {editorMode === "supersede" ? (
                <Notice tone="warning">
                  Saving does not edit this template. It writes a NEW version pointing back at this
                  one and closes this one's window, so every dispatch keeps resolving the recipe it
                  actually used.
                </Notice>
              ) : null}
              <TextField label="Template name" value={name} onChange={setName} />
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Drug</th>
                    <th style={th}>RxNorm</th>
                    <th style={th}>Strength</th>
                    <th style={th}>Form</th>
                    <th style={th}>Route</th>
                    <th style={th}>Controlled</th>
                    <th style={thNum}>Expected</th>
                    <th style={th}>Unit</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {meds.map((m) => (
                    <tr key={m.key} style={rowLine}>
                      <td style={td}>
                        <input
                          aria-label="Drug name"
                          value={m.drugName}
                          onChange={(e) => patchMed(m.key, { drugName: e.target.value })}
                          style={{ ...inputStyle, minWidth: "9rem" }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          aria-label="RxNorm CUI"
                          value={m.rxnorm}
                          onChange={(e) => patchMed(m.key, { rxnorm: e.target.value })}
                          style={{ ...inputStyle, minWidth: "6rem", fontFamily: t.fontMono }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          aria-label="Strength"
                          value={m.strength}
                          onChange={(e) => patchMed(m.key, { strength: e.target.value })}
                          style={{ ...inputStyle, minWidth: "6rem" }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          aria-label="Dosage form"
                          value={m.dosageForm}
                          onChange={(e) => patchMed(m.key, { dosageForm: e.target.value })}
                          style={{ ...inputStyle, minWidth: "6rem" }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          aria-label="Route of administration"
                          value={m.routeOfAdministration}
                          onChange={(e) =>
                            patchMed(m.key, { routeOfAdministration: e.target.value })
                          }
                          style={{ ...inputStyle, minWidth: "6rem" }}
                        />
                      </td>
                      <td style={td}>
                        <CheckboxField
                          label="Controlled"
                          checked={m.isControlledSubstance}
                          onChange={(v) => patchMed(m.key, { isControlledSubstance: v })}
                        />
                        {m.isControlledSubstance ? (
                          <SelectField
                            label="Schedule"
                            value={m.controlledSubstanceSchedule ?? "CII"}
                            options={enumOptions(CONTROLLED_SCHEDULES, (s) => s)}
                            onChange={(v) =>
                              // `v` is always one of CONTROLLED_SCHEDULES — this SelectField offers no other value.
                              patchMed(m.key, {
                                controlledSubstanceSchedule:
                                  v as MedDraft["controlledSubstanceSchedule"],
                              })
                            }
                          />
                        ) : null}
                      </td>
                      <td style={td}>
                        <input
                          aria-label="Expected quantity"
                          value={m.expectedQuantity}
                          onChange={(e) => patchMed(m.key, { expectedQuantity: e.target.value })}
                          style={{ ...inputStyle, minWidth: "5rem", fontFamily: t.fontMono }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          aria-label="Expected unit"
                          value={m.expectedUnit}
                          onChange={(e) => patchMed(m.key, { expectedUnit: e.target.value })}
                          style={{ ...inputStyle, minWidth: "4rem" }}
                        />
                      </td>
                      <td style={td}>
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          onClick={() => setMeds((prev) => prev.filter((x) => x.key !== m.key))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: "flex", gap: t.space2 }}>
                <button
                  type="button"
                  style={ghostButtonStyle}
                  onClick={() => setMeds((prev) => [...prev, blankMed()])}
                >
                  Add medication
                </button>
              </div>
              {meds.some((m) => m.isControlledSubstance) ? (
                <Notice tone="warning">
                  A controlled medication on this recipe means every dispatch of this kit enters the
                  DEA perpetual log, with a lot number and expiration required on that line at
                  dispatch time.
                </Notice>
              ) : null}
              <span style={mutedStyle}>
                Floor validation runs on the server and names the medication it is missing.
                Templates effective from {shortDate(floor?.effectiveFrom)} carry the current floor.
              </span>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
