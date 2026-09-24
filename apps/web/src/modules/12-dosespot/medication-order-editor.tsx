import { PageHeader, PatientWorkspaceLayout, useApiClient } from "@wardenx/ui";
import {
  AdmissionLookupField,
  MdmEntityLookupField,
} from "../../shared/entity-lookups";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  medicationFindingKey,
  medicationFindings,
  isMedicationFindingMapped,
  type MedicationFinding,
} from "./medication-validation";
import {
  emptyMedicationData,
  hydrateMedicationData,
  serializeMedicationData,
} from "./medication-editor-model";

type Kind = "standard" | "controlled_substance" | "compounded";
type Data = Record<string, any>;
const componentLabels: Record<string, string> = {
  componentName: "Ingredient name",
  rxnormRxcui: "RxNorm RxCUI",
  ndc: "NDC",
  componentStrength: "Strength",
  quantityRatio: "Quantity ratio",
};
const componentPlaceholders: Record<string, string> = {
  componentName: "Enter ingredient name",
  rxnormRxcui: "Enter RxCUI",
  ndc: "Enter NDC",
  componentStrength: "Enter strength",
  quantityRatio: "Enter ratio",
};
const numberOrEmpty = (value: string): number | "" =>
  value === "" ? "" : Number(value);
const emptyData = (): Data => emptyMedicationData();
function Finding({
  path,
  findings,
}: {
  path: string;
  findings: MedicationFinding[];
}): JSX.Element | null {
  const finding = findings.find((x) => medicationFindingKey(x.field) === path);
  return finding ? (
    <span role="alert" className="med-editor-finding">
      {finding.message}
    </span>
  ) : null;
}
function Sig({
  data,
  update,
  findings,
}: {
  data: Data;
  update: (d: Data) => void;
  findings: MedicationFinding[];
}): JSX.Element {
  const sig = data.sigStructured ?? {};
  const put = (k: string, v: unknown) =>
    update({ ...data, sigStructured: { ...sig, [k]: v } });
  return (
    <fieldset>
      <legend>Directions for use (SIG)</legend>
      <p className="med-editor-help">
        Record the structured directions and the text shown to the care team.
      </p>
      <Finding path="sigStructured" findings={findings} />
      <div className="med-editor-pair med-editor-pair--value-unit">
        <div className="med-editor-pair-field">
          <label>
            Dose quantity
            <input
              type="number"
              value={sig.doseQuantity ?? ""}
              placeholder="Enter amount"
              onChange={(e) =>
                put("doseQuantity", numberOrEmpty(e.target.value))
              }
            />
          </label>
          <Finding path="sig.doseQuantity" findings={findings} />
        </div>
        <div className="med-editor-pair-field">
          <label>
            Dose unit
            <input
              value={sig.doseUnit ?? ""}
              placeholder="Enter unit"
              onChange={(e) => put("doseUnit", e.target.value)}
            />
          </label>
          <Finding path="sig.doseUnit" findings={findings} />
        </div>
      </div>
      <label>
        Route
        <input
          value={sig.route ?? ""}
          placeholder="Enter route"
          onChange={(e) => put("route", e.target.value)}
        />
      </label>
      <Finding path="sig.route" findings={findings} />
      <label>
        Frequency
        <input
          value={sig.frequencyCode ?? ""}
          placeholder="Enter frequency code"
          onChange={(e) => put("frequencyCode", e.target.value)}
        />
      </label>
      <Finding path="sig.frequencyCode" findings={findings} />
      <div className="med-editor-pair med-editor-pair--value-unit">
        <div className="med-editor-pair-field">
          <label>
            Duration
            <input
              type="number"
              value={sig.duration?.durationValue ?? ""}
              placeholder="Enter duration"
              onChange={(e) =>
                put("duration", {
                  ...(sig.duration ?? {}),
                  durationValue: numberOrEmpty(e.target.value),
                })
              }
            />
          </label>
          <Finding path="sig.duration.durationValue" findings={findings} />
        </div>
        <div className="med-editor-pair-field">
          <label>
            Duration unit
            <select
              value={sig.duration?.durationUnit ?? ""}
              onChange={(e) =>
                put("duration", {
                  ...(sig.duration ?? {}),
                  durationUnit: e.target.value,
                })
              }
            >
              <option value="">Select unit</option>
              {["days", "weeks", "months"].map((unit) => (
                <option key={unit}>{unit}</option>
              ))}
            </select>
          </label>
          <Finding path="sig.duration.durationUnit" findings={findings} />
        </div>
      </div>
      <label>
        <input
          type="checkbox"
          checked={sig.asNeeded ?? false}
          onChange={(e) => put("asNeeded", e.target.checked)}
        />{" "}
        As needed
      </label>
      <Finding path="sig.asNeeded" findings={findings} />
      {sig.asNeeded ? (
        <>
          <label>
            As-needed reason code
            <input
              value={sig.asNeededReasonCode ?? ""}
              placeholder="Enter reason code"
              onChange={(e) => put("asNeededReasonCode", e.target.value)}
            />
          </label>
          <Finding path="sig.asNeededReasonCode" findings={findings} />
        </>
      ) : null}
      <Finding path="sigFreeText" findings={findings} />
      <label>
        Human-readable SIG
        <input
          value={data.sigFreeText ?? ""}
          placeholder="Write directions in plain language"
          onChange={(e) => update({ ...data, sigFreeText: e.target.value })}
        />
      </label>
    </fieldset>
  );
}
function Components({
  data,
  update,
  findings,
}: {
  data: Data;
  update: (d: Data) => void;
  findings: MedicationFinding[];
}): JSX.Element {
  const parts = data.components ?? [];
  return (
    <fieldset>
      <legend>Compound components</legend>
      <p className="med-editor-help">Add each ingredient separately.</p>
      <Finding path="components" findings={findings} />
      {parts.map((part: Data, index: number) => (
        <fieldset key={index} className="med-editor-component">
          <legend>Component {index + 1}</legend>
          {[
            "componentName",
            "rxnormRxcui",
            "ndc",
            "componentStrength",
            "quantityRatio",
          ].map((key) => (
            <label key={key}>
              {componentLabels[key] ?? key}
              <input
                value={part[key] ?? ""}
                placeholder={componentPlaceholders[key] ?? "Enter value"}
                onChange={(e) =>
                  update({
                    ...data,
                    components: parts.map((p: Data, i: number) =>
                      i === index ? { ...p, [key]: e.target.value } : p,
                    ),
                  })
                }
              />
              <Finding path={`component.${index}.${key}`} findings={findings} />
            </label>
          ))}
          <button
            type="button"
            className="med-editor-secondary"
            aria-label={`Remove component ${index + 1}`}
            onClick={() =>
              update({
                ...data,
                components: parts.filter((_: Data, i: number) => i !== index),
              })
            }
          >
            Remove component
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() =>
          update({
            ...data,
            components: [
              ...parts,
              { componentName: "", componentStrength: "", quantityRatio: "" },
            ],
          })
        }
      >
        Add component
      </button>
    </fieldset>
  );
}
export function MedicationOrderEditor(): JSX.Element {
  const api = useApiClient(),
    navigate = useNavigate(),
    { patientId: routePatientId, id } = useParams<{ patientId: string; id: string }>();
  const editing = !!id;
  const [kind, setKind] = useState<Kind>("standard"),
    [admission, setAdmission] = useState(""),
    [data, setData] = useState<Data>(emptyData()),
    [findings, setFindings] = useState<MedicationFinding[]>([]),
    [name, setName] = useState(""),
    [strength, setStrength] = useState(""),
    [form, setForm] = useState(""),
    [route, setRoute] = useState(""),
    [rxcui, setRxcui] = useState(""),
    [ndc, setNdc] = useState(""),
    [physician, setPhysician] = useState(""),
    [pharmacy, setPharmacy] = useState(""),
    [discipline, setDiscipline] = useState("hospice_physician"),
    [patientId, setPatientId] = useState(routePatientId ?? ""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [searching, setSearching] = useState(false),
    [searched, setSearched] = useState(false),
    [searchError, setSearchError] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState<string | null>(null),
    [loadingDraft, setLoadingDraft] = useState(!!id);
  useEffect(() => {
    if (!id) return;
    let active = true;
    void (async () => {
      try {
        const r: any = await api.GET("/api/v1/medication-orders/{id}", {
          params: { path: { id } },
        });
        if (!active) return;
        if (!r.data) {
          setSaveError(
            "Could not load this draft. Please return to the order and try again.",
          );
          return;
        }
        const o = r.data;
      setKind(o.medClass);
      setPatientId(o.patientId);
        setAdmission(o.admissionId);
        setData(hydrateMedicationData(o.data, o.medClass));
        setName(o.drugName);
        setStrength(o.strength);
        setForm(o.doseForm);
        setRoute(o.route);
        setRxcui(o.rxnormRxcui ?? "");
        setNdc(o.ndc ?? "");
        setPhysician(o.prescribingPhysicianMdmId);
        setPharmacy(o.dispensingPharmacyMdmId ?? "");
        setDiscipline(o.prescriberDiscipline || "hospice_physician");
      } catch {
        if (active)
          setSaveError("Could not load this draft. Please try again.");
      } finally {
        if (active) setLoadingDraft(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, id]);
  const save = async () => {
    if (saving || loadingDraft || (editing && !admission)) return;
    setSaving(true);
    setSaveError(null);
    setFindings([]);
    const body = editing
      ? {
          data: serializeMedicationData(data, kind),
          drugName: name,
          strength,
          refillsAuthorized: data.refillsAuthorized ?? 0,
        }
      : {
          patientId,
          admissionId: admission,
          medClass: kind,
          rxnormRxcui: rxcui || null,
          ndc: ndc || null,
          drugName: name,
          strength,
          doseForm: form,
          route,
          data: serializeMedicationData(data, kind),
          prescriberDiscipline: discipline,
          prescribingPhysicianMdmId: physician,
          ...(pharmacy ? { dispensingPharmacyMdmId: pharmacy } : {}),
          refillsAuthorized: data.refillsAuthorized ?? 0,
        };
    try {
      const r: any = editing
        ? await api.PATCH("/api/v1/medication-orders/{id}", {
            params: { path: { id: id! } },
            body,
          } as never)
        : await api.POST("/api/v1/medication-orders", { body } as never);
      if (!r.data) {
        const nextFindings = medicationFindings(r.error);
        setFindings(nextFindings);
        if (!nextFindings.length)
          setSaveError(
            "Draft could not be saved. Please check the fields and try again.",
          );
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      navigate(`/medication-orders/${r.data.id}`);
    } catch {
      setSaveError("Draft could not be saved. Please try again.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <PatientWorkspaceLayout banner={<PageHeader title={editing ? "Edit medication draft" : "New medication order"} />}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="medications" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <style>{editorStyles}</style>
          <div className="med-editor">
        <p className="med-editor-intro">
          {editing
            ? "Update this draft before it is submitted for signature."
            : "Complete the prescription details, then save a draft for review."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {loadingDraft ? (
            <p role="status" className="med-editor-message">
              Loading draft…
            </p>
          ) : null}
          {saveError ? (
            <p role="alert" className="med-editor-error">
              {saveError}
            </p>
          ) : null}
          {findings.length ? (
            <p role="alert" className="med-editor-error">
              Review {findings.length} issue{findings.length === 1 ? "" : "s"}{" "}
              below before saving.
            </p>
          ) : null}
          {findings.some((f) => !isMedicationFindingMapped(f.field)) ? (
            <div role="alert" className="med-editor-error">
              {findings
                .filter((f) => !isMedicationFindingMapped(f.field))
                .map((f, i) => (
                  <p key={i}>{f.message}</p>
                ))}
            </div>
          ) : null}
          {!editing ? (
            <AdmissionLookupField
              label="Active admission"
              patientId={patientId}
              state="active"
              value={admission}
              onChange={setAdmission}
            />
          ) : null}
          <Finding path="admissionId" findings={findings} />
          <fieldset>
            <legend>Medication and prescriber</legend>
            <p className="med-editor-help">
              Search the catalog to prefill the drug name and RxNorm code, or
              enter the details manually.
            </p>
            <label>
              RxNorm search
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setResults([]);
                  setSearched(false);
                  setSearchError(null);
                }}
                placeholder="Search by medication name"
              />
              <button
                type="button"
                disabled={searching || !query.trim()}
                onClick={() =>
                  void (async () => {
                    setSearching(true);
                    setSearchError(null);
                    setResults([]);
                    setSearched(false);
                    try {
                      const get: any = api.GET;
                      const r = await get("/api/v1/terminology/rxnorm/search", {
                        params: {
                          path: { system: "rxnorm" },
                          query: { q: query.trim(), mode: "fuzzy", limit: 10 },
                        },
                      });
                      if (r.error) throw new Error("Search unavailable");
                      setResults(r.data?.results ?? []);
                      setSearched(true);
                    } catch {
                      setSearchError(
                        "RxNorm search is unavailable. You can enter the medication manually.",
                      );
                    } finally {
                      setSearching(false);
                    }
                  })
                }
              >
                {searching ? "Searching…" : "Search"}
              </button>
            </label>
            {!editing ? (
              <>
                <label>
                  RxNorm RxCUI
                  <input
                    value={rxcui}
                    placeholder="Enter RxCUI"
                    onChange={(e) => setRxcui(e.target.value)}
                  />
                </label>
                <Finding path="rxnormRxcui" findings={findings} />
              </>
            ) : null}
            {!editing ? (
              <>
                <label>
                  NDC
                  <input
                    value={ndc}
                    placeholder="Enter NDC"
                    onChange={(e) => setNdc(e.target.value)}
                  />
                </label>
                <Finding path="ndc" findings={findings} />
              </>
            ) : null}
            {searchError ? (
              <span role="alert" className="med-editor-finding">
                {searchError}
              </span>
            ) : null}
            {searched && !results.length ? (
              <span role="status" className="med-editor-help">
                No matches found. Enter the details manually.
              </span>
            ) : null}
            {results.length ? (
              <div
                className="med-editor-results"
                aria-label="RxNorm search results"
              >
                <p className="med-editor-help">
                  Choose a result to fill the name and code:
                </p>
                {results.map((r) => (
                  <button
                    type="button"
                    key={r.code}
                    onClick={() => {
                      setRxcui(r.code);
                      setName(r.display);
                      setResults([]);
                      setSearched(false);
                    }}
                  >
                    {r.display} <small>({r.code})</small>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="med-editor-pair">
              <div className="med-editor-pair-field">
                <label>
                  Drug name
                  <input
                    value={name}
                    placeholder="Enter medication name"
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <Finding path="drugName" findings={findings} />
              </div>
              <div className="med-editor-pair-field">
                <label>
                  Strength
                  <input
                    value={strength}
                    placeholder="Enter strength"
                    onChange={(e) => setStrength(e.target.value)}
                  />
                </label>
                <Finding path="strength" findings={findings} />
              </div>
            </div>
            {!editing ? (
              <>
                <div className="med-editor-pair">
                  <div className="med-editor-pair-field">
                    <label>
                      Dose form
                      <input
                        value={form}
                        placeholder="Enter dose form"
                        onChange={(e) => setForm(e.target.value)}
                      />
                    </label>
                    <Finding path="doseForm" findings={findings} />
                  </div>
                  <div className="med-editor-pair-field">
                    <label>
                      Route
                      <input
                        value={route}
                        placeholder="Enter route"
                        onChange={(e) => setRoute(e.target.value)}
                      />
                    </label>
                    <Finding path="route" findings={findings} />
                  </div>
                </div>
                <MdmEntityLookupField
                  kind="physician"
                  label="Prescribing physician"
                  value={physician}
                  onChange={setPhysician}
                />
                <Finding path="prescribingPhysicianMdmId" findings={findings} />
                <MdmEntityLookupField
                  kind="pharmacy"
                  label="Dispensing pharmacy"
                  value={pharmacy}
                  onChange={setPharmacy}
                />
                <Finding path="dispensingPharmacyMdmId" findings={findings} />
                <label>
                  Prescriber discipline
                  <input
                    value={discipline}
                    placeholder="Enter discipline"
                    onChange={(e) => setDiscipline(e.target.value)}
                  />
                </label>
                <Finding path="prescriberDiscipline" findings={findings} />
              </>
            ) : null}
          </fieldset>
          <div className="med-editor-kind">
            <label>
              Medication class
              <select
                disabled={editing}
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as Kind;
                  setKind(next);
                  setData(emptyMedicationData(next));
                }}
              >
                {["standard", "controlled_substance", "compounded"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <Finding path="medClass" findings={findings} />
            {!editing ? (
              <p className="med-editor-help">
                Changing the class resets directions and dispensing fields
                already entered.
              </p>
            ) : null}
          </div>
          {kind === "controlled_substance" ? (
            <fieldset>
              <legend>Controlled requirements</legend>
              <div className="med-editor-pair">
                <div className="med-editor-pair-field">
                  <label>
                    DEA schedule
                    <select
                      value={data.deaSchedule ?? ""}
                      onChange={(e) =>
                        setData({
                          ...data,
                          deaSchedule: e.target.value,
                          refillsAuthorized:
                            e.target.value === "II"
                              ? 0
                              : data.refillsAuthorized,
                        })
                      }
                    >
                      <option value="">Select schedule</option>
                      {["II", "III", "IV", "V"].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                  <Finding path="deaSchedule" findings={findings} />
                </div>
                <div className="med-editor-pair-field">
                  <label>
                    Prescriber DEA
                    <input
                      value={data.prescriberDea ?? ""}
                      placeholder="Enter DEA identifier"
                      onChange={(e) =>
                        setData({ ...data, prescriberDea: e.target.value })
                      }
                    />
                  </label>
                  <Finding path="prescriberDea" findings={findings} />
                </div>
              </div>
            </fieldset>
          ) : null}
          {kind === "compounded" ? (
            <>
              <MdmEntityLookupField
                kind="pharmacy"
                label="Compounding pharmacy"
                value={data.compoundingPharmacyMdmId ?? ""}
                onChange={(v) =>
                  setData({ ...data, compoundingPharmacyMdmId: v })
                }
              />
              <Finding path="compoundingPharmacyMdmId" findings={findings} />
              <label>
                Formulation description
                <textarea
                  value={data.formulationDescription ?? ""}
                  placeholder="Describe the formulation"
                  onChange={(e) =>
                    setData({ ...data, formulationDescription: e.target.value })
                  }
                />
              </label>
              <Finding path="formulationDescription" findings={findings} />
              <label>
                <input
                  type="checkbox"
                  checked={data.containsControlled ?? false}
                  onChange={(e) =>
                    setData(
                      e.target.checked
                        ? { ...data, containsControlled: true }
                        : (() => {
                            const { deaSchedule: _dea, ...withoutDea } = data;
                            return { ...withoutDea, containsControlled: false };
                          })(),
                    )
                  }
                />{" "}
                Contains controlled substance
              </label>
              <Finding path="containsControlled" findings={findings} />
              {data.containsControlled === true ? (
                <label>
                  DEA schedule
                  <select
                    value={data.deaSchedule ?? ""}
                    onChange={(e) =>
                      setData({ ...data, deaSchedule: e.target.value })
                    }
                  >
                    <option value="">Select schedule</option>
                    {["II", "III", "IV", "V"].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <Finding path="deaSchedule" findings={findings} />
                </label>
              ) : null}
              <Components data={data} update={setData} findings={findings} />
            </>
          ) : null}
          <Sig data={data} update={setData} findings={findings} />
          <fieldset>
            <legend>Dispensing and context</legend>
            <div className="med-editor-pair med-editor-pair--value-unit">
              <div className="med-editor-pair-field">
                <label>
                  Dispense quantity
                  <input
                    type="number"
                    value={data.dispenseQuantity?.value ?? ""}
                    placeholder="Enter quantity"
                    onChange={(e) =>
                      setData({
                        ...data,
                        dispenseQuantity: {
                          ...(data.dispenseQuantity ?? {}),
                          value: numberOrEmpty(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <Finding path="quantity" findings={findings} />
                <Finding path="quantity.value" findings={findings} />
              </div>
              <div className="med-editor-pair-field">
                <label>
                  Dispense quantity unit
                  <input
                    value={data.dispenseQuantity?.unit ?? ""}
                    placeholder="Enter unit"
                    onChange={(e) =>
                      setData({
                        ...data,
                        dispenseQuantity: {
                          ...(data.dispenseQuantity ?? {}),
                          unit: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <Finding path="quantity.unit" findings={findings} />
              </div>
            </div>
            <div className="med-editor-pair">
              <div className="med-editor-pair-field">
                <label>
                  Days supply
                  <input
                    type="number"
                    value={data.daysSupply ?? ""}
                    placeholder="Enter days"
                    onChange={(e) =>
                      setData({
                        ...data,
                        daysSupply: numberOrEmpty(e.target.value),
                      })
                    }
                  />
                </label>
                <Finding path="daysSupply" findings={findings} />
              </div>
              <div className="med-editor-pair-field">
                <label>
                  Refills
                  <input
                    type="number"
                    disabled={data.deaSchedule === "II"}
                    value={
                      data.deaSchedule === "II"
                        ? 0
                        : (data.refillsAuthorized ?? 0)
                    }
                    onChange={(e) =>
                      setData({
                        ...data,
                        refillsAuthorized: numberOrEmpty(e.target.value),
                      })
                    }
                  />
                </label>
                <Finding path="refillsAuthorized" findings={findings} />
              </div>
            </div>
            <label>
              <input
                type="checkbox"
                disabled={kind === "compounded"}
                checked={kind === "compounded" ? true : (data.daw ?? false)}
                onChange={(e) => setData({ ...data, daw: e.target.checked })}
              />{" "}
              Dispense as written (DAW)
            </label>
            <Finding path="daw" findings={findings} />
            <label>
              Indication
              <textarea
                value={data.indication ?? ""}
                placeholder="Document the indication"
                onChange={(e) =>
                  setData({ ...data, indication: e.target.value })
                }
              />
            </label>
            <Finding path="indication" findings={findings} />
            <label>
              Clinical justification
              <textarea
                value={data.clinicalJustification ?? ""}
                placeholder="Document the clinical rationale"
                onChange={(e) =>
                  setData({ ...data, clinicalJustification: e.target.value })
                }
              />
            </label>
            <Finding path="clinicalJustification" findings={findings} />
            <label>
              Notes
              <textarea
                value={data.notes ?? ""}
                placeholder="Additional notes, if needed"
                onChange={(e) => setData({ ...data, notes: e.target.value })}
              />
            </label>
            <Finding path="notes" findings={findings} />
          </fieldset>
          <div className="med-editor-footer">
            <span className="med-editor-help">
              Saving keeps this order as a draft.
            </span>
            <div className="med-editor-footer-actions">
              <button
                type="button"
                className="med-editor-secondary"
                onClick={() => navigate(-1)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || loadingDraft || (editing && !admission)}
              >
                {saving ? "Saving…" : "Save draft"}
              </button>
            </div>
          </div>
        </form>
          </div>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

const editorStyles = `
.med-editor { max-width: 62rem; margin: 0 auto; padding-bottom: 2rem; color: var(--color-on-surface); }
.med-editor-intro { margin: .25rem 0 1.5rem; color: var(--color-on-surface-variant); line-height: 1.5; }
.med-editor form { display: grid; gap: 1.25rem; }
.med-editor fieldset, .med-editor-kind { min-width: 0; margin: 0; padding: 1.25rem; border: 1px solid var(--color-outline-variant); border-radius: .75rem; background: var(--color-surface); }
.med-editor legend { padding: 0 .35rem; font-size: 1.05rem; font-weight: 700; }
.med-editor-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1rem; align-items: start; }
.med-editor-pair--value-unit { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); }
.med-editor-pair-field { min-width: 0; }

.med-editor label { display: grid; gap: .4rem; margin: .8rem 0; font-size: .875rem; font-weight: 600; }
.med-editor label:has(input[type=checkbox]) { display: flex; align-items: center; gap: .65rem; }
.med-editor input:not([type=checkbox]), .med-editor select, .med-editor textarea { box-sizing: border-box; width: 100%; min-height: 2.65rem; padding: .55rem .7rem; border: 1px solid var(--color-outline-variant); border-radius: .45rem; color: var(--color-on-surface); background: var(--color-surface); font: inherit; }
.med-editor textarea { min-height: 6rem; resize: vertical; }
.med-editor input[type=checkbox] { width: 1.1rem; height: 1.1rem; margin: 0; }
.med-editor input:focus-visible, .med-editor select:focus-visible, .med-editor textarea:focus-visible, .med-editor button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.med-editor button { min-height: 2.5rem; padding: .5rem .85rem; border: 1px solid var(--color-primary); border-radius: .45rem; background: var(--color-primary); color: var(--color-on-primary); font: inherit; font-weight: 600; cursor: pointer; }
.med-editor button:disabled { cursor: not-allowed; opacity: .55; }
.med-editor button.med-editor-secondary { color: var(--color-on-surface); border-color: var(--color-outline-variant); background: var(--color-surface); }
.med-editor-help { margin: .35rem 0 .8rem; color: var(--color-on-surface-variant); font-size: .85rem; line-height: 1.45; }
.med-editor-finding { display: block; margin: .25rem 0 .6rem; color: var(--color-error, #b42318); font-size: .85rem; }
.med-editor-error { padding: .8rem 1rem; border: 1px solid var(--color-error, #b42318); border-radius: .5rem; color: var(--color-error, #b42318); }
.med-editor-message { padding: .8rem 1rem; }
.med-editor-results { display: grid; gap: .35rem; max-height: 17rem; overflow: auto; padding: .6rem; border: 1px solid var(--color-outline-variant); border-radius: .5rem; }
.med-editor-results button { text-align: left; color: var(--color-on-surface); background: var(--color-surface); border-color: var(--color-outline-variant); }
.med-editor-results small { opacity: .7; }
.med-editor-component { margin: 1rem 0 !important; }
.med-editor-footer { position: sticky; bottom: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .75rem; padding: .9rem 1rem; border: 1px solid var(--color-outline-variant); border-radius: .75rem; background: var(--color-surface); box-shadow: 0 -4px 18px rgba(0,0,0,.06); }
.med-editor-footer-actions { display: flex; flex-wrap: wrap; gap: .65rem; }
@media (max-width: 40rem) { .med-editor-pair, .med-editor-pair--value-unit { grid-template-columns: minmax(0, 1fr); } .med-editor fieldset, .med-editor-kind { padding: 1rem; } .med-editor-footer-actions { width: 100%; } .med-editor-footer-actions button { flex: 1; } }
`;
