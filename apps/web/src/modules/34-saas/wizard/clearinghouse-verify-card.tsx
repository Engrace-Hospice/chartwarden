// apps/web/src/modules/34-saas/wizard — step 7, the connection and the activation. Claim.MD has a safe connection test, so the member runs
// it; Stedi has none, so the member attests what was checked (a note, and a confirmation that it names no patient information). Activation
// is the organization's own administrator's act, and the server refuses it until the connection and the BAA are both verified. Each write
// needs a fresh step-up and carries one Idempotency-Key per intent (a retry after no answer replays under the same key).
import {
  Button,
  InlineAlert,
  TextAreaField,
  stashStepUpMemoryDraft,
  useApiClient,
  useOpsWrite,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { BILLING_ERROR_COPY, isAboutAnInput } from "./billing-errors";
import type { TenantClearinghouseActions, TenantClearinghouseView } from "./clearinghouse-tenant";
import { WriteFailureNotice } from "./write-failure";

const BASE = "/api/v1/tenant/clearinghouse";
const DRAFT_KEY = "wizard:clearinghouse_selected:verify";
const EVIDENCE_MIN = 8;
const EVIDENCE_MAX = 500;

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

export function VerifyCard({
  view,
  onSettled,
}: {
  view: TenantClearinghouseView;
  onSettled: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const attesting = view.verifiableBy === "attestation";
  const restored = useStepUpMemoryDraft<{ note: string }>(DRAFT_KEY);
  const [note, setNote] = useState(restored?.note ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState("");

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
    setProblem(null);
    setDone("");
    const body = attesting
      ? { evidenceNote: trimmed, confirmNoPatientInformation: true as const }
      : {};
    await write.run(
      attesting ? `verify:${trimmed}` : "verify:test",
      (key) =>
        client.POST(`${BASE}/verify`, { params: { header: { "Idempotency-Key": key } }, body }),
      async (data) => {
        // An attestation runs no vendor test; a connection test that reports nothing is not a pass.
        const found = attesting ? null : testProblemOf(data?.test?.outcome);
        setProblem(found);
        setDone(
          found !== null
            ? ""
            : attesting
              ? "The connection was attested."
              : "The connection test passed.",
        );
        setNote("");
        setConfirmed(false);
        await onSettled();
      },
    );
  }

  const fieldNote = noteError ?? write.failure?.fieldErrors.evidenceNote;
  return (
    <section className="wx-drawer-card" aria-label="Connection">
      <div className="wx-drawer-card-head">
        <h3>Connection</h3>
      </div>
      {attesting ? (
        <form
          className="wx-form-stack"
          aria-label="Verify the connection"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p className="wx-row-sub">
            This vendor has no automatic connection test. Check the connection yourself, then say
            what you checked.
          </p>
          <TextAreaField
            label="What was checked, and by whom"
            hint={`${EVIDENCE_MIN} to ${EVIDENCE_MAX} characters. No patient information.`}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setConfirmed(false); // the confirmation is about THESE words
            }}
            error={fieldNote}
          />
          <label className="wx-action-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            This note names no patient information
          </label>
          {write.failure && !isAboutAnInput(write.failure) ? (
            <WriteFailureNotice
              failure={write.failure}
              onReverify={() => stashStepUpMemoryDraft(DRAFT_KEY, { note })}
            />
          ) : null}
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={write.busy}>
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
          {write.failure ? <WriteFailureNotice failure={write.failure} /> : null}
          <div className="wx-drawer-actions">
            <Button disabled={write.busy} onClick={() => void verify()}>
              Test the connection
            </Button>
          </div>
        </div>
      )}
      {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
      {done ? <InlineAlert tone="success">{done}</InlineAlert> : null}
    </section>
  );
}

export function ActivateCard({
  view,
  actions,
  onSettled,
  onRefresh,
}: {
  view: TenantClearinghouseView;
  actions: TenantClearinghouseActions;
  onSettled: () => Promise<void>;
  /** Read this step's data again (not the wizard: that read is audited per call). */
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);

  async function activate(): Promise<void> {
    await write.run(
      "activate",
      (key) => client.POST(`${BASE}/activate`, { params: { header: { "Idempotency-Key": key } } }),
      onSettled,
    );
  }

  return (
    <section className="wx-drawer-card" aria-label="Activation">
      <div className="wx-drawer-card-head">
        <h3>Activation</h3>
      </div>
      {view.status === "active" ? (
        <p className="wx-row-sub">The clearinghouse is active.</p>
      ) : actions.canActivate ? (
        <div className="wx-form-stack">
          <p className="wx-row-sub">
            The connection and your vendor BAA are verified. Activating lets claims go out under
            your vendor account.
          </p>
          {write.failure ? <WriteFailureNotice failure={write.failure} /> : null}
          <div className="wx-drawer-actions">
            <Button disabled={write.busy} onClick={() => void activate()}>
              Activate the clearinghouse
            </Button>
          </div>
        </div>
      ) : actions.waitingForBaa ? (
        <div className="wx-form-stack">
          <InlineAlert tone="info">
            Waiting for ChartWarden to verify your vendor BAA. Activation opens once it has, and the
            connection is verified.
          </InlineAlert>
          <div>
            <Button size="sm" tone="secondary" onClick={() => void onRefresh()}>
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <p className="wx-row-sub">
          Activation opens once the connection is verified and ChartWarden has verified your vendor
          BAA.
        </p>
      )}
    </section>
  );
}
