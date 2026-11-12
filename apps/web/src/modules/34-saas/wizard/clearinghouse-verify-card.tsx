// apps/web/src/modules/34-saas/wizard — step 7, the connection and the activation. Claim.MD has a safe connection test, so the member runs
// it; Stedi has none, so the member attests what was checked (a note, and a confirmation that it names no patient information). Activation
// is the organization's own administrator's act, and the server refuses it until the connection and the BAA are both verified. Each write
// needs a fresh step-up, carries one Idempotency-Key per intent (a retry after no answer replays under the same key), and voids a
// pending go-live attestation. Results go to the panel's status line: a verified connection takes this card away, and its message with it.
import {
  Button,
  PendingAttestationWarning,
  TextAreaField,
  isAboutAnInput,
  useApiClient,
  useOpsWrite,
} from "@chartwarden/ui";
import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { DRAFT_ACTIONS, draftKeyFor, stashDraft, useRestoredDraft } from "./billing-drafts";
import { BILLING_ERROR_COPY, isViewMoved } from "./billing-errors";
import { BillingFailureNotice } from "./billing-failure-notice";
import { useServerFieldErrors } from "./billing-field-errors";
import type { CardContext } from "./card-context";
import {
  type TenantClearinghouseActions,
  type TenantClearinghouseIdentity,
  type TenantClearinghouseView,
  sameTenantClearinghouseIdentity,
  tenantClearinghouseIdentity,
} from "./clearinghouse-tenant";
import { useGuarded } from "./use-guarded";

const BASE = "/api/v1/tenant/clearinghouse";
const EVIDENCE_MIN = 8;
const EVIDENCE_MAX = 500;
const FIELDS: ReadonlySet<string> = new Set(["evidenceNote"]);

const TEST_PROBLEM: Readonly<Record<string, string>> = {
  credential_rejected:
    "The vendor rejected the credential. Nothing was verified; choose the clearinghouse again with the right credential.",
  unreachable: "The vendor could not be reached. Nothing was verified; try the test again shortly.",
};
const TEST_UNCONFIRMED =
  "The connection test did not report a result this page understands. Nothing was verified; try again, and tell ChartWarden if it keeps happening.";

/** What a finished connection test tells the member: nothing when it passed, else the vendor's problem, else a generic failure. */
function testProblemOf(outcome: string | undefined): string | null {
  if (outcome === "ok") return null;
  return (outcome !== undefined ? TEST_PROBLEM[outcome] : undefined) ?? TEST_UNCONFIRMED;
}

const collapse = (text: string): string => text.trim().replace(/\s+/g, " ");

interface VerifyDraft {
  readonly config: TenantClearinghouseIdentity;
  readonly note: string;
}

export function VerifyCard({
  view,
  ctx,
}: {
  view: TenantClearinghouseView;
  ctx: CardContext;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const { guard, notice } = useGuarded();
  const serverErrors = useServerFieldErrors(write.failure);
  const attesting = view.verifiableBy === "attestation";
  const draftKey = draftKeyFor(ctx.scope, DRAFT_ACTIONS.clearinghouseVerify, ctx.stepKey);
  const config = tenantClearinghouseIdentity(view);
  const candidate = useRestoredDraft<VerifyDraft>(draftKey, ctx.scope.returning);
  const restored = sameTenantClearinghouseIdentity(candidate?.config, config)
    ? candidate
    : undefined;
  const [note, setNote] = useState(restored?.note ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const locked = ctx.lockedFor("verify");
  const headingId = useId();
  const { onBusy } = ctx;
  useEffect(() => {
    onBusy("verify", write.busy);
    return () => onBusy("verify", false);
  }, [onBusy, write.busy]);

  async function verify(): Promise<void> {
    const trimmed = collapse(note);
    if (attesting) {
      if (trimmed.length < EVIDENCE_MIN || trimmed.length > EVIDENCE_MAX) {
        setNoteError(
          `Say what was checked and by whom (${EVIDENCE_MIN} to ${EVIDENCE_MAX} characters, no patient information).`,
        );
        return;
      }
      if (!confirmed) {
        setNoteError("Confirm that your note names no patient information.");
        return;
      }
    }
    setNoteError(null);
    ctx.announce(null);
    const body = attesting
      ? { evidenceNote: trimmed, confirmNoPatientInformation: true as const }
      : {};
    const outcome = await write.run(
      attesting ? `verify:${trimmed}` : "verify:test",
      (key) =>
        client.POST(`${BASE}/verify`, {
          params: {
            header: { "Idempotency-Key": key, "If-Match": String(view.version) },
          },
          body,
        }),
      async (data) => {
        // An attestation runs no vendor test; a connection test that reports nothing is not a pass.
        const problem = attesting ? null : testProblemOf(data?.test?.outcome);
        ctx.announce(
          problem !== null
            ? { tone: "error", text: problem }
            : {
                tone: "success",
                text: attesting ? "The connection was attested." : "The connection test passed.",
              },
          true,
        );
        setNote("");
        setConfirmed(false);
        await ctx.onSettled();
      },
    );
    if (!outcome.ok && isViewMoved(outcome.failure)) await ctx.onMoved();
  }

  const fieldNote = noteError ?? serverErrors.errors.evidenceNote;
  const stray = write.failure && !isAboutAnInput(write.failure, (f) => FIELDS.has(f));
  return (
    <section className="wx-drawer-card" aria-labelledby={headingId}>
      <div className="wx-drawer-card-head">
        <h3 id={headingId}>Connection</h3>
      </div>
      {locked ? <p className="wx-row-sub">Finish or cancel the change above first.</p> : null}
      {locked ? null : <PendingAttestationWarning view={ctx.wizard} audience="tenant" />}
      {attesting ? (
        <form
          className="wx-form-stack"
          aria-label="Verify the connection"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!write.busy && !locked) void guard(verify);
          }}
        >
          <p className="wx-row-sub">
            This vendor has no automatic connection test. Check the connection yourself, then say
            what you checked.
          </p>
          <TextAreaField
            label="What was checked, and by whom"
            hint={`${EVIDENCE_MIN} to ${EVIDENCE_MAX} characters. No patient information.`}
            disabled={locked}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setConfirmed(false); // the confirmation is about THESE words
              setNoteError(null);
              serverErrors.touch("evidenceNote");
            }}
            error={fieldNote}
          />
          <label className="wx-action-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            This note names no patient information
          </label>
          {stray ? (
            <BillingFailureNotice
              failure={write.failure}
              onReverify={() => stashDraft(draftKey, { config, note } satisfies VerifyDraft)}
            />
          ) : null}
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={locked} aria-disabled={write.busy || undefined}>
              Verify the connection
            </Button>
          </div>
        </form>
      ) : (
        <div className="wx-form-stack">
          <p className="wx-row-sub">
            ChartWarden sends a test that carries no patient information to check the vendor accepts
            your credential.
          </p>
          {write.failure ? <BillingFailureNotice failure={write.failure} /> : null}
          <div className="wx-drawer-actions">
            <Button
              disabled={locked}
              aria-disabled={write.busy || undefined}
              onClick={() => {
                if (!write.busy) void guard(verify);
              }}
            >
              Test the connection
            </Button>
          </div>
        </div>
      )}
      {notice}
    </section>
  );
}
