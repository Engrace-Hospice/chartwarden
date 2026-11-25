// apps/web/src/modules/08-encounters — the HearthNote composer (M8 §5.2/§2.6, Track B / ADR-0030; #91).
//
// The server remains the source of truth for:
// - template vocabulary,
// - narrative assembly,
// - finalization eligibility,
// - optimistic concurrency.
//
// This page only improves the authoring experience around that contract.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { type BlockerFunction, useBlocker, useNavigate, useParams } from "react-router-dom";
import { type PanelStatus, withPanelStatus } from "../../shell/panel-status";
import { PlanOfCareStep } from "../07-care-plan/change-proposals";
import type { UiFeedback } from "./compose-feedback";
import { humanize } from "./compose-text";
import { ComposeHeaderActions } from "./compose/compose-header-actions";
import {
  type ComposeOperation,
  PANEL_ORDER,
  PLAN_SECTION_ID,
  type PanelKey,
  type PanelStatuses,
  type PatientSummary,
  REASON_SECTION_ID,
  type ReasonSuggestion,
  VITALS_SECTION_ID,
  documentationCompletion,
  isShellExit,
  removedFromDraftFeedback,
  serializedDraft,
} from "./compose/compose-model";
import { ComposePatientBanner } from "./compose/compose-patient-banner";
import {
  ComposeProgressSummary,
  FeedbackNotice,
  PreviewStaleNotice,
  RequiredDocumentationCard,
  SaveStateLine,
} from "./compose/compose-status-banners";
import { createComposeWrites } from "./compose/compose-writes";
import { DiscardChangesModal } from "./compose/discard-changes-modal";
import { createDraftEditors } from "./compose/draft-editors";
import { FreeTextSection } from "./compose/free-text-section";
import { NotePreviewCard } from "./compose/note-preview-card";
import { SectionEditorHeader } from "./compose/section-editor-header";
import { SectionRail } from "./compose/section-rail";
import { StatementMenu } from "./compose/statement-menu";
import { usePreviewSync } from "./compose/use-preview-sync";
import { useVisitPurposeSuggestion } from "./compose/use-visit-purpose-suggestion";
import { ComposerDraftRail, ComposerDraftStrip } from "./composer-draft-chrome";
import { confirmedSectionIds, isDisciplinePlanSection } from "./draft-model";
import { DraftSectionPanel } from "./draft-section-panel";
import {
  editorBody,
  editorCard,
  editorColumn,
  page,
  previewColumn,
  workspace,
} from "./encounter-compose-styles";
import {
  type DraftSections,
  type EncounterView,
  FALL_FOLLOWUP_CODE,
  type FallIncidentsView,
  NO_SECTIONS,
  type TemplateSection,
  type TemplateView,
  dropUnofferedEntries,
  isSectionPopulated,
  loadFallIncidents,
  loadSelections,
  loadTemplate,
  sectionHasEmptySlots,
  sectionsFilledByRecords,
  sectionsNeedingAttention,
  toDraft,
} from "./encounters-api";
import { LateEntryReasonCard } from "./late-entry-reason-card";
import { PlanNextVisitPanel } from "./next-visit/plan-next-visit-panel";
import {
  NOTE_VIEW_UNAVAILABLE_DESCRIPTION,
  NoteViewUnavailable,
  isNoteViewUnavailable,
} from "./note-view-unavailable";
import { PlanReviewPrompts } from "./plan-review-prompt";
import { RecordedPanels } from "./recorded-panels";
import { type SectionFacts, notesHint, sectionChip } from "./section-status";
import { useComposerDraft } from "./use-composer-draft";
import { useFocusRequest } from "./use-focus-request";
import { useLateEntryReason } from "./use-late-entry-reason";
import { useNoWoundConcerns } from "./use-no-wound-concerns";
import { VitalsPanel } from "./vitals-panel";

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
  // The failed read is the Part 2 note view that could not be decided (503): the screen offers a retry.
  const [retryable, setRetryable] = useState(false);
  const [feedback, setFeedback] = useState<UiFeedback | null>(null);
  const [operation, setOperation] = useState<ComposeOperation | null>(null);
  const [lastSavedDraft, setLastSavedDraft] = useState(() => serializedDraft({}, null));
  // The recorded fall a follow-up-after-a-fall visit follows up: the stored link, the author's current choice, and the falls on offer.
  const [linkedFall, setLinkedFall] = useState<{ incidentId: string; occurredOn: string } | null>(
    null,
  );
  const [fallIncidentId, setFallIncidentId] = useState<string | null>(null);
  const [fallChoices, setFallChoices] = useState<FallIncidentsView | null>(null);
  // The author's own edit of the note text: the saved edit (null = the note reads as generated), whether the note moved underneath
  // it since, and the text box while they are changing it.
  const [editedNarrative, setEditedNarrative] = useState<string | null>(null);
  const [editStale, setEditStale] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [vitalsOpen, setVitalsOpen] = useState(false);
  // The vitals form is mounted the first time it is opened and kept (hidden when closed), so what was typed survives a close.
  const [vitalsMounted, setVitalsMounted] = useState(false);
  // The last re-read of the note failed: the preview may be out of date until one succeeds.
  const [previewStale, setPreviewStale] = useState(false);
  // The reason the scheduled visit's purpose suggested, held as an UNSAVED choice until the clinician saves it.
  const [suggestion, setSuggestion] = useState<ReasonSuggestion | null>(null);
  // What each panel says about itself: unsaved input, a write in flight, a saved record. The note is dirty or busy when any panel is.
  const [panelStatus, setPanelStatus] = useState<PanelStatuses>({});
  // True from the start of a load until it ends: panels are gone in between, and what they say on the way out is not about the note
  // that is about to be shown.
  const loadingRef = useRef(true);
  const reportPanel = useCallback((key: PanelKey, status: PanelStatus): void => {
    if (loadingRef.current) return;
    setPanelStatus((held) => withPanelStatus(held, key, status));
  }, []);
  // What a notice and a suggestion say belongs to one note: another note (Back or Forward between composer URLs) starts without them.
  const [shownFor, setShownFor] = useState(encounterId);
  if (shownFor !== encounterId) {
    setShownFor(encounterId);
    setFeedback(null);
    setSuggestion(null);
  }
  const planRegion = useRef<HTMLDivElement>(null);
  // The newest re-read of the note's text: an older one answering late must not overwrite what a newer read or a save put on screen.
  const previewRead = useRef(0);
  const reportVitals = useCallback(
    (status: PanelStatus) => reportPanel("vitals", status),
    [reportPanel],
  );
  const reportPlan = useCallback(
    (status: PanelStatus) => reportPanel("plan", status),
    [reportPanel],
  );
  const loadSequence = useRef(0);
  // Focus for the heading of the open section, so a drafted section opened from the strip takes the reader to it.
  const [sectionHeadingRef, focusSectionHeading] = useFocusRequest<HTMLHeadingElement>();

  const load = useCallback(async (): Promise<EncounterView | null> => {
    if (!encounterId) return null;
    const sequence = ++loadSequence.current;

    loadingRef.current = true;
    setLoading(true);
    setError(null);
    setRetryable(false);
    setEncounter(null);
    setPatient(null);
    setTemplate(null);
    setDraft({});
    setPreview("");
    setVersion(0);
    setLastSavedDraft(serializedDraft({}, null));
    setLinkedFall(null);
    setFallIncidentId(null);
    setFallChoices(null);
    setEditedNarrative(null);
    setEditStale(false);
    setEditing(false);
    setEditText("");
    setVitalsOpen(false);
    setVitalsMounted(false);
    setPreviewStale(false);
    setPanelStatus({});
    setOpenSection(null);

    try {
      const enc = await client.GET("/api/v1/encounters/{encounterId}", {
        params: { path: { encounterId } },
      });

      if (sequence !== loadSequence.current) return null;
      if (enc.error || !enc.data) {
        const noteViewUnavailable = isNoteViewUnavailable(enc.error);
        setRetryable(noteViewUnavailable);
        setError(
          noteViewUnavailable
            ? NOTE_VIEW_UNAVAILABLE_DESCRIPTION
            : "Could not load this encounter.",
        );
        loadingRef.current = false;
        setLoading(false);
        return null;
      }

      const loadedEncounter = enc.data as EncounterView;
      const [tmpl, sel, pat] = await Promise.all([
        loadTemplate(client, encounterId),
        loadSelections(client, encounterId),
        client.GET("/api/v1/patients/{id}", {
          params: { path: { id: loadedEncounter.patientId } },
        }),
      ]);

      if (sequence !== loadSequence.current) return null;

      if (!tmpl || !sel || pat.error || !pat.data) {
        setError("Could not load this encounter.");
        loadingRef.current = false;
        setLoading(false);
        return null;
      }

      setEncounter(loadedEncounter);
      setTemplate(tmpl);
      setPatient(pat.data as PatientSummary);

      const loadedDraft = toDraft(sel.sections);
      const {
        draft: offeredDraft,
        dropped,
        droppedParams,
      } = dropUnofferedEntries(tmpl, loadedDraft);
      setDraft(offeredDraft);
      // The saved baseline stays the STORED tree, so a removal reads as an unsaved change the author applies.
      setLastSavedDraft(serializedDraft(loadedDraft, sel.fallIncident?.incidentId ?? null));
      setLinkedFall(sel.fallIncident ?? null);
      setFallIncidentId(sel.fallIncident?.incidentId ?? null);
      // "Save the draft to apply the change" only means something on a note that can still be saved.
      if ((dropped > 0 || droppedParams > 0) && loadedEncounter.status === "draft") {
        setFeedback(removedFromDraftFeedback(dropped, droppedParams));
      }
      setPreview(sel.layer1Preview);
      setEditedNarrative(sel.editedNarrative ?? null);
      setEditStale(sel.editedNarrativeStale === true);
      setVersion(sel.version);

      setOpenSection((prev) => prev ?? tmpl.sections[0]?.sectionId ?? null);
      loadingRef.current = false;
      setLoading(false);
      return loadedEncounter;
    } catch {
      if (sequence !== loadSequence.current) return null;
      setError("Could not load this encounter. Check your connection and try again.");
      loadingRef.current = false;
      setLoading(false);
      return null;
    }
  }, [client, encounterId]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  useVisitPurposeSuggestion(client, encounter, template, setDraft, setSuggestion);

  // The link only means something beside the follow-up-after-a-fall reason; anywhere else the note carries none.
  const reasonIsFall =
    draft[REASON_SECTION_ID]?.entries.some((e) => e.code === FALL_FOLLOWUP_CODE) === true;
  const effectiveFallId = reasonIsFall ? fallIncidentId : null;
  // The falls on offer are read once the author picks the follow-up reason: the list is a disclosure from Quality's register, so
  // it is not fetched for a note that never asks for it.
  useEffect(() => {
    if (!encounterId || encounter?.status !== "draft" || !reasonIsFall || fallChoices !== null) {
      return;
    }
    let current = true;
    void loadFallIncidents(client, encounterId).then((found) => {
      if (current) setFallChoices(found);
    });
    return () => {
      current = false;
    };
  }, [client, encounterId, encounter?.status, reasonIsFall, fallChoices]);

  // The server counts a saved ADL or nutrition record as documenting the section that states it, so the panels' saved records do too,
  // and a wound assessed at this visit documents the wound section the note states it in.
  const adlRecorded = panelStatus.adl?.recorded === true;
  const nutritionRecorded = panelStatus.nutrition?.recorded === true;
  const woundsRecorded = panelStatus.wounds?.recorded === true;
  const noWoundConcerns = useNoWoundConcerns(template?.sections, draft, setDraft);
  // The wounds panel takes a saved "no concerns" sentence out by itself when a wound is on file. It does so on load, with the panel
  // possibly hidden, and leaves the note unsaved: the notice is the composer's, in the words the panel uses. A warning already on
  // screen (statements dropped from the draft on load) keeps its words and gets the removal after them; a notice that goes away by
  // itself (tagged) is replaced, since the removal would go with it.
  const reportNoConcernsRemoved = useCallback(
    (message: string): void =>
      setFeedback((held) =>
        held?.tone === "warning" && held.tag === undefined
          ? held.message.includes(message)
            ? held
            : { ...held, message: `${held.message} ${message}` }
          : { tone: "warning", title: "", message },
      ),
    [],
  );
  const filledByRecord = useMemo(
    () =>
      template
        ? sectionsFilledByRecords(template, {
            adl: adlRecorded,
            nutrition: nutritionRecorded,
            wounds: woundsRecorded,
          })
        : NO_SECTIONS,
    [template, adlRecorded, nutritionRecorded, woundsRecorded],
  );

  const editable = encounter?.status === "draft" && encounter.id === encounterId;
  // While the author is typing over the note text, the selections and the save and finalize buttons wait: the text is a copy of
  // the note as it reads, so changing what it was made from underneath it would leave the two disagreeing.
  const frozen = !editable || editing;
  // Module 8 §2.5: a note entered after the visit carries the author's reason; the box shows when the note is late (or the server asked).
  const lateEntry = useLateEntryReason({
    encounterId,
    serviceDate: encounter?.serviceDate,
    editable,
  });
  const currentDraft = useMemo(
    () => serializedDraft(draft, effectiveFallId),
    [draft, effectiveFallId],
  );
  // The note as it reads now. An edit made on an older version of the note no longer says what the note says (it misses what was
  // documented since), so a stale edit is never shown as the note: the generated text is, and the old edit is offered beside it.
  const editInForce = editedNarrative !== null && !editStale;
  const noteText = editInForce ? editedNarrative : preview;
  // Text typed into the edit box and not yet applied counts as unsaved, like a ticked statement does.
  const editDirty = editing && editText !== noteText;
  const selectionsDirty = currentDraft !== lastSavedDraft || editDirty;
  // A panel's form is saved by the panel's own button, so its unsaved input and its writes in flight count as the note's.
  const panels = Object.values(panelStatus);
  const panelsDirty = panels.some((panel) => panel.dirty);
  const dirtyPanels = PANEL_ORDER.filter((key) => panelStatus[key]?.dirty === true);
  /** What the author calls a part of the note: the heading of its section, or the panel's own title. */
  function panelTitle(key: PanelKey): string {
    if (key === "vitals") return "Visit vitals";
    if (key === "plan") return "Plan of care";
    return template?.sections.find((s) => s.recordedPanel === key)?.heading ?? key;
  }
  // A template with a vitals section (every non-telephonic RN/LPN/MD/NP visit) takes the vitals form inside it; any other keeps the form behind the header's "Vitals" button.
  const vitalsInSection =
    template?.sections.some((s) => s.sectionId === VITALS_SECTION_ID) === true;
  /** Bring a part of the note into view (its section opened, the vitals shown, the plan scrolled to) so its unsaved entries can be dealt with. */
  function showPanel(key: PanelKey): void {
    if (key === "vitals") {
      setVitalsMounted(true);
      if (vitalsInSection) setOpenSection(VITALS_SECTION_ID);
      else setVitalsOpen(true);
    } else if (key === "plan") {
      planRegion.current?.scrollIntoView?.({ block: "start" });
    } else {
      const sectionId = template?.sections.find((s) => s.recordedPanel === key)?.sectionId;
      if (sectionId !== undefined) setOpenSection(sectionId);
    }
  }
  const savingPanels = Object.entries(panelStatus).filter(([, panel]) => panel.saving);
  const dirty = editable && (selectionsDirty || panelsDirty);
  const busy = operation !== null || savingPanels.length > 0;
  // The plan step may keep saving its own drawer while it says so; only another write locks it.
  const planDisabled = frozen || operation !== null || savingPanels.some(([key]) => key !== "plan");
  // A late-entry reason typed in the box is sent only by Finalize, so it is not part of `dirty` (Save draft would not save it), but
  // leaving the page loses it: the leave guard and the unload warning count it.
  const leaveGuarded = dirty || lateEntry.unsent;
  const shouldBlock = useCallback<BlockerFunction>(
    ({ nextLocation }) => (leaveGuarded || busy) && !isShellExit(nextLocation.pathname),
    [busy, leaveGuarded],
  );
  const blocker = useBlocker(shouldBlock);
  const active =
    template?.sections.find((s) => s.sectionId === openSection) ?? template?.sections[0];
  // ADR-0114: the pre-drafted sections. "off" (the tenant switch, or nothing drafted) leaves the composer exactly as it was.
  const {
    noteDraft,
    drafted,
    pending,
    panelSection,
    blockedReason,
    carePlanRevision,
    refusal,
    refuse,
    resolveSection,
  } = useComposerDraft({
    encounterId: encounter?.id,
    encounterStatus: encounter?.status,
    activeSectionId: active?.sectionId,
    saving: busy,
    selectionsDirty: editable && selectionsDirty,
    unsavedPanels: editable ? dirtyPanels.map(panelTitle) : [],
  });
  // The server's check 1 counts drafted text the clinician confirmed as populating a required section; so does every count here.
  const confirmedIds = useMemo(() => confirmedSectionIds(drafted), [drafted]);
  const unmet = useMemo(
    () => (template ? sectionsNeedingAttention(template, draft, filledByRecord, confirmedIds) : []),
    [template, draft, filledByRecord, confirmedIds],
  );

  // Opening the vitals section mounts the form (and keeps it, so what was typed survives a switch to another section).
  const activeSectionId = active?.sectionId;
  useEffect(() => {
    if (vitalsInSection && activeSectionId === VITALS_SECTION_ID) setVitalsMounted(true);
  }, [vitalsInSection, activeSectionId]);

  useEffect(() => {
    if (!leaveGuarded && !busy) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, leaveGuarded]);

  // The notice that asked for the panels to be saved or discarded goes once they are.
  useEffect(() => {
    if (!panelsDirty) setFeedback((held) => (held?.tag === "findings-unsaved" ? null : held));
  }, [panelsDirty]);

  const completion = useMemo(
    () => documentationCompletion(template, draft, filledByRecord, confirmedIds, unmet.length),
    [draft, template, filledByRecord, confirmedIds, unmet.length],
  );

  const { toggleEntry, chooseOne, setSlot, setFreeText, addToFreeText } = createDraftEditors(
    template,
    draft,
    setDraft,
  );

  const headingOfSection = (sectionId: string): string =>
    template?.sections.find((section) => section.sectionId === sectionId)?.heading ??
    humanize(sectionId);

  const openFromSummary = (sectionId: string): void => {
    setOpenSection(sectionId);
    focusSectionHeading();
  };

  const { readStored, applyStored, refreshPreview, refreshFromPanel } = usePreviewSync({
    client,
    encounterId,
    loadSequence,
    previewRead,
    setPreview,
    setEditedNarrative,
    setEditStale,
    setPreviewStale,
    reloadDraft: noteDraft.reload,
  });

  const { startEdit, writeEdit, save, finalize } = createComposeWrites({
    client,
    encounterId,
    version,
    draft,
    effectiveFallId,
    currentDraft,
    editedNarrative,
    selectionsDirty,
    dirtyPanels,
    panelTitle,
    showPanel,
    headingOfSection,
    lateEntry,
    previewRead,
    readStored,
    applyStored,
    refreshPreview,
    reloadDraft: noteDraft.reload,
    refuse,
    load,
    setFeedback,
    setOperation,
    setError,
    setVersion,
    setPreview,
    setPreviewStale,
    setLastSavedDraft,
    setEditing,
    setEditText,
  });

  if (error) {
    return retryable ? (
      <NoteViewUnavailable description={error} onRetry={() => void load()} />
    ) : (
      <EmptyState title="Unavailable" description={error} />
    );
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

  /** One section's requirement, content and open details: the rail, the header chip and the notes hint all read this. */
  const factsOf = (section: TemplateSection): SectionFacts => ({
    required: section.required,
    populated:
      isSectionPopulated(draft, section.sectionId, confirmedIds) ||
      filledByRecord.has(section.sectionId),
    needsDetails: sectionHasEmptySlots(template, draft, section.sectionId),
  });
  const activeFacts = active ? factsOf(active) : null;
  const activeChip = activeFacts ? sectionChip(activeFacts) : null;
  const activeDraft = active ? draft[active.sectionId] : undefined;
  const activeSelectionCount = activeDraft?.entries.length ?? 0;
  const activeHasFreeText = (activeDraft?.freeText.trim().length ?? 0) > 0;
  const recordPath = `/patients/${encounter.patientId}/encounters/${encounter.id}`;
  // One form, mounted once opened and kept (hidden when not shown): inside the vitals section when the template has one, else above the sections.
  const vitalsForm = vitalsMounted ? (
    <VitalsPanel
      encounterId={encounter.id}
      disabled={frozen || busy}
      headingLevel={vitalsInSection ? 3 : 2}
      onStatusChange={reportVitals}
      onSaved={() => {
        setVitalsOpen(false);
        // Vitals are a source of the draft: the text, its hash and its state are re-read.
        void noteDraft.reload();
        setFeedback({
          tone: "success",
          title: "Vitals recorded",
          message: "Visit vitals were saved.",
        });
        void refreshPreview();
      }}
    />
  ) : null;
  return (
    <PatientWorkspaceLayout banner={<ComposePatientBanner patient={patient} />}>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Compose visit note"
            actions={
              <ComposeHeaderActions
                status={encounter.status}
                busy={busy}
                frozen={frozen}
                saving={operation === "saving"}
                vitalsInSection={vitalsInSection}
                vitalsOpen={vitalsOpen}
                onOpenRecord={() => navigate(recordPath)}
                onVitals={() => {
                  setVitalsMounted(true);
                  if (!vitalsInSection) {
                    setVitalsOpen((v) => !v);
                    return;
                  }
                  // The form is inside the section: take the author to its heading, also when the section is already open.
                  setOpenSection(VITALS_SECTION_ID);
                  focusSectionHeading();
                }}
                onSave={() => void save()}
                onFinalize={() => void finalize()}
              />
            }
          />
        }
        table={
          <main className="wx-encounter-compose" style={page}>
            <ComposeProgressSummary
              completion={completion}
              itemsInCurrentSection={activeSelectionCount + (activeHasFreeText ? 1 : 0)}
            />

            <SaveStateLine
              operation={operation}
              savingPanelCount={savingPanels.length}
              selectionsDirty={selectionsDirty}
              panelsDirty={panelsDirty}
            />

            <FeedbackNotice
              feedback={feedback}
              onOpenCarePlan={() => navigate(`/patients/${encounter.patientId}/care-plan`)}
            />

            <PreviewStaleNotice stale={previewStale} />

            {lateEntry.visible ? (
              <LateEntryReasonCard
                serviceDate={encounter.serviceDate}
                estimate={lateEntry.estimate}
                reason={lateEntry.reason}
                onReasonChange={lateEntry.setReason}
                refusedAndShort={lateEntry.refusedAndShort}
                disabled={busy || frozen}
                onFinalize={() => void finalize()}
                focusRequests={lateEntry.focusRequests}
              />
            ) : null}

            <RequiredDocumentationCard unmet={unmet} lateEntryPending={lateEntry.pending} />

            <ComposerDraftStrip
              noteDraft={noteDraft}
              pending={pending}
              headingOf={headingOfSection}
              onOpenSection={openFromSummary}
              refusal={refusal}
            />

            {vitalsInSection ? null : <div hidden={!vitalsOpen}>{vitalsForm}</div>}

            <div className="wx-encounter-compose-workspace" style={workspace}>
              <SectionRail
                sections={template.sections}
                activeSectionId={active?.sectionId}
                drafted={drafted}
                factsOf={factsOf}
                onOpenSection={setOpenSection}
                editable={editable}
                encounterStatus={encounter.status}
              />

              <section className="wx-encounter-compose-editor" style={editorColumn}>
                {active ? (
                  <div style={editorCard}>
                    <SectionEditorHeader
                      section={active}
                      chip={activeChip}
                      selectionCount={activeSelectionCount}
                      headingRef={sectionHeadingRef}
                    />

                    {panelSection ? (
                      <div className="wx-draft-slot">
                        <DraftSectionPanel
                          key={panelSection.sectionId}
                          section={panelSection}
                          note={noteDraft.notes[panelSection.sectionId] ?? null}
                          busy={noteDraft.busySectionId === panelSection.sectionId}
                          blockedReason={blockedReason}
                          onResolve={(resolution) => resolveSection(panelSection, resolution)}
                          planSection={isDisciplinePlanSection(
                            encounter.discipline,
                            panelSection.sectionId,
                          )}
                        />
                      </div>
                    ) : null}

                    <div style={editorBody}>
                      <RecordedPanels
                        sections={template.sections}
                        activeSectionId={active.sectionId}
                        encounterId={encounter.id}
                        patientId={encounter.patientId}
                        disabled={frozen || busy}
                        onChanged={refreshFromPanel}
                        onStatusChange={reportPanel}
                        onNoConcernsRemoved={reportNoConcernsRemoved}
                        {...noWoundConcerns}
                      />
                      {vitalsInSection ? (
                        <div hidden={active.sectionId !== VITALS_SECTION_ID}>{vitalsForm}</div>
                      ) : null}
                      <PlanNextVisitPanel
                        active={active.sectionId === PLAN_SECTION_ID}
                        encounterId={encounter.id}
                        patientId={encounter.patientId}
                        discipline={encounter.discipline}
                        currentVisitId={encounter.visitId}
                        disabled={frozen || busy}
                        planStepBusy={panelStatus.plan?.saving === true}
                        onAddToNote={(text) => addToFreeText(PLAN_SECTION_ID, text)}
                        onShowPlanOfCare={() => showPanel("plan")}
                        followUpSlot={
                          <PlanReviewPrompts
                            entries={Object.values(draft).flatMap((section) => section.entries)}
                            onOpenPlan={() => showPanel("plan")}
                            disabled={frozen || busy}
                          />
                        }
                      />
                      <StatementMenu
                        section={active}
                        sections={template.sections}
                        draft={draft}
                        disabled={frozen || busy}
                        discipline={encounter.discipline}
                        encounterType={encounter.encounterType}
                        suggestion={suggestion}
                        selectionsDirty={selectionsDirty}
                        reasonIsFall={reasonIsFall}
                        fallLink={{
                          choices: fallChoices,
                          linked: linkedFall,
                          value: fallIncidentId,
                          onChange: setFallIncidentId,
                        }}
                        onChooseOne={chooseOne}
                        onToggleEntry={toggleEntry}
                        onSetSlot={setSlot}
                        onOpenPlan={() => showPanel("plan")}
                      />

                      <FreeTextSection
                        hint={
                          activeFacts
                            ? notesHint({
                                ...activeFacts,
                                hasStatements: active.entries.length > 0,
                                documentedByRecord: filledByRecord.has(active.sectionId),
                              })
                            : null
                        }
                        value={draft[active.sectionId]?.freeText ?? ""}
                        onChange={(value) => setFreeText(active.sectionId, value)}
                        disabled={frozen || busy}
                      />
                    </div>
                  </div>
                ) : null}
              </section>

              <aside className="wx-encounter-compose-preview" style={previewColumn}>
                <NotePreviewCard
                  editing={editing}
                  editInForce={editInForce}
                  editedNarrative={editedNarrative}
                  editStale={editStale}
                  preview={preview}
                  noteText={noteText}
                  editText={editText}
                  onEditTextChange={setEditText}
                  editable={editable}
                  busy={busy}
                  onCancelEdit={() => setEditing(false)}
                  onDiscardEdit={() => void writeEdit(null)}
                  onApplyEdit={() => void writeEdit(editText)}
                  onStartEdit={() => void startEdit()}
                  onSave={() => void save()}
                />

                <ComposerDraftRail
                  encounter={encounter}
                  editable={editable}
                  drafted={drafted}
                  draftReady={noteDraft.load.status === "ready"}
                  carePlanRevision={carePlanRevision}
                  onLinksChanged={() => void noteDraft.reload()}
                />
              </aside>
            </div>

            <div ref={planRegion}>
              <PlanOfCareStep
                encounterId={encounter.id}
                patientId={encounter.patientId}
                disabled={planDisabled}
                onStatusChange={reportPlan}
              />
            </div>
          </main>
        }
      />
      <DiscardChangesModal
        open={blocker.state === "blocked"}
        busy={busy}
        onKeepEditing={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
      />
    </PatientWorkspaceLayout>
  );
}
