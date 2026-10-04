import {
  ConfirmDialog,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  StatusPill,
  type StatusTone,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — INTAKE.ReviewSideBySide (DocLens, F-237; spec
// docs/design/screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md "Review Workspace"). The human-in-the
// -loop boundary for DocLens: the source page on the left with every extracted value's bounding box laid
// over it, the extracted fields on the right, and nothing reaches the chart until a reviewer has looked at
// each value against the page and the review is completed with an attestation.
//
// THE GATE THIS SCREEN EXISTS FOR — source-view confirmation. A field's Accept / Edit / Reject stay
// disabled until the field is SELECTED (which switches the viewer to its page and scrolls its box into
// view) and the reviewer ticks "I compared this with the source" for THAT field. The decision body's
// `sourceViewConfirmed: true` is a constant in the contract; this is what makes it true rather than a
// formality. Bulk approve only ever covers low-risk fields the reviewer has ticked this way.
//
// What the screen shows before the server enforces it (each is re-checked server-side; ADR-0030):
//   • High-risk fields (medications, allergies…) are per-field only and need an RN-or-above licence —
//     a 403 is rendered as that sentence, not as "forbidden".
//   • A field the stage-5 vision check read differently ("Page reads: …") needs a reason (≥5 chars) to
//     accept AS EXTRACTED (422 VISION_DISAGREEMENT_REASON_REQUIRED). Editing to the page's reading does not.
//     For a LIST field (medications[n], allergies[n]) the check reads every entry visible in the crop and
//     verifies the value is among them, so a mismatch means "not found in the list" and `observedValue` is
//     only the CLOSEST reading — the copy says so ("Closest on page: …") rather than implying a 1:1 read.
//   • A possible 42 CFR Part 2 (SUD) detection must be confirmed or rejected before completion (409
//     SUD_DETECTION_UNRESOLVED); Complete is disabled while it stands.
//   • Only low-risk contact fields are write-back targets ("Updates chart"); everything else is
//     "Evidence only". The completion dialog previews which approved fields should reach the chart, and
//     the result shows what the SERVER committed and excluded — the preview is never presented as fact.
//
// NOT BUILT HERE: the chart-discrepancy drawer and page reclassification (spec "Resolve discrepancy" /
// "Reclassify page") — the workspace read carries no discrepancy rows, and reclassification is a batch
// action. A page under the 0.75 classifier floor is labelled "Needs manual label" so it is not trusted
// silently. Reads GET /api/v1/intake/uploads/:id/workspace; writes via ./doclens-api.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PatientLookupField, ReferralLookupField } from "../../shell/entity-lookups";
import {
  type Candidate,
  type CompleteResult,
  type Workspace,
  type WorkspacePage,
  bulkApprove,
  completeReview,
  decide,
  pageImageUrl,
  releaseReview,
  relinkBatch,
  resolveIdentity,
  resolveSud,
  startReview,
} from "./doclens-api";
import {
  IDENTITY_LABEL,
  MIN_REASON,
  batchStatusLabel,
  bboxPercent,
  bulkEligible,
  clinicalTargetOf,
  codingFlagInfo,
  confidenceBand,
  decisionLabel,
  docTypeLabel,
  exclusionLabel,
  fieldLabel,
  fieldSection,
  identityDetail,
  identityNeedsAnswer,
  needsManualLabel,
  pct,
  sortedCodingFlags,
  sourceLabel,
  updatesChart,
  updatesChartClinical,
} from "./doclens-model";
import { lifecycleTone } from "./lantern";
import "./doclens-review.css";
import { ProspectSummaryPanel } from "./prospect-summary";

type Mode = { id: string; kind: "edit" | "reject" } | null;

const CODING_TONE: Record<"critical" | "warning" | "info", StatusTone> = {
  critical: "error",
  warning: "warning",
  info: "neutral",
};

const CONFIDENCE_TONE: Record<"high" | "medium" | "low", StatusTone> = {
  high: "success",
  medium: "warning",
  low: "error",
};
const RISK: Record<Candidate["riskLevel"], { label: string; tone: StatusTone }> = {
  high: { label: "High risk", tone: "critical" },
  medium: { label: "Medium risk", tone: "warning" },
  low: { label: "Low risk", tone: "neutral" },
};
const DECISION_TONE: Record<string, StatusTone> = {
  approve: "success",
  approve_with_edit: "progress",
  reject: "neutral",
};

/** `medications[0].name` — a list entry, which the vision check verifies against every entry in the crop. */
const isListField = (fieldPath: string): boolean => /\[\d+\]/.test(fieldPath);

/** Is the event target a text entry? (Keyboard shortcuts never fire while typing.) */
const typing = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement &&
  (el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "checkbox") ||
    el.isContentEditable);

export function DocLensReviewWorkspace(): JSX.Element {
  const client = useApiClient();
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewerPage, setViewerPage] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>(null);
  const [editValue, setEditValue] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [acceptReasons, setAcceptReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorRef = useRef<HTMLDivElement | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [relinkOpen, setRelinkOpen] = useState(false);

  const boxRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  /** Load (or silently refresh) the workspace; viewer + selection state survive a refresh. */
  const refresh = useCallback(async (): Promise<void> => {
    if (!batchId) return;
    const r = await client
      .GET("/api/v1/intake/uploads/{id}/workspace", { params: { path: { id: batchId } } })
      .catch(() => null);
    if (!r || r.error || !r.data) {
      setLoadError(
        r?.response?.status === 404
          ? "This intake batch is not available to you."
          : "The review workspace could not be loaded.",
      );
      return;
    }
    const data = r.data;
    setLoadError(null);
    setWs(data);
    setViewerPage((p) => p ?? data.pages[0]?.page ?? data.candidates[0]?.page ?? null);
  }, [client, batchId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const review = ws?.review ?? null;
  const inProgress = review?.status === "in_progress";
  const canDecide = Boolean(inProgress && review?.isMine);
  const lockedByOther = Boolean(inProgress && review && !review.isMine);
  const isComplete = review?.status === "complete" || ws?.batch.status === "writeback_complete";
  const sudStatus = ws?.sud.status ?? "not_detected";
  const identityStatus = ws?.batch.identityStatus ?? null;
  const identityBlocking = identityStatus === "possible" || identityStatus === "mismatch";

  const pages = useMemo(
    () => new Map<number, WorkspacePage>((ws?.pages ?? []).map((p) => [p.page, p])),
    [ws],
  );

  /** Candidates grouped by document type → section, in reading order (page, then top of the box). */
  const groups = useMemo(() => {
    const sorted = [...(ws?.candidates ?? [])].sort(
      (a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
    );
    const out = new Map<string, { title: string; items: Candidate[] }>();
    for (const c of sorted) {
      const key = `${c.documentType}|${fieldSection(c.fieldPath)}`;
      const g = out.get(key) ?? {
        title: `${docTypeLabel(c.documentType)} · ${fieldSection(c.fieldPath)}`,
        items: [],
      };
      g.items.push(c);
      out.set(key, g);
    }
    return [...out.values()];
  }, [ws]);
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selected = ordered.find((c) => c.id === selectedId) ?? null;

  const select = useCallback((c: Candidate, focusRow = false) => {
    setSelectedId(c.id);
    setViewerPage(c.page);
    setMode((m) => (m && m.id === c.id ? m : null));
    setActionError(null);
    if (focusRow) rowRefs.current.get(c.id)?.focus();
  }, []);

  // Selecting a field brings its box (and its row) into view. `viewerPage` re-runs it because a field on
  // another page has no box mounted until the viewer has switched to that page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above — the box mounts on the page switch.
  useEffect(() => {
    if (!selectedId) return;
    for (const el of [boxRefs.current.get(selectedId), rowRefs.current.get(selectedId)]) {
      if (el && typeof el.scrollIntoView === "function")
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selectedId, viewerPage]);

  // The "Not saved" alert sits under the page header, often scrolled out of view from the button that
  // failed (the SUD panel, a field row); bring it into view so a refused action never looks like a no-op.
  useEffect(() => {
    const el = actionErrorRef.current;
    if (actionError && el && typeof el.scrollIntoView === "function")
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [actionError]);

  async function run<T>(
    action: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
  ): Promise<{ value: T } | null> {
    setBusy(true);
    setActionError(null);
    const r = await action();
    setBusy(false);
    if (!r.ok) {
      setActionError(r.message);
      return null;
    }
    return { value: r.value };
  }

  async function submitDecision(
    c: Candidate,
    decision: "approve" | "approve_with_edit" | "reject",
    extra: { editedValue?: string; reason?: string } = {},
  ): Promise<void> {
    if (!review) return;
    const ok = await run(() =>
      decide(client, review.id, {
        candidateId: c.id,
        decision,
        sourceViewConfirmed: true,
        ...(extra.editedValue !== undefined ? { editedValue: extra.editedValue } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      }),
    );
    if (ok === null) return;
    setMode(null);
    setEditValue("");
    setRejectReason("");
    await refresh();
    // Move on to the next undecided field, so a reviewer can work down the list.
    const next = ordered.slice(ordered.indexOf(c) + 1).find((x) => x.decision === null);
    if (next) select(next, true);
  }

  // ── per-field gate state ──
  const gate = (c: Candidate) => {
    const boxVisible = selectedId === c.id && viewerPage === c.page;
    const sourceOk = confirmed.has(c.id);
    const reason = (acceptReasons[c.id] ?? "").trim();
    const needsReason = c.vision.status === "disagreed";
    const reasonOk = !needsReason || reason.length >= MIN_REASON;
    return {
      boxVisible,
      sourceOk,
      needsReason,
      reason,
      canAccept: canDecide && !busy && sourceOk && reasonOk,
      canEdit: canDecide && !busy && sourceOk,
      canReject: canDecide && !busy && sourceOk,
    };
  };

  function accept(c: Candidate): void {
    const g = gate(c);
    if (!g.canAccept) return;
    void submitDecision(c, "approve", g.needsReason ? { reason: g.reason } : {});
  }
  function openEdit(c: Candidate): void {
    if (!gate(c).canEdit) return;
    setMode({ id: c.id, kind: "edit" });
    setEditValue(c.decision?.editedValue ?? c.value ?? "");
  }
  function openReject(c: Candidate): void {
    if (!gate(c).canReject) return;
    setMode({ id: c.id, kind: "reject" });
    setRejectReason("");
  }

  function onListKey(e: KeyboardEvent<HTMLElement>): void {
    if (typing(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = selected ? ordered.indexOf(selected) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next =
        ordered[e.key === "ArrowDown" ? Math.min(ordered.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next) {
        e.preventDefault();
        select(next, true);
      }
      return;
    }
    if (!selected) return;
    const k = e.key.toLowerCase();
    if (k === "a") {
      e.preventDefault();
      accept(selected);
    } else if (k === "e") {
      e.preventDefault();
      openEdit(selected);
    } else if (k === "r") {
      e.preventDefault();
      openReject(selected);
    }
  }

  // ── review lifecycle ──
  async function begin(): Promise<void> {
    const ok = await run(() => startReview(client, batchId));
    if (ok !== null) await refresh();
  }
  async function release(): Promise<void> {
    if (!review) return;
    const ok = await run(() => releaseReview(client, review.id));
    if (ok !== null) await refresh();
  }

  if (loadError && !ws) {
    return (
      <div className="wx-reports">
        <div className="wx-list-state">
          <EmptyState title="Review unavailable" description={loadError} />
          <Link to="/intake" className="wx-btn-secondary">
            Back to intake review
          </Link>
        </div>
      </div>
    );
  }
  if (!ws) {
    return (
      <div className="wx-reports">
        <div className="wx-list-state">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const decidedCount = ws.candidates.filter((c) => c.decision !== null).length;
  const eligible = ws.candidates.filter((c) => bulkEligible(c, confirmed));
  const docTypes = [
    ...new Set(
      (ws.pages.length
        ? ws.pages.map((p) => p.documentType)
        : ws.jobs.map((j) => j.documentType)
      ).filter((v): v is string => Boolean(v)),
    ),
  ];
  const unavailable = ws.jobs.filter(
    (j) => j.status === "awaiting_capability" || j.status === "failed",
  );
  const currentPage = viewerPage !== null ? (pages.get(viewerPage) ?? null) : null;
  const pageNumbers = ws.pages.length
    ? ws.pages.map((p) => p.page)
    : [...new Set(ws.candidates.map((c) => c.page))].sort((a, b) => a - b);

  return (
    <div className="wx-reports wx-doclens">
      <header className="wx-page-head">
        <div>
          <nav aria-label="Breadcrumb" className="wx-row-sub">
            <Link to="/referrals">Referrals</Link> / <Link to="/intake">Intake review</Link> /{" "}
            <Link to={`/intake/${ws.batch.id}`}>Batch details</Link>
          </nav>
          <h1 style={{ fontSize: "1.875rem" }}>
            {ws.batch.patientName ?? (ws.batch.patientId ? "Patient" : "Unassigned intake")}
          </h1>
          <div className="wx-doclens-meta">
            <StatusPill
              label={batchStatusLabel(ws.batch.status)}
              tone={lifecycleTone(ws.batch.status)}
            />
            <span>{docTypes.length ? docTypes.map(docTypeLabel).join(", ") : "Unclassified"}</span>
            <span>·</span>
            <span>{sourceLabel(ws.batch.sourceChannel)}</span>
            <span>·</span>
            <span className="wx-nums">
              {decidedCount} / {ws.candidates.length} fields decided
            </span>
          </div>
        </div>
        <div
          className="wx-page-actions"
          style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
        >
          {!isComplete && !lockedByOther ? (
            <button
              type="button"
              className="wx-btn-secondary"
              disabled={busy}
              onClick={() => setRelinkOpen(true)}
              title="Filed under the wrong patient? Move this document to the right patient or referral"
            >
              <Glyph name="arrow-right" size={16} /> Move document
            </button>
          ) : null}
          {!inProgress && !isComplete ? (
            <button
              type="button"
              className="wx-btn-primary"
              disabled={busy}
              onClick={() => void begin()}
            >
              <Glyph name="play" size={16} /> Start review
            </button>
          ) : null}
          {canDecide ? (
            <>
              <button
                type="button"
                className="wx-btn-secondary"
                disabled={busy}
                onClick={() => void release()}
              >
                Release
              </button>
              <button
                type="button"
                className="wx-btn-secondary"
                disabled={busy || eligible.length === 0}
                onClick={() => setBulkOpen(true)}
                title="Low-risk fields you have ticked as compared with the source, not SUD-tagged and not disputed by the vision check"
              >
                <Glyph name="check" size={16} /> Approve reviewed low-risk ({eligible.length})
              </button>
              <button
                type="button"
                className="wx-btn-primary"
                disabled={busy || sudStatus === "detected" || identityBlocking}
                title={
                  identityBlocking
                    ? "Answer every flagged document (same patient / another patient's) first"
                    : undefined
                }
                onClick={() => setCompleteOpen(true)}
              >
                <Glyph name="file-check" size={16} /> Complete review
              </button>
            </>
          ) : null}
        </div>
      </header>

      {actionError ? (
        <div ref={actionErrorRef}>
          <Alert tone="error" title="Not saved" body={actionError} />
        </div>
      ) : null}
      {lockedByOther ? (
        <Alert
          tone="info"
          title="Another reviewer has this batch open"
          body="You can look, but decisions are locked to the reviewer who started the review until they complete or release it."
        />
      ) : null}
      {!inProgress && !isComplete && ws.candidates.length > 0 ? (
        <Alert
          tone="info"
          title="Review not started"
          body="Start the review to accept, edit or reject fields. Starting locks the batch to you; Release hands it back with your decisions kept."
        />
      ) : null}
      {isComplete ? (
        <Alert
          tone="success"
          title="Review complete"
          body="This batch has been reviewed. Decisions are read-only."
        />
      ) : null}
      {isComplete ? <ProspectSummaryPanel batchId={ws.batch.id} /> : null}
      {unavailable.map((j) => (
        <Alert
          key={j.id}
          tone="warning"
          title={`${j.status === "failed" ? "AI extraction failed" : "AI extraction was unavailable"} for ${
            j.pageFrom === j.pageTo ? `page ${j.pageFrom}` : `pages ${j.pageFrom}–${j.pageTo}`
          }`}
          body={`${docTypeLabel(j.documentType)} — no fields were extracted from ${
            j.pageFrom === j.pageTo ? "this page" : "these pages"
          }. Review them on the source document directly.`}
          details={j.failureReason}
        />
      ))}

      {identityBlocking ? (
        <Alert
          tone="error"
          title={`${(ws.documents ?? []).filter(identityNeedsAnswer).length} document${
            (ws.documents ?? []).filter(identityNeedsAnswer).length === 1 ? "" : "s"
          } in this fax may belong to another patient`}
          body="Compare the name and date of birth on each flagged document (listed below) with this patient. Mark it as this patient's, or as another patient's — its fields are then never written to this chart. If the whole upload is someone else's, use Move document."
        />
      ) : null}
      {ws.batch.recordsRequestConflict ? (
        <Alert
          tone="error"
          title={`This fax carries records-request code ${ws.batch.recordsRequestConflict.code}, which was issued for ${
            ws.batch.recordsRequestConflict.kind === "code_names_another_patient"
              ? "a different patient"
              : "a different referral"
          }`}
          body={
            isComplete
              ? "The fax was filed here and not moved. Check that these records belong to this patient."
              : "It was not moved. Check the name and date of birth on the pages: if these records answer that request, use Move document to file them under its referral (the request then counts as received); if they belong here, review them as usual."
          }
        />
      ) : null}
      {identityStatus === "no_target" ? (
        <Alert
          tone="warning"
          title="This document is not linked to a patient or referral"
          body="Nothing can reach a chart until it is. Use Move document to file it under the right patient or referral; every document is then checked against them."
        />
      ) : null}

      <SudPanel
        status={sudStatus}
        indicatorCount={ws.sud.indicators.length}
        disabled={busy || lockedByOther || isComplete}
        onResolve={async (outcome, reason) => {
          const ok = await run(() => resolveSud(client, batchId, outcome, reason));
          if (ok !== null) await refresh();
          return ok !== null;
        }}
      />

      {ws.documents.length > 1 ? (
        <DocumentList
          documents={ws.documents}
          candidates={ws.candidates}
          currentPage={viewerPage}
          onOpen={(page) => setViewerPage(page)}
          canAnswer={!isComplete && !lockedByOther && !busy}
          onAnswer={async (pageFrom, resolution, reason) => {
            const ok = await run(() =>
              resolveIdentity(client, ws.batch.id, pageFrom, resolution, reason),
            );
            if (ok !== null) await refresh();
            return ok !== null;
          }}
        />
      ) : null}

      <div className="wx-doclens-split">
        {/* ── source page ── */}
        <section className="wx-doclens-viewer" aria-label="Source document">
          {pageNumbers.length > 1 ? (
            <fieldset className="wx-seg wx-seg-compact">
              <legend className="wx-sr-only">Page</legend>
              {pageNumbers.map((n) => {
                const count = ws.candidates.filter((c) => c.page === n).length;
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={viewerPage === n}
                    className={viewerPage === n ? "is-selected" : undefined}
                    onClick={() => setViewerPage(n)}
                  >
                    Page {n}
                    <span className="wx-seg-count wx-nums" aria-label={`${count} fields`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </fieldset>
          ) : null}
          {currentPage ? <PageClassification page={currentPage} /> : null}
          {viewerPage === null ? (
            <div className="wx-list-state">
              <EmptyState
                title="No pages"
                description="This batch has no rendered pages to review."
              />
            </div>
          ) : (
            <PageStage
              batchId={ws.batch.id}
              pageNo={viewerPage}
              page={currentPage}
              candidates={ws.candidates.filter((c) => c.page === viewerPage)}
              sudBoxes={
                sudStatus === "detected" || sudStatus === "confirmed"
                  ? ws.sud.indicators.filter((s) => s.page === viewerPage)
                  : []
              }
              selectedId={selectedId}
              onSelect={(c) => select(c, true)}
              boxRef={(id, el) => {
                if (el) boxRefs.current.set(id, el);
                else boxRefs.current.delete(id);
              }}
            />
          )}
        </section>

        {/* ── extracted fields ── */}
        <section className="wx-doclens-fields" aria-label="Extracted fields" onKeyDown={onListKey}>
          <p className="wx-row-sub" style={{ margin: 0 }}>
            Select a field to see it on the page. ↑/↓ moves between fields; A accepts, E edits, R
            rejects once you have compared the field with the source.
          </p>
          {ordered.length === 0 ? (
            <div className="wx-list-state">
              <EmptyState
                title="No extracted fields"
                description="DocLens has not extracted any fields from this batch."
              />
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.title} className="wx-doclens-group">
                <h2>{g.title}</h2>
                <ul>
                  {g.items.map((c) => {
                    const isSel = c.id === selectedId;
                    const gs = gate(c);
                    return (
                      <li key={c.id} className={isSel ? "is-selected" : undefined}>
                        <button
                          type="button"
                          className="wx-doclens-field"
                          aria-current={isSel ? "true" : undefined}
                          tabIndex={isSel || (!selectedId && c === ordered[0]) ? 0 : -1}
                          ref={(el) => {
                            if (el) rowRefs.current.set(c.id, el);
                            else rowRefs.current.delete(c.id);
                          }}
                          onClick={() => select(c)}
                          title={c.description ?? undefined}
                        >
                          <FieldSummary c={c} sud={sudStatus} />
                        </button>
                        <CodingChecks c={c} />
                        {isSel ? (
                          <FieldActions
                            c={c}
                            gate={gs}
                            canDecide={canDecide}
                            readOnlyNote={
                              isComplete
                                ? "Review complete — decisions are read-only."
                                : lockedByOther
                                  ? "Another reviewer has this batch open — decisions are read-only."
                                  : "Start the review (button at the top of the page) to accept, edit or reject this field."
                            }
                            busy={busy}
                            mode={mode?.id === c.id ? mode.kind : null}
                            editValue={editValue}
                            rejectReason={rejectReason}
                            acceptReason={acceptReasons[c.id] ?? ""}
                            onConfirmSource={(v) =>
                              setConfirmed((prev) => {
                                const next = new Set(prev);
                                if (v) next.add(c.id);
                                else next.delete(c.id);
                                return next;
                              })
                            }
                            onAcceptReason={(v) => setAcceptReasons((p) => ({ ...p, [c.id]: v }))}
                            onEditValue={setEditValue}
                            onRejectReason={setRejectReason}
                            onAccept={() => accept(c)}
                            onOpenEdit={() => openEdit(c)}
                            onOpenReject={() => openReject(c)}
                            onCancel={() => setMode(null)}
                            onSaveEdit={() => {
                              const v = editValue.trim();
                              if (v)
                                void submitDecision(c, "approve_with_edit", { editedValue: v });
                            }}
                            onConfirmReject={() => {
                              const r = rejectReason.trim();
                              if (r.length === 0 || r.length >= MIN_REASON)
                                void submitDecision(c, "reject", r ? { reason: r } : {});
                            }}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>
      </div>

      <ConfirmDialog
        open={bulkOpen}
        title={`Approve ${eligible.length} reviewed low-risk field${eligible.length === 1 ? "" : "s"}?`}
        description={
          <>
            <p style={{ margin: "0 0 0.5rem" }}>
              Each of these was ticked as compared with the source. High-risk, SUD-tagged and
              vision-disputed fields are never bulk-approved.
            </p>
            <ul style={{ margin: 0, paddingLeft: "1.125rem" }}>
              {eligible.map((c) => (
                <li key={c.id}>
                  {fieldLabel(c.fieldPath)}: {c.value ?? "—"}
                </li>
              ))}
            </ul>
          </>
        }
        confirmLabel={`Approve ${eligible.length}`}
        pending={busy}
        onCancel={() => setBulkOpen(false)}
        onConfirm={() => {
          if (!review) return;
          void run(() =>
            bulkApprove(
              client,
              review.id,
              eligible.map((c) => c.id),
            ),
          ).then(async (ok) => {
            setBulkOpen(false);
            if (ok !== null) await refresh();
          });
        }}
      />

      {relinkOpen ? (
        <RelinkDialog
          current={ws.batch.patientName}
          sudLive={ws.sud.status === "detected" || ws.sud.status === "confirmed"}
          onClose={() => setRelinkOpen(false)}
          onMove={async (to, reason) => {
            const r = await relinkBatch(client, ws.batch.id, to, reason);
            if (r.ok) {
              setRelinkOpen(false);
              await refresh();
            }
            return r.ok ? null : r.message;
          }}
        />
      ) : null}
      {completeOpen && review ? (
        <CompleteDialog
          ws={ws}
          onClose={() => {
            setCompleteOpen(false);
            void refresh();
          }}
          onComplete={() => completeReview(client, review.id)}
        />
      ) : null}
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────────────────────────────────

function Alert({
  tone,
  title,
  body,
  details,
}: {
  tone: "error" | "warning" | "info" | "success";
  title: string;
  body: ReactNode;
  details?: string | null;
}): JSX.Element {
  return (
    <div className={`wx-doclens-alert is-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Glyph
        name={tone === "success" ? "check-circle" : tone === "info" ? "info" : "alert"}
        size={18}
      />
      <div style={{ minWidth: 0 }}>
        <strong>{title}</strong>
        <div>{body}</div>
        {details ? (
          <details>
            <summary>Details</summary>
            <code>{details}</code>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function PageClassification({ page }: { page: WorkspacePage }): JSX.Element {
  const manual = needsManualLabel(page);
  return (
    <p className="wx-doclens-classification">
      <span>
        Page {page.page}: <strong>{docTypeLabel(page.documentType)}</strong>
        {page.confidence !== null ? ` · ${pct(page.confidence)} classifier confidence` : ""}
      </span>
      {manual ? <StatusPill label="Needs manual label" tone="warning" glyph="alert" /> : null}
    </p>
  );
}

function PageStage({
  batchId,
  pageNo,
  page,
  candidates,
  sudBoxes,
  selectedId,
  onSelect,
  boxRef,
}: {
  batchId: string;
  pageNo: number;
  page: WorkspacePage | null;
  candidates: Candidate[];
  sudBoxes: Workspace["sud"]["indicators"];
  selectedId: string | null;
  onSelect: (c: Candidate) => void;
  boxRef: (id: string, el: HTMLButtonElement | null) => void;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page gets a fresh image attempt.
  useEffect(() => setFailed(false), [batchId, pageNo]);
  return (
    <div className="wx-doclens-stage">
      <div
        className="wx-doclens-page"
        data-testid="doclens-page"
        style={page ? { aspectRatio: `${page.width} / ${page.height}` } : undefined}
      >
        {failed ? (
          <p className="wx-doclens-page-missing">
            The image for page {pageNo} could not be loaded. Field boxes are still shown in
            position.
          </p>
        ) : (
          <img
            src={pageImageUrl(batchId, pageNo)}
            alt={`Page ${pageNo} of the source document`}
            onError={() => setFailed(true)}
          />
        )}
        {page
          ? sudBoxes.map((s, i) => (
              <span
                key={`${s.ruleId}-${i}`}
                className="wx-doclens-sud-box"
                style={bboxPercent(s.bbox, page)}
                title={`Possible SUD content: ${s.term}`}
                aria-hidden
              />
            ))
          : null}
        {page
          ? candidates.map((c) => {
              const sel = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  type="button"
                  ref={(el) => boxRef(c.id, el)}
                  className={`wx-doclens-box${sel ? " is-selected" : ""}${c.decision ? " is-decided" : ""}`}
                  style={bboxPercent(c.bbox, page)}
                  aria-label={`${fieldLabel(c.fieldPath)} on the page`}
                  aria-pressed={sel}
                  data-candidate-id={c.id}
                  onClick={() => onSelect(c)}
                />
              );
            })
          : null}
      </div>
      {sudBoxes.length > 0 ? (
        <p className="wx-row-sub" style={{ margin: "0.5rem 0 0" }}>
          <span className="wx-doclens-sud-key" aria-hidden /> {sudBoxes.length} possible substance
          use disorder term{sudBoxes.length === 1 ? "" : "s"} outlined on this page.
        </p>
      ) : null}
    </div>
  );
}

/** F-238 — the documents the fax splitter found, with each one's coding issues. Click opens its first page. */
function DocumentList(props: {
  documents: Workspace["documents"];
  candidates: readonly Candidate[];
  currentPage: number | null;
  onOpen: (page: number) => void;
  canAnswer: boolean;
  onAnswer: (
    pageFrom: number,
    resolution: "same_patient" | "other_patient",
    reason: string,
  ) => Promise<boolean>;
}): JSX.Element {
  const issuesOn = (from: number, to: number) => {
    const flags = props.candidates
      .filter((c) => c.page >= from && c.page <= to)
      .flatMap((c) => c.codingFlags.map((f) => codingFlagInfo(f.kind).severity));
    return {
      critical: flags.filter((f) => f === "critical").length,
      warning: flags.filter((f) => f === "warning").length,
    };
  };
  const total = props.candidates.reduce((n, c) => n + c.codingFlags.length, 0);
  return (
    <details className="wx-doclens-docs" open>
      <summary>
        <strong>{props.documents.length} documents in this fax</strong>
        {total > 0 ? (
          <span className="wx-row-sub">
            {" "}
            · {total} coding check{total === 1 ? "" : "s"} on page-printed ICD-10-CM codes
          </span>
        ) : null}
      </summary>
      <table className="wx-table wx-doclens-docs-table">
        <thead>
          <tr>
            <th scope="col">Pages</th>
            <th scope="col">Document</th>
            <th scope="col">Type</th>
            <th scope="col">Dated</th>
            <th scope="col">Coding</th>
            <th scope="col">Patient</th>
          </tr>
        </thead>
        <tbody>
          {props.documents.map((d) => {
            const here =
              props.currentPage !== null &&
              props.currentPage >= d.pageFrom &&
              props.currentPage <= d.pageTo;
            const issues = issuesOn(d.pageFrom, d.pageTo);
            return (
              <tr key={d.pageFrom} aria-current={here ? "true" : undefined}>
                <td className="wx-nums">
                  <button
                    type="button"
                    className="wx-link-button"
                    onClick={() => props.onOpen(d.pageFrom)}
                  >
                    {d.pageFrom === d.pageTo ? `p. ${d.pageFrom}` : `pp. ${d.pageFrom}–${d.pageTo}`}
                  </button>
                </td>
                <td>
                  {d.title ?? <span className="wx-row-sub">Untitled</span>}
                  {d.duplicateOfPage !== null ? (
                    <>
                      {" "}
                      <StatusPill
                        label={`Re-sent copy of p. ${d.duplicateOfPage} — not extracted`}
                        tone="neutral"
                      />
                    </>
                  ) : null}
                </td>
                <td>{docTypeLabel(d.documentType)}</td>
                <td className="wx-nums">{d.date ?? <span className="wx-row-sub">—</span>}</td>
                <td>
                  {issues.critical > 0 ? (
                    <StatusPill label={`${issues.critical} must fix`} tone="error" />
                  ) : null}{" "}
                  {issues.warning > 0 ? (
                    <StatusPill label={`${issues.warning} to check`} tone="warning" />
                  ) : null}
                  {issues.critical + issues.warning === 0 ? (
                    <span className="wx-row-sub">—</span>
                  ) : null}
                </td>
                <td>
                  <IdentityCell doc={d} canAnswer={props.canAnswer} onAnswer={props.onAnswer} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

/** F-238 — does this document belong to this patient? Flagged ones are answered here, with a reason. */
function IdentityCell({
  doc,
  canAnswer,
  onAnswer,
}: {
  doc: Workspace["documents"][number];
  canAnswer: boolean;
  onAnswer: (
    pageFrom: number,
    resolution: "same_patient" | "other_patient",
    reason: string,
  ) => Promise<boolean>;
}): JSX.Element {
  const [answering, setAnswering] = useState<"same_patient" | "other_patient" | null>(null);
  const [reason, setReason] = useState("");
  if (doc.duplicateOfPage !== null) return <span className="wx-row-sub">—</span>;
  if (doc.identity.resolution === "other_patient")
    return <StatusPill label="Another patient's — not written back" tone="error" />;
  if (doc.identity.resolution === "same_patient")
    return <StatusPill label="Same patient (confirmed)" tone="success" />;
  const info = doc.identity.status ? IDENTITY_LABEL[doc.identity.status] : null;
  if (!info) return <span className="wx-row-sub">Not checked</span>;
  const detail = identityDetail(doc.identity.disagreeing);
  return (
    <div className="wx-doclens-identity">
      <StatusPill label={info.label} tone={info.tone} />
      {detail ? <span className="wx-row-sub">{detail}</span> : null}
      {identityNeedsAnswer(doc) && canAnswer ? (
        answering === null ? (
          <span className="wx-doclens-identity-actions">
            <button
              type="button"
              className="wx-link-button"
              onClick={() => setAnswering("same_patient")}
            >
              Same patient
            </button>
            <button
              type="button"
              className="wx-link-button"
              onClick={() => setAnswering("other_patient")}
            >
              Another patient's
            </button>
          </span>
        ) : (
          <form
            className="wx-doclens-identity-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await onAnswer(doc.pageFrom, answering, reason.trim())) {
                setAnswering(null);
                setReason("");
              }
            }}
          >
            <label>
              <span className="wx-sr-only">Reason</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  answering === "same_patient" ? "Why (e.g. married name)" : "Whose it is / why"
                }
                minLength={5}
                maxLength={1000}
                required
              />
            </label>
            <button type="submit" className="wx-btn-primary" disabled={reason.trim().length < 5}>
              {answering === "same_patient" ? "Confirm same patient" : "Mark as another patient's"}
            </button>
            <button type="button" className="wx-link-button" onClick={() => setAnswering(null)}>
              Cancel
            </button>
          </form>
        )
      ) : null}
    </div>
  );
}

/** F-238 — file a misfiled fax under the right patient or referral; every document is then re-checked. */
function RelinkDialog({
  current,
  sudLive,
  onClose,
  onMove,
}: {
  current: string | null;
  sudLive: boolean;
  onClose: () => void;
  onMove: (
    to: { patientId?: string; referralId?: string },
    reason: string,
  ) => Promise<string | null>;
}): JSX.Element {
  const [kind, setKind] = useState<"patient" | "referral">("patient");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = target !== "" && reason.trim().length >= 5 && !pending;
  return (
    <Modal
      open
      onClose={pending ? undefined : onClose}
      ariaLabel="Move document"
      width="34rem"
      accent={t.primary}
    >
      <form
        className="wx-doclens-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const err = await onMove(
            kind === "patient" ? { patientId: target } : { referralId: target },
            reason.trim(),
          );
          setPending(false);
          if (err) setError(err);
        }}
      >
        <h2>Move this document</h2>
        <p>
          Currently filed under <strong>{current ?? "no patient"}</strong>. Moving it re-checks
          every document against the new patient and clears earlier "same patient" answers. The move
          is kept in the batch's history.
        </p>
        {sudLive ? (
          <p className="wx-doclens-relink-sud">
            This document has a substance-use (42 CFR Part 2) detection. Its privacy flag moves with
            it: the new patient's chart is restricted, and the flag is lifted from{" "}
            {current ?? "the current patient"} unless another of their documents still holds it.
          </p>
        ) : null}
        <fieldset className="wx-seg wx-seg-compact">
          <legend className="wx-sr-only">Move to</legend>
          {(["patient", "referral"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              className={kind === k ? "is-selected" : undefined}
              onClick={() => {
                setKind(k);
                setTarget("");
              }}
            >
              {k === "patient" ? "Patient" : "Referral (prospect)"}
            </button>
          ))}
        </fieldset>
        {kind === "patient" ? (
          <PatientLookupField
            label="Patient"
            value={target}
            onChange={(v) => setTarget(v)}
            required
          />
        ) : (
          <ReferralLookupField
            label="Referral"
            value={target}
            onChange={(v) => setTarget(v)}
            hint="Records follow the referral's patient once it is resolved."
            required
          />
        )}
        <label className="wx-field">
          <span>Reason</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            minLength={5}
            maxLength={1000}
            placeholder="e.g. PCP records for this prospect were filed under another patient"
            required
          />
        </label>
        {error ? (
          <p role="alert" className="wx-doclens-error">
            {error}
          </p>
        ) : null}
        <div className="wx-doclens-dialog-actions">
          <button type="button" className="wx-btn-secondary" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="wx-btn-primary" disabled={!ready}>
            {pending ? "Moving…" : "Move document"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** F-238 — the coding checks on one page-scanned code, most severe first. Outside the field's button. */
function CodingChecks({ c }: { c: Candidate }): JSX.Element | null {
  if (c.codingFlags.length === 0) return null;
  return (
    <ul className="wx-doclens-coding" aria-label="Coding checks">
      {sortedCodingFlags(c.codingFlags).map((f) => {
        const info = codingFlagInfo(f.kind);
        return (
          <li key={`${f.kind}:${f.code}`} data-severity={info.severity}>
            <StatusPill label={info.label} tone={CODING_TONE[info.severity]} />
            <span className="wx-doclens-coding-detail">
              {f.detail}
              {f.suggest.length > 0 ? (
                <>
                  {" "}
                  Consider: <span className="wx-nums">{f.suggest.join(", ")}</span>.
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function FieldSummary({ c, sud }: { c: Candidate; sud: Workspace["sud"]["status"] }): JSX.Element {
  const band = confidenceBand(c.confidence);
  const risk = RISK[c.riskLevel];
  const clinical = clinicalTargetOf(c.fieldPath);
  const showsOnChart =
    (c.writebackTarget || (clinical !== null && c.riskLevel === "high")) &&
    !(c.sudDetected && sud !== "rejected");
  return (
    <>
      <span className="wx-doclens-field-head">
        <span className="wx-doclens-field-label">{fieldLabel(c.fieldPath)}</span>
        {c.decision ? (
          <StatusPill
            label={decisionLabel(c.decision.decision)}
            tone={DECISION_TONE[c.decision.decision] ?? "neutral"}
            glyph={c.decision.decision === "reject" ? "x-circle" : "check"}
          />
        ) : null}
      </span>
      {c.description ? <span className="wx-doclens-field-desc">{c.description}</span> : null}
      <span className="wx-doclens-field-value">
        {c.decision?.decision === "approve_with_edit" && c.decision.editedValue !== null ? (
          <>
            {c.decision.editedValue}
            <span className="wx-row-sub"> (extracted: {c.value ?? "—"})</span>
          </>
        ) : (
          (c.value ?? <span className="wx-row-sub">No value extracted</span>)
        )}
      </span>
      <span className="wx-doclens-chips">
        <StatusPill
          label={`${pct(c.confidence)} · ${band} confidence`}
          tone={CONFIDENCE_TONE[band]}
        />
        <StatusPill label={risk.label} tone={risk.tone} />
        {c.vision.status === "verified" ? (
          <StatusPill label="Matches page" tone="success" glyph="eye" />
        ) : c.vision.status === "disagreed" ? (
          <StatusPill
            label={
              isListField(c.fieldPath)
                ? `Not found on page — closest: “${c.vision.observedValue ?? "—"}”`
                : `Page reads: “${c.vision.observedValue ?? "—"}”`
            }
            tone="warning"
            glyph="eye"
          />
        ) : c.vision.status === "unverified" && c.riskLevel !== "low" ? (
          <StatusPill label="Not verified" tone="neutral" glyph="eye-off" />
        ) : null}
        {c.sudDetected ? <StatusPill label="SUD page" tone="critical" glyph="shield" /> : null}
        <span className="wx-doclens-chart">
          <Glyph name={showsOnChart ? "arrow-right" : "lock"} size={13} />
          {!showsOnChart
            ? "Evidence only"
            : clinical === "medication_history"
              ? "Outside med list (to reconcile)"
              : clinical === "allergy"
                ? "Allergy list (unverified)"
                : "Updates chart"}
        </span>
      </span>
    </>
  );
}

function FieldActions(props: {
  c: Candidate;
  gate: {
    boxVisible: boolean;
    sourceOk: boolean;
    needsReason: boolean;
    reason: string;
    canAccept: boolean;
    canEdit: boolean;
    canReject: boolean;
  };
  canDecide: boolean;
  readOnlyNote: string;
  busy: boolean;
  mode: "edit" | "reject" | null;
  editValue: string;
  rejectReason: string;
  acceptReason: string;
  onConfirmSource: (v: boolean) => void;
  onAcceptReason: (v: string) => void;
  onEditValue: (v: string) => void;
  onRejectReason: (v: string) => void;
  onAccept: () => void;
  onOpenEdit: () => void;
  onOpenReject: () => void;
  onCancel: () => void;
  onSaveEdit: () => void;
  onConfirmReject: () => void;
}): JSX.Element {
  const { c, gate: g, mode } = props;
  const id = c.id.slice(0, 8);
  if (!props.canDecide) {
    return (
      <div className="wx-doclens-actions">
        {c.decision?.reason ? (
          <p className="wx-row-sub" style={{ margin: 0 }}>
            Reason: {c.decision.reason}
          </p>
        ) : null}
        <p className="wx-row-sub" style={{ margin: 0 }}>
          {props.readOnlyNote}
        </p>
      </div>
    );
  }
  const rejectLen = props.rejectReason.trim().length;
  return (
    <div className="wx-doclens-actions">
      <label className="wx-doclens-check">
        <input
          type="checkbox"
          checked={g.sourceOk}
          disabled={!g.boxVisible && !g.sourceOk}
          onChange={(e) => props.onConfirmSource(e.target.checked)}
        />
        I compared this with the source
      </label>
      {!g.boxVisible && !g.sourceOk ? (
        <p className="wx-row-sub" style={{ margin: 0 }}>
          Show this field's page to compare it.
        </p>
      ) : null}
      {g.needsReason && mode === null ? (
        <label className="wx-doclens-input">
          <span>
            {isListField(c.fieldPath)
              ? `The vision check did not find this entry in the list on the page (closest reading: “${c.vision.observedValue ?? "—"}”).`
              : `The page reads “${c.vision.observedValue ?? "—"}”.`}{" "}
            To keep the extracted value as it is, say why (at least {MIN_REASON} characters). If the
            value is wrong, use Edit instead — this box is a note, not a correction.
          </span>
          <input
            type="text"
            value={props.acceptReason}
            aria-label="Reason for accepting despite the page reading"
            onChange={(e) => props.onAcceptReason(e.target.value)}
          />
        </label>
      ) : null}
      {mode === "edit" ? (
        <form
          className="wx-doclens-input"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSaveEdit();
          }}
        >
          <label htmlFor={`edit-${id}`}>Corrected value</label>
          <input
            id={`edit-${id}`}
            type="text"
            value={props.editValue}
            // biome-ignore lint/a11y/noAutofocus: the reviewer just asked to edit this value.
            autoFocus
            onChange={(e) => props.onEditValue(e.target.value)}
          />
          <div className="wx-doclens-buttons">
            {c.vision.status === "disagreed" && c.vision.observedValue ? (
              <button
                type="button"
                className="wx-btn-secondary wx-btn-sm"
                onClick={() => props.onEditValue(c.vision.observedValue ?? "")}
              >
                {isListField(c.fieldPath) ? "Use closest reading" : "Use page reading"}
              </button>
            ) : null}
            <button type="button" className="wx-btn-secondary wx-btn-sm" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="wx-btn-primary wx-btn-sm"
              disabled={props.busy || props.editValue.trim().length === 0}
            >
              Save edit
            </button>
          </div>
        </form>
      ) : mode === "reject" ? (
        <form
          className="wx-doclens-input"
          onSubmit={(e) => {
            e.preventDefault();
            props.onConfirmReject();
          }}
        >
          <label htmlFor={`reject-${id}`}>
            Reason (optional, at least {MIN_REASON} characters if given)
          </label>
          <input
            id={`reject-${id}`}
            type="text"
            value={props.rejectReason}
            // biome-ignore lint/a11y/noAutofocus: the reviewer just asked to reject this value.
            autoFocus
            onChange={(e) => props.onRejectReason(e.target.value)}
          />
          <div className="wx-doclens-buttons">
            <button type="button" className="wx-btn-secondary wx-btn-sm" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="wx-btn-primary wx-btn-sm"
              disabled={props.busy || (rejectLen > 0 && rejectLen < MIN_REASON)}
            >
              Reject field
            </button>
          </div>
        </form>
      ) : (
        <div className="wx-doclens-buttons">
          <button
            type="button"
            className="wx-btn-primary wx-btn-sm"
            disabled={!g.canAccept}
            onClick={props.onAccept}
            aria-keyshortcuts="A"
          >
            <Glyph name="check" size={14} /> Accept
          </button>
          <button
            type="button"
            className="wx-btn-secondary wx-btn-sm"
            disabled={!g.canEdit}
            onClick={props.onOpenEdit}
            aria-keyshortcuts="E"
          >
            <Glyph name="pencil" size={14} /> Edit
          </button>
          <button
            type="button"
            className="wx-btn-secondary wx-btn-sm"
            disabled={!g.canReject}
            onClick={props.onOpenReject}
            aria-keyshortcuts="R"
          >
            <Glyph name="x-circle" size={14} /> Reject
          </button>
        </div>
      )}
      {c.riskLevel === "high" ? (
        <p className="wx-row-sub" style={{ margin: 0 }}>
          High-risk field: decided one at a time by an RN, NP, PA or physician.
        </p>
      ) : null}
    </div>
  );
}

function SudPanel({
  status,
  indicatorCount,
  disabled,
  onResolve,
}: {
  status: Workspace["sud"]["status"];
  indicatorCount: number;
  disabled: boolean;
  onResolve: (outcome: "confirmed" | "rejected", reason?: string) => Promise<boolean>;
}): JSX.Element | null {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  if (status === "not_detected") return null;
  if (status === "confirmed")
    return (
      <Alert
        tone="warning"
        title="Substance use disorder flag confirmed"
        body="This document is treated as 42 CFR Part 2 information. Fields from the flagged pages stay off the chart, and a §2.31 consent is required before any disclosure."
      />
    );
  if (status === "rejected")
    return (
      <Alert
        tone="info"
        title="Substance use disorder flag rejected as a false positive"
        body="Fields from the previously flagged pages are eligible for the chart again."
      />
    );
  const len = reason.trim().length;
  return (
    <section className="wx-doclens-sud" aria-labelledby="doclens-sud-title">
      <Glyph name="shield" size={20} />
      <div style={{ minWidth: 0, display: "grid", gap: "0.5rem" }}>
        <strong id="doclens-sud-title">Possible substance use disorder information</strong>
        <p style={{ margin: 0 }}>
          This document may contain substance use disorder information protected by 42 CFR Part 2. A
          provisional privacy flag has been placed on the patient. Confirm or reject it before
          completing the review; a §2.31 consent is required before any disclosure.
        </p>
        {indicatorCount > 0 ? (
          <p className="wx-row-sub" style={{ margin: 0 }}>
            {indicatorCount} matching term{indicatorCount === 1 ? " is" : "s are"} outlined on the
            pages.
          </p>
        ) : null}
        {rejecting ? (
          <form
            className="wx-doclens-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (len >= MIN_REASON)
                void onResolve("rejected", reason.trim()).then((ok) => ok && setRejecting(false));
            }}
          >
            <label htmlFor="doclens-sud-reason">
              Why is this not SUD information? (at least {MIN_REASON} characters, e.g. “Methadone
              prescribed for pain”)
            </label>
            <input
              id="doclens-sud-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="wx-doclens-buttons">
              <button
                type="button"
                className="wx-btn-secondary wx-btn-sm"
                onClick={() => setRejecting(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="wx-btn-primary wx-btn-sm"
                disabled={disabled || len < MIN_REASON}
              >
                Reject flag
              </button>
            </div>
          </form>
        ) : (
          <div className="wx-doclens-buttons">
            <button
              type="button"
              className="wx-btn-primary wx-btn-sm"
              disabled={disabled}
              onClick={() => void onResolve("confirmed")}
            >
              Confirm SUD flag
            </button>
            <button
              type="button"
              className="wx-btn-secondary wx-btn-sm"
              disabled={disabled}
              onClick={() => setRejecting(true)}
            >
              Not SUD (false positive)
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function CompleteDialog({
  ws,
  onClose,
  onComplete,
}: {
  ws: Workspace;
  onClose: () => void;
  onComplete: () => Promise<{ ok: true; value: CompleteResult } | { ok: false; message: string }>;
}): JSX.Element {
  const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const decided = ws.candidates.filter((c) => c.decision !== null).length;
  const toChart = ws.candidates.filter((c) => updatesChart(c, ws.sud.status));
  const toMeds = ws.candidates.filter(
    (c) =>
      updatesChartClinical(c, ws.sud.status) &&
      clinicalTargetOf(c.fieldPath) === "medication_history",
  );
  const toAllergies = ws.candidates.filter(
    (c) => updatesChartClinical(c, ws.sud.status) && clinicalTargetOf(c.fieldPath) === "allergy",
  );
  const label = (path: string): string => fieldLabel(path);
  const lineOf = (c: (typeof ws.candidates)[number]): string =>
    c.decision?.editedValue ?? c.value ?? "—";
  // The demographics planner reports every medication / allergy line as "not a demographics field"; the
  // clinical half (`clinicalWriteback`) is what decided them, so show its outcome instead.
  const demographicExcluded = (result?.writeback?.excluded ?? []).filter(
    (x) => clinicalTargetOf(x.fieldPath) === null,
  );
  const clinicalResult = result?.clinicalWriteback;

  return (
    <Modal
      open
      onClose={pending ? undefined : onClose}
      ariaLabel={result ? "Review complete" : "Complete review"}
      width="34rem"
      accent={t.primary}
    >
      <div className="wx-doclens-dialog">
        {result ? (
          <>
            <h2>Review complete</h2>
            {result.writeback ? (
              <>
                <p>
                  {result.writeback.committedFieldPaths.length
                    ? `${result.writeback.committedFieldPaths.length} field${
                        result.writeback.committedFieldPaths.length === 1 ? " was" : "s were"
                      } sent to the chart as drafts:`
                    : "No fields were sent to the chart."}
                </p>
                {result.writeback.committedFieldPaths.length ? (
                  <ul>
                    {result.writeback.committedFieldPaths.map((p) => (
                      <li key={p}>{label(p)}</li>
                    ))}
                  </ul>
                ) : null}
                {demographicExcluded.length ? (
                  <>
                    <p>Kept off the chart:</p>
                    <ul>
                      {demographicExcluded.map((x) => (
                        <li key={`${x.candidateId}-${x.fieldPath}`}>
                          {label(x.fieldPath)} — {exclusionLabel(x.reason, x.fieldPath)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : (
              <p>The server did not report a chart write-back for this review.</p>
            )}
            {clinicalResult ? (
              <>
                {clinicalResult.medicationHistoryFieldPaths.length ? (
                  <p>
                    {clinicalResult.medicationHistoryFieldPaths.length} medication line
                    {clinicalResult.medicationHistoryFieldPaths.length === 1 ? " was" : "s were"}{" "}
                    added to the patient&apos;s outside medication list for a clinician to
                    reconcile. No medication order was created or changed.
                  </p>
                ) : null}
                {clinicalResult.allergyFieldPaths.length ? (
                  <p>
                    {clinicalResult.allergyFieldPaths.length} allerg
                    {clinicalResult.allergyFieldPaths.length === 1 ? "y was" : "ies were"} added to
                    the allergy list as unverified, pending clinician verification.
                  </p>
                ) : null}
                {clinicalResult.excluded.length ? (
                  <>
                    <p>Medications and allergies kept off the chart:</p>
                    <ul>
                      {clinicalResult.excluded.map((x) => (
                        <li key={`${x.candidateId}-${x.fieldPath}`}>
                          {label(x.fieldPath)} — {exclusionLabel(x.reason, x.fieldPath)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : null}
            <div className="wx-doclens-buttons" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="wx-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Complete review</h2>
            <p className="wx-nums">
              {decided} of {ws.candidates.length} fields decided.
            </p>
            <p>
              {toChart.length
                ? `These approved fields should update the chart (as drafts):`
                : "No approved field is a chart field, so nothing will be written to the chart."}
            </p>
            {toChart.length ? (
              <ul>
                {toChart.map((c) => (
                  <li key={c.id}>
                    {label(c.fieldPath)}: {c.decision?.editedValue ?? c.value ?? "—"}
                  </li>
                ))}
              </ul>
            ) : null}
            {toMeds.length ? (
              <>
                <p>
                  These medication lines go to the outside medication list, for a clinician to
                  reconcile — no medication order is created or changed:
                </p>
                <ul>
                  {toMeds.map((c) => (
                    <li key={c.id}>{lineOf(c)}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {toAllergies.length ? (
              <>
                <p>These allergies go to the allergy list as unverified:</p>
                <ul>
                  {toAllergies.map((c) => (
                    <li key={c.id}>{lineOf(c)}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="wx-row-sub">
              Everything else — rejected and undecided fields, legal name or date of birth, and
              diagnoses — stays as evidence on the source document only. Substance-use treatment
              medications stay off the chart unless the SUD flag was rejected. The server makes the
              final call; you will see exactly what it wrote.
            </p>
            <label className="wx-doclens-check">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />
              I reviewed each accepted field against the source document
            </label>
            {error ? (
              <p role="alert" className="wx-doclens-error">
                {error}
              </p>
            ) : null}
            <div className="wx-doclens-buttons" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="wx-btn-secondary"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="wx-btn-primary"
                disabled={!attested || pending}
                onClick={() => {
                  setPending(true);
                  setError(null);
                  void onComplete().then((r) => {
                    setPending(false);
                    if (r.ok) setResult(r.value);
                    else setError(r.message);
                  });
                }}
              >
                {pending ? "Completing…" : "Complete review"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
