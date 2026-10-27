import {
  Button,
  EmptyState,
  Glyph,
  InlineAlert,
  KpiCard,
  LoadingSpinner,
  Panel,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import type { paths } from "@chartwarden/ui";
// apps/web/src/modules/41-billing-commercial — COMMERCIAL CLAIM DETAIL (M41, issue #726; spec section 5). One claim with the four
// things a biller needs before it can go out: the PAYER and PLAN, the AUTHORIZATION on file, the COORDINATION OF BENEFITS, and the
// VALIDATION (with audited overrides of soft blocks). Lines are the priced level-of-care stretches.
//   GET  /api/v1/billing/commercial/claims/{id}            claim, plan, authorizations, lines, latest validation (read-audited)
//   POST .../validate | .../ready | .../void                the lifecycle (Idempotency-Key is added by the client)
// An authorization is shown by status and period, never its number. A blocked "ready" is a 409 whose message tells the user what
// to fix; it is shown inline, never as a toast. Authorization to write is the server's; the buttons follow the session's grants.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import { patientLabel, usePatientNames } from "../23-billing-medicare/use-patient-names";
import { authFailureRedirect } from "../23-billing-medicare/write-workflow";
import {
  COMMERCIAL_PATHS,
  authorizationPosture,
  authorizationRequirementLabel,
  claimStateTone,
  dollars,
  filingIndicatorLabel,
  levelOfCareLabel,
  payerKindLabel,
  payerStatusLabel,
  payerStatusTone,
  servicePeriod,
  shortId,
  statusLabel,
} from "./commercial-model";
import { ValidationPanel } from "./validation-panel";

type ClaimView =
  paths["/api/v1/billing/commercial/claims/{id}"]["get"]["responses"][200]["content"]["application/json"];

type Load =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly view: ClaimView };

type Action = "validate" | "ready" | "void";
const ACTION_PATH = {
  validate: "/api/v1/billing/commercial/claims/{id}/validate",
  ready: "/api/v1/billing/commercial/claims/{id}/ready",
  void: "/api/v1/billing/commercial/claims/{id}/void",
} as const;

/** Keyed by claim id so a navigation between claims starts clean (no stale claim, payer name, notice or action error). */
export function CommercialClaimDetail(): JSX.Element {
  const { claimId = "" } = useParams();
  return <ClaimDetailView key={claimId} claimId={claimId} />;
}

const ACTION_NOTICE: Record<Action, string> = {
  validate: "Validation re-run. The results below are current.",
  ready: "The claim is marked ready.",
  void: "The claim is void.",
};

