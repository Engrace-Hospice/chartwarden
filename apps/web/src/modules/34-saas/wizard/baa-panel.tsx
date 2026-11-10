// apps/web/src/modules/34-saas/wizard — step 3, BAA: the business associate agreement between ChartWarden and your organization.
// ChartWarden records it; your compliance officer attests it here (POST /api/v1/tenant/baa/:id/attest, a fresh step-up). The facts are
// the server's own go-live checks in your words: executed, attested, and more than 90 days left.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  LoadingSpinner,
  stashStepUpMemoryDraft,
  useApiClient,
  useLoad,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { FailureNotice } from "./failure-notice";
import type { StepPanelProps } from "./panel-props";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";
import { WIZARD_ERROR_COPY } from "./wizard-errors";
import { ROLE_COMPLIANCE_OFFICER } from "./wizard-model";

type BaaPage = operations["getApiV1TenantBaa"]["responses"][200]["content"]["application/json"];
type BaaRecord = BaaPage["items"][number];

/** The go-live guard: an executed BAA must have more than this many days left. */
const MIN_DAYS_LEFT = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT_KEY = "wizard:baa_executed:attest";

/** The record go-live judges: the newest one. */
const latestOf = (items: readonly BaaRecord[]): BaaRecord | null =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

function baaFacts(record: BaaRecord | null, now: Date): Fact[] {
  const daysLeft =
    record?.expiresOn == null
      ? null
      : Math.floor((new Date(record.expiresOn).getTime() - now.getTime()) / DAY_MS);
  return [
    {
      key: "recorded",
      label: "ChartWarden has recorded your BAA",
      state: record ? "ok" : "pending",
    },
    {
      key: "executed",
      label: "The BAA is executed",
      state: record?.baaStatus === "executed" ? "ok" : "pending",
    },
    {
      key: "attested",
      label: "Your compliance officer has attested it",
      state: record?.attestedAt ? "ok" : "pending",
    },
    {
      key: "days",
      label: `It has more than ${MIN_DAYS_LEFT} days left`,
      state:
        record?.baaStatus === "executed" && (daysLeft === null || daysLeft > MIN_DAYS_LEFT)
          ? "ok"
          : "pending",
    },
  ];
}

function BaaRecordFacts({ record }: { record: BaaRecord }): JSX.Element {
  return (
    <dl className="wx-kv">
      <dt>Status</dt>
      <dd>{record.baaStatus}</dd>
      <dt>Addendum version</dt>
      <dd>{record.addendumVersion}</dd>
      {record.executedOn ? (
        <>
          <dt>Executed</dt>
          <dd className="wx-nums">{record.executedOn}</dd>
        </>
      ) : null}
      {record.expiresOn ? (
        <>
          <dt>Expires</dt>
          <dd className="wx-nums">{record.expiresOn}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function BaaPanel({ held, roles, onChanged }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const mayRead = held.has(ONBOARDING_KEYS.baaRead);
  const mayAttest = held.has(ONBOARDING_KEYS.baaAttest) && roles.has(ROLE_COMPLIANCE_OFFICER);
  const baa = useLoad<BaaPage>(
    `baa:${mayRead}`,
    async () =>
      mayRead
        ? client.GET("/api/v1/tenant/baa")
        : { data: { items: [], nextCursor: null, hasMore: false } },
    WIZARD_ERROR_COPY,
  );
  // Back from Re-verify the confirmation box is as it was left (it holds no free text, only the tick).
  const restored = useStepUpMemoryDraft<{ confirmed: boolean }>(DRAFT_KEY);
  const [confirmed, setConfirmed] = useState(restored?.confirmed ?? false);
  const write = useOpsWrite();

  const record = latestOf(baa.data?.items ?? []);
  const canAttest = mayAttest && record?.baaStatus === "executed" && !record.attestedAt;

  async function attest(): Promise<void> {
    if (!record || !confirmed) return;
    const id = record.id;
    const outcome = await write.run(
      `attest:${id}`,
      (key) =>
        client.POST("/api/v1/tenant/baa/{id}/attest", {
          params: { path: { id } },
          body: { attestationConfirmed: true },
          headers: { "Idempotency-Key": key },
        }),
      async () => {
        await Promise.all([baa.reload(true), onChanged()]);
      },
    );
    if (outcome.ok) setConfirmed(false);
  }

  return (
    <section className="wx-drawer-card" aria-label="Business associate agreement">
      <div className="wx-drawer-card-head">
        <h3>Your BAA</h3>
      </div>
      <FactList facts={baaFacts(record, new Date())} ariaLabel="What settles this step" />
      {!mayRead ? <RoleCannot what="see the BAA" /> : null}
      {baa.failure ? (
        <div className="wx-form-stack">
          <InlineAlert tone="error">Could not load your BAA.</InlineAlert>
          <div>
            <Button tone="secondary" size="sm" onClick={() => void baa.reload()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}
      {baa.loading && !baa.data && !baa.failure ? (
        <LoadingSpinner label="Loading your BAA…" />
      ) : null}
      {mayRead && baa.data && record === null ? (
        <p>ChartWarden has not recorded your BAA yet. ChartWarden completes this step.</p>
      ) : null}
      {record ? <BaaRecordFacts record={record} /> : null}
      {canAttest ? (
        <form
          className="wx-form-stack"
          aria-label="Attest the BAA"
          onSubmit={(e) => {
            e.preventDefault();
            void attest();
          }}
        >
          <label className="wx-action-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>I confirm this agreement is correct for our organization.</span>
          </label>
          {write.failure ? (
            <FailureNotice
              failure={write.failure}
              onReverify={() => stashStepUpMemoryDraft(DRAFT_KEY, { confirmed })}
            />
          ) : null}
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={!confirmed || write.busy}>
              {write.busy ? "Attesting…" : "Attest the BAA"}
            </Button>
          </div>
        </form>
      ) : null}
      {record?.baaStatus === "executed" && !record.attestedAt && !mayAttest && mayRead ? (
        <p className="wx-row-sub">Your compliance officer attests the BAA.</p>
      ) : null}
    </section>
  );
}
