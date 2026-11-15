import {
  Button,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  TextAreaField,
  TextField,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/08-encounters — the HearthNote composer (M8 §5.2/§2.6, Track B / ADR-0030; #91).
//
// The server remains the source of truth for:
// - template vocabulary,
// - narrative assembly,
// - finalization eligibility,
// - optimistic concurrency.
//
// This page only improves the authoring experience around that contract.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { type BlockerFunction, useBlocker, useNavigate, useParams } from "react-router-dom";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import {
  type DraftSections,
  type EncounterView,
  type MenuEntry,
  type TemplateView,
  type WriteResult,
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

const sectionIsFilled = (draft: DraftSections, sectionId: string): boolean => {
  const value = draft[sectionId];
  return (value?.entries.length ?? 0) > 0 || (value?.freeText.trim().length ?? 0) > 0;
};

type UiFeedback = {
  tone: "success" | "error" | "warning";
  title: string;
  message: string;
  field?: string;
};

function feedbackFor(result: Extract<WriteResult<unknown>, { ok: false }>): UiFeedback {
  if (result.code === "STALE_VERSION")
    return {
      tone: "warning",
      title: "This visit note changed",
      message:
        "The note was updated after you opened it. Reload the latest version before continuing.",
    };
  const first = Array.isArray(result.details) ? result.details[0] : result.details;
  const field =
    first && typeof first === "object" && typeof (first as { field?: unknown }).field === "string"
      ? (first as { field: string }).field
      : undefined;
  return {
    tone: "error",
    title: "Action needed",
    message: readableValidation(result.details, result.message),
    field,
  };
}

interface PatientSummary {
  readonly firstName: string;
  readonly lastName: string;
  readonly mrn: string;
  readonly dob?: string;
}

const SHELL_EXIT_PATHS = new Set(["/expired", "/error", "/maintenance", "/tenant-unavailable"]);
const isShellExit = (pathname: string): boolean =>
  SHELL_EXIT_PATHS.has(pathname) || pathname === "/login" || pathname.startsWith("/login/");

const serializedDraft = (draft: DraftSections): string => JSON.stringify(toSelectionsBody(draft));

const VITAL_LABELS: Record<string, string> = {
  bpSystolic: "Systolic blood pressure",
  bpDiastolic: "Diastolic blood pressure",
  heartRate: "Heart rate",
  respiratoryRate: "Respiratory rate",
  temperature: "Temperature",
  spo2: "SpO₂",
  painScore: "Pain score",
};

function readableValidation(details: unknown, fallback: string): string {
  const first = Array.isArray(details) ? details[0] : details;
  if (first && typeof first === "object") {
    const item = first as { field?: unknown; message?: unknown };
    const field =
      typeof item.field === "string" ? (VITAL_LABELS[item.field] ?? humanize(item.field)) : null;
    if (typeof item.message === "string") return field ? `${field}: ${item.message}` : item.message;
  }
  return fallback;
}

export function EncounterCompose(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { encounterId } = useParams<{ patientId: string; encounterId: string }>();

  const [encounter, setEncounter] = useState<EncounterView | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [draft, setDraft] = useState<DraftSections>({});
  const [preview, setPreview] = useState("");
  const [version, setVersion] = useState(0);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<UiFeedback | null>(null);
  const [operation, setOperation] = useState<"saving" | "finalizing" | null>(null);
  const [lastSavedDraft, setLastSavedDraft] = useState(() => serializedDraft({}));
  const [vitalsOpen, setVitalsOpen] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    if (!encounterId) return;
    const sequence = ++loadSequence.current;

    setLoading(true);
    setError(null);

    const enc = await client.GET("/api/v1/encounters/{encounterId}", {
      params: { path: { encounterId } },
    });

    if (sequence !== loadSequence.current) return;
    if (enc.error || !enc.data) {
      setError("Could not load this encounter.");
      setLoading(false);
      return;
    }

    const loadedEncounter = enc.data as EncounterView;
    const [tmpl, sel, pat] = await Promise.all([
      loadTemplate(client, encounterId),
      loadSelections(client, encounterId),
      client.GET("/api/v1/patients/{id}", {
        params: { path: { id: loadedEncounter.patientId } },
      }),
    ]);

    if (sequence !== loadSequence.current) return;

    setEncounter(loadedEncounter);
    setTemplate(tmpl);
    setPatient((pat.data ?? null) as PatientSummary | null);

    if (sel) {
      const loadedDraft = toDraft(sel.sections);
      setDraft(loadedDraft);
      setLastSavedDraft(serializedDraft(loadedDraft));
      setPreview(sel.layer1Preview);
      setVersion(sel.version);
    } else {
      setDraft({});
      setLastSavedDraft(serializedDraft({}));
    }

    setOpenSection((prev) => prev ?? tmpl?.sections[0]?.sectionId ?? null);
    setLoading(false);
  }, [client, encounterId]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  const unmet = useMemo(
    () => (template ? unmetRequiredSections(template, draft) : []),
    [template, draft],
  );

  const editable = encounter?.status === "draft" && encounter.id === encounterId;
  const currentDraft = useMemo(() => serializedDraft(draft), [draft]);
  const dirty = editable && currentDraft !== lastSavedDraft;
  const busy = operation !== null;
  const shouldBlock = useCallback<BlockerFunction>(
    ({ nextLocation }) => (dirty || busy) && !isShellExit(nextLocation.pathname),
    [busy, dirty],
  );
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, dirty]);

  const completion = useMemo(() => {
    if (!template) {
      return {
        completed: 0,
        total: 0,
        requiredRemaining: 0,
        percent: 0,
      };
    }

    const completed = template.sections.filter((section) =>
      sectionIsFilled(draft, section.sectionId),
    ).length;

    const total = template.sections.length;

    return {
      completed,
      total,
      requiredRemaining: unmet.length,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }, [draft, template, unmet.length]);

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
      [sectionId]: {
        entries: prev[sectionId]?.entries ?? [],
        freeText: value,
      },
    }));
  }

  async function save(): Promise<void> {
    if (!encounterId) return;

    setOperation("saving");
    setFeedback(null);

    const res = await saveSelections(client, encounterId, version, toSelectionsBody(draft));

    if (!res.ok) {
      setOperation(null);
      setFeedback(feedbackFor(res));
      return;
    }

    setVersion(res.value.version);
    setPreview(res.value.layer1Preview);
    setLastSavedDraft(currentDraft);
    setOperation(null);
    setFeedback({
      tone: "success",
      title: "Draft saved",
      message: "Your visit note changes were saved.",
    });
  }

  async function finalize(): Promise<void> {
    if (!encounterId) return;

    setOperation("finalizing");
    setFeedback(null);

    const saved = await saveSelections(client, encounterId, version, toSelectionsBody(draft));

    if (!saved.ok) {
      setOperation(null);
      setFeedback(feedbackFor(saved));
      return;
    }

    setVersion(saved.value.version);
    setPreview(saved.value.layer1Preview);
    setLastSavedDraft(currentDraft);

    const res = await finalizeEncounter(client, encounterId);

    if (!res.ok) {
      setOperation(null);
      setFeedback(feedbackFor(res));
      return;
    }

    setFeedback({
      tone: "success",
      title: "Note finalized",
      message: "Sign it from the encounter record.",
    });
    await load();
    setOperation(null);
  }

  if (error) {
    return <EmptyState title="Unavailable" description={error} />;
  }

  if (encounter !== null && encounter.id !== encounterId) {
    return <LoadingSpinner />;
  }

  if (loading && encounter === null) {
    return <LoadingSpinner />;
  }

  if (encounter === null || template === null) {
    return <EmptyState title="Not found" description="This encounter is not available." />;
  }

  const active = template.sections.find((s) => s.sectionId === openSection) ?? template.sections[0];

  const activeDraft = active ? draft[active.sectionId] : undefined;
  const activeSelectionCount = activeDraft?.entries.length ?? 0;
  const activeHasFreeText = (activeDraft?.freeText.trim().length ?? 0) > 0;
  const recordPath = `/patients/${encounter.patientId}/encounters/${encounter.id}`;
  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      mrn={patient.mrn}
      dob={patient.dob}
    />
  ) : (
    <PatientBanner name="Encounter documentation" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Compose visit note"
            actions={
              <div className="wx-encounter-compose-actions" style={headerActions}>
                <Button tone="tertiary" onClick={() => navigate(recordPath)} disabled={busy}>
                  Back to encounter
                </Button>
                <StatusPill
                  label={stateLabel(encounter.status)}
                  tone={ENCOUNTER_TONE[encounter.status] ?? "neutral"}
                />

                <Button tone="tertiary" onClick={() => navigate(recordPath)} disabled={busy}>
                  Open record
                </Button>

                <Button
                  tone="tertiary"
                  onClick={() => setVitalsOpen((v) => !v)}
                  disabled={!editable || busy}
                >
                  {vitalsOpen ? "Close vitals" : "Vitals"}
                </Button>

                <Button tone="tertiary" onClick={() => void save()} disabled={busy || !editable}>
                  {operation === "saving" ? "Saving…" : "Save draft"}
                </Button>

                <Button onClick={() => void finalize()} disabled={busy || !editable}>
                  Finalize note
                </Button>
              </div>
            }
          />
        }
        table={
          <main className="wx-encounter-compose" style={page}>
            <section
              className="wx-encounter-compose-summary"
              style={summaryBar}
              aria-label="Visit note progress"
            >
              <div style={summaryMain}>
                <div style={summaryTitleRow}>
                  <div>
                    <div style={eyebrow}>Documentation progress</div>
                    <div style={summaryTitle}>
                      {completion.completed} of {completion.total} sections documented
                    </div>
                  </div>

                  <strong style={completionPercent}>{completion.percent}%</strong>
                </div>

                <div style={progressTrack} aria-hidden>
                  <span
                    style={{
                      ...progressFill,
                      width: `${completion.percent}%`,
                    }}
                  />
                </div>
              </div>

              <div className="wx-encounter-compose-summary-stats" style={summaryStats}>
                <div className="wx-encounter-compose-summary-stat" style={summaryStat}>
                  <span style={summaryStatValue}>{completion.requiredRemaining}</span>
                  <span style={summaryStatLabel}>required remaining</span>
                </div>

                <div style={summaryDivider} />

                <div className="wx-encounter-compose-summary-stat" style={summaryStat}>
                  <span style={summaryStatValue}>
                    {activeSelectionCount + (activeHasFreeText ? 1 : 0)}
                  </span>
                  <span style={summaryStatLabel}>items in current section</span>
                </div>
              </div>
            </section>

            <output className="wx-encounter-save-state" aria-live="polite">
              {operation === "saving"
                ? "Saving changes…"
                : operation === "finalizing"
                  ? "Saving and finalizing…"
                  : dirty
                    ? "Unsaved changes"
                    : "All changes saved"}
            </output>

            {feedback ? (
              <output
                style={{
                  ...noticeBox,
                  ...(feedback.tone === "success" ? noticeSuccess : noticeError),
                }}
              >
                <strong style={noticeTitle}>{feedback.title}</strong>
                <span>{feedback.message}</span>
                {feedback.field === "carePlan" ? (
                  <Button
                    tone="tertiary"
                    onClick={() => navigate(`/patients/${encounter.patientId}/care-plan`)}
                  >
                    Open care plan
                  </Button>
                ) : null}
              </output>
            ) : null}

            {unmet.length > 0 ? (
              <section style={attentionCard} aria-label="Required documentation">
                <div style={attentionMark} aria-hidden>
                  !
                </div>

                <div style={{ minWidth: 0 }}>
                  <strong style={attentionTitle}>
                    {unmet.length} required {unmet.length === 1 ? "section needs" : "sections need"}{" "}
                    attention
                  </strong>
                  <p style={attentionText}>
                    Complete {unmet.join(", ")} before finalization. The server still performs the
                    authoritative finalization check.
                  </p>
                </div>
              </section>
            ) : (
              <section style={readyCard}>
                <span style={readyMark} aria-hidden>
                  ✓
                </span>
                <div>
                  <strong style={readyTitle}>Required documentation is complete</strong>
                  <p style={readyText}>
                    You can still review the assembled note before finalizing.
                  </p>
                </div>
              </section>
            )}

            {vitalsOpen ? (
              <VitalsPanel
                encounterId={encounter.id}
                disabled={busy}
                onSaved={() => {
                  setVitalsOpen(false);
                  setFeedback({
                    tone: "success",
                    title: "Vitals recorded",
                    message: "Visit vitals were saved.",
                  });
                }}
              />
            ) : null}

            <div className="wx-encounter-compose-workspace" style={workspace}>
              <aside
                className="wx-encounter-compose-section-rail"
                style={sectionRail}
                aria-label="Visit note sections"
              >
                <div style={railHeader}>
                  <div>
                    <div style={eyebrow}>Note sections</div>
                    <strong style={railTitle}>Document the visit</strong>
                  </div>
                  <span style={railCount}>{template.sections.length}</span>
                </div>

                <nav style={sectionNav}>
                  {template.sections.map((section, index) => {
                    const filled = sectionIsFilled(draft, section.sectionId);
                    const isActive = section.sectionId === active?.sectionId;
                    const missingRequired = section.required && !filled;
                    const sectionState = filled
                      ? "Documented"
                      : missingRequired
                        ? "Required"
                        : "Not started";

                    return (
                      <button
                        key={section.sectionId}
                        type="button"
                        onClick={() => setOpenSection(section.sectionId)}
                        aria-current={isActive ? "step" : undefined}
                        aria-label={`${section.heading}: ${sectionState}`}
                        style={{
                          ...sectionNavButton,
                          ...(isActive ? sectionNavButtonActive : null),
                        }}
                      >
                        <span
                          style={{
                            ...sectionIndex,
                            ...(filled ? sectionIndexComplete : null),
                            ...(isActive && !filled ? sectionIndexActive : null),
                          }}
                          aria-hidden
                        >
                          {filled ? "✓" : index + 1}
                        </span>

                        <span style={sectionNavCopy}>
                          <span
                            style={{
                              ...sectionNavTitle,
                              ...(isActive ? sectionNavTitleActive : null),
                            }}
                          >
                            {section.heading}
                          </span>

                          <span
                            style={{
                              ...sectionNavMeta,
                              ...(missingRequired ? sectionNavMetaRequired : null),
                            }}
                          >
                            {sectionState}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </nav>

                {!editable ? (
                  <div style={readOnlyHint}>
                    This note is read-only because the encounter is{" "}
                    {stateLabel(encounter.status).toLowerCase()}.
                  </div>
                ) : null}
              </aside>

              <section className="wx-encounter-compose-editor" style={editorColumn}>
                {active ? (
                  <div style={editorCard}>
                    <header className="wx-encounter-compose-editor-header" style={editorHeader}>
                      <div style={{ minWidth: 0 }}>
                        <div style={eyebrow}>Current section</div>
                        <div style={editorTitleRow}>
                          <h2 style={editorTitle}>{active.heading}</h2>
                          {active.required ? (
                            <span className="wx-encounter-required-badge" style={requiredBadge}>
                              Required
                            </span>
                          ) : (
                            <span style={optionalBadge}>Optional</span>
                          )}
                        </div>
                        <p style={editorDescription}>
                          Select the statements that describe this visit. Additional free text is
                          stored verbatim.
                        </p>
                      </div>

                      <div style={selectionCounter}>
                        <strong>{activeSelectionCount}</strong>
                        <span>
                          {activeSelectionCount === 1
                            ? "statement selected"
                            : "statements selected"}
                        </span>
                      </div>
                    </header>

                    <div style={editorBody}>
                      {active.entries.length === 0 ? (
                        <div style={emptyVocabulary}>
                          <strong style={emptyVocabularyTitle}>
                            No preset statements for this section
                          </strong>
                          <p style={emptyVocabularyText}>
                            The template has no entries for this {humanize(encounter.discipline)}{" "}
                            {humanize(encounter.encounterType)}. Add the documentation in the
                            free-text field below.
                          </p>
                        </div>
                      ) : (
                        <div style={entryGrid}>
                          {active.entries.map((entry) => {
                            const picked = draft[active.sectionId]?.entries.find(
                              (e) => e.code === entry.code,
                            );
                            const selected = picked !== undefined;

                            return (
                              <div
                                key={entry.code}
                                style={{
                                  ...entryCard,
                                  ...(selected ? entryCardSelected : null),
                                }}
                              >
                                <label style={entryLabel}>
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    disabled={!editable || busy}
                                    onChange={() => toggleEntry(active.sectionId, entry)}
                                    style={entryCheckbox}
                                  />

                                  <span style={entryContent}>
                                    <span style={entryText}>{entry.label}</span>

                                    {entry.bodySystem ? (
                                      <span style={entryMetaRow}>
                                        <StatusPill
                                          label={humanize(entry.bodySystem)}
                                          tone="neutral"
                                        />
                                      </span>
                                    ) : null}
                                  </span>
                                </label>

                                {picked && entry.slots.length > 0 ? (
                                  <div style={slotPanel}>
                                    <div style={slotPanelTitle}>Complete selected details</div>

                                    <div style={slotGrid}>
                                      {entry.slots.map((slot) => (
                                        <TextField
                                          key={slot}
                                          label={humanize(slot)}
                                          value={String(picked.params[slot] ?? "")}
                                          onChange={(e) =>
                                            setSlot(
                                              active.sectionId,
                                              entry.code,
                                              slot,
                                              e.target.value,
                                            )
                                          }
                                          disabled={!editable || busy}
                                        />
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div style={freeTextSection}>
                        <div style={freeTextHeading}>
                          <div>
                            <strong style={freeTextTitle}>Additional clinical notes</strong>
                            <p style={freeTextHint}>
                              Optional. Enter only information not already represented by the
                              selected statements.
                            </p>
                          </div>
                          <span style={verbatimBadge}>Recorded verbatim</span>
                        </div>

                        <TextAreaField
                          label="Additional notes"
                          value={draft[active.sectionId]?.freeText ?? ""}
                          onChange={(e) => setFreeText(active.sectionId, e.target.value)}
                          rows={5}
                          disabled={!editable || busy}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>

              <aside className="wx-encounter-compose-preview" style={previewColumn}>
                <section style={previewCard}>
                  <header style={previewHeader}>
                    <div>
                      <div style={eyebrow}>SERVER-ASSEMBLED PREVIEW</div>
                      <h2 style={previewTitle}>Note as it reads</h2>
                    </div>

                    <span style={previewStatus}>
                      {preview.trim().length > 0 ? "Available" : "Not saved"}
                    </span>
                  </header>

                  <div style={previewBody}>
                    {preview.trim().length === 0 ? (
                      <div style={previewEmpty}>
                        <strong style={previewEmptyTitle}>No assembled narrative yet</strong>
                        <p style={previewEmptyText}>
                          Save the draft to generate the server-built narrative from your
                          selections.
                        </p>
                      </div>
                    ) : (
                      <p style={previewText}>{preview}</p>
                    )}
                  </div>

                  {editable ? (
                    <footer style={previewFooter}>
                      <span style={previewFooterText}>Preview updates after saving.</span>
                      <Button tone="tertiary" onClick={() => void save()} disabled={busy}>
                        {busy ? "Saving…" : "Save & refresh preview"}
                      </Button>
                    </footer>
                  ) : null}
                </section>
              </aside>
            </div>
          </main>
        }
      />
      <Modal
        open={blocker.state === "blocked"}
        role="alertdialog"
        ariaLabel="Leave without saving?"
        dismissOnScrim={false}
      >
        <div style={discardDialog}>
          <h2 style={discardTitle}>Leave without saving?</h2>
          <p style={discardText}>
            {busy
              ? "Your visit note is being saved. Wait for the operation to finish before leaving."
              : "Your visit-note changes have not been saved. Keep editing or discard them before leaving."}
          </p>
          <footer style={discardActions}>
            <Button tone="tertiary" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            {!busy ? <Button onClick={() => blocker.proceed?.()}>Discard changes</Button> : null}
          </footer>
        </div>
      </Modal>
    </PatientWorkspaceLayout>
  );
}

/**
 * §2.2 vitals capture.
 * The server remains responsible for validating clinical envelopes and
 * clinically-not-indicated semantics.
 */
function VitalsPanel({
  encounterId,
  disabled,
  onSaved,
}: {
  encounterId: string;
  disabled: boolean;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const FIELDS = [
    ["bpSystolic", "BP systolic", "mmHg"],
    ["bpDiastolic", "BP diastolic", "mmHg"],
    ["heartRate", "Heart rate", "bpm"],
    ["respiratoryRate", "Respiratory rate", "breaths/min"],
    ["temperature", "Temperature", "°F"],
    ["spo2", "SpO₂", "%"],
    ["painScore", "Pain score", "0–10"],
  ] as const;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

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
    if (!res.ok) {
      setError(readableValidation(res.details, res.message));
      return;
    }
    onSaved();
  }

  return (
    <section style={vitalsPanel}>
      <header style={vitalsHeader}>
        <div>
          <div style={eyebrow}>Quick capture</div>
          <h2 style={vitalsTitle}>Visit vitals</h2>
          <p style={vitalsDescription}>
            Record the measurements available for this visit. Leave unavailable fields blank.
          </p>
        </div>
      </header>

      <div style={vitalsGrid}>
        {FIELDS.map(([key, label, unit]) => (
          <div key={key} style={vitalField}>
            <TextField
              label={label}
              value={values[key] ?? ""}
              disabled={busy || disabled}
              onChange={(e) =>
                setValues((current) => ({
                  ...current,
                  [key]: e.target.value,
                }))
              }
            />
            <span style={vitalUnit}>{unit}</span>
          </div>
        ))}
      </div>

      {error ? (
        <p role="alert" style={vitalsError}>
          {error}
        </p>
      ) : null}

      <footer style={vitalsFooter}>
        <span style={vitalsFooterHint}>Clinical validation is applied by the server.</span>

        <Button onClick={() => void submit()} disabled={busy || disabled}>
          {busy ? "Recording…" : "Record vitals"}
        </Button>
      </footer>
    </section>
  );
}

const hairline = "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)";

const page: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1rem",
  background: "color-mix(in srgb, var(--color-surface-container-low) 55%, transparent)",
};

const headerActions: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const summaryBar: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  justifyContent: "space-between",
  gap: "1.5rem",
  padding: "1rem 1.1rem",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
  boxShadow: "0 1px 2px color-mix(in srgb, black 6%, transparent)",
};

const summaryMain: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const summaryTitleRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: "1rem",
};

const eyebrow: CSSProperties = {
  marginBottom: "0.2rem",
  fontSize: "0.8125rem",
  lineHeight: 1.2,
  fontWeight: 500,
  color: "var(--color-on-surface-variant)",
};

const summaryTitle: CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 650,
  color: "var(--color-on-surface)",
};

const completionPercent: CSSProperties = {
  fontSize: "1.05rem",
  color: "var(--color-primary)",
};

const progressTrack: CSSProperties = {
  height: "0.4rem",
  marginTop: "0.65rem",
  borderRadius: 999,
  overflow: "hidden",
  background: "var(--color-surface-container-highest)",
};

const progressFill: CSSProperties = {
  display: "block",
  height: "100%",
  borderRadius: 999,
  background: "var(--color-primary)",
  transition: "width 180ms ease",
};

const summaryStats: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexShrink: 0,
};

const summaryStat: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: "7rem",
};

const summaryStatValue: CSSProperties = {
  fontSize: "1.1rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const summaryStatLabel: CSSProperties = {
  marginTop: "0.1rem",
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};

const summaryDivider: CSSProperties = {
  width: 1,
  alignSelf: "stretch",
  background: "var(--color-outline-variant)",
  opacity: 0.5,
};

const noticeBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  padding: "0.75rem 0.9rem",
  borderRadius: "0.7rem",
  fontSize: "0.82rem",
  border: hairline,
};

const noticeSuccess: CSSProperties = {
  background: "color-mix(in srgb, var(--color-success) 8%, var(--color-surface))",
  color: "var(--color-on-surface)",
};

const noticeError: CSSProperties = {
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  color: "var(--color-on-surface)",
};

const noticeTitle: CSSProperties = {
  flexShrink: 0,
  fontWeight: 700,
};

const attentionCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 25%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 6%, var(--color-surface))",
};

const attentionMark: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "1.7rem",
  height: "1.7rem",
  flexShrink: 0,
  borderRadius: 999,
  fontSize: "0.85rem",
  fontWeight: 800,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: "var(--color-error)",
};

const attentionTitle: CSSProperties = {
  display: "block",
  fontSize: "0.83rem",
  color: "var(--color-on-surface)",
};

const attentionText: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

const readyCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-success) 22%, transparent)",
  background: "color-mix(in srgb, var(--color-success) 6%, var(--color-surface))",
};

const readyMark: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "1.7rem",
  height: "1.7rem",
  flexShrink: 0,
  borderRadius: 999,
  fontSize: "0.82rem",
  fontWeight: 800,
  color: "var(--color-success)",
  background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
};

const readyTitle: CSSProperties = {
  display: "block",
  fontSize: "0.83rem",
};

const readyText: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.78rem",
  color: "var(--color-on-surface-variant)",
};

