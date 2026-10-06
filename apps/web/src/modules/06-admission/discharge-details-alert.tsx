import { InlineAlert, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — the admission detail's alert for a discharged / transferred admission whose
// stay-ending record lacks the detail the final Medicare claim needs (place of death / receiving care setting).
// Reads GET /api/v1/admissions/:id/discharge-details only for ended admissions; renders nothing otherwise, or
// when the read fails (the alert is advisory — the claim's own validation is the blocking signal).
import { type JSX, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type MissingDischargeDetail,
  dischargeDetailsPath,
  missingDetailExplanation,
  missingDetailNoun,
} from "../../shell/discharge-claim-codes";

/** Admission states after the stay ended (a transfer-out and every discharge land here). */
const ENDED_STATES = new Set(["discharged", "bereavement", "closed"]);

export function MissingDischargeDetailsAlert({
  admissionId,
  admissionState,
}: {
  admissionId: string;
  admissionState: string;
}): JSX.Element | null {
  const client = useApiClient();
  const [missing, setMissing] = useState<MissingDischargeDetail | null>(null);
  const ended = ENDED_STATES.has(admissionState);

  useEffect(() => {
    if (!ended) {
      setMissing(null);
      return;
    }
    let active = true;
    void Promise.resolve()
      .then(() =>
        client.GET("/api/v1/admissions/{id}/discharge-details", {
          params: { path: { id: admissionId } },
        }),
      )
      .then(({ data, error }) => {
        if (!active) return;
        const m = (data as { missing?: MissingDischargeDetail | null } | undefined)?.missing;
        setMissing(error ? null : (m ?? null));
      })
      .catch(() => {
        if (active) setMissing(null);
      });
    return () => {
      active = false;
    };
  }, [client, admissionId, ended]);

  if (!missing) return null;
  return (
    <InlineAlert tone="info">
      <strong>The final claim is held: the {missingDetailNoun(missing)} is not recorded.</strong>{" "}
      {missingDetailExplanation(missing)}{" "}
      <Link
        to={dischargeDetailsPath(admissionId)}
        style={{ color: "var(--color-primary)", fontWeight: 600 }}
      >
        Record the {missingDetailNoun(missing)}
      </Link>
    </InlineAlert>
  );
}
