// apps/web/src/modules/21-supplies — the DEA 21 CFR §1304 PERPETUAL LOG for one kit
// (`/supplies/dispatches/:dispatchId/perpetual-log`, §8.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Record Detail."
//
// NOT IN §5.1's INVENTORY, AND IT HAS TO BE ITS OWN SCREEN. §8.1 publishes the log behind its own permission
// key (`comfort_kit.perpetual_log.read`, `compliance` category), deliberately separate from
// `comfort_kit.dispatch.read`: a supply coordinator who may file requests must not thereby acquire the
// lot-level custody chain, and a compliance officer who reads it needs no request permission at all. Nav
// gating is per-screen, so folding this into S21.4 would have made the dispatch screen's permission the
// effective gate on the ledger — strictly wider than §4.3 says.
//
// TWO THINGS THIS SCREEN DOES NOT DO, on purpose:
//   • It does not recompute a balance. `balanceAfterQuantity` is the balance AS RECORDED with each entry;
//     a balance derived at read time silently absorbs a missing entry, which is exactly the discrepancy the
//     log exists to expose. Where the recorded balance and the running arithmetic disagree, the screen
//     SHOWS both and flags the line — it does not pick a winner.
//   • It offers no edit or correction. The column is append-only: a corrected count is a NEW `adjustment`
//     entry, because "what did the log say before someone changed it" is the first question an inspection
//     asks.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { type PerpetualLogView, errorMessage, getPerpetualLog } from "./supplies-api";
import { LOG_KIND_TONE, dateTime, humanize, shortDate, shortId, toneOf } from "./supplies-status";
import {
  Card,
  Field,
  Notice,
  SchedulePill,
  SummaryGrid,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdQty,
  th,
  thNum,
} from "./supplies-ui";

/**
 * Walk a line's entries and mark any whose RECORDED balance disagrees with the running sum of the deltas.
 * The running sum is a check, never a replacement: a mismatch means an entry is missing or a delta was
 * mis-recorded, and both are findings — so the row is flagged and both numbers are rendered.
 */
function balanceChecks(
  entries: readonly { quantityDelta: string; balanceAfterQuantity: string }[],
): boolean[] {
  let running: number | null = null;
  return entries.map((e) => {
    const delta = Number(e.quantityDelta);
    const recorded = Number(e.balanceAfterQuantity);
    if (!Number.isFinite(delta) || !Number.isFinite(recorded)) {
      running = Number.isFinite(recorded) ? recorded : null;
      return false;
    }
    // The first entry establishes the opening balance; there is nothing before it to disagree with.
    const expected = running === null ? recorded : running + delta;
    running = recorded;
    return Math.abs(expected - recorded) > 1e-9;
  });
}

export function ComfortKitPerpetualLog(): JSX.Element {
  const client = useApiClient();
  const { dispatchId } = useParams<{ dispatchId: string }>();
  const [log, setLog] = useState<PerpetualLogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!dispatchId) return;
    setLoading(true);
    setError(null);
    const { log: l, error: err } = await getPerpetualLog(client, dispatchId);
    if (err) {
      setError(errorMessage(err, "The perpetual log for this kit could not be loaded."));
      setLoading(false);
      return;
    }
    setLog(l);
    setLoading(false);
  }, [client, dispatchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!log || !dispatchId)
    return (
      <EmptyState
        title="Not found"
        description="No perpetual log exists for this dispatch, or it is outside your organization."
      />
    );

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Perpetual log — kit {log.kitSerialNumber}</span>}
        breadcrumb="Supplies — DEA 21 CFR §1304 controlled-substance record"
        actions={
          <Link to={`/supplies/dispatches/${dispatchId}`} style={ghostButtonStyle}>
            Back to dispatch
          </Link>
        }
      />

      <Notice tone="info">
        This is the record an inspection asks for: one kit, every lot, every movement, in the order
        it was recorded. It is append-only — a corrected count appears as a new adjustment entry
        rather than as an edit to the entry it corrects.
      </Notice>

      <Card title="Kit">
        <SummaryGrid>
          <Field label="Dispatch" value={shortId(log.dispatchId)} mono />
          <Field label="Kit serial" value={log.kitSerialNumber} mono />
          <Field label="Dispatched" value={dateTime(log.dispatchedAt)} />
          <Field label="Dispatched by" value={shortId(log.dispatchedByMembershipId)} mono />
        </SummaryGrid>
      </Card>

      {log.lines.length === 0 ? (
        <Card title="Lines">
          <span style={mutedStyle}>
            This kit carries no lot-tracked line. Only medications with a lot number enter the
            perpetual log; a non-controlled, non-lot-tracked item has no §1304 obligation.
          </span>
        </Card>
      ) : null}

      {log.lines.map((line) => {
        const mismatches = balanceChecks(line.entries);
        const anyMismatch = mismatches.some(Boolean);
        return (
          <Card
            key={line.dispatchedContentId}
            title={line.drugName}
            actions={
              <div style={{ display: "flex", gap: t.space2, alignItems: "center" }}>
                {anyMismatch ? <StatusPill label="Balance disagreement" tone="error" /> : null}
                <SchedulePill
                  schedule={line.controlledSubstanceSchedule}
                  isControlled={line.controlledSubstanceSchedule !== null}
                />
              </div>
            }
          >
            <SummaryGrid>
              <Field label="Lot" value={line.lotNumber ?? "—"} mono />
              <Field label="Expires" value={shortDate(line.expirationDate)} />
              <Field
                label="Dispatched quantity"
                value={`${line.dispatchedQuantity} ${line.dispatchedUnit}`}
                mono
              />
              <Field label="Entries" value={line.entries.length} />
            </SummaryGrid>

            {anyMismatch ? (
              <Notice tone="error">
                At least one entry's recorded balance does not match the running sum of the deltas
                before it. Both numbers are shown below — the recorded balance is the legal record,
                and the disagreement is the finding, so neither is silently corrected here.
              </Notice>
            ) : null}

            {line.entries.length === 0 ? (
              <span style={mutedStyle}>
                No movement has been recorded against this lot beyond the dispatch itself.
              </span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Occurred</th>
                    <th style={th}>Transaction</th>
                    <th style={thNum}>Delta</th>
                    <th style={thNum}>Balance (recorded)</th>
                    <th style={th}>Recorded by</th>
                    <th style={th}>Witness</th>
                    <th style={th}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {line.entries.map((e, i) => (
                    <tr key={`${e.occurredAt}-${e.sourceReference ?? i}`} style={rowLine}>
                      <td style={td}>{dateTime(e.occurredAt)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(e.transactionKind)}
                          tone={toneOf(LOG_KIND_TONE, e.transactionKind)}
                        />
                      </td>
                      <td style={tdQty}>
                        {e.quantityDelta} {e.unit}
                      </td>
                      <td style={tdQty}>
                        {e.balanceAfterQuantity}
                        {mismatches[i] ? (
                          <div style={{ ...mutedStyle, color: t.error }}>
                            disagrees with running sum
                          </div>
                        ) : null}
                      </td>
                      <td style={{ ...td, fontFamily: t.fontMono }}>
                        {shortId(e.recordedByMembershipId)}
                      </td>
                      <td style={{ ...td, fontFamily: t.fontMono }}>
                        {e.witnessMembershipId ? shortId(e.witnessMembershipId) : "—"}
                      </td>
                      <td style={{ ...td, fontFamily: t.fontMono }}>
                        {shortId(e.sourceReference)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        );
      })}
    </div>
  );
}
