// apps/web/src/modules/23-billing-medicare — the "Needs attention" strip at the top of Billing Home (the Overview).
// One card per source (claims, denied claims, NOE, NOTR, DDE items), each labelled with its own count, and the five most
// urgent items below. It reads through the same hook and model as the Work Queue, so the two always agree, and it only
// links: a source that failed or was refused shows "—" (never 0), and "Nothing is at risk" appears only once every
// source has answered whole.
import {
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  Panel,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useMemo } from "react";
import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fmtDay } from "./dde-queue-model";
import { patientLabel, usePatientNames } from "./use-patient-names";
import { type WorkQueueSources, useWorkQueueSources } from "./use-work-queue-sources";
import { ValidationSummaryCard } from "./validation-summary-card";
import { SourceCard, SourceProblems, UrgencyPill, isUrgent } from "./work-queue";
import { type SourceState, buildWorkItems, countLabel } from "./work-queue-model";

const TOP_COUNT = 5;
const itemsOf = <T,>(s: SourceState<T>): T[] => (s.status === "ok" ? s.items : []);

export function BillingNeedsAttention(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { sources, reload } = useWorkQueueSources(client);

  const items = useMemo(
    () =>
      buildWorkItems(
        {
          claims: itemsOf(sources.claims),
          noe: itemsOf(sources.noe),
          notr: itemsOf(sources.notr),
          dde: itemsOf(sources.dde),
        },
        new Date(),
      ),
    [sources],
  );
  const top = useMemo(() => items.filter(isUrgent).slice(0, TOP_COUNT), [items]);
  const topPatientIds = useMemo(
    () => [...new Set(top.flatMap((i) => (i.patientId ? [i.patientId] : [])))],
    [top],
  );
  const names = usePatientNames(client, topPatientIds);

  const states = Object.entries(sources) as [keyof WorkQueueSources, SourceState<unknown>][];
  const settled = states.every(([, s]) => s.status !== "loading");
  const failed = states.filter(([, s]) => s.status === "error");
  const refused = states.filter(([, s]) => s.status === "denied");
  const paged = states.some(([, s]) => s.status === "ok" && s.hasMore);
  // The "+" on the Denied card follows the whole claims source (any state paged), so it may say "3+" for an exact 3:
  // it can overstate that more exist, never understate.
  const denied = itemsOf(sources.claims).filter((c) => c.state === "denied").length;
  const go = (type: string, urgent = false) =>
    navigate(`/billing/queue?type=${type}${urgent ? "&urgent=1" : ""}`);

  return (
    <section aria-label="Needs attention" style={{ display: "grid", gap: "0.75rem" }}>
      <SourceProblems failed={failed} refused={refused} onRetry={reload} />
      <KpiStrip>
        <SourceCard
          label="Claims"
          source={sources.claims}
          rows={items.filter((i) => i.kind === "claim")}
          quietDetail="need action"
          onSelect={() => go("claim")}
        />
        <ValidationSummaryCard />
        <KpiCard
          label="Denied claims"
          value={countLabel(sources.claims, denied)}
          detail={sources.claims.status === "ok" ? "see denials" : "Not available"}
          tone={sources.claims.status === "ok" && denied > 0 ? "warning" : "neutral"}
          onSelect={() => navigate("/remittance/denials")}
        />
        <SourceCard
          label="NOE"
          source={sources.noe}
          rows={items.filter((i) => i.kind === "noe")}
          onSelect={() => go("noe", true)}
        />
        <SourceCard
          label="NOTR"
          source={sources.notr}
          rows={items.filter((i) => i.kind === "notr")}
          onSelect={() => go("notr", true)}
        />
        <SourceCard
          label="DDE items"
          source={sources.dde}
          rows={items.filter((i) => i.dde !== null)}
          onSelect={() => go("dde", true)}
        />
      </KpiStrip>
      {!settled ? (
        <LoadingSpinner />
      ) : top.length > 0 ? (
        <Panel title="Most urgent">
          <ul aria-label="Most urgent" className="wx-urgent-list">
            {top.map((i) => (
              <li key={i.key} className="wx-urgent-row">
                <strong>
                  {i.patientId ? patientLabel(names[i.patientId], i.patientId) : "Unknown patient"}
                </strong>
                <span>{i.what}</span>
                <span>{fmtDay(i.deadlineAt)}</span>
                <UrgencyPill urgency={i.urgency} />
                <StatusPill label={i.statusLabel} tone={i.statusTone} />
                <Link to={i.href} className="wx-urgent-action">
                  {i.nextAction}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : failed.length + refused.length === 0 && !paged ? (
        <p style={{ margin: 0 }}>Nothing is at risk or overdue.</p>
      ) : null}
    </section>
  );
}
