// apps/web/src/modules/09-assessments/wounds — one observation as label/value rows. The registry's history drawer and the
// visit note's wound panel both draw it, so an observation is worded one way wherever it appears.
import type { JSX } from "react";
import { observationRows } from "./wound-format";
import type { WoundObservation } from "./wounds-api";

export function WoundObservationFacts({
  observation,
}: { readonly observation: WoundObservation }): JSX.Element {
  const rows = observationRows(observation);
  if (rows.length === 0) {
    return <span className="wx-text-muted">Nothing was recorded in this observation.</span>;
  }
  return (
    <dl className="wx-kv">
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
