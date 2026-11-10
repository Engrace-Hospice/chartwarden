import {
  Button,
  StatusPill,
  TableScroll,
  TextField,
  focusFirstInvalid,
  parsePriceCents,
  parseWholeNumber,
  stashStepUpMemoryDraft,
  useApiClient,
  useRequestGuard,
  useRestoreFocus,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Plan editor (`/admin/plans/:id/edit`, plan.admin.write).
// Hydrates from GET /api/admin/plans/:id (M35A-T03 detail GET), then manages the plan's usage meters
// (POST/PATCH .../meters) and drives the lifecycle: Activate (which the §4.13 outbox dispatcher syncs to a
// Stripe product/price — the "Sync to Stripe" path, vendor SDK OFF) and Deprecate. Every mutation carries a
// server-enforced step-up + Idempotency-Key; stale step-up surfaces as a first-class outcome. Redesign frame:
// the meters in the main column, the plan summary in the right drawer.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { cap, formatCents, idempotencyKey } from "./status";
import {
  DrawerHead,
  type Outcome,
  OutcomeBanner,
  StateEmpty,
  StateError,
  StateLoading,
  UNREACHABLE_OUTCOME,
  failureOutcome,
  isNotFound,
  settleWrite,
} from "./ui";

type PlanDetail =
  operations["getApiAdminPlansById"]["responses"][200]["content"]["application/json"];
type Meter = PlanDetail["meters"][number];

interface MeterDraft {
  eventType: string;
  inclusive: string;
  overage: string;
  threshold: string;
}

const BLANK_METER: MeterDraft = { eventType: "", inclusive: "0", overage: "0", threshold: "80" };
const meterDraftKey = (id: string): string => `plan-meter:${id}`;

/** The new meter's field messages (strict: "1e3" and "0x1f" are not quantities or prices). */
function meterErrors(m: MeterDraft): Partial<Record<keyof MeterDraft, string>> {
  const errors: Partial<Record<keyof MeterDraft, string>> = {};
  if (!m.eventType.trim()) errors.eventType = "Enter the event type to meter.";
  if (parseWholeNumber(m.inclusive) === null) errors.inclusive = "Enter a whole number, 0 or more.";
  if (parsePriceCents(m.overage) === null)
    errors.overage = "Enter dollars, 0 or more, with up to two decimals.";
  const threshold = parseWholeNumber(m.threshold, 100);
  // the server's range (subscription-typebox.ts: warningThresholdPercent 1..100)
  if (threshold === null || threshold < 1)
    errors.threshold = "Enter a whole percentage from 1 to 100.";
  return errors;
}

/** Keyed on the plan id, so a move to another plan starts fresh (its meter draft, outcome and form are per plan). */
export function PlanEdit(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  return <PlanEditBody key={id} />;
}

function PlanEditBody(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const meterRowRef = useRef<HTMLFormElement>(null);
  // Activate, Deprecate and Add meter disable while in flight (dropping focus), and a save reloads the page: focus goes back to
  // the control that was pressed, else to the new meter's first field.
  const captureFocus = useRestoreFocus(busy, () => meterRowRef.current?.querySelector("input"));
  // A step-up refusal sends the operator to /step-up and back; the typed meter comes back once.
  const restoredMeter = useStepUpMemoryDraft<MeterDraft>(meterDraftKey(id ?? ""));
  const [meter, setMeter] = useState<MeterDraft>(restoredMeter ?? BLANK_METER);

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    if (!id) {
      setError("No plan selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    const res = await client.GET("/api/admin/plans/{id}", { params: { path: { id } } });
    if (!isCurrent()) return;
    if (res.error) {
      // A 404 is final: retrying cannot bring the record back, so no "Try again" (#597, F-044).
      setNotFound(isNotFound(res));
      setError(isNotFound(res) ? "Plan not found." : "Plan unavailable.");
      setLoading(false);
      return;
    }
    setPlan(res.data);
    setLoading(false);
  }, [client, id, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (
      fn: () => Promise<{ error?: unknown }>,
      okMsg: string,
      failMsg: string,
    ): Promise<boolean> => {
      captureFocus();
      setBusy(true);
      setOutcome(null);
      const res = await settleWrite(fn());
      if (!res || res.error) {
        setOutcome(res ? failureOutcome(res.error, failMsg) : UNREACHABLE_OUTCOME);
        setBusy(false);
        return false;
      }
      setOutcome({ ok: true, message: okMsg });
      await load();
      setBusy(false);
      return true;
    },
    [load, captureFocus],
  );

  const [meterAttempted, setMeterAttempted] = useState(false);
  const meterIssues = meterAttempted ? meterErrors(meter) : {};

  const addMeter = useCallback(async () => {
    if (!id || busy) return;
    setMeterAttempted(true);
    const issues = meterErrors(meter);
    const inclusive = parseWholeNumber(meter.inclusive);
    const overage = parsePriceCents(meter.overage);
    const threshold = parseWholeNumber(meter.threshold, 100);
    if (
      Object.keys(issues).length > 0 ||
      inclusive === null ||
      overage === null ||
      threshold === null
    ) {
      focusFirstInvalid(meterRowRef.current);
      return;
    }
    const added = await run(
      () =>
        client.POST("/api/admin/plans/{id}/meters", {
          params: { path: { id } },
          body: {
            eventType: meter.eventType.trim(),
            label: meter.eventType.trim(),
            inclusiveQuantity: inclusive,
            overageUnitPriceCents: overage,
            billingAggregation: "sum",
            warningThresholdPercent: threshold,
          },
          headers: { "Idempotency-Key": idempotencyKey() },
        }),
      `Meter "${meter.eventType}" added.`,
      "Could not add the meter (check the fields).",
    );
    if (!added) return; // a refused meter keeps what was typed, to fix and retry
    setMeter(BLANK_METER);
    setMeterAttempted(false);
  }, [busy, client, id, meter, run]);

  const activate = useCallback(() => {
    if (!id || busy) return;
    void run(
      () =>
        client.POST("/api/admin/plans/{id}/activate", {
          params: { path: { id } },
          headers: { "Idempotency-Key": idempotencyKey() },
        }),
      "Plan activated — queued for Stripe sync (product/price).",
      "Could not activate this plan.",
    );
  }, [busy, client, id, run]);

  const deprecate = useCallback(() => {
    if (!id || busy) return;
    void run(
      () =>
        client.POST("/api/admin/plans/{id}/deprecate", {
          params: { path: { id } },
          headers: { "Idempotency-Key": idempotencyKey() },
        }),
      "Plan deprecated.",
      "Could not deprecate this plan.",
    );
  }, [busy, client, id, run]);

  const frame = (content: JSX.Element): JSX.Element => (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Edit plan</h1>
            <p>Usage meters, pricing and the plan's lifecycle.</p>
          </div>
        </header>
        {content}
      </div>
    </div>
  );
  if (loading) return frame(<StateLoading label="Loading plan…" />);
  if (error || !plan)
    return frame(
      <StateError
        message={error ?? "Plan not found."}
        onRetry={notFound ? undefined : () => void load()}
      />,
    );

  return (
    <div className="wx-list-drawer has-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>{`Edit — ${plan.name}`}</h1>
            <p>Usage meters, pricing and the plan's lifecycle.</p>
          </div>
          <div className="wx-list-toolbar-end">
            {plan.isActive ? (
              <Button tone="secondary" onClick={deprecate} disabled={busy}>
                Deprecate
              </Button>
            ) : (
              <Button onClick={activate} disabled={busy}>
                Activate & sync to Stripe
              </Button>
            )}
          </div>
        </header>
        {outcome ? (
          <OutcomeBanner
            {...outcome}
            onReverify={() => stashStepUpMemoryDraft(meterDraftKey(id ?? ""), meter)}
          />
        ) : null}
        <h2 className="wx-action-title">Usage meters</h2>
        {plan.meters.length === 0 ? (
          <StateEmpty icon="bar-chart">No meters yet — add one below.</StateEmpty>
        ) : (
          <MetersTable meters={plan.meters} currencyCode={plan.currencyCode} />
        )}
        <form
          ref={meterRowRef}
          className="wx-drawer-card"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void addMeter();
          }}
        >
          <div className="wx-form-grid">
            <TextField
              label="Event type"
              required
              value={meter.eventType}
              onChange={(e) => setMeter({ ...meter, eventType: e.target.value })}
              error={meterIssues.eventType}
            />
            <TextField
              label="Included qty"
              required
              value={meter.inclusive}
              inputMode="numeric"
              error={meterIssues.inclusive}
              onChange={(e) => setMeter({ ...meter, inclusive: e.target.value })}
            />
            <TextField
              label="Overage $/unit"
              required
              value={meter.overage}
              inputMode="decimal"
              error={meterIssues.overage}
              onChange={(e) => setMeter({ ...meter, overage: e.target.value })}
            />
            <TextField
              label="Warn %"
              required
              value={meter.threshold}
              inputMode="numeric"
              error={meterIssues.threshold}
              onChange={(e) => setMeter({ ...meter, threshold: e.target.value })}
            />
          </div>
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={busy}>
              Add meter
            </Button>
          </div>
        </form>
      </div>
      <PlanSummary plan={plan} />
    </div>
  );
}

