// apps/web/src/modules/06-admission — the live HETS hospice-period answer inside the benefit-period field (readmission
// and New admission). `useHetsHospicePeriods` reads GET /api/v1/billing/eligibility/hospice-periods?patientId=
// (&electionDate= on the readmission screen, for the RHC carry-over) through
// the typed client; `HetsPeriodPanel` shows it. A 403 (no `billing.eligibility.read`) or an unconfigured HETS falls
// back to the manual checkbox flow with a quiet hint — never an error banner, never a block.
//
// "Run HETS check" (only with `billing.eligibility.check`) POSTs /api/v1/billing/eligibility/check with an
// Idempotency-Key (202: the worker runs the 270/271), then polls the read until a newer check lands.
import { Button, InlineAlert, useApiClient } from "@wardenx/ui";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { ProviderEntityLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import {
  type HetsAdvice,
  type HetsHospicePeriodsView,
  type HetsLoad,
  hetsAnswerChanged,
} from "./hets-model";

export const HETS_CHECK_PERMISSION = "billing.eligibility.check";
const DEFAULT_POLL_MS = 3000;
const MAX_POLLS = 10;

export interface HetsHandle {
  load: HetsLoad;
  canCheck: boolean;
  checking: boolean;
  checkMessage: string | null;
  runCheck: (providerEntityId: string, asOfServiceDate: string) => Promise<void>;
}

type FetchResult = HetsLoad | { kind: "idle" };

/**
 * The HETS hospice-period read for a patient (`null` patient → idle). `pollMs` is for tests. With `electionDate`
 * the view also carries the two-tier RHC carry-over a new election on that date starts with (`rhcCarryOver`).
 */
export function useHetsHospicePeriods(
  patientId: string | null | undefined,
  opts: { pollMs?: number; electionDate?: string } = {},
): HetsHandle {
  const electionDate =
    opts.electionDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.electionDate)
      ? opts.electionDate
      : undefined;
  const client = useApiClient();
  const session = useSession();
  const canCheck = session?.permissions?.includes(HETS_CHECK_PERMISSION) ?? false;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const [load, setLoad] = useState<HetsLoad>({ kind: "idle" });
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchView = useCallback(
    async (id: string): Promise<FetchResult> => {
      try {
        const { data, error, response } = await client.GET(
          "/api/v1/billing/eligibility/hospice-periods",
          { params: { query: { patientId: id, ...(electionDate ? { electionDate } : {}) } } },
        );
        if (response?.status === 403) return { kind: "unavailable", reason: "forbidden" };
        if (error || !data) return { kind: "unavailable", reason: "error" };
        const view = data as unknown as HetsHospicePeriodsView;
        if (view.status === "hets_not_configured")
          return { kind: "unavailable", reason: "not_configured" };
        return { kind: "loaded", view };
      } catch {
        return { kind: "unavailable", reason: "error" };
      }
    },
    [client, electionDate],
  );

  useEffect(() => {
    if (!patientId) {
      setLoad({ kind: "idle" });
      return;
    }
    let active = true;
    setLoad({ kind: "loading" });
    void fetchView(patientId).then((r) => {
      if (active) setLoad(r);
    });
    return () => {
      active = false;
    };
  }, [patientId, fetchView]);

  const runCheck = useCallback(
    async (providerEntityId: string, asOfServiceDate: string) => {
      if (!patientId) return;
      const before = load.kind === "loaded" ? load.view : null;
      setChecking(true);
      setCheckMessage(null);
      const idem =
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const { error, response } = await client.POST("/api/v1/billing/eligibility/check", {
        headers: { "Idempotency-Key": idem },
        body: { patientId, providerEntityId, asOfServiceDate },
      });
      if (error || (response && response.status !== 202)) {
        if (!mounted.current) return;
        setChecking(false);
        setCheckMessage(
          response?.status === 403
            ? "You are not permitted to run a HETS check."
            : "The HETS check could not be started. Confirm the period manually.",
        );
        return;
      }
      for (let i = 0; i < MAX_POLLS; i += 1) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (!mounted.current) return;
        const r = await fetchView(patientId);
        if (r.kind === "loaded" && hetsAnswerChanged(before, r.view)) {
          if (!mounted.current) return;
          setLoad(r);
          setChecking(false);
          return;
        }
      }
      if (!mounted.current) return;
      setChecking(false);
      setCheckMessage(
        "The HETS check is still running. Come back to this step in a minute, or confirm the period manually.",
      );
    },
    [client, fetchView, load, patientId, pollMs],
  );

  return { load, canCheck, checking, checkMessage, runCheck };
}

/** The HETS line(s) of the benefit-period field. */
export function HetsPeriodPanel({
  idPrefix,
  advice,
  handle,
  serviceDate,
  onUsePeriod,
}: {
  idPrefix: string;
  advice: HetsAdvice;
  handle: HetsHandle;
  serviceDate: string;
  onUsePeriod: (p: { sequence: number; confirmedOn: string }) => void;
}): JSX.Element | null {
  const [providerEntityId, setProviderEntityId] = useState("");
  const [providerLabel, setProviderLabel] = useState("");
  const nothing =
    !advice.hint && !advice.info && !advice.offerCheck && !handle.checkMessage && !handle.checking;
  if (nothing) return null;
  return (
    <div style={{ display: "grid", gap: "0.5rem" }} data-testid={`${idPrefix}-hets`}>
      {advice.info ? (
        <InlineAlert tone="info">
          {advice.sandbox ? <strong>[Sandbox data — not real CMS] </strong> : null}
          {advice.info}
          {advice.usePeriod ? (
            <>
              {" "}
              <Button
                type="button"
                size="sm"
                tone="secondary"
                onClick={() => advice.usePeriod && onUsePeriod(advice.usePeriod)}
              >
                Use period {advice.usePeriod.sequence}
              </Button>
            </>
          ) : null}
        </InlineAlert>
      ) : advice.sandbox ? (
        <p className="wx-hope-field-hint">
          <strong>Sandbox data — not real CMS.</strong>
        </p>
      ) : null}
      {advice.hint ? <p className="wx-hope-field-hint">{advice.hint}</p> : null}
      {advice.offerCheck ? (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          <ProviderEntityLookupField
            label="Provider entity for the HETS check"
            value={providerEntityId}
            valueLabel={providerLabel}
            onChange={(value, option) => {
              setProviderEntityId(value);
              setProviderLabel(typeof option?.searchLabel === "string" ? option.searchLabel : "");
            }}
          />
          <div>
            <Button
              type="button"
              size="sm"
              tone="secondary"
              disabled={!providerEntityId || handle.checking}
              onClick={() => void handle.runCheck(providerEntityId, serviceDate)}
            >
              {handle.checking
                ? "Checking HETS…"
                : advice.offerCheck === "recheck"
                  ? "Re-check HETS"
                  : "Run HETS check"}
            </Button>
          </div>
        </div>
      ) : null}
      {handle.checkMessage ? <p className="wx-hope-field-hint">{handle.checkMessage}</p> : null}
    </div>
  );
}
