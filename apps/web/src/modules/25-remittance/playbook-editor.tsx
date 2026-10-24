import { Button, SelectField, TextAreaField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the playbook EDITOR (hospice ADR/TPE/QIC PRD milestone 9a-1): one modal that writes a
// new playbook for a denial reason (code kind + code, optionally one MAC) or edits / adds a draft version. The text is the
// organization's own: a SOURCE NOTE is required (where the guidance came from), and a draft is never active until a
// different person publishes it. Nothing here suggests wording or states what a MAC requires. The server owns every
// refusal and its message is shown verbatim; a stale draft (409) is reported and the library reloads.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ActionModal, ButtonRow, ErrorAlert, FormButtons, Hint, PhiNotice } from "./action-ui";
import {
  PLAYBOOK_CODE_KIND_LABEL,
  type PlaybookContentInput,
  type PlaybookCreateInput,
  type PlaybookVersion,
  createDraftVersion,
  createPlaybook,
  saveDraft,
} from "./playbook-api";
import type { WriteResult } from "./remittance-api";

export interface EditorStep {
  readonly key: string;
  readonly text: string;
}

export interface PlaybookEditorTarget {
  /** A new playbook: its key is typed here. */
  readonly kind: "new";
  readonly codeKind?: string;
  readonly code?: string;
  readonly macName?: string;
}
export type PlaybookEditorMode =
  | PlaybookEditorTarget
  /** Add a version to an existing playbook, starting from the text of the latest version. */
  | { readonly kind: "version"; readonly playbookId: string; readonly from: PlaybookVersion | null }
  /** Edit the one draft in place. */
  | { readonly kind: "draft"; readonly draft: PlaybookVersion };

export interface PlaybookEditorProps {
  readonly mode: PlaybookEditorMode;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
  /**
   * The draft changed under the user (HTTP 409 version conflict). The editor STAYS open with what was typed and shows the
   * message; the parent reloads, and because `mode.draft` is read live, the next save uses the rebased row version.
   */
  readonly onConflict?: (message: string) => void;
}

const CODE_KINDS = ["carc", "rarc", "mac_reason"] as const;
const stepKey = (used: readonly EditorStep[]): string => {
  let n = used.length + 1;
  while (used.some((s) => s.key === `step-${n}`)) n += 1;
  return `step-${n}`;
};

const seed = (mode: PlaybookEditorMode): PlaybookVersion | null =>
  mode.kind === "draft" ? mode.draft : mode.kind === "version" ? mode.from : null;

export function PlaybookEditor({
  mode,
  onClose,
  onDone,
  onConflict,
}: PlaybookEditorProps): JSX.Element {
  const client = useApiClient();
  const from = seed(mode);
  const [codeKind, setCodeKind] = useState<string>(
    mode.kind === "new" && mode.codeKind && CODE_KINDS.includes(mode.codeKind as never)
      ? mode.codeKind
      : "carc",
  );
  const [code, setCode] = useState(mode.kind === "new" ? (mode.code ?? "") : "");
  const [macName, setMacName] = useState(mode.kind === "new" ? (mode.macName ?? "") : "");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState(from?.summary ?? "");
  const [sourceNote, setSourceNote] = useState(from?.sourceNote ?? "");
  const [steps, setSteps] = useState<readonly EditorStep[]>(
    from?.steps.length
      ? from.steps.map((s) => ({ key: s.key, text: s.text }))
      : [{ key: "step-1", text: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const filled = steps.filter((s) => s.text.trim() !== "");
  const blockedReason =
    mode.kind === "new" && (code.trim() === "" || title.trim() === "")
      ? "Enter the code and a title."
      : summary.trim() === ""
        ? "Write a short summary."
        : sourceNote.trim() === ""
          ? "Say where this guidance came from (a source note is required)."
          : filled.length === 0
            ? "Add at least one step."
            : null;

  const content = (): PlaybookContentInput => ({
    summary: summary.trim(),
    sourceNote: sourceNote.trim(),
    steps: filled.map((s) => ({ key: s.key, text: s.text.trim() })),
  });

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let res: WriteResult<unknown>;
    let done: string;
    if (mode.kind === "new") {
      const body: PlaybookCreateInput = {
        codeKind: codeKind as PlaybookCreateInput["codeKind"],
        code: code.trim(),
        title: title.trim(),
        ...(macName.trim() ? { macName: macName.trim() } : {}),
        ...content(),
      };
      res = await createPlaybook(client, body);
      done = "Draft saved. Someone other than the author must review and publish it.";
    } else if (mode.kind === "version") {
      res = await createDraftVersion(client, mode.playbookId, content());
      done = "New draft saved. It is not active until someone else publishes it.";
    } else {
      res = await saveDraft(client, mode.draft.id, mode.draft.rowVersion, content());
      done = "Draft updated.";
    }
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok) onDone(done);
    else {
      setError(
        res.code === "VERSION_CONFLICT"
          ? `${res.message} Your text is kept; save again to overwrite the newer draft.`
          : res.message,
      );
      if (res.code === "VERSION_CONFLICT") onConflict?.(res.message);
    }
  }

  const setStepText = (key: string, text: string): void =>
    setSteps((cur) => cur.map((s) => (s.key === key ? { ...s, text } : s)));
  const title0 =
    mode.kind === "new"
      ? "Write a playbook"
      : mode.kind === "version"
        ? "New version"
        : "Edit draft";

  return (
    <ActionModal ariaLabel={title0} onClose={onClose} width="44rem">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && blockedReason === null) void submit();
        }}
      >
        {mode.kind === "new" ? (
          <>
            <SelectField
              label="Reason code type"
              value={codeKind}
              onChange={(e) => setCodeKind(e.target.value)}
              options={CODE_KINDS.map((k) => ({
                value: k,
                label: PLAYBOOK_CODE_KIND_LABEL[k] ?? k,
              }))}
            />
            <TextField
              label="Code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={16}
            />
            <TextField
              label="MAC (optional)"
              value={macName}
              onChange={(e) => setMacName(e.target.value)}
              maxLength={120}
              hint="Leave empty for a playbook that applies to every MAC."
            />
            <TextField
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </>
        ) : null}
        <TextAreaField
          label="Summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={1000}
          rows={3}
        />
        <TextAreaField
          label="Source of this guidance"
          value={sourceNote}
          onChange={(e) => setSourceNote(e.target.value)}
          maxLength={500}
          rows={2}
          hint="Required. Where did this come from (a MAC letter, a webinar, a consultant memo, your own review)?"
        />
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="wx-action-title">Steps</legend>
          {steps.map((s, i) => (
            <div key={s.key} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label={`Step ${i + 1}`}
                  value={s.text}
                  onChange={(e) => setStepText(s.key, e.target.value)}
                  maxLength={500}
                />
              </div>
              <Button
                tone="tertiary"
                size="sm"
                disabled={steps.length === 1}
                aria-label={`Remove step ${i + 1}`}
                onClick={() => setSteps((cur) => cur.filter((x) => x.key !== s.key))}
              >
                Remove
              </Button>
            </div>
          ))}
          <ButtonRow>
            <Button
              tone="secondary"
              size="sm"
              disabled={steps.length >= 30}
              onClick={() => setSteps((cur) => [...cur, { key: stepKey(cur), text: "" }])}
            >
              Add a step
            </Button>
          </ButtonRow>
        </fieldset>
        <PhiNotice />
        <Hint>
          This is saved as a draft. It does not apply to any denial until a different person reviews
          and publishes it.
        </Hint>
        <ErrorAlert message={error} />
        <FormButtons
          submitLabel="Save draft"
          busy={busy}
          blocked={blockedReason !== null}
          blockedReason={blockedReason ?? undefined}
          onSubmit={() => void submit()}
          onCancel={onClose}
          asFormSubmit
        />
      </form>
    </ActionModal>
  );
}