const workspace: CSSProperties = {
  display: "grid",
  gap: "1rem",
  alignItems: "start",
};

const sectionRail: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
};

const railHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.95rem 1rem",
  borderBottom: hairline,
};

const railTitle: CSSProperties = {
  fontSize: "0.88rem",
};

const railCount: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: "1.65rem",
  height: "1.65rem",
  padding: "0 0.4rem",
  borderRadius: 999,
  fontSize: "0.72rem",
  fontWeight: 700,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

const sectionNav: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  padding: "0.45rem",
};

const sectionNavButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  gap: "0.65rem",
  padding: "0.65rem 0.7rem",
  border: "1px solid transparent",
  borderRadius: "0.65rem",
  background: "transparent",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const sectionNavButtonActive: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)",
  background: "color-mix(in srgb, var(--color-primary) 7%, var(--color-surface))",
};

const sectionIndex: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "1.55rem",
  height: "1.55rem",
  flexShrink: 0,
  borderRadius: 999,
  fontSize: "0.68rem",
  fontWeight: 700,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

const sectionIndexComplete: CSSProperties = {
  color: "var(--color-success)",
  background: "color-mix(in srgb, var(--color-success) 11%, var(--color-surface))",
};

const sectionIndexActive: CSSProperties = {
  color: "var(--color-on-primary)",
  background: "var(--color-primary)",
};

