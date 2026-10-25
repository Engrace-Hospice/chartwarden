// apps/web/src/modules/24-billing-medicaid — the "Needs attention" strip on the Medicaid Overview (the AR dashboard): a
// count per source (claims needing action, blocked by validation, denied) and the five most stuck claims. It reads through
// the same hook and model as the Medicaid Work Queue, so the two agree, and it only links. A source that failed or was
// refused shows "—" (never 0), and "Nothing is stuck" appears only once every source answered whole.
import { KpiCard, KpiStrip, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useMemo } from "react";
import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { patientLabel, usePatientNames } from "../23-billing-medicare/use-patient-names";
import { type SourceState, countLabel } from "../23-billing-medicare/work-queue-model";
import { buildMedicaidWork, isUrgentMedicaid } from "./medicaid-work-model";
import { MedicaidSourceProblems, itemsOf, sourceDetail } from "./medicaid-work-queue";
import { type MedicaidWorkSources, useMedicaidWorkSources } from "./use-medicaid-work-sources";

const TOP_COUNT = 5;

export function MedicaidNeedsAttention(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { sources, reload } = useMedicaidWorkSources(client);

  const items = useMemo(
    () => buildMedicaidWork({ claims: itemsOf(sources.claims), blocked: itemsOf(sources.blocked) }),
    [sources],
  );
  const stuck = useMemo(() => items.filter(isUrgentMedicaid), [items]);
  const top = useMemo(() => stuck.slice(0, TOP_COUNT), [stuck]);
  const topPatientIds = useMemo(
    () => [...new Set(top.flatMap((i) => (i.patientId ? [i.patientId] : [])))],
    [top],
  );
  const names = usePatientNames(client, topPatientIds);

  const states = Object.entries(sources) as [keyof MedicaidWorkSources, SourceState<unknown>][];
  const settled = states.every(([, s]) => s.status !== "loading");
  const whole = states.every(([, s]) => s.status === "ok" && !s.hasMore);
  const blockedCount = items.filter((i) => i.blocked).length;
  const deniedCount = items.filter((i) => i.statusLabel === "Denied").length;
  const go = (query: string) => navigate(`/medicaid/billing/queue${query}`);

  return (
    <section aria-label="Needs attention" style={{ display: "grid", gap: "0.75rem" }}>
      <MedicaidSourceProblems sources={sources} onRetry={reload} />
      <KpiStrip>
        <KpiCard
          label="Needing action"
          value={countLabel(sources.claims, items.length)}
          detail={sourceDetail(sources.claims, stuck.length, "none stuck")}
          tone={stuck.length > 0 ? "warning" : "neutral"}
          onSelect={() => go("")}
        />
        <KpiCard
          label="Blocked by validation"
          value={countLabel(sources.blocked, blockedCount)}
          detail={sourceDetail(sources.blocked, 0, "fix the blocking rules")}
          tone={blockedCount > 0 ? "warning" : "neutral"}
          onSelect={() => go("?type=blocked")}
        />
        <KpiCard
          label="Denied claims"
          value={countLabel(sources.claims, deniedCount)}
          detail={sourceDetail(sources.claims, 0, "see denials")}
          tone={deniedCount > 0 ? "warning" : "neutral"}
          onSelect={() => go("?type=denied")}
        />
      </KpiStrip>
      {!settled ? (
        <LoadingSpinner />
      ) : top.length > 0 ? (
        <ul aria-label="Most stuck" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {top.map((i) => (
            <li
              key={i.key}
              style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", padding: "0.4rem 0" }}
            >
              <strong>
                {i.patientId ? patientLabel(names[i.patientId], i.patientId) : "Unknown patient"}
              </strong>
              <span>{i.what}</span>
              <StatusPill label={i.statusLabel} tone={i.statusTone} />
              <Link to={i.href} style={{ color: "var(--color-primary)", fontWeight: 600 }}>
                {i.nextAction}
              </Link>
            </li>
          ))}
        </ul>
      ) : whole ? (
        <p style={{ margin: 0 }}>Nothing is stuck.</p>
      ) : null}
    </section>
  );
}
