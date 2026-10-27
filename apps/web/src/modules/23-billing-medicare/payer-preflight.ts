// Non-mutating payer preflight for the claim assembly screen (#851). Mirrors the D15 gate in the server's
// medicarePrimaryForRange (claim-assembly-seam-adapters.ts) so billing staff learn early; the server's assemble call
// stays AUTHORITATIVE — this is a convenience and never replaces it. Messages carry no identifiers (PHI-free).
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";

export interface PayerCoverageRow {
  coverageKind: string;
  rank: number;
  current: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type PayerPreflightStatus =
  | "idle"
  | "loading"
  | "error"
  | "no-medicare"
  | "medicare-advantage"
  | "non-primary"
  | "ok";

export const BLOCKING_STATUSES: ReadonlySet<PayerPreflightStatus> = new Set([
  "no-medicare",
  "medicare-advantage",
  "non-primary",
]);

export const PAYER_PREFLIGHT_MESSAGES: Readonly<Record<string, string>> = {
  loading: "Checking the patient's payer coverage…",
  error:
    "Payer coverage could not be checked. You can still assemble — the server re-checks the payer.",
  "no-medicare":
    "No Original Medicare (medicare_ffs) coverage covers this service period, so a Medicare claim cannot be assembled. Record the coverage on the patient's chart, or bill under Billing - Commercial.",
  "medicare-advantage":
    "This patient is a Medicare Advantage enrollee without Original Medicare as the primary coverage. Hospice is billed as an Original Medicare claim: record medicare_ffs with the MBI as primary alongside the Medicare Advantage row.",
  "non-primary":
    "Original Medicare is on file but is not the primary payer for this service period (D15). A commercial primary payer is billed under Billing - Commercial.",
  ok: "Original Medicare is the primary payer for this service period.",
};

// Coverage in force on a date; with no date yet, fall back to the server's `current` flag.
const covers = (row: PayerCoverageRow, date: string): boolean =>
  date === ""
    ? row.current
    : row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo >= date);

export function classifyPayerCoverage(
  rows: readonly PayerCoverageRow[],
  serviceFrom: string,
  serviceTo: string,
): PayerPreflightStatus {
  const ffs = rows.find(
    (r) => r.coverageKind === "medicare_ffs" && covers(r, serviceFrom) && covers(r, serviceTo),
  );
  const advantage = rows.find(
    (r) => r.coverageKind === "medicare_advantage" && covers(r, serviceFrom),
  );
  if (!ffs) return advantage ? "medicare-advantage" : "no-medicare";
  if (ffs.rank === 1) return "ok";
  return advantage && advantage.rank < ffs.rank ? "medicare-advantage" : "non-primary";
}

/** Fetch the patient's coverages when the patient changes; a late response for a previous patient is ignored. */
export function usePayerPreflight(
  patientId: string,
  serviceFrom: string,
  serviceTo: string,
): PayerPreflightStatus {
  const client = useApiClient();
  const id = patientId.trim();
  // rows === null means the request failed.
  const [loaded, setLoaded] = useState<{ id: string; rows: PayerCoverageRow[] | null } | null>(
    null,
  );

  useEffect(() => {
    if (id === "") return;
    let stale = false;
    const controller = new AbortController();
    client
      .GET("/api/v1/patients/{id}/payers", {
        params: { path: { id } },
        signal: controller.signal,
      })
      .then(({ data, error }) => {
        if (stale) return;
        setLoaded({ id, rows: error || !Array.isArray(data?.payers) ? null : (data.payers as PayerCoverageRow[]) });
      })
      .catch(() => {
        if (!stale) setLoaded({ id, rows: null });
      });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [client, id]);

  if (id === "") return "idle";
  if (loaded?.id !== id) return "loading";
  if (loaded.rows === null) return "error";
  return classifyPayerCoverage(loaded.rows, serviceFrom, serviceTo);
}