const sectionNavCopy: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  gap: "0.1rem",
};

const sectionNavTitle: CSSProperties = {
  overflow: "hidden",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const sectionNavTitleActive: CSSProperties = {
  color: "var(--color-primary)",
};

const sectionNavMeta: CSSProperties = {
  fontSize: "0.68rem",
  color: "var(--color-on-surface-variant)",
};

const sectionNavMetaRequired: CSSProperties = {
  color: "var(--color-error)",
};

const readOnlyHint: CSSProperties = {
  margin: "0 0.75rem 0.75rem",
  padding: "0.7rem",
  borderRadius: "0.6rem",
  fontSize: "0.72rem",
  lineHeight: 1.4,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-low)",
};

const editorColumn: CSSProperties = {
  minWidth: 0,
};

const editorCard: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
  boxShadow: "0 1px 2px color-mix(in srgb, black 5%, transparent)",
};

const editorHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1.1rem 1.2rem",
  borderBottom: hairline,
};

const editorTitleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.5rem",
};

const editorTitle: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const editorDescription: CSSProperties = {
  maxWidth: "46rem",
  margin: "0.35rem 0 0",
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

const requiredBadge: CSSProperties = {
  padding: "0.18rem 0.42rem",
  borderRadius: 999,
  fontSize: "0.66rem",
  fontWeight: 700,
  color: "var(--color-error-pill-fg)",
  background: "color-mix(in srgb, var(--color-error) 9%, transparent)",
};

const discardDialog: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1.25rem",
};

