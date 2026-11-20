// apps/web/src/modules/08-encounters — the addenda panel on the encounter detail screen (GAP-027).
//
// An addendum is the post-signature correction path (M8 D2): its own selections, finalize and signature.
// The screen could open one and nothing more. This lists each addendum with its SERVER status and the
// author (read-only), and offers exactly the next step that status allows:
//   draft      → Edit draft (selection composer) · Finalize
//   finalized  → Sign (attestation ceremony)
//   signed     → nothing; it is part of the legal record
// Actions are enabled by that returned status, never by a client-side role guess: whether THIS caller
// may act (author-only, GAP-028; step-up, D13; the Layer-3 gate) is the server's answer, and a refusal
// is shown verbatim — including STEP_UP_REQUIRED, which links to the real /step-up screen.
import {
  Button,
  CeremonyModal,
  EmptyState,
  Modal,
  StatusPill,
  TextAreaField,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { type BlockerFunction, Link, useBlocker } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  findStepUpDraftResourceId,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import {
  type AddendumResult,
  type AddendumRow,
  finalizeAddendum,
  loadAddendumSelections,
  saveAddendumSelections,
  signAddendum,
} from "./addenda-api";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import {
  type DraftSections,
  type TemplateView,
  loadTemplate,
  toDraft,
  toSelectionsBody,
  unmetRequiredSections,
} from "./encounters-api";
import { ProposedFromMessage } from "./proposed-from-message";
import { SlotInput } from "./slot-input";
import { authFailureRedirect } from "./write-workflow";

type Failure = Extract<AddendumResult<unknown>, { ok: false }>;

interface PanelProps {
  readonly encounterId: string;
  readonly addenda: readonly AddendumRow[];
  /** Re-read the encounter after any state change so statuses come from the server again. */
  readonly onChanged: () => void;
}

/** A refusal rendered as user-facing prose; step-up gets the real ceremony link. */
function FailureAlert({ failure }: { failure: Failure }): JSX.Element {
  const path = `${window.location.pathname}${window.location.search}`;
  const stepUp = authFailureRedirect(
    failure.status ?? undefined,
    failure.code ?? undefined,
    path,
    failure.message,
  );
  const redirect = stepUp ?? (failure.status === 401 ? "/login" : null);
  return (
    <div role="alert" style={alertBox}>
      <span>{failure.message}</span>
      {redirect ? (
        <Link to={redirect} style={alertLink}>
          {failure.status === 401 ? "Sign in again" : "Re-authenticate"}
        </Link>
      ) : null}
    </div>
  );
}

const ADDENDUM_DRAFT_ACTION = "m8-addendum";
const STEP_UP_CODE = "STEP_UP_REQUIRED";
const SHELL_EXIT_PATHS = new Set(["/expired", "/error", "/maintenance", "/tenant-unavailable"]);
const isShellExit = (pathname: string): boolean =>
  SHELL_EXIT_PATHS.has(pathname) || pathname === "/login" || pathname.startsWith("/login/");

const transportFailure: Failure = {
  ok: false,
  status: null,
  code: null,
  message: "The connection was interrupted. Your changes are still here; try again.",
};

export function AddendaPanel({ encounterId, addenda, onChanged }: PanelProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  // Coming back from /step-up: reopen the editor whose unsaved selections were stashed.
  const [editingId, setEditingId] = useState<string | null>(() => {
    const stashed = findStepUpDraftResourceId(session, ADDENDUM_DRAFT_ACTION);
    return addenda.some((a) => a.id === stashed && a.status === "draft") ? stashed : null;
  });
  const [signingId, setSigningId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ addendumId: string; error: Failure } | null>(null);

  async function finalize(addendumId: string): Promise<void> {
    setBusyId(addendumId);
    setFailure(null);
    const res = await finalizeAddendum(client, { encounterId, addendumId });
    setBusyId(null);
    if (!res.ok) return setFailure({ addendumId, error: res });
    onChanged();
  }

  async function sign(addendumId: string): Promise<void> {
    setBusyId(addendumId);
    setFailure(null);
    const res = await signAddendum(client, { encounterId, addendumId });
    setBusyId(null);
    setSigningId(null);
    if (!res.ok) return setFailure({ addendumId, error: res });
    onChanged();
  }

  const signing = addenda.find((a) => a.id === signingId) ?? null;

  return (
    <div style={shell}>
      <ProposedFromMessage encounterId={encounterId} onChanged={onChanged} />
      {addenda.length === 0 ? (
        <EmptyState title="No addenda" description="Corrections to this signed note appear here." />
      ) : (
        <ul style={list}>
          {addenda.map((a) => (
            <li key={a.id} style={item} aria-label={`Addendum ${a.id}`}>
              <StackedRows
                rows={[
                  {
                    label: "Status",
                    value: (
                      <StatusPill
                        label={stateLabel(a.status)}
                        tone={ENCOUNTER_TONE[a.status] ?? "neutral"}
                      />
                    ),
                  },
                  {
                    label: "Author (membership)",
                    value: <span style={mono}>{a.authoredByUserId}</span>,
                  },
                  { label: "Reason", value: a.reason },
                  { label: "Opened", value: shortStamp(a.createdAt) },
                  ...(a.signedAt ? [{ label: "Signed", value: shortStamp(a.signedAt) }] : []),
                ]}
              />
              {a.status !== "signed" ? (
                <div style={actions}>
                  {a.status === "draft" ? (
                    <>
                      {editingId !== a.id ? (
                        <Button
                          tone="secondary"
                          size="sm"
                          disabled={busyId === a.id || editingId !== null}
                          onClick={() => setEditingId(a.id)}
                        >
                          Edit draft
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        disabled={busyId === a.id || editingId === a.id}
                        onClick={() => void finalize(a.id)}
                      >
                        {busyId === a.id ? "Working…" : "Finalize addendum"}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => {
                        setFailure(null);
                        setSigningId(a.id);
                      }}
                    >
                      Sign addendum
                    </Button>
                  )}
                </div>
              ) : null}
              {failure?.addendumId === a.id ? <FailureAlert failure={failure.error} /> : null}
              {editingId === a.id && a.status === "draft" ? (
                <AddendumEditor
                  encounterId={encounterId}
                  addendumId={a.id}
                  onClose={() => {
                    clearStepUpDraft(stepUpDraftKey(session, ADDENDUM_DRAFT_ACTION, a.id));
                    setEditingId(null);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <CeremonyModal
        open={signing !== null}
        title="Sign addendum"
        attestation={
          <div style={stack}>
            <strong>Sign addendum</strong>
            <span style={metaText}>{signing?.reason}</span>
            {failure && failure.addendumId === signingId ? (
              <FailureAlert failure={failure.error} />
            ) : null}
          </div>
        }
        legalText="I attest this addendum is complete and accurate to the best of my knowledge."
        signer={{ name: "Signing clinician", role: "This session" }}
        commitLabel={busyId === signingId && signingId ? "Signing…" : "Sign & commit"}
        onCommit={() => signingId && void sign(signingId)}
        onCancel={() => setSigningId(null)}
      />
    </div>
  );
}

// Same "YYYY-MM-DD HH:mm" form the Sign-off card uses (UTC wall time from the server string).
function shortStamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

interface StackedRow {
  readonly label: string;
  readonly value: ReactNode;
}

// Label above value: the rail is too narrow for a two-column grid (ids and timestamps wrapped).
function StackedRows({ rows }: { readonly rows: readonly StackedRow[] }): JSX.Element {
  return (
    <dl style={rowsList}>
      {rows.map((r) => (
        <div key={r.label} style={rowItem}>
          <dt style={rowLabel}>{r.label}</dt>
          <dd style={rowValue}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface EditorProps {
  readonly encounterId: string;
  readonly addendumId: string;
  readonly onClose: () => void;
}

/** Selection composer for one draft addendum — the parent's template menu, the addendum's own tree. */
function AddendumEditor({ encounterId, addendumId, onClose }: EditorProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const draftKey = stepUpDraftKey(session, ADDENDUM_DRAFT_ACTION, addendumId);
  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [draft, setDraft] = useState<DraftSections>({});
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState("");
  const [loadError, setLoadError] = useState<Failure | null>(null);
  const [saveError, setSaveError] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
  const shouldBlock = useCallback<BlockerFunction>(
    ({ nextLocation }) => (dirty || saving) && !isShellExit(nextLocation.pathname),
    [dirty, saving],
  );
  const blocker = useBlocker(shouldBlock);

  const load = useCallback(async () => {
    const [tpl, sel] = await Promise.all([
      loadTemplate(client, encounterId),
      loadAddendumSelections(client, { encounterId, addendumId }),
    ]);
    if (!sel.ok) return setLoadError(sel);
    if (!tpl) {
      return setLoadError({
        ok: false,
        status: null,
        code: null,
        message: "The note template could not be loaded.",
      });
    }
    setTemplate(tpl);
    // Unsaved edits stashed before a step-up round trip win over the (older) saved tree; the version
    // stays the server's, so the save still carries a correct If-Match.
    const stashed = peekStepUpDraft<DraftSections>(draftKey);
    setDraft(stashed ?? toDraft(sel.value.sections));
    setDirty(stashed !== null);
    setVersion(sel.value.version);
    setPreview(sel.value.layer1Preview);
  }, [client, encounterId, addendumId, draftKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  function toggle(sectionId: string, code: string): void {
    setSaved(false);
    setDirty(true);
    setDraft((cur) => {
      const sec = cur[sectionId] ?? { entries: [], freeText: "" };
      const has = sec.entries.some((e) => e.code === code);
      const entries = has
        ? sec.entries.filter((e) => e.code !== code)
        : [...sec.entries, { code, params: {} }];
      return { ...cur, [sectionId]: { ...sec, entries } };
    });
  }

  function setSlot(sectionId: string, code: string, slot: string, value: string): void {
    setSaved(false);
    setDirty(true);
    setDraft((cur) => {
      const sec = cur[sectionId];
      if (!sec) return cur;
      const entries = sec.entries.map((e) =>
        e.code === code ? { ...e, params: { ...e.params, [slot]: value } } : e,
      );
      return { ...cur, [sectionId]: { ...sec, entries } };
    });
  }

  function setFreeText(sectionId: string, freeText: string): void {
    setSaved(false);
    setDirty(true);
    setDraft((cur) => ({
      ...cur,
      [sectionId]: { entries: cur[sectionId]?.entries ?? [], freeText },
    }));
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await saveAddendumSelections(
        client,
        { encounterId, addendumId },
        version,
        toSelectionsBody(draft),
      );
      if (!res.ok) {
        if (res.code === STEP_UP_CODE) stashStepUpDraft(draftKey, draft);
        return setSaveError(res);
      }
      clearStepUpDraft(draftKey);
      setVersion(res.value.version);
      setPreview(res.value.layer1Preview);
      setDirty(false);
      setSaved(true);
    } catch {
      setSaveError(transportFailure);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <FailureAlert failure={loadError} />;
  if (!template) return <p style={metaText}>Loading addendum…</p>;

  const unmet = unmetRequiredSections(template, draft);

  return (
    <div style={editor} aria-label="Addendum editor">
      {template.sections.map((section) => {
        const sec = draft[section.sectionId];
        return (
          <fieldset key={section.sectionId} style={fieldset}>
            <legend style={legend}>
              {section.heading}
              {section.required ? " (required)" : ""}
            </legend>
            {section.entries.map((entry) => {
              const picked = sec?.entries.find((e) => e.code === entry.code);
              const id = `${addendumId}-${section.sectionId}-${entry.code}`;
              return (
                <div key={entry.code}>
                  <label htmlFor={id} style={checkLabel}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={Boolean(picked)}
                      disabled={saving}
                      onChange={() => toggle(section.sectionId, entry.code)}
                    />
                    {entry.label}
                  </label>
                  {picked
                    ? entry.slots.map((slot) => (
                        <SlotInput
                          key={slot}
                          slot={slot}
                          spec={entry.slotSpecs[slot]}
                          label={`${entry.label} — ${entry.slotSpecs[slot]?.label ?? slot}`}
                          value={String(picked.params[slot] ?? "")}
                          disabled={saving}
                          onChange={(value) => setSlot(section.sectionId, entry.code, slot, value)}
                        />
                      ))
                    : null}
                </div>
              );
            })}
            <TextAreaField
              label={`${section.heading} — additional notes`}
              style={{ minHeight: "4rem" }}
              value={sec?.freeText ?? ""}
              disabled={saving}
              onChange={(ev) => setFreeText(section.sectionId, ev.target.value)}
            />
          </fieldset>
        );
      })}
      {unmet.length > 0 ? (
        <p style={metaText}>Required before finalizing: {unmet.join(", ")}</p>
      ) : null}
      {preview ? (
        <div>
          <strong style={metaText}>Narrative preview</strong>
          <p style={reasonText}>{preview}</p>
        </div>
      ) : null}
      {saveError ? <FailureAlert failure={saveError} /> : null}
      {saving ? <output style={metaText}>Saving addendum changes…</output> : null}
      {!saving && dirty ? <output style={metaText}>Unsaved addendum changes</output> : null}
      {!saving && saved ? <output style={metaText}>Addendum changes saved</output> : null}
      <div style={actions}>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
        <Button
          size="sm"
          tone="secondary"
          disabled={saving}
          onClick={() => {
            if (dirty || saving) setCloseRequested(true);
            else onClose();
          }}
        >
          Close editor
        </Button>
      </div>
      <Modal
        open={blocker.state === "blocked" || closeRequested}
        role="alertdialog"
        ariaLabel="Leave addendum without saving?"
        dismissOnScrim={false}
      >
        <div style={discardDialog}>
          <h2 style={discardTitle}>Leave addendum without saving?</h2>
          <p style={discardText}>
            {saving
              ? "Your addendum is being saved. Wait for the operation to finish before leaving."
              : "Your addendum changes have not been saved. Keep editing or discard them before leaving."}
          </p>
          <footer style={discardActions}>
            <Button
              tone="tertiary"
              onClick={() => {
                setCloseRequested(false);
                blocker.reset?.();
              }}
            >
              Keep editing addendum
            </Button>
            {!saving ? (
              <Button
                onClick={() => {
                  clearStepUpDraft(draftKey);
                  if (closeRequested) onClose();
                  else blocker.proceed?.();
                }}
              >
                Discard addendum changes
              </Button>
            ) : null}
          </footer>
        </div>
      </Modal>
    </div>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.5rem" };
const shell: CSSProperties = { display: "flex", flexDirection: "column" };
const rowsList: CSSProperties = { margin: 0, display: "grid", rowGap: "0.55rem" };
const rowItem: CSSProperties = { display: "grid", rowGap: "0.1rem" };
const rowLabel: CSSProperties = { fontSize: "0.72rem", color: t.onSurfaceVariant };
const rowValue: CSSProperties = {
  margin: 0,
  fontSize: "0.85rem",
  color: t.onSurface,
  overflowWrap: "anywhere",
};
const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
// Flat rows split by a hairline — no card inside the rail card.
const item: CSSProperties = {
  ...stack,
  gap: "0.6rem",
  padding: "0.85rem 0",
  borderTop: `1px solid ${t.outlineVariant}`,
};
const metaText: CSSProperties = { margin: 0, fontSize: "0.72rem", color: t.onSurfaceVariant };
const mono: CSSProperties = { fontFamily: t.fontMono };
const reasonText: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.onSurface };
const actions: CSSProperties = { display: "flex", gap: "0.5rem", flexWrap: "wrap" };
// Flat inline alert: a token-coloured rule on the left, no tinted box.
const alertBox: CSSProperties = {
  ...stack,
  gap: "0.3rem",
  paddingLeft: "0.7rem",
  borderLeft: `3px solid ${t.error}`,
  color: t.error,
  fontSize: "0.78rem",
};
const alertLink: CSSProperties = { color: t.primary, fontWeight: 650 };
const editor: CSSProperties = { ...stack, gap: "0.75rem" };
const fieldset: CSSProperties = {
  ...stack,
  border: "none",
  borderTop: `1px solid ${t.outlineVariant}`,
  margin: 0,
  padding: "0.75rem 0 0",
};
const legend: CSSProperties = { fontSize: "0.78rem", fontWeight: 650, color: t.onSurface };
const checkLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  fontSize: "0.8rem",
  color: t.onSurface,
};
const discardDialog: CSSProperties = { ...stack, gap: "1rem", padding: "1.25rem" };
const discardTitle: CSSProperties = { margin: 0, color: t.onSurface, fontSize: "1.15rem" };
const discardText: CSSProperties = { margin: 0, color: t.onSurfaceVariant, lineHeight: 1.5 };
const discardActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  flexWrap: "wrap",
};