function MetersTable({
  meters,
  currencyCode,
}: { meters: readonly Meter[]; currencyCode: string }): JSX.Element {
  return (
    <TableScroll>
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Usage meters</caption>
        <thead>
          <tr>
            <th scope="col">Meter</th>
            <th scope="col" className="wx-num-col">
              Included
            </th>
            <th scope="col" className="wx-num-col">
              Overage / unit
            </th>
          </tr>
        </thead>
        <tbody>
          {meters.map((m) => (
            <tr key={m.eventType}>
              <td>
                <span className="wx-row-title">{m.label}</span>
                <span className="wx-row-sub wx-data-md">{m.eventType}</span>
              </td>
              <td className="wx-num-col wx-nums">{m.inclusiveQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">
                {formatCents(m.overageUnitPriceCents, currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function PlanSummary({ plan }: { plan: PlanDetail }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="Plan summary">
      <DrawerHead icon="layout-grid" title={plan.name} sub={plan.slug} />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Plan</h3>
            <StatusPill
              label={plan.isActive ? "Active" : "Draft"}
              tone={plan.isActive ? "success" : "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Tier / cadence</dt>
            <dd>
              {cap(plan.tier)} · {cap(plan.cadence)}
            </dd>
            <dt>Base price</dt>
            <dd className="wx-nums">{formatCents(plan.basePriceCents, plan.currencyCode)}</dd>
            <dt>Trial</dt>
            <dd className="wx-nums">{plan.trialPeriodDays} days</dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Stripe</h3>
          <dl className="wx-kv">
            <dt>Product</dt>
            <dd className="wx-data-md">{plan.stripeProductId ?? "— (pending sync)"}</dd>
            <dt>Price</dt>
            <dd className="wx-data-md">{plan.stripePriceId ?? "— (pending sync)"}</dd>
          </dl>
        </section>
      </div>
    </aside>
  );
}
