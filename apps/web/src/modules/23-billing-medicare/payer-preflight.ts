// Non-mutating payer preflight for the claim assembly screen (#851). Mirrors the D15 gate in the server's
// medicarePrimaryForRange (claim-assembly-seam-adapters.ts) so billing staff learn early; the server's assemble call
// stays AUTHORITATIVE — this is a convenience and never replaces it. Messages carry no identifiers (PHI-free).
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";

export interface PayerCoverageRow {
  id: string;
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

export const PAYER_PREFLIGHT_MESSAGES: Readonly<Partial<Record<PayerPreflightStatus, string>>> = {
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (v: string): string => v.slice(0, 10);
const covers = (row: PayerCoverageRow, date: string): boolean =>
  day(row.effectiveFrom) <= date && (row.effectiveTo === null || day(row.effectiveTo) >= date);

// Like the server's activeCoverageOfKind: among rows of a kind in force on a date, the best (lowest) rank wins.
const bestOfKind = (rows: readonly PayerCoverageRow[], kind: string, date: string) =>
  rows.filter((r) => r.coverageKind === kind && covers(r, date)).sort((x, y) => x.rank - y.rank)[0];

export function classifyPayerCoverage(
  rows: readonly PayerCoverageRow[],
  serviceFrom: string,
  serviceTo: string,
): PayerPreflightStatus {
  const ffs = bestOfKind(rows, "medicare_ffs", serviceFrom);
  const advantage = bestOfKind(rows, "medicare_advantage", serviceFrom);
  // The server needs the SAME coverage row (patient_payer.id) at both ends of the range.
  if (!ffs || ffs.id !== bestOfKind(rows, "medicare_ffs", serviceTo)?.id) {
    return advantage ? "medicare-advantage" : "no-medicare";
  }
  if (ffs.rank === 1) return "ok";
  return advantage && advantage.rank < ffs.rank ? "medicare-advantage" : "non-primary";
}

/** Fetch the patient's coverages when the patient changes; a late response for a previous patient is ignored. */
export function usePayerPreflight(
  patientId: string,
  serviceFrom: string,
  serviceTo: string,
): { status: PayerPreflightStatus; retry: () => void } {
  const client = useApiClient();
  const trimmed = patientId.trim();
  // The route is an audited PHI read: only ever call it for a well-formed patient id (the lookup field emits the
  // selected option id or "", but a restored draft or a typed value must never reach the API as partial text).
  const id = UUID_RE.test(trimmed) ? trimmed : "";
  const [attempt, setAttempt] = useState(0);
  const key = `${id}#${attempt}`;
  // rows === null means the request failed.
  const [loaded, setLoaded] = useState<{ key: string; rows: PayerCoverageRow[] | null } | null>(
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
        setLoaded({ key, rows: error || !Array.isArray(data?.payers) ? null : data.payers });
      })
      .catch(() => {
        if (!stale) setLoaded({ key, rows: null });
      });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [client, id, key]);

  const retry = () => setAttempt((n) => n + 1);
  // Dates decide coverage; wait for a valid range rather than judging on the `current` flag.
  if (id === "" || serviceFrom === "" || serviceTo === "" || serviceFrom > serviceTo) {
    return { status: "idle", retry };
  }
  if (loaded?.key !== key) return { status: "loading", retry };
  if (loaded.rows === null) return { status: "error", retry };
  return { status: classifyPayerCoverage(loaded.rows, serviceFrom, serviceTo), retry };
}