function ClaimDetailView({ claimId }: { claimId: string }): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const permissions = useSession()?.permissions ?? [];
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [payerName, setPayerName] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const voidControls = useRef<HTMLSpanElement>(null);
  const voidWasOpen = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Void swaps one button for Confirm / Keep: move focus into the pair, and back to the first control when it closes.
  useEffect(() => {
    if (confirmVoid || voidWasOpen.current) voidControls.current?.querySelector("button")?.focus();
    voidWasOpen.current = confirmVoid;
  }, [confirmVoid]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/billing/commercial/claims/{id}", { params: { path: { id: claimId } } })
      .then(({ data, response }) => {
        if (!active) return;
        if (data) setLoad({ status: "ready", view: data });
        else setLoad({ status: response.status === 404 ? "missing" : "error" });
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, claimId, reloadKey]);

  const view = load.status === "ready" ? load.view : null;
  const payerId = view?.plan.payerId;
  useEffect(() => {
    if (!payerId) return;
    let active = true;
    void client
      .GET("/api/v1/mdm/{kind}/{id}", { params: { path: { kind: "payer", id: payerId } } })
      .then(({ data }) => {
        if (active) setPayerName(data?.canonical?.displayName ?? null);
      })
      .catch(() => undefined); // the short id stands in
    return () => {
      active = false;
    };
  }, [client, payerId]);

  const names = usePatientNames(client, view ? [view.claim.patientId] : []);

  const run = async (action: Action): Promise<void> => {
    setBusy(action);
    setActionError(null);
    setNotice(null);
    try {
      const { error, response } = await client.POST(ACTION_PATH[action], {
        params: { path: { id: claimId }, header: { "Idempotency-Key": crypto.randomUUID() } },
      });
      if (error) {
        const env = (error as { error?: { code?: string; message?: string } }).error;
        const redirect = authFailureRedirect(response.status, env?.code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        setActionError(
          response.status === 409 && env?.message
            ? env.message
            : response.status === 403
              ? "You are not allowed to do that on this claim."
              : "That did not go through. Reload the claim and try again.",
        );
      }
      if (!error) setNotice(ACTION_NOTICE[action]);
      setConfirmVoid(false);
      reload();
    } catch {
      setActionError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  if (load.status === "loading") {
    return (
      <output className="wx-list-state" aria-live="polite">
        <LoadingSpinner />
      </output>
    );
  }
  if (load.status !== "ready" || !view) {
    return (
      <div className="wx-list-state" role="alert">
        <h1 className="wx-sr-only">Commercial claim</h1>
        <EmptyState
          title={load.status === "missing" ? "Claim not found" : "Claim unavailable"}
          description={
            load.status === "missing"
              ? "This commercial claim does not exist, or it is outside your scope."
              : "The claim could not be loaded."
          }
        />
        <Link to={COMMERCIAL_PATHS.queue} className="wx-btn-secondary">
          Back to the claim queue
        </Link>
      </div>
    );
  }

  const { claim, plan, authorizations, lines, validation } = view;
  const isDraft = claim.state === "draft";
  const canWrite = permissions.includes("commercial_billing.write");
  const canOverride = permissions.includes("commercial_billing.override_validation");
  const auth = authorizationPosture(plan.authorizationRequirement, authorizations, {
    from: claim.serviceFrom,
    to: claim.serviceTo,
    levelsOfCare: lines.map((l) => l.levelOfCare),
  });
  const payerLabel = payerName ?? `Payer ${shortId(plan.payerId)}`;

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        <header className="wx-page-head">
          <div>
            <p className="wx-row-sub">
              <Link to={COMMERCIAL_PATHS.queue}>Commercial claims</Link> /{" "}
              {claim.claimControlNumber}
            </p>
            <h1>Claim {claim.claimControlNumber}</h1>
            <p>
              {patientLabel(names[claim.patientId], claim.patientId)} ·{" "}
              {servicePeriod(claim.serviceFrom, claim.serviceTo)}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.625rem", alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill label={statusLabel(claim.state)} tone={claimStateTone(claim.state)} />
            {canWrite && isDraft ? (
              <>
                <Button
                  tone="secondary"
                  disabled={busy !== null}
                  onClick={() => void run("validate")}
                >
                  {busy === "validate" ? "Validating…" : "Re-validate"}
                </Button>
                <Button disabled={busy !== null} onClick={() => void run("ready")}>
                  {busy === "ready" ? "Checking…" : "Mark ready"}
                </Button>
              </>
            ) : null}
            {canWrite && claim.state !== "void" ? (
              confirmVoid ? (
                <span ref={voidControls} style={{ display: "inline-flex", gap: "0.625rem" }}>
                  <Button
                    tone="secondary"
                    disabled={busy !== null}
                    onClick={() => void run("void")}
                  >
                    {busy === "void" ? "Voiding…" : "Confirm void"}
                  </Button>
                  <Button tone="tertiary" onClick={() => setConfirmVoid(false)}>
                    Keep claim
                  </Button>
                </span>
              ) : (
                <span ref={voidControls}>
                  <Button tone="tertiary" onClick={() => setConfirmVoid(true)}>
                    Void claim
                  </Button>
                </span>
              )
            ) : null}
          </div>
        </header>

        <BillingTabs />

        {actionError ? <InlineAlert tone="error">{actionError}</InlineAlert> : null}
        {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
        {claim.state === "ready" ? (
          <InlineAlert tone="success">
            This claim is validated and ready. Sending arrives with the submission slice.
          </InlineAlert>
        ) : null}

        <div className="wx-stat-grid" aria-label="Claim totals">
          <KpiCard
            icon="receipt"
            label="Charge"
            value={dollars(claim.totalChargeCents)}
            detail={`${lines.length} service lines`}
          />
          <KpiCard
            icon="check-circle"
            label="Expected payment"
            value={claim.expectedPaymentCents === null ? "—" : dollars(claim.expectedPaymentCents)}
            detail="From the plan's contract rates"
          />
          <KpiCard
            icon="file-text"
            label="Type of bill"
            value={claim.tob}
            detail={filingIndicatorLabel(claim.claimFilingIndicator)}
          />
        </div>

        <Panel title="Service lines" icon="clipboard-list" flush>
          <div className="wx-list-table-wrap">
            <table className="wx-list-table wx-list-table-static">
              <caption className="wx-sr-only">Service lines</caption>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Level of care</th>
                  <th scope="col">Revenue code</th>
                  <th scope="col">Dates</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Units
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Rate
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Charge
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.lineNumber}>
                    <td className="wx-nums">{l.lineNumber}</td>
                    <td>{levelOfCareLabel(l.levelOfCare)}</td>
                    <td className="wx-nums">{l.revenueCode}</td>
                    <td className="wx-nums">{servicePeriod(l.serviceFrom, l.serviceTo)}</td>
                    <td className="wx-nums" style={{ textAlign: "right" }}>
                      {l.units}
                    </td>
                    <td className="wx-nums" style={{ textAlign: "right" }}>
                      {l.unitRateCents === null ? "—" : dollars(l.unitRateCents)}
                    </td>
                    <td className="wx-nums" style={{ textAlign: "right" }}>
                      {dollars(l.lineChargeCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Validation" icon="shield-check">
          <ValidationPanel
            claimId={claim.id}
            validation={validation}
            canOverride={canOverride && isDraft}
            onChanged={() => {
              setNotice(
                "Override recorded in the audit trail. Re-validate to see the claim's status.",
              );
              reload();
            }}
          />
        </Panel>
      </div>

      <aside
        className="wx-with-rail-side"
        aria-label="Payer, authorization and coordination of benefits"
      >
        <Panel title="Payer and plan" icon="building">
          <dl className="wx-kv">
            <dt>Payer</dt>
            <dd>{payerLabel}</dd>
            <dt>Plan</dt>
            <dd>{plan.planName}</dd>
            <dt>Filing indicator</dt>
            <dd>{filingIndicatorLabel(claim.claimFilingIndicator)}</dd>
            <dt>Payer in master data</dt>
            <dd>
              <StatusPill
                label={payerStatusLabel(plan.payerStatus)}
                tone={payerStatusTone(plan.payerStatus)}
              />
            </dd>
          </dl>
          <p className="wx-row-sub" style={{ margin: "0.625rem 0 0" }}>
            <Link to={COMMERCIAL_PATHS.payers}>Supported payers</Link>
          </p>
        </Panel>

        <Panel title="Sending and history" icon="clock">
          <ul className="wx-checklist" aria-label="Sending and history">
            <li>
              <span className="wx-checklist-text">
                <Link to={COMMERCIAL_PATHS.sendGate(claim.id)}>Send gate</Link>
              </span>
            </li>
            <li>
              <span className="wx-checklist-text">
                <Link to={COMMERCIAL_PATHS.timeline(claim.id)}>Claim history</Link>
              </span>
            </li>
          </ul>
        </Panel>

        <Panel title="Authorization" icon="shield-check">
          <p style={{ margin: "0 0 0.5rem" }}>
            <StatusPill label={auth.label} tone={auth.tone} />
          </p>
          <p className="wx-row-sub" style={{ margin: "0 0 0.5rem" }}>
            Plan policy: {authorizationRequirementLabel(plan.authorizationRequirement)}
          </p>
          {authorizations.length === 0 ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              No authorization on file for this claim's dates.
            </p>
          ) : (
            <ul className="wx-checklist" aria-label="Authorizations">
              {authorizations.map((a) => (
                <li key={a.id}>
                  <span className="wx-checklist-text">
                    {levelOfCareLabel(a.levelOfCare)} · {a.effectiveFrom} to{" "}
                    {a.effectiveTo ?? "open"}{" "}
                    <StatusPill
                      label={statusLabel(a.status)}
                      tone={a.status === "approved" ? "success" : "neutral"}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Coordination of benefits" icon="link">
          <dl className="wx-kv">
            <dt>Payer kind</dt>
            <dd>{payerKindLabel(claim.secondaryPayerKind)}</dd>
          </dl>
          <p className="wx-row-sub" style={{ margin: "0.625rem 0 0" }}>
            {claim.secondaryPayerKind
              ? `The ${claim.secondaryPayerKind === "medicare" ? "Medicare" : "Medicaid"} other-payer loop is on the 837I, so the secondary payer can pay after this plan.`
              : "No other payer is on this claim; the commercial plan pays alone."}
          </p>
        </Panel>
      </aside>
    </div>
  );
}
