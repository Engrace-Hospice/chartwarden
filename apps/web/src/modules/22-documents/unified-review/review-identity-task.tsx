// UR — one document's patient-identity block of the safeguard panel: the reviewer answers "same
// patient" or "another patient" with a reason, once the page it is on is showing.
import { StatusPill, useApiClient, useEditorFocus } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { IdentityResolution, Workspace } from "../doclens-api";
import { resolveIdentity } from "../doclens-api";
import { MIN_REASON } from "../doclens-model";
import { saveSafeguard } from "./review-decision-flow";
import { ReasonForm } from "./review-reason-form";
import { focusEnclosingBlock, safeguardBlockId } from "./review-safeguard-focus";

const REFRESH_FAILED =
  "The identity resolution was saved, but the workspace could not be refreshed.";

const PLACEHOLDER: Record<IdentityResolution, string> = {
  same_patient: "Why the identifiers are consistent",
  other_patient: "Why this belongs to another patient",
};

export function IdentityTask({
  workspace,
  pageFrom,
  title,
  showingSource,
  current,
  busy,
  disabled,
  blockedReason,
  onReviewSource,
  onError,
  onBusy,
  onSaved,
}: {
  workspace: Workspace;
  pageFrom: number;
  title: string;
  /** The source page of this document is the one on screen, so "Review source page" is not offered. */
  showingSource: boolean;
  /** The task the reviewer chose is this block. */
  current: boolean;
  /** A resolution is being saved. */
  busy: boolean;
  disabled: boolean;
  /** What unlocks resolution; shown while it is locked. */
  blockedReason: string | null;
  onReviewSource: () => void;
  onError: (error: string | null) => void;
  onBusy: (busy: boolean) => void;
  onSaved: () => Promise<Workspace | null>;
}): JSX.Element {
  const client = useApiClient();
  const [resolution, setResolution] = useState<IdentityResolution | null>(null);
  const [reason, setReason] = useState("");
  const lastChoice = useRef<IdentityResolution>("same_patient");
  const returnName = (choice: IdentityResolution): string =>
    `unified-identity-${pageFrom}-${choice}`;
  // Closing the form hands focus back to the button that opened it, even though that button unmounted.
  useEditorFocus(resolution !== null, returnName(lastChoice.current));
  const hintId = `unified-identity-hint-${pageFrom}`;
  const describedBy = disabled && blockedReason ? hintId : undefined;

  const choose = (choice: IdentityResolution): void => {
    lastChoice.current = choice;
    setResolution(choice);
  };

  async function submit(): Promise<void> {
    if (disabled || !resolution || reason.trim().length < MIN_REASON) return;
    const saved = await saveSafeguard({
      write: () => resolveIdentity(client, workspace.batch.id, pageFrom, resolution, reason.trim()),
      refresh: onSaved,
      onBusy,
      onError,
      refreshFailedMessage: REFRESH_FAILED,
    });
    if (!saved) return;
    setResolution(null);
    setReason("");
  }

  return (
    <fieldset
      className="wx-unified-safeguard-task"
      aria-label={`Patient identity · ${title}`}
      data-safeguard-block={safeguardBlockId({ kind: "identity", page: pageFrom })}
      aria-current={current ? "true" : undefined}
      tabIndex={-1}
    >
      <div>
        <strong>Patient identity · {title}</strong>
        <StatusPill label="Identity review required" tone="critical" />
      </div>
      {!showingSource ? (
        <button
          type="button"
          className="wx-btn-secondary"
          onClick={(event) => {
            focusEnclosingBlock(event.currentTarget);
            onReviewSource();
          }}
        >
          Review source page {pageFrom}
        </button>
      ) : null}
      {resolution ? (
        <ReasonForm
          id={`identity-reason-${pageFrom}`}
          label="Reason"
          value={reason}
          placeholder={PLACEHOLDER[resolution]}
          minLength={MIN_REASON}
          submitLabel="Save identity resolution"
          busy={busy}
          canSubmit={!disabled && reason.trim().length >= MIN_REASON}
          onChange={setReason}
          onSubmit={() => void submit()}
          onCancel={() => setResolution(null)}
        />
      ) : (
        <div className="wx-doclens-buttons">
          <button
            type="button"
            className="wx-btn-primary"
            data-editor-return={returnName("same_patient")}
            aria-describedby={describedBy}
            disabled={disabled}
            onClick={() => choose("same_patient")}
          >
            Same patient
          </button>
          <button
            type="button"
            className="wx-btn-secondary"
            data-editor-return={returnName("other_patient")}
            aria-describedby={describedBy}
            disabled={disabled}
            onClick={() => choose("other_patient")}
          >
            Another patient
          </button>
        </div>
      )}
      {disabled && blockedReason ? (
        <p id={hintId} className="wx-row-sub">
          {blockedReason}
        </p>
      ) : null}
    </fieldset>
  );
}
