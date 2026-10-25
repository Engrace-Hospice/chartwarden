// apps/web/src/modules/23-billing-medicare — the patient chart's "Needs attention" panel: this patient's claims, notices
// and DDE items that are waiting on a person, from the same sources and model as the Billing work queue but narrowed to
// one patient. Read-only links into the existing screens. A source that could not be read is said so, never shown as
// "nothing waiting"; a patient switch drops the previous patient's rows before the new ones load.
import { LoadingSpinner, Panel, StatusPill, useApiClient } from "@chartwarden/ui";
import { useMemo } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { fmtDay } from "./dde-queue-model";
import { useWorkQueueSources } from "./use-work-queue-sources";
import { type SourceState, type WorkItem, buildWorkItems } from "./work-queue-model";

const NOUN = { claims: "claims", noe: "NOE", notr: "NOTR", dde: "DDE items" } as const;

const items = <T,>(s: SourceState<T>): T[] => (s.status === "ok" ? s.items : []);

export function PatientWorkPanel({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const { sources, reload } = useWorkQueueSources(client, patientId);
  const entries = Object.entries(sources) as [keyof typeof NOUN, SourceState<unknown>][];
  const loading = entries.some(([, s]) => s.status === "loading");
  const down = entries.filter(([, s]) => s.status === "error" || s.status === "denied");
  const paged = entries.some(([, s]) => s.status === "ok" && s.hasMore);
  const work = useMemo(
    () =>
      buildWorkItems(
        {
          claims: items(sources.claims),
          noe: items(sources.noe),
          notr: items(sources.notr),
          dde: items(sources.dde),
        },
        new Date(),
      ),
    [sources],
  );

  return (
    <Panel title="Needs attention" icon="alert-circle">
      {down.length > 0 ? (
        <p className="wx-rail-empty" role="alert" style={{ padding: 0 }}>
          {down.map(([k]) => NOUN[k]).join(", ")} could not be read, so their items are not shown.{" "}
          <button type="button" className="wx-btn-link" onClick={reload}>
            Try again
          </button>
        </p>
      ) : null}
      {work.length > 0 ? (
        <ul className="wx-rail-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {work.map((w) => (
            <WorkRow key={w.key} item={w} />
          ))}
        </ul>
      ) : loading ? (
        <LoadingSpinner />
      ) : down.length === 0 && !paged ? (
        <p className="wx-rail-empty" style={{ padding: 0 }}>
          Nothing is waiting on a person for this patient.
        </p>
      ) : null}
      {paged ? (
        <p className="wx-rail-empty" style={{ padding: 0 }}>
          Only the first items of a long list were loaded; more may be waiting.
        </p>
      ) : null}
    </Panel>
  );
}

function WorkRow({ item }: { item: WorkItem }): JSX.Element {
  return (
    <li style={{ display: "grid", gap: "0.125rem", padding: "0.5rem 0" }}>
      <Link to={item.href} className="wx-row-title" style={{ fontSize: "0.875rem" }}>
        {item.nextAction}
        <span className="sr-only"> — {item.what}</span>
      </Link>
      <span style={{ fontSize: "0.75rem" }}>
        {item.what}
        {item.deadlineAt ? ` · due ${fmtDay(item.deadlineAt)}` : ""}
      </span>
      <span>
        <StatusPill label={item.statusLabel} tone={item.statusTone} />
      </span>
    </li>
  );
}
