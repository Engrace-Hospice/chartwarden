// UR — the Part 2 / SUD block of the safeguard panel: confirm the detection, or reject it as a false
// positive with a reason. Resolution stays locked until the page the detection is on is showing.
import { Glyph, StatusPill, useApiClient, useEditorFocus } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { SudStatus, Workspace } from "../doclens-api";
import { resolveSud } from "../doclens-api";
import { MIN_REASON, PART2_WITHHELD_MESSAGE } from "../doclens-model";
import { saveSafeguard } from "./review-decision-flow";
import { ReasonForm } from "./review-reason-form";
import { focusEnclosingBlock } from "./review-safeguard-focus";

const REJECT_RETURN = "unified-sud-reject";
const HINT_ID = "unified-sud-hint";
const REFRESH_FAILED = "The safeguard was saved, but the workspace could not be refreshed.";

function summaryLabel(status: SudStatus): string {
  if (status === "confirmed") return "Confirmed";
  return status === "rejected" ? "Rejected" : "No detection";
}

export function SudTask({
  workspace,
  activePage,
  current,
  busy,
  disabled,
  blockedReason,
  onReviewSource,
  onBusy,
  onError,
  onSaved,
}: {
  workspace: Workspace;
  activePage: number | null;
  /** The task the reviewer chose is this block. */
  current: boolean;
  /** A resolution is being saved. */
  busy: boolean;
  /** Resolution cannot be recorded now (read-only, pending, complete, owned by another, source not showing). */
  disabled: boolean;
  /** What unlocks resolution; shown while it is locked. */
  blockedReason: string | null;
  onReviewSource: (page: number) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onSaved: () => Promise<Workspace | null>;
}): JSX.Element {
  const client = useApiClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  useEditorFocus(rejecting, REJECT_RETURN);
  const { sud } = workspace;
  const sudPage = sud.indicators[0]?.page ?? null;

  if (sud.status !== "detected")
    return (
      <div className="wx-unified-safeguard-task">
        <strong>Part 2 / SUD safeguard</strong>
        <StatusPill
          label={summaryLabel(sud.status)}
          tone={sud.status === "confirmed" ? "warning" : "success"}
        />
      </div>
    );

  async function save(outcome: "confirmed" | "rejected", why?: string): Promise<void> {
    if (disabled) return;
    const saved = await saveSafeguard({
      write: () => resolveSud(client, workspace.batch.id, outcome, why),
      refresh: onSaved,
      onBusy,
      onError,
      refreshFailedMessage: REFRESH_FAILED,
    });
    if (!saved) return;
    setRejecting(false);
    setReason("");
  }

  return (
    <fieldset
      className="wx-unified-safeguard-task"
      aria-label="Part 2 / SUD safeguard"
      data-safeguard-block="sud"
      aria-current={current ? "true" : undefined}
      tabIndex={-1}
    >
      <div>
        <strong>Part 2 / SUD safeguard</strong>
        <StatusPill label="Resolution required" tone="critical" />
      </div>
      {sud.contentRedacted ? (
        <p>{PART2_WITHHELD_MESSAGE} An authorized reviewer with a need to know must resolve it.</p>
      ) : (
        <>
          <p>
            Review the protected-content detection before completion. Confirming keeps Part 2
            restrictions; rejecting it as a false positive requires a reason.
          </p>
          {sudPage !== null && activePage !== sudPage ? (
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={(event) => {
                focusEnclosingBlock(event.currentTarget);
                onReviewSource(sudPage);
              }}
            >
              Review source page {sudPage}
            </button>
          ) : null}
          {rejecting ? (
            <ReasonForm
              id="unified-sud-reason"
              label="False-positive reason"
              value={reason}
              minLength={MIN_REASON}
              submitLabel="Reject as false positive"
              busy={busy}
              canSubmit={!disabled && reason.trim().length >= MIN_REASON}
              onChange={setReason}
              onSubmit={() => void save("rejected", reason.trim())}
              onCancel={() => setRejecting(false)}
            />
          ) : (
            <div className="wx-doclens-buttons">
              <button
                type="button"
                className="wx-btn-primary"
                aria-describedby={disabled && blockedReason ? HINT_ID : undefined}
                disabled={disabled}
                onClick={() => void save("confirmed")}
              >
                <Glyph name="shield" size={16} /> Confirm Part 2 safeguard
              </button>
              <button
                type="button"
                className="wx-btn-secondary"
                data-editor-return={REJECT_RETURN}
                aria-describedby={disabled && blockedReason ? HINT_ID : undefined}
                disabled={disabled}
                onClick={() => setRejecting(true)}
              >
                Reject false positive
              </button>
            </div>
          )}
          {disabled && blockedReason ? (
            <p id={HINT_ID} className="wx-row-sub">
              {blockedReason}
            </p>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
