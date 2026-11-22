// apps/web/src/modules/08-encounters — the HearthNote composer (M8 §5.2/§2.6, Track B / ADR-0030; #91).
//
// The server remains the source of truth for:
// - template vocabulary,
// - narrative assembly,
// - finalization eligibility,
// - optimistic concurrency.
//
// This page only improves the authoring experience around that contract.
import { visitPurposeLabel } from "@chartwarden/types";
import {
  Button,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  PatientBanner,
  PatientWorkspaceLayout,
  SelectField,
  StatusPill,
  TextAreaField,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { type BlockerFunction, useBlocker, useNavigate, useParams } from "react-router-dom";
import { type PanelStatus, withPanelStatus } from "../../shell/panel-status";
import { PlanOfCareStep } from "../07-care-plan/change-proposals";
import { type UiFeedback, feedbackFor, transportFeedback } from "./compose-feedback";
import { gateRefusalWords } from "./compose-gate-refusal";
import { humanize } from "./compose-text";
import { ComposerDraftRail, ComposerDraftStrip } from "./composer-draft-chrome";
import {
  STATE_LABEL,
  confirmedSectionIds,
  draftedStateOf,
  isDisciplinePlanSection,
} from "./draft-model";
import { DraftSectionPanel } from "./draft-section-panel";
import {
  attentionCard,
  attentionMark,
  attentionText,
  attentionTitle,
  completionPercent,
  discardActions,
  discardDialog,
  discardText,
  discardTitle,
  editorBody,
  editorCard,
  editorColumn,
  editorDescription,
  editorHeader,
  editorTitle,
  editorTitleRow,
  emptyVocabulary,
  emptyVocabularyText,
  emptyVocabularyTitle,
  entryCard,
  entryCardSelected,
  entryCheckbox,
  entryContent,
  entryGrid,
  entryLabel,
  entryMetaRow,
  entryText,
  eyebrow,
  freeTextHeading,
  freeTextHint,
  freeTextSection,
  freeTextTitle,
  headerActions,
  noticeBox,
  noticeError,
  noticeSuccess,
  noticeTitle,
  optionalBadge,
  page,
  previewActions,
  previewBody,
  previewCard,
  previewColumn,
  previewEmpty,
  previewEmptyText,
  previewEmptyTitle,
  previewFooter,
  previewFooterText,
  previewHeader,
  previewStatus,
  previewText,
  previewTitle,
  progressFill,
  progressTrack,
  railCount,
  railHeader,
  railTitle,
  readOnlyHint,
  readyCard,
  readyMark,
  readyText,
  readyTitle,
  requiredBadge,
  sectionIndex,
  sectionIndexActive,
  sectionIndexComplete,
  sectionNav,
  sectionNavButton,
  sectionNavButtonActive,
  sectionNavCopy,
  sectionNavMeta,
  sectionNavMetaRequired,
  sectionNavTitle,
  sectionNavTitleActive,
  sectionRail,
  selectionCounter,
  slotGrid,
  slotPanel,
  slotPanelTitle,
  staleEditNotice,
  summaryBar,
  summaryDivider,
  summaryMain,
  summaryStat,
  summaryStatLabel,
  summaryStatValue,
  summaryStats,
  summaryTitle,
  summaryTitleRow,
  verbatimBadge,
  workspace,
} from "./encounter-compose-styles";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import {
  type DraftSections,
  type EncounterView,
  FALL_FOLLOWUP_CODE,
  type FallIncidentsView,
  type MenuEntry,
  type SelectionsView,
  type TemplateSection,
  type TemplateView,
  currentNoteText,
  dropUnofferedEntries,
  finalizeEncounter,
  isSectionPopulated,
  isSingleChoice,
  loadFallIncidents,
  loadSelections,
  loadTemplate,
  loadVisitPurpose,
  saveSelections,
  sectionHasEmptySlots,
  sectionsFilledByRecords,
  sectionsNeedingAttention,
  suggestedReasonCode,
  toDraft,
  toSelectionsBody,
} from "./encounters-api";
import { FallLinkField } from "./fall-link-field";
import {
  NOTE_VIEW_UNAVAILABLE_DESCRIPTION,
  NoteViewUnavailable,
  isNoteViewUnavailable,
} from "./note-view-unavailable";
import { type RecordedPanelKind, RecordedPanels } from "./recorded-panels";
import { SlotInput } from "./slot-input";
import { useComposerDraft } from "./use-composer-draft";
import { useFocusRequest } from "./use-focus-request";
import { VitalsPanel } from "./vitals-panel";

interface PatientSummary {
  readonly firstName: string;
  readonly lastName: string;
  readonly mrn: string;
  readonly dob?: string;
}

const SHELL_EXIT_PATHS = new Set(["/expired", "/error", "/maintenance", "/tenant-unavailable"]);
const isShellExit = (pathname: string): boolean =>
  SHELL_EXIT_PATHS.has(pathname) || pathname === "/login" || pathname.startsWith("/login/");

const serializedDraft = (draft: DraftSections, fallIncidentId: string | null): string =>
  JSON.stringify(toSelectionsBody(draft, fallIncidentId));

/** The note's own words for a part of it that keeps its own form (named in the notice that asks the author to save or discard it). */
const PANEL_ORDER: readonly PanelKey[] = ["adl", "nutrition", "wounds", "vitals", "plan"];

function unsavedPanelsFeedback(titles: readonly string[]): UiFeedback {
  return {
    tone: "warning",
    title: "Unsaved entries in a section",
    message: `Save or discard the unsaved entries in ${titles.join(", ")} before finalizing.`,
    tag: "findings-unsaved",
  };
}

/** What was taken out of a stored draft because the template cannot show it and the server would refuse it. */
function removedFromDraftFeedback(statements: number, details: number): UiFeedback {
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  const parts = [
    statements > 0
      ? `${statements} saved ${plural(statements, "statement is", "statements are")} no longer offered in ${plural(statements, "its", "their")} section and ${plural(statements, "was", "were")} removed here.`
      : null,
    details > 0
      ? `${details} saved ${plural(details, "detail does", "details do")} not belong to ${plural(details, "its", "their")} statement and ${plural(details, "was", "were")} removed here.`
      : null,
  ].filter((part): part is string => part !== null);
  return {
    tone: "warning",
    title:
      statements > 0 ? "Statements removed from this draft" : "Details removed from this draft",
    message: `${parts.join(" ")} Save the draft to apply the change.`,
  };
}

/** The template section a visit reason is recorded in. */
const REASON_SECTION_ID = "chief_concern";

/** The parts of the note that keep their own form and say so (see `useReportPanelStatus`). */
type PanelKey = RecordedPanelKind | "vitals" | "plan";
type PanelStatuses = Readonly<Partial<Record<PanelKey, PanelStatus>>>;

/**
 * The recorded panels whose saved record the draft compiler states (`describeRecordedAdl`, for the aide's `adl` section); the others are not.
 * Keyed by panel, not by template: on a note whose template drafts nothing from the ADLs the re-read is harmless (it reads no source).
 * Keep it in step with the compiler (a drift note sits beside `describeRecordedAdl` in `compile.ts`).
 */
const DRAFT_SOURCE_PANELS: ReadonlySet<RecordedPanelKind> = new Set<RecordedPanelKind>(["adl"]);
const NO_SECTIONS: ReadonlySet<string> = new Set();

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
  const [operation, setOperation] = useState<"saving" | "finalizing" | null>(null);
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
  const [suggestion, setSuggestion] = useState<{ code: string; from: string } | null>(null);
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

  // A note that came from the schedule suggests the reason its visit purpose implies (a routine visit, an MSW or
  // chaplain assessment). Only into an empty Reason for Visit, and only as an unsaved choice: the clinician
  // confirms it by saving, or picks another.
  useEffect(() => {
    const visitId = encounter?.visitId;
    const reasonSection = template?.sections.find((s) => s.sectionId === REASON_SECTION_ID);
    if (encounter?.status !== "draft" || !visitId || reasonSection === undefined) return;
    let current = true;
    void loadVisitPurpose(client, visitId).then((purpose) => {
      if (!current || purpose === null) return;
      const code = suggestedReasonCode(purpose, reasonSection.entries);
      if (code === null) return;
      setDraft((prev) => {
        const held = prev[REASON_SECTION_ID];
        if (held !== undefined && (held.entries.length > 0 || held.freeText.trim() !== "")) {
          return prev;
        }
        setSuggestion({ code, from: visitPurposeLabel(purpose) ?? purpose });
        return {
          ...prev,
          [REASON_SECTION_ID]: { freeText: held?.freeText ?? "", entries: [{ code, params: {} }] },
        };
      });
    });
    return () => {
      current = false;
    };
  }, [client, encounter, template]);

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

  // The server counts a saved ADL or nutrition record as documenting the section that states it, so the panels' saved records do too.
  const adlRecorded = panelStatus.adl?.recorded === true;
  const nutritionRecorded = panelStatus.nutrition?.recorded === true;
  const filledByRecord = useMemo(
    () =>
      template
        ? sectionsFilledByRecords(template, { adl: adlRecorded, nutrition: nutritionRecorded })
        : NO_SECTIONS,
    [template, adlRecorded, nutritionRecorded],
  );

  const editable = encounter?.status === "draft" && encounter.id === encounterId;
  // While the author is typing over the note text, the selections and the save and finalize buttons wait: the text is a copy of
  // the note as it reads, so changing what it was made from underneath it would leave the two disagreeing.
  const frozen = !editable || editing;
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
  /** Bring a part of the note into view (its section opened, the vitals shown, the plan scrolled to) so its unsaved entries can be dealt with. */
  function showPanel(key: PanelKey): void {
    if (key === "vitals") {
      setVitalsMounted(true);
      setVitalsOpen(true);
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
  const shouldBlock = useCallback<BlockerFunction>(
    ({ nextLocation }) => (dirty || busy) && !isShellExit(nextLocation.pathname),
    [busy, dirty],
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

  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, dirty]);

  // The notice that asked for the panels to be saved or discarded goes once they are.
  useEffect(() => {
    if (!panelsDirty) setFeedback((held) => (held?.tag === "findings-unsaved" ? null : held));
  }, [panelsDirty]);

  const completion = useMemo(() => {
    if (!template) {
      return {
        completed: 0,
        total: 0,
        requiredRemaining: 0,
        percent: 0,
      };
    }

    const completed = template.sections.filter(
      (section) =>
        (isSectionPopulated(draft, section.sectionId, confirmedIds) ||
          filledByRecord.has(section.sectionId)) &&
        !sectionHasEmptySlots(template, draft, section.sectionId),
    ).length;

    const total = template.sections.length;

    return {
      completed,
      total,
      requiredRemaining: unmet.length,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }, [draft, template, filledByRecord, confirmedIds, unmet.length]);

  function toggleEntry(sectionId: string, entry: MenuEntry): void {
    // Statements sharing an exclusive group contradict each other and the server refuses two in one note,
    // so picking one replaces its sibling wherever in the note that sibling was recorded.
    const rivals = new Set(
      entry.exclusiveGroup === null
        ? []
        : (template?.sections ?? []).flatMap((s) =>
            s.entries
              .filter((e) => e.exclusiveGroup === entry.exclusiveGroup && e.code !== entry.code)
              .map((e) => e.code),
          ),
    );

    setDraft((prev) => {
      const current = prev[sectionId] ?? { entries: [], freeText: "" };
      if (current.entries.some((e) => e.code === entry.code)) {
        return {
          ...prev,
          [sectionId]: {
            ...current,
            entries: current.entries.filter((e) => e.code !== entry.code),
          },
        };
      }

      const cleared: DraftSections = Object.fromEntries(
        Object.entries(prev).map(([id, section]) => [
          id,
          { ...section, entries: section.entries.filter((e) => !rivals.has(e.code)) },
        ]),
      );
      const base = cleared[sectionId] ?? current;
      return {
        ...cleared,
        [sectionId]: { ...base, entries: [...base.entries, { code: entry.code, params: {} }] },
      };
    });
  }

  /** A single-choice section's select: pick one (replacing any other) or `""` to clear it. */
  function chooseOne(section: TemplateSection, code: string): void {
    const held = draft[section.sectionId]?.entries[0]?.code;
    if (code === held) return;
    // toggleEntry swaps a rival out and unticks a held one, which is exactly pick-and-clear.
    const entry = section.entries.find((e) => e.code === (code === "" ? held : code));
    if (entry !== undefined) toggleEntry(section.sectionId, entry);
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

  /** The stored note, or null when it could not be read (a refusal or a dropped connection). */
  const readStored = useCallback(async (): Promise<SelectionsView | null> => {
    if (!encounterId) return null;
    try {
      return await loadSelections(client, encounterId);
    } catch {
      return null;
    }
  }, [client, encounterId]);

  const headingOfSection = (sectionId: string): string =>
    template?.sections.find((section) => section.sectionId === sectionId)?.heading ??
    humanize(sectionId);

  const openFromSummary = (sectionId: string): void => {
    setOpenSection(sectionId);
    focusSectionHeading();
  };

  /** What the server holds for the note's text: the generated preview and the author's edit of it, if any. */
  const applyStored = useCallback((stored: SelectionsView): void => {
    setPreview(stored.layer1Preview);
    setEditedNarrative(stored.editedNarrative ?? null);
    setEditStale(stored.editedNarrativeStale === true);
    setPreviewStale(false);
  }, []);

  /**
   * Re-read the server-assembled note without touching the author's working draft. Vitals are recorded
   * apart from the selections and the note states them, so the preview is stale the moment they save. The
   * preview shows what is stored; unsaved edits still need a save, exactly as before.
   */
  const refreshPreview = useCallback(async (): Promise<void> => {
    // The load this read belongs to (another note, or a reload, starts a newer one) and the read itself (a newer read or a save puts
    // newer text on screen): an answer for an older one must not overwrite it.
    const sequence = loadSequence.current;
    const read = ++previewRead.current;
    const stored = await readStored();
    if (sequence !== loadSequence.current || read !== previewRead.current) return;
    if (stored === null) {
      setPreviewStale(true);
      return;
    }
    applyStored(stored);
  }, [applyStored, readStored]);
  // The panels' "something they state was saved": stable, so the memoised panels are not re-rendered by a keystroke in the free text.
  // A saved ADL record is a source of the draft (the aide's recorded ADLs lead the drafted `adl` section), so the draft is re-read too:
  // the text, its hash and its state must be the ones the author is about to confirm. The nutrition and wound records are not a source of
  // any drafted section, so saving them re-reads the preview alone (a draft read is a full recompute and a patient-attributed audit row).
  const reloadDraft = noteDraft.reload;
  const refreshFromPanel = useCallback(
    (panel: RecordedPanelKind): void => {
      void refreshPreview();
      if (DRAFT_SOURCE_PANELS.has(panel)) void reloadDraft();
    },
    [refreshPreview, reloadDraft],
  );

  /** Edit the note text. Unsaved selections are saved first, so the text being edited is the note as it now reads. */
  async function startEdit(): Promise<void> {
    if (!encounterId) return;
    if (selectionsDirty && !(await save())) return;
    const stored = await readStored();
    if (!stored) {
      setFeedback(transportFeedback);
      return;
    }
    previewRead.current += 1;
    applyStored(stored);
    setEditText(currentNoteText(stored));
    setEditing(true);
  }

  /** Apply (text) or discard (null) the author's edit of the note text, then show the note as the server now holds it. */
  async function writeEdit(next: string | null): Promise<void> {
    if (!encounterId) return;
    setOperation("saving");
    setFeedback(null);
    try {
      const res = await saveSelections(
        client,
        encounterId,
        version,
        toSelectionsBody(draft, effectiveFallId, next),
      );
      if (!res.ok) {
        setFeedback(feedbackFor(res));
        return;
      }
      setVersion(res.value.version);
      setLastSavedDraft(currentDraft);
      setEditing(false);
      await refreshPreview();
      setFeedback({
        tone: "success",
        title: next === null ? "Edit discarded" : "Note text updated",
        message:
          next === null
            ? "The note reads as generated from your selections."
            : "Your edited text is what will be signed. The generated text is kept beside it.",
      });
    } catch {
      setFeedback(transportFeedback);
    } finally {
      setOperation(null);
    }
  }

  async function save(): Promise<boolean> {
    if (!encounterId) return false;

    setOperation("saving");
    setFeedback(null);

    try {
      const res = await saveSelections(
        client,
        encounterId,
        version,
        toSelectionsBody(draft, effectiveFallId),
      );

      if (!res.ok) {
        setFeedback(feedbackFor(res));
        return false;
      }

      setVersion(res.value.version);
      setPreview(res.value.layer1Preview);
      previewRead.current += 1;
      setPreviewStale(false);
      setLastSavedDraft(currentDraft);
      // A save changes the clinician's own words inside a drafted section, so its text, hash and state are re-read.
      void noteDraft.reload();
      // A saved edit may have gone stale under what was just saved; the server decides.
      if (editedNarrative !== null) await refreshPreview();
      setFeedback({
        tone: "success",
        title: "Draft saved",
        message: "Your visit note changes were saved.",
      });
      return true;
    } catch {
      setFeedback(transportFeedback);
      return false;
    } finally {
      setOperation(null);
    }
  }

  async function finalize(): Promise<void> {
    if (!encounterId) return;
    // Finalizing reloads the note, which would drop what a panel holds unsaved: say so instead of losing it silently.
    if (dirtyPanels.length > 0) {
      setFeedback(unsavedPanelsFeedback(dirtyPanels.map(panelTitle)));
      showPanel(dirtyPanels[0] as PanelKey);
      return;
    }

    setOperation("finalizing");
    setFeedback(null);
    let finalizationAttempted = false;

    try {
      const saved = await saveSelections(
        client,
        encounterId,
        version,
        toSelectionsBody(draft, effectiveFallId),
      );

      if (!saved.ok) {
        setFeedback(feedbackFor(saved));
        return;
      }

      setVersion(saved.value.version);
      setPreview(saved.value.layer1Preview);
      previewRead.current += 1;
      setPreviewStale(false);
      setLastSavedDraft(currentDraft);

      finalizationAttempted = true;
      const res = await finalizeEncounter(client, encounterId);

      if (!res.ok) {
        // The save changed what the draft is built from and the gate may have named drafted sections: one re-read shows what the
        // server holds now. (A finalize that succeeds reloads the whole note below, and the draft with it.)
        void noteDraft.reload();
        const gate = gateRefusalWords(res.details, headingOfSection);
        if (gate) {
          // The gate named drafted sections: say which and why, beside the draft strip.
          refuse(gate.refusal);
          setFeedback(gate.feedback);
          return;
        }
        setFeedback(feedbackFor(res));
        return;
      }

      setFeedback({
        tone: "success",
        title: "Note finalized",
        message: "Sign it from the encounter record.",
      });
      const reloaded = await load();
      if (!reloaded) {
        setError(
          "The note was finalized, but the updated record could not be reloaded. Return to the encounter record or refresh before continuing.",
        );
      }
    } catch {
      if (!finalizationAttempted) {
        setFeedback(transportFeedback);
        return;
      }

      const reconciled = await load();
      if (!reconciled) {
        setError(
          "Finalization status could not be confirmed. Return to the encounter record or refresh before continuing.",
        );
      } else if (reconciled.status === "draft") {
        setFeedback({
          tone: "warning",
          title: "Finalization not completed",
          message: "Your draft was saved, but finalization was not completed. You can try again.",
        });
      } else {
        setFeedback({
          tone: "success",
          title: "Note finalized",
          message: "The server confirmed finalization after the connection was interrupted.",
        });
      }
    } finally {
      setOperation(null);
    }
  }

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
                  onClick={() => {
                    setVitalsMounted(true);
                    setVitalsOpen((v) => !v);
                  }}
                  disabled={frozen || busy}
                >
                  {vitalsOpen ? "Close vitals" : "Vitals"}
                </Button>

                <Button tone="tertiary" onClick={() => void save()} disabled={busy || frozen}>
                  {operation === "saving" ? "Saving…" : "Save draft"}
                </Button>

                <Button onClick={() => void finalize()} disabled={busy || frozen}>
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
                  : savingPanels.length > 0
                    ? "Saving a section…"
                    : selectionsDirty
                      ? "Unsaved changes"
                      : panelsDirty
                        ? "Unsaved entries in a section. Use that section's own Save button."
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

            {previewStale ? (
              <output style={{ ...noticeBox, ...noticeError }}>
                <strong style={noticeTitle}>Note preview not refreshed</strong>
                <span>
                  Your change was saved, but the note could not be read again, so the preview may be
                  out of date. Use Save &amp; refresh preview to read it.
                </span>
              </output>
            ) : null}

            {unmet.length > 0 ? (
              <section style={attentionCard} aria-label="Required documentation">
                <div style={attentionMark} aria-hidden>
                  !
                </div>

                <div style={{ minWidth: 0 }}>
                  <strong style={attentionTitle}>
                    {unmet.length} {unmet.length === 1 ? "section needs" : "sections need"}{" "}
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

            <ComposerDraftStrip
              noteDraft={noteDraft}
              pending={pending}
              headingOf={headingOfSection}
              onOpenSection={openFromSummary}
              refusal={refusal}
            />

            <div hidden={!vitalsOpen}>
              {vitalsMounted ? (
                <VitalsPanel
                  encounterId={encounter.id}
                  disabled={frozen || busy}
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
              ) : null}
            </div>

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
                    const needsDetails = sectionHasEmptySlots(template, draft, section.sectionId);
                    // "Documented" means finalize will take it: a statement with an empty slot is not that.
                    const filled =
                      (isSectionPopulated(draft, section.sectionId, confirmedIds) ||
                        filledByRecord.has(section.sectionId)) &&
                      !needsDetails;
                    const isActive = section.sectionId === active?.sectionId;
                    const needsAttention = needsDetails || (section.required && !filled);
                    const sectionState = filled
                      ? "Documented"
                      : needsDetails
                        ? "Needs details"
                        : needsAttention
                          ? "Required"
                          : "Not started";
                    const draftedState = draftedStateOf(drafted, section.sectionId);

                    return (
                      <button
                        key={section.sectionId}
                        type="button"
                        onClick={() => setOpenSection(section.sectionId)}
                        aria-current={isActive ? "step" : undefined}
                        aria-label={`${section.heading}: ${sectionState}${
                          draftedState ? `, draft ${STATE_LABEL[draftedState].toLowerCase()}` : ""
                        }`}
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
                              ...(needsAttention ? sectionNavMetaRequired : null),
                            }}
                          >
                            {sectionState}
                          </span>
                          {draftedState ? (
                            <span style={sectionNavMeta}>Draft: {STATE_LABEL[draftedState]}</span>
                          ) : null}
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
                          <h2 ref={sectionHeadingRef} tabIndex={-1} style={editorTitle}>
                            {active.heading}
                          </h2>
                          {active.required ? (
                            <span className="wx-encounter-required-badge" style={requiredBadge}>
                              Required
                            </span>
                          ) : (
                            <span style={optionalBadge}>Optional</span>
                          )}
                        </div>
                        <p style={editorDescription}>
                          {isSingleChoice(active.entries)
                            ? "Choose one. Anything the choice cannot say goes in the notes below, stored verbatim."
                            : active.entries.length === 0
                              ? "This section has no preset statements. Write it in the free-text field below; it is stored verbatim."
                              : "Select the statements that describe this visit. Additional free text is stored verbatim."}
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
                      />
                      {active.entries.length === 0 && active.recordedPanel ? null : active.entries
                          .length === 0 ? (
                        <div style={emptyVocabulary}>
                          <strong style={emptyVocabularyTitle}>
                            No preset statements for this section
                          </strong>
                          <p style={emptyVocabularyText}>
                            Add the documentation for this {humanize(encounter.discipline)}{" "}
                            {humanize(encounter.encounterType)} in the free-text field below.
                          </p>
                        </div>
                      ) : isSingleChoice(active.entries) ? (
                        <>
                          <SelectField
                            label={active.heading}
                            value={draft[active.sectionId]?.entries[0]?.code ?? ""}
                            disabled={frozen || busy}
                            onChange={(e) => chooseOne(active, e.target.value)}
                            options={[
                              { value: "", label: "Select…" },
                              ...active.entries.map((e) => ({ value: e.code, label: e.label })),
                            ]}
                          />
                          {active.sectionId === REASON_SECTION_ID &&
                          suggestion !== null &&
                          selectionsDirty &&
                          draft[active.sectionId]?.entries[0]?.code === suggestion.code ? (
                            <p style={freeTextHint}>
                              Suggested from the scheduled visit ({suggestion.from}). Save to keep
                              it, or choose another.
                            </p>
                          ) : null}
                          {active.sectionId === REASON_SECTION_ID && reasonIsFall ? (
                            <FallLinkField
                              choices={fallChoices}
                              linked={linkedFall}
                              value={fallIncidentId}
                              disabled={frozen || busy}
                              onChange={setFallIncidentId}
                            />
                          ) : null}
                        </>
                      ) : (
                        <div style={entryGrid}>
                          {active.entries.map((entry) => {
                            const picked = draft[active.sectionId]?.entries.find(
                              (e) => e.code === entry.code,
                            );
                            const selected = picked !== undefined;
                            // One statement, one place: a statement already recorded in another section
                            // is locked here so the note cannot carry it twice with different values.
                            const elsewhere = selected
                              ? undefined
                              : template?.sections.find(
                                  (s) =>
                                    s.sectionId !== active.sectionId &&
                                    draft[s.sectionId]?.entries.some((e) => e.code === entry.code),
                                );

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
                                    disabled={frozen || busy || elsewhere !== undefined}
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

                                    {elsewhere ? (
                                      <span style={entryMetaRow}>
                                        Already recorded in {elsewhere.heading}
                                      </span>
                                    ) : null}
                                  </span>
                                </label>

                                {picked && entry.slots.length > 0 ? (
                                  <div style={slotPanel}>
                                    <div style={slotPanelTitle}>Complete selected details</div>

                                    <div style={slotGrid}>
                                      {entry.slots.map((slot) => (
                                        <SlotInput
                                          key={slot}
                                          slot={slot}
                                          spec={entry.slotSpecs[slot]}
                                          value={String(picked.params[slot] ?? "")}
                                          onChange={(value) =>
                                            setSlot(active.sectionId, entry.code, slot, value)
                                          }
                                          disabled={frozen || busy}
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
                              {active.entries.length > 0
                                ? "Optional. Enter only information not already represented by the selected statements."
                                : filledByRecord.has(active.sectionId)
                                  ? "Optional. The saved record above documents this section; add notes only for what it does not cover."
                                  : active.required
                                    ? "Required. This section has no preset statements; document it here in your own words."
                                    : "Optional."}
                            </p>
                          </div>
                          <span style={verbatimBadge}>Recorded verbatim</span>
                        </div>

                        <TextAreaField
                          label="Additional notes"
                          value={draft[active.sectionId]?.freeText ?? ""}
                          onChange={(e) => setFreeText(active.sectionId, e.target.value)}
                          rows={5}
                          disabled={frozen || busy}
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
                      {editing
                        ? "Editing"
                        : editInForce
                          ? "Edited by you"
                          : editedNarrative !== null
                            ? "Edit out of date"
                            : preview.trim().length > 0
                              ? "Available"
                              : "Not saved"}
                    </span>
                  </header>

                  {editedNarrative !== null && editStale && !editing ? (
                    <div role="alert" style={staleEditNotice}>
                      <strong>The note changed after you edited this text.</strong> Below is the
                      note as it now reads; your earlier edit is not used. Edit it again to keep
                      your wording, or discard the old edit. The note cannot be finalized until you
                      do.
                      <details>
                        <summary>Your earlier edit</summary>
                        <p style={previewText}>{editedNarrative}</p>
                      </details>
                    </div>
                  ) : null}

                  <div style={previewBody}>
                    {editing ? (
                      <TextAreaField
                        label="Note text"
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={14}
                        disabled={busy}
                      />
                    ) : noteText.trim().length === 0 ? (
                      <div style={previewEmpty}>
                        <strong style={previewEmptyTitle}>No assembled narrative yet</strong>
                        <p style={previewEmptyText}>
                          Save the draft to generate the server-built narrative from your
                          selections.
                        </p>
                      </div>
                    ) : (
                      <p style={previewText}>{noteText}</p>
                    )}
                  </div>

                  {editable ? (
                    <footer style={previewFooter}>
                      <span style={previewFooterText}>
                        {editing
                          ? "Your text is what will be signed; the generated text is kept beside it."
                          : editInForce
                            ? "Your edited text will be signed."
                            : editedNarrative !== null
                              ? "Apply a new edit or discard the old one to finalize."
                              : "Preview updates after saving."}
                      </span>
                      <span style={previewActions}>
                        {editing ? (
                          <>
                            <Button
                              tone="tertiary"
                              onClick={() => setEditing(false)}
                              disabled={busy}
                            >
                              Cancel
                            </Button>
                            {editedNarrative !== null ? (
                              <Button
                                tone="tertiary"
                                onClick={() => void writeEdit(null)}
                                disabled={busy}
                              >
                                Discard edit
                              </Button>
                            ) : null}
                            <Button
                              onClick={() => void writeEdit(editText)}
                              disabled={busy || editText.trim().length === 0}
                            >
                              {busy ? "Saving…" : "Apply edit"}
                            </Button>
                          </>
                        ) : (
                          <>
                            {editedNarrative !== null ? (
                              <Button
                                tone="tertiary"
                                onClick={() => void writeEdit(null)}
                                disabled={busy}
                              >
                                Discard edit
                              </Button>
                            ) : null}
                            <Button
                              tone="tertiary"
                              onClick={() => void startEdit()}
                              disabled={busy}
                            >
                              Edit
                            </Button>
                            <Button tone="tertiary" onClick={() => void save()} disabled={busy}>
                              {busy ? "Saving…" : "Save & refresh preview"}
                            </Button>
                          </>
                        )}
                      </span>
                    </footer>
                  ) : null}
                </section>

                <ComposerDraftRail
                  encounter={encounter}
                  editable={editable}
                  drafted={drafted}
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