const discardTitle: CSSProperties = {
  margin: 0,
  fontSize: "1.15rem",
  color: "var(--color-on-surface)",
};

const discardText: CSSProperties = {
  margin: 0,
  lineHeight: 1.5,
  color: "var(--color-on-surface-variant)",
};

const discardActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};

const optionalBadge: CSSProperties = {
  padding: "0.18rem 0.42rem",
  borderRadius: 999,
  fontSize: "0.66rem",
  fontWeight: 650,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

const selectionCounter: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  flexShrink: 0,
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};

const editorBody: CSSProperties = {
  padding: "1rem 1.15rem 1.15rem",
};

const entryGrid: CSSProperties = {
  display: "grid",
  gap: "0.55rem",
};

const entryCard: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.7rem",
  background: "var(--color-surface)",
  transition: "border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease",
};

const entryCardSelected: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))",
  boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--color-primary) 85%, transparent)",
};

const entryLabel: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.75rem 0.8rem",
  cursor: "pointer",
};

const entryCheckbox: CSSProperties = {
  width: "1rem",
  height: "1rem",
  marginTop: "0.1rem",
  flexShrink: 0,
  accentColor: "var(--color-primary)",
};

const entryContent: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  flexDirection: "column",
  gap: "0.35rem",
};

