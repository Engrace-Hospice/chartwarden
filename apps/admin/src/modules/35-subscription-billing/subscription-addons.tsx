import {
  Button,
  SelectField,
  StatusPill,
  TableScroll,
  TextAreaField,
  TextField,
  sendWrite,
  stashStepUpMemoryDraft,
  useApiClient,
  useIdempotencyKeeper,
  useRestoreFocus,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — ADR-0110 the Add-ons panel on the subscription detail. Lists the
// subscription's add-ons (GET /api/admin/subscriptions/:id/addons), grants or starts a trial of the claims-billing
// add-on (POST …/addons, step-up + Idempotency-Key) and cancels a live one (POST …/addons/:addonId/cancel). The
// active-patient count is the current period's census (shown, not billed: Stripe charging is deferred).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { cap, formatCents, formatDate } from "./status";
import { type Outcome, OutcomeBanner, StateEmpty, StateLoading, writeFailure } from "./ui";

type SubscriptionAddon =
  operations["getApiAdminSubscriptionsByIdAddons"]["responses"][200]["content"]["application/json"][number];
export type AddonUsage = NonNullable<
  operations["getApiAdminUsageByOrganizationIdCurrent"]["responses"][200]["content"]["application/json"]["claimsBillingAddon"]
>;

const CLAIMS_BILLING = "claims_billing";
type Mode = "grant" | "trial";

const addonTone = (row: SubscriptionAddon): "success" | "progress" | "neutral" =>
  row.live ? (row.status === "trialing" ? "progress" : "success") : "neutral";

export function AddonsPanel({
  subscriptionId,
  usage,
}: {
  subscriptionId: string;
  usage: AddonUsage | null;
}): JSX.Element {
  const client = useApiClient();
  const draftKey = `subscription-addons:${subscriptionId}`;
  const restored = useStepUpMemoryDraft<{ mode: Mode; trialEndsAt: string; reason: string }>(
    draftKey,
  );
  const [rows, setRows] = useState<SubscriptionAddon[] | null>(null);
  const [mode, setMode] = useState<Mode>(restored?.mode ?? "grant");
  const [trialEndsAt, setTrialEndsAt] = useState(restored?.trialEndsAt ?? "");
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which row's cancel is in flight: every action locks while busy, but only that row's button shows the spinner.
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // A refused grant or cancel re-enables the button the keyboard user pressed; it was disabled while in flight, which dropped focus.
  const captureFocus = useRestoreFocus(busy);
  // One Idempotency-Key per grant / cancel: a retry of the same unchanged request after "could not reach the server" replays it.
  const keeper = useIdempotencyKeeper();

  const load = useCallback(async () => {
    const res = await client.GET("/api/admin/subscriptions/{id}/addons", {
      params: { path: { id: subscriptionId } },
    });
    setRows(res.error ? [] : res.data);
  }, [client, subscriptionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = rows?.find((r) => r.addonSlug === CLAIMS_BILLING && r.live) ?? null;
  const reasonError =
    attempted && reason.trim().length < 3 ? "Give a reason (3+ characters)." : undefined;
  const trialError =
    attempted && mode === "trial" && !trialEndsAt ? "Pick the day the trial ends." : undefined;

  const grant = useCallback(async () => {
    if (busy) return;
    setAttempted(true);
    if (reason.trim().length < 3 || (mode === "trial" && !trialEndsAt)) return;
    captureFocus();
    setBusy(true);
    setOutcome(null);
    const body = {
      addonSlug: CLAIMS_BILLING,
      mode,
      reason: reason.trim(),
      ...(mode === "trial"
        ? { trialEndsAt: new Date(`${trialEndsAt}T23:59:59Z`).toISOString() }
        : {}),
    };
    const sent = await sendWrite(keeper, `grant:${subscriptionId}:${JSON.stringify(body)}`, (key) =>
      client.POST("/api/admin/subscriptions/{id}/addons", {
        params: { path: { id: subscriptionId } },
        body,
        headers: { "Idempotency-Key": key },
      }),
    );
    setBusy(false);
    const failure = writeFailure(sent, "Could not add the claims-billing add-on.");
    if (failure) {
      setOutcome(failure);
      return;
    }
    setOutcome({ ok: true, message: mode === "trial" ? "Trial started." : "Add-on granted." });
    setReason("");
    setAttempted(false);
    await load();
  }, [busy, client, subscriptionId, mode, trialEndsAt, reason, load, captureFocus, keeper]);

  const cancel = useCallback(
    async (addonId: string) => {
      if (busy) return;
      captureFocus();
      setBusy(true);
      setCancellingId(addonId);
      setOutcome(null);
      const sent = await sendWrite(keeper, `cancel:${subscriptionId}:${addonId}`, (key) =>
        client.POST("/api/admin/subscriptions/{id}/addons/{addonId}/cancel", {
          params: { path: { id: subscriptionId, addonId } },
          headers: { "Idempotency-Key": key },
        }),
      );
      setBusy(false);
      setCancellingId(null);
      const failure = writeFailure(sent, "Could not cancel the add-on.");
      if (failure) {
        setOutcome(failure);
        return;
      }
      setOutcome({
        ok: true,
        message: "Add-on canceled. New claims work stops; in-flight claims still finish.",
      });
      await load();
    },
    [busy, client, subscriptionId, load, captureFocus, keeper],
  );

  return (
    <section className="wx-drawer-card">
      <div className="wx-drawer-card-head">
        <h2>Add-ons</h2>
      </div>
      {rows === null ? (
        <StateLoading label="Loading add-ons…" />
      ) : rows.length === 0 ? (
        <StateEmpty icon="receipt">No add-ons on this subscription.</StateEmpty>
      ) : (
        <TableScroll>
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Add-ons</caption>
            <thead>
              <tr>
                <th scope="col">Add-on</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Trial ends</th>
                <th scope="col">Ended</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="wx-row-title">{r.addonName}</span>
                  </td>
                  <td>
                    <StatusPill label={r.live ? cap(r.status) : "Ended"} tone={addonTone(r)} />
                  </td>
                  <td className="wx-nums">{formatDate(r.startedAt)}</td>
                  <td className="wx-nums">{formatDate(r.trialEndsAt)}</td>
                  <td className="wx-nums">{formatDate(r.endsAt)}</td>
                  <td>
                    {r.live ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        loading={cancellingId === r.addonId}
                        disabled={busy}
                        onClick={() => void cancel(r.addonId)}
                      >
                        Cancel add-on
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {usage ? (
        <p className="wx-source-line wx-nums">
          Active patients this period: {usage.activePatientCount.toLocaleString()} ·{" "}
          {usage.unitPriceCents === null
            ? "price not set"
            : `${formatCents(usage.unitPriceCents)} per active patient per month`}{" "}
          · not billed yet
        </p>
      ) : null}
      {live ? null : (
        <form
          className="wx-form-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void grant();
          }}
        >
          <div className="wx-form-grid">
            <SelectField
              label="Claims billing"
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              options={[
                { value: "grant", label: "Grant (active now)" },
                { value: "trial", label: "Start a trial" },
              ]}
            />
            {mode === "trial" ? (
              <TextField
                label="Trial ends"
                type="date"
                value={trialEndsAt}
                onChange={(e) => setTrialEndsAt(e.target.value)}
                error={trialError}
              />
            ) : null}
          </div>
          <TextAreaField
            label="Reason (for the audit record)"
            hint="Do not include patient information."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={reasonError}
            rows={2}
          />
          <div className="wx-drawer-actions">
            <Button type="submit" loading={busy && cancellingId === null}>
              {mode === "trial" ? "Start trial" : "Grant add-on"}
            </Button>
          </div>
        </form>
      )}
      {outcome ? (
        <OutcomeBanner
          {...outcome}
          onReverify={() => stashStepUpMemoryDraft(draftKey, { mode, trialEndsAt, reason })}
        />
      ) : null}
    </section>
  );
}
