import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  TextAreaField,
  TextField,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/08-encounters — the HearthNote composer (M8 §5.2/§2.6, Track B / ADR-0030; #91).
//
// This is the write #91's title names: "the staff app can read and sign clinical records but cannot
// AUTHOR one". M8's sign / acknowledge / cosign-sign / supervisor-release ceremonies were already built;
// the note itself could not be written. A visit note is the highest-volume artifact in a hospice EHR,
// the CoP documentation of the visit, and the substantiation behind the claim.
//
// TAP-TO-DOCUMENT, NOT FREE TYPING. §2.6's model is a bounded vocabulary: the clinician picks curated
// phrases into template sections and the server assembles a byte-identical Layer-1 narrative from them.
// So the composer is a MENU, and the menu comes from `GET .../template` (F-063) — the same
// `resolveTemplate` + `entriesFor` resolution `assembleSelections` enforces on the way back in. Shipping
// the corpus to the browser instead would be a second copy of those rules, free to disagree.
//
// FREE TEXT IS PER-SECTION AND VERBATIM. Assembly appends it after the section's assembled sentences and
// never grammars it (§2.6 / architecture §10.5.2), so what the clinician types is what the record says.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES.
//
//   • THE NARRATIVE. `layer1Preview` comes back from the read and from every save — the note as it
//     currently reads. This screen never assembles prose; it renders what the server assembled.
//   • THE LAYER-3 GATE. Whether the note may finalize is `POST .../finalize`'s answer. The unmet-required
//     list below is a PROMPT — Finalize stays enabled, because the server's checks are more than
//     "required sections are non-empty" and a client that guessed would either block a legal note or
//     promise an illegal one.
//   • §7.7 CONCURRENCY. `If-Match` is a typed header param on the save; a 412 means someone else saved
//     first and is rendered as that, not as a generic error.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import {
  type DraftSections,
  type EncounterView,
  type MenuEntry,
  type TemplateView,
  captureVitals,
  finalizeEncounter,
  loadSelections,
  loadTemplate,
  saveSelections,
  toDraft,
  toSelectionsBody,
  unmetRequiredSections,
} from "./encounters-api";

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function EncounterCompose(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { encounterId } = useParams<{ encounterId: string }>();
  const [encounter, setEncounter] = useState<EncounterView | null>(null);
  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [draft, setDraft] = useState<DraftSections>({});
  const [preview, setPreview] = useState("");
  const [version, setVersion] = useState(0);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vitalsOpen, setVitalsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!encounterId) return;
    setLoading(true);
    setError(null);
    const enc = await client.GET("/api/v1/encounters/{encounterId}", {
      params: { path: { encounterId } },
    });
    if (enc.error || !enc.data) {
      setError("Could not load this encounter.");
      setLoading(false);
      return;
    }
    setEncounter(enc.data as EncounterView);
    const [tmpl, sel] = await Promise.all([
      loadTemplate(client, encounterId),
      loadSelections(client, encounterId),
    ]);
    setTemplate(tmpl);
    if (sel) {
      setDraft(toDraft(sel.sections));
      setPreview(sel.layer1Preview);
      setVersion(sel.version);
    }
    setOpenSection((prev) => prev ?? tmpl?.sections[0]?.sectionId ?? null);
    setLoading(false);
  }, [client, encounterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const unmet = useMemo(
    () => (template ? unmetRequiredSections(template, draft) : []),
    [template, draft],
  );

  const editable = encounter?.status === "draft";

  function toggleEntry(sectionId: string, entry: MenuEntry): void {
    setDraft((prev) => {
      const current = prev[sectionId] ?? { entries: [], freeText: "" };
      const has = current.entries.some((e) => e.code === entry.code);
      return {
        ...prev,
        [sectionId]: {
          ...current,
          entries: has
            ? current.entries.filter((e) => e.code !== entry.code)
            : [...current.entries, { code: entry.code, params: {} }],
        },
      };
    });
  }

  function setSlot(sectionId: string, code: string, slot: string, value: string): void {
    setDraft((prev) => {
      const current = prev[sectionId] ?? { entries: [], freeText: "" };
      return {
        ...prev,
        [sectionId]: {
          ...current,
          entries: current.entries.map((e) =>
            e.code === code ? { ...e, params: { ...e.params, [slot]: value } } : e,
          ),
        },
      };
    });
  }

  function setFreeText(sectionId: string, value: string): void {
    setDraft((prev) => ({
      ...prev,
      [sectionId]: { entries: prev[sectionId]?.entries ?? [], freeText: value },
    }));
  }

  async function save(): Promise<void> {
    if (!encounterId) return;
    setBusy(true);
    setNotice(null);
    const res = await saveSelections(client, encounterId, version, toSelectionsBody(draft));
    setBusy(false);
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    setVersion(res.value.version);
    setPreview(res.value.layer1Preview);
    setNotice("Saved.");
  }

  async function finalize(): Promise<void> {
    if (!encounterId) return;
    setBusy(true);
    setNotice(null);
    // Save first: finalizing an unsaved draft would gate on the tree the server last saw, not the one
    // on screen — the clinician would be refused for content they are looking at.
    const saved = await saveSelections(client, encounterId, version, toSelectionsBody(draft));
    if (!saved.ok) {
      setBusy(false);
      setNotice(saved.message);
      return;
    }
    setVersion(saved.value.version);
    setPreview(saved.value.layer1Preview);
    const res = await finalizeEncounter(client, encounterId);
    setBusy(false);
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    setNotice("Finalized. Sign it from the encounter record.");
    await load();
  }

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && encounter === null) return <LoadingSpinner />;
  if (encounter === null || template === null)
    return <EmptyState title="Not found" description="This encounter is not available." />;

  const active = template.sections.find((s) => s.sectionId === openSection) ?? template.sections[0];

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Compose visit note"
          breadcrumb={`${humanize(encounter.encounterType)} · ${humanize(encounter.discipline)} · ${encounter.serviceDate}`}
          actions={
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <StatusPill
                label={stateLabel(encounter.status)}
                tone={ENCOUNTER_TONE[encounter.status] ?? "neutral"}
              />
              <Button tone="tertiary" onClick={() => setVitalsOpen((v) => !v)} disabled={!editable}>
                Vitals
              </Button>
              <Button tone="tertiary" onClick={() => void save()} disabled={busy || !editable}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button onClick={() => void finalize()} disabled={busy || !editable}>
                Finalize
              </Button>
              <Button tone="tertiary" onClick={() => navigate(`/encounters/${encounter.id}`)}>
                Open record
              </Button>
            </div>
          }
        />
      }
      table={
        <div style={{ display: "flex", flexDirection: "column" }}>
          {notice ? <output style={noticeBox}>{notice}</output> : null}

          {unmet.length > 0 ? (
            <p style={promptBox}>
              Still empty: {unmet.join(", ")}. The server decides whether the note may finalize —
              this is what its §2.6 completeness check will look at first.
            </p>
          ) : null}

          {vitalsOpen ? (
            <VitalsPanel
              encounterId={encounter.id}
              onDone={(m) => {
                setVitalsOpen(false);
                setNotice(m);
              }}
            />
          ) : null}

          <nav style={tabRow}>
            {template.sections.map((s) => {
              const d = draft[s.sectionId];
              const filled = (d?.entries.length ?? 0) > 0 || (d?.freeText.trim().length ?? 0) > 0;
              return (
                <button
                  key={s.sectionId}
                  type="button"
                  onClick={() => setOpenSection(s.sectionId)}
                  style={{
                    ...tab,
                    ...(s.sectionId === active?.sectionId ? tabActive : null),
                  }}
                >
                  {s.heading}
                  {s.required && !filled ? (
                    <span style={{ color: "var(--color-error)" }}> *</span>
                  ) : null}
                  {filled ? <span style={{ color: "var(--color-success)" }}> ✓</span> : null}
                </button>
              );
            })}
          </nav>

          {active ? (
            <section style={{ padding: "1rem" }}>
              <h2 style={sectionTitle}>
                {active.heading}
                {active.required ? <span style={requiredTag}> required</span> : null}
              </h2>
              {active.entries.length === 0 ? (
                <p style={meta}>
                  The shipped vocabulary has no entries for this section on a{" "}
                  {humanize(encounter.discipline)} {humanize(encounter.encounterType)}. Use the
                  free-text box — assembly preserves it verbatim.
                </p>
              ) : (
                <ul style={list}>
                  {active.entries.map((entry) => {
                    const picked = draft[active.sectionId]?.entries.find(
                      (e) => e.code === entry.code,
                    );
                    return (
                      <li key={entry.code} style={entryRow}>
                        <label style={entryLabel}>
                          <input
                            type="checkbox"
                            checked={picked !== undefined}
                            disabled={!editable}
                            onChange={() => toggleEntry(active.sectionId, entry)}
                          />
                          <span>{entry.label}</span>
                          {entry.bodySystem ? (
                            <StatusPill label={humanize(entry.bodySystem)} tone="neutral" />
                          ) : null}
                        </label>
                        {picked && entry.slots.length > 0 ? (
                          <div style={slotRow}>
                            {entry.slots.map((slot) => (
                              <TextField
                                key={slot}
                                label={humanize(slot)}
                                value={String(picked.params[slot] ?? "")}
                                onChange={(e) =>
                                  setSlot(active.sectionId, entry.code, slot, e.target.value)
                                }
                              />
                            ))}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              <TextAreaField
                label="Additional notes (recorded verbatim)"
                value={draft[active.sectionId]?.freeText ?? ""}
                onChange={(e) => setFreeText(active.sectionId, e.target.value)}
                rows={3}
              />
            </section>
          ) : null}

          <section style={previewBox}>
            <h2 style={sectionTitle}>Note as it reads</h2>
            {preview.trim().length === 0 ? (
              <p style={meta}>
                Nothing assembled yet. The narrative is built server-side from the selections above
                — save to see it.
              </p>
            ) : (
              <p style={previewText}>{preview}</p>
            )}
          </section>
        </div>
      }
    />
  );
}

/**
 * The §2.2 vitals capture. Every field is optional at the boundary and the SERVER validates the
 * envelopes and the clinically-not-indicated reason, so this collects and submits rather than checking.
 */
function VitalsPanel({
  encounterId,
  onDone,
}: {
  encounterId: string;
  onDone: (message: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

  const FIELDS = [
    ["bpSystolic", "BP systolic"],
    ["bpDiastolic", "BP diastolic"],
    ["heartRate", "Heart rate"],
    ["respiratoryRate", "Respiratory rate"],
    ["temperature", "Temperature"],
    ["spo2", "SpO₂"],
    ["painScore", "Pain score"],
  ] as const;

  async function submit(): Promise<void> {
    setBusy(true);
    const body: Record<string, number> = {};
    for (const [key] of FIELDS) {
      const raw = values[key];
      if (raw !== undefined && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
        body[key] = Number(raw);
      }
    }
    const res = await captureVitals(
      client,
      encounterId,
      body as Parameters<typeof captureVitals>[2],
    );
    setBusy(false);
    onDone(res.ok ? "Vitals recorded." : res.message);
  }

  return (
    <section style={{ padding: "1rem", borderBottom: hairline }}>
      <h2 style={sectionTitle}>Vitals</h2>
      <div style={vitalsGrid}>
        {FIELDS.map(([key, label]) => (
          <TextField
            key={key}
            label={label}
            value={values[key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.5rem" }}>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy ? "Recording…" : "Record vitals"}
        </Button>
      </div>
    </section>
  );
}

const hairline = "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)";
const tabRow = {
  display: "flex",
  gap: "0.25rem",
  padding: "0.5rem 1rem 0",
  borderBottom: hairline,
  overflowX: "auto",
} as const;
const tab = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0.5rem 0.75rem",
  fontSize: "0.85rem",
  color: "var(--color-on-surface-variant)",
  whiteSpace: "nowrap",
} as const;
const tabActive = {
  color: "var(--color-primary)",
  borderBottom: "2px solid var(--color-primary)",
  fontWeight: 600,
} as const;
const sectionTitle = { margin: "0 0 0.5rem", fontSize: "0.95rem", fontWeight: 600 } as const;
const requiredTag = { fontSize: "0.7rem", fontWeight: 400, color: "var(--color-error)" } as const;
const list = { listStyle: "none", margin: "0 0 0.75rem", padding: 0 } as const;
const entryRow = { padding: "0.3rem 0", fontSize: "0.85rem" } as const;
const entryLabel = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  cursor: "pointer",
} as const;
const slotRow = {
  display: "flex",
  gap: "0.5rem",
  margin: "0.35rem 0 0 1.5rem",
  flexWrap: "wrap",
} as const;
const vitalsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
  gap: "0.5rem",
} as const;
const previewBox = { padding: "1rem", borderTop: hairline } as const;
const previewText = { margin: 0, fontSize: "0.9rem", lineHeight: 1.6 } as const;
const meta = { margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" } as const;
const noticeBox = {
  display: "block",
  padding: "0.75rem 1rem 0",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
const promptBox = {
  margin: 0,
  padding: "0.5rem 1rem",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