const entryText: CSSProperties = {
  fontSize: "0.82rem",
  lineHeight: 1.4,
  fontWeight: 550,
  color: "var(--color-on-surface)",
};

const entryMetaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.4rem",
};

const slotPanel: CSSProperties = {
  padding: "0.75rem 0.8rem 0.8rem 2.55rem",
  borderTop: hairline,
  background: "var(--color-surface-container-low)",
};

const slotPanelTitle: CSSProperties = {
  marginBottom: "0.55rem",
  fontSize: "0.7rem",
  fontWeight: 700,
  color: "var(--color-on-surface-variant)",
};

const slotGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.65rem",
};

const emptyVocabulary: CSSProperties = {
  padding: "1rem",
  borderRadius: "0.75rem",
  border: hairline,
  background: "var(--color-surface-container-low)",
};

const emptyVocabularyTitle: CSSProperties = {
  fontSize: "0.82rem",
};

const emptyVocabularyText: CSSProperties = {
  margin: "0.3rem 0 0",
  fontSize: "0.76rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

const freeTextSection: CSSProperties = {
  marginTop: "1rem",
  paddingTop: "1rem",
  borderTop: hairline,
};

const freeTextHeading: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginBottom: "0.65rem",
};

const freeTextTitle: CSSProperties = {
  fontSize: "0.82rem",
};

const freeTextHint: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};

const verbatimBadge: CSSProperties = {
  flexShrink: 0,
  padding: "0.2rem 0.45rem",
  borderRadius: 999,
  fontSize: "0.64rem",
  fontWeight: 650,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

const previewColumn: CSSProperties = {
  minWidth: 0,
};

const previewCard: CSSProperties = {
  position: "sticky",
  top: "1rem",
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
};

const previewHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.95rem 1rem",
  borderBottom: hairline,
};

const previewTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 700,
};

const previewStatus: CSSProperties = {
  padding: "0.18rem 0.4rem",
  borderRadius: 999,
  fontSize: "0.64rem",
  fontWeight: 650,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

const previewBody: CSSProperties = {
  minHeight: "12rem",
  maxHeight: "55vh",
  overflowY: "auto",
  padding: "1rem",
};

const previewText: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontSize: "0.82rem",
  lineHeight: 1.65,
  color: "var(--color-on-surface)",
};

const previewEmpty: CSSProperties = {
  display: "flex",
  minHeight: "10rem",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  padding: "1rem",
  textAlign: "center",
};

const previewEmptyTitle: CSSProperties = {
  fontSize: "0.8rem",
};

const previewEmptyText: CSSProperties = {
  maxWidth: "16rem",
  margin: "0.35rem 0 0",
  fontSize: "0.72rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

const previewFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.6rem",
  padding: "0.7rem 0.85rem",
  borderTop: hairline,
  background: "var(--color-surface-container-low)",
};

const previewFooterText: CSSProperties = {
  fontSize: "0.67rem",
  color: "var(--color-on-surface-variant)",
};

const vitalsPanel: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
};

const vitalsHeader: CSSProperties = {
  padding: "0.9rem 1rem 0",
};

const vitalsTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 700,
};

const vitalsDescription: CSSProperties = {
  margin: "0.25rem 0 0",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const vitalsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
};

const vitalField: CSSProperties = {
  position: "relative",
};

const vitalUnit: CSSProperties = {
  display: "block",
  marginTop: "0.18rem",
  fontSize: "0.65rem",
  color: "var(--color-on-surface-variant)",
};

const vitalsError: CSSProperties = {
  margin: "0 1rem 0.75rem",
  padding: "0.75rem",
  borderRadius: "0.5rem",
  color: "var(--color-on-error-container)",
  background: "var(--color-error-container)",
};

const vitalsFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.75rem 1rem",
  borderTop: hairline,
  background: "var(--color-surface-container-low)",
};

const vitalsFooterHint: CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};
