import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — medication-order detail (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail" (medication detail / the
// prescribe modal in sign-only mode). View of a single medication order: drug + sig facts, the §2.2
// D2 lifecycle status, the controlled-substance / EPCS posture, the prescriber + pharmacy, the signature
// posture, refills remaining, and the correction lineage (replaces / derived-from-refill). For a transmitted
// order it also loads the DoseSpot transmission status + retry history (§2.6).
//
// #91 — the §2.2 write ceremonies are here now, offered by the order's CURRENT status. The server still
// decides every one of them (`transitionMedicationOrder`); narrowing the offer keeps a prescriber from
// being shown a ceremony that will certainly be refused, and a refusal is still rendered where they are
// looking. `sign-controlled` (the EPCS two-step) is deliberately NOT offered: §2.4/D18 ships Phase 1
// `not_certified`, so `requestSignature` refuses a controlled order outright and the ceremony would
// always fail — see `prescribe-modal.tsx`, which reads that status rather than assuming it.
// The SERVER enforces every scope incl. ABAC (ADR-0030 — out-of-scope orders 404, never 403).
// Reads GET /api/v1/medication-orders/:id and (when transmitted) GET .../transmission.
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { type MedicationAction, MedicationActionModal } from "./medication-action-modal";
import { MED_ORDER_TONE, SEND_TONE, controlledLabel, stateLabel } from "./medication-status";

interface MedicationOrderView {
  id: string;
  patientId: string;
  admissionId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  doseForm: string;
  route: string;
  rxnormRxcui: string | null;
  ndc: string | null;
  prescriberDiscipline: string;
  prescribingPhysicianMdmId: string;
  dispensingPharmacyMdmId: string | null;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  cosignRequired: boolean;
  cosignStatus: "pending" | "attached" | null;
  refillsRemaining: number;
  derivedFromRefillId: string | null;
  replacesMedicationOrderId: string | null;
  signedAt: string | null;
  signedBy: string | null;
  transmittedAt: string | null;
  discontinuedAt: string | null;
  discontinuationReason: string | null;
  createdAt: string;
}

interface TransmissionView {
  orderId: string;
  status: string;
  retryHistory: { attempt: number; at: string; errorClass: string | null }[];
}

const ACTION_LABEL: Record<MedicationAction, string> = {
  "request-signature": "Send for signature",
  sign: "Sign",
  cosign: "Cosign",
  verbal: "Record verbal",
  discontinue: "Discontinue",
  complete: "Complete",
};

function dateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div style={fact}>
      <dt style={term}>{label}</dt>
      <dd style={description}>{children}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={card} aria-label={title}>
      <h2 style={sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

export function MedicationDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<MedicationOrderView | null>(null);
  const [tx, setTx] = useState<TransmissionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [txError, setTxError] = useState(false);
  const [action, setAction] = useState<MedicationAction | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger a completed write bumps, not read in the body.
  useEffect(() => {
    let active = true;
    setRow(null);
    setTx(null);
    setTxError(false);
    setError(null);
    setLoading(true);
    if (!id) {
      setError("Medication order ID is missing.");
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void (async () => {
      try {
        const { data, error: fetchError } = await client.GET("/api/v1/medication-orders/{id}", {
          params: { path: { id } },
        });
        if (!active) return;
        if (fetchError || !data) {
          setError("Could not load the medication order.");
          return;
        }
        const order = data as MedicationOrderView;
        setRow(order);
        if (order.transmittedAt) {
          try {
            const { data: transmission, error: transmissionError } = await client.GET(
              "/api/v1/medication-orders/{id}/transmission",
              {
                params: { path: { id } },
              },
            );
            if (!active) return;
            if (transmissionError || !transmission) setTxError(true);
            else setTx(transmission as TransmissionView);
          } catch {
            if (active) setTxError(true);
          }
        }
      } catch {
        if (active) setError("Could not load the medication order.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, id, reloadKey]);

  /** The §2.2 transitions this order's CURRENT status permits. The server decides; this narrows the
   *  offer so a prescriber is not shown a ceremony that will certainly be refused (#91). */
  const offered: MedicationAction[] =
    row === null
      ? []
      : row.status === "draft"
        ? ["request-signature"]
        : row.status === "pending_signature"
          ? ["sign"]
          : row.status === "verbal_pending"
            ? ["sign", "cosign"]
            : row.status === "active"
              ? ["discontinue", "complete", ...(row.cosignRequired ? (["cosign"] as const) : [])]
              : [];

  return (
    <PatientWorkspaceLayout
      banner={
        <PageHeader
          title="Medication order"
          breadcrumb={
            row ? (
              <button
                type="button"
                onClick={() => navigate(`/patients/${row.patientId}/medications${location.search}`)}
              >
                ← Medications
              </button>
            ) : undefined
          }
          actions={
            row ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                {row.status === "draft" ? (
                  <Button
                    tone="secondary"
                    onClick={() => navigate(`/medication-orders/${row.id}/edit${location.search}`)}
                  >
                    Edit draft
                  </Button>
                ) : null}
                {offered.map((a) => (
                  <Button key={a} tone="tertiary" onClick={() => setAction(a)}>
                    {ACTION_LABEL[a]}
                  </Button>
                ))}
              </span>
            ) : undefined
          }
        >
          {row ? <span style={muted}>Created {dateTime(row.createdAt)}</span> : null}
        </PageHeader>
      }
    >
      {row && action ? (
        <MedicationActionModal
          open
          action={action}
          orderId={row.id}
          onClose={() => setAction(null)}
          onDone={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {row ? <ChartModuleRail patientId={row.patientId} current="medications" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          {loading ? (
            <LoadingSpinner />
          ) : error || !row ? (
            <EmptyState
              title="Medication order unavailable"
              description={error ?? "Could not load the medication order."}
            />
          ) : (
            <div style={page}>
              <section style={hero} aria-labelledby="medication-title">
                <div style={heroTop}>
                  <div style={{ minWidth: 0 }}>
                    <p style={eyebrow}>Medication prescription</p>
                    <h1 id="medication-title" style={drugTitle}>
                      {row.drugName}
                    </h1>
                    <p style={drugSubtitle}>
                      {[row.strength, row.doseForm, row.route].filter(Boolean).join(" · ") ||
                        "Strength, form and route not recorded"}
                    </p>
                  </div>
                  <div style={badges}>
                    <StatusPill
                      label={stateLabel(row.status)}
                      tone={MED_ORDER_TONE[row.status] ?? "neutral"}
                    />
                    {row.isControlledSubstance ? (
                      <StatusPill
                        label={controlledLabel(row.deaSchedule)}
                        tone="critical"
                        glyph="alert"
                      />
                    ) : null}
                  </div>
                </div>
                <div style={heroSummary}>
                  <span>
                    <strong>{row.refillsRemaining}</strong> refills remaining
                  </span>
                  <span>
                    Signed: <strong>{row.signedAt ? "Yes" : "No"}</strong>
                  </span>
                  <span>
                    Transmitted: <strong>{row.transmittedAt ? "Yes" : "No"}</strong>
                  </span>
                </div>
              </section>

              <div style={columns}>
                <div style={stack}>
                  <Section title="Prescription">
                    <dl style={facts}>
                      <Fact label="Medication class">{stateLabel(row.medClass)}</Fact>
                      <Fact label="Strength">{row.strength || "—"}</Fact>
                      <Fact label="Dose form">{row.doseForm || "—"}</Fact>
                      <Fact label="Route">{row.route || "—"}</Fact>
                      <Fact label="RxNorm RxCUI">
                        <span className="wx-data-md">{row.rxnormRxcui || "—"}</span>
                      </Fact>
                      <Fact label="NDC">
                        <span className="wx-data-md">{row.ndc || "—"}</span>
                      </Fact>
                    </dl>
                  </Section>
                  <Section title="Prescriber and pharmacy">
                    <dl style={facts}>
                      <Fact label="Prescriber">
                        <span className="wx-data-md">{row.prescribingPhysicianMdmId}</span>
                      </Fact>
                      <Fact label="Discipline">{stateLabel(row.prescriberDiscipline)}</Fact>
                      <Fact label="Dispensing pharmacy">
                        <span className="wx-data-md">
                          {row.dispensingPharmacyMdmId || "Not selected"}
                        </span>
                      </Fact>
                    </dl>
                  </Section>
                </div>
                <div style={stack}>
                  <Section title="Signature and safety">
                    <dl style={facts}>
                      <Fact label="Controlled substance">
                        {row.isControlledSubstance ? (
                          <StatusPill
                            label={controlledLabel(row.deaSchedule)}
                            tone="critical"
                            glyph="alert"
                          />
                        ) : (
                          "No"
                        )}
                      </Fact>
                      <Fact label="Signed">
                        {row.signedAt ? dateTime(row.signedAt) : "Not signed"}
                      </Fact>
                      {row.signedAt ? (
                        <Fact label="Signed by">
                          <span className="wx-data-md">{row.signedBy || "—"}</span>
                        </Fact>
                      ) : null}
                      <Fact label="Cosignature">
                        {row.cosignRequired ? (
                          <StatusPill
                            label={stateLabel(row.cosignStatus ?? "pending")}
                            tone={row.cosignStatus === "attached" ? "success" : "warning"}
                          />
                        ) : (
                          "Not required"
                        )}
                      </Fact>
                    </dl>
                  </Section>
                  <Section title="Transmission">
                    {row.transmittedAt ? (
                      <>
                        <p style={muted}>Sent {dateTime(row.transmittedAt)}</p>
                        {tx ? (
                          <>
                            <StatusPill
                              label={stateLabel(tx.status)}
                              tone={SEND_TONE[tx.status] ?? "neutral"}
                            />
                            {tx.retryHistory.length ? (
                              <div style={history}>
                                <h3 style={historyTitle}>
                                  Retry history ({tx.retryHistory.length})
                                </h3>
                                <ol style={retryList}>
                                  {tx.retryHistory.map((attempt) => (
                                    <li key={`${attempt.attempt}-${attempt.at}`} style={retryItem}>
                                      <strong>Attempt {attempt.attempt}</strong>
                                      <span>{dateTime(attempt.at)}</span>
                                      {attempt.errorClass ? (
                                        <span>{stateLabel(attempt.errorClass)}</span>
                                      ) : null}
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            ) : (
                              <p style={muted}>No retries recorded.</p>
                            )}
                          </>
                        ) : (
                          <p role={txError ? "alert" : "status"} style={muted}>
                            {txError
                              ? "Transmission details are unavailable."
                              : "Loading transmission details…"}
                          </p>
                        )}
                      </>
                    ) : (
                      <p style={muted}>Not transmitted.</p>
                    )}
                  </Section>
                </div>
              </div>
              {row.replacesMedicationOrderId || row.derivedFromRefillId || row.discontinuedAt ? (
                <Section title="Order history">
                  <dl style={facts}>
                    {row.replacesMedicationOrderId ? (
                      <Fact label="Corrects order">
                        <span className="wx-data-md">{row.replacesMedicationOrderId}</span>
                      </Fact>
                    ) : null}
                    {row.derivedFromRefillId ? (
                      <Fact label="From refill">
                        <span className="wx-data-md">{row.derivedFromRefillId}</span>
                      </Fact>
                    ) : null}
                    {row.discontinuedAt ? (
                      <Fact label="Discontinued">
                        {dateTime(row.discontinuedAt)}
                        {row.discontinuationReason
                          ? ` · ${stateLabel(row.discontinuationReason)}`
                          : ""}
                      </Fact>
                    ) : null}
                  </dl>
                </Section>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

const page = { display: "grid", gap: "1rem", paddingBottom: "2rem" } as const;
const card = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
  background: "var(--color-surface)",
  padding: "1.25rem",
  minWidth: 0,
} as const;
const hero = { ...card, padding: "1.5rem" };
const heroTop = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "1rem",
  alignItems: "flex-start",
  justifyContent: "space-between",
};
const eyebrow = {
  margin: "0 0 .4rem",
  fontSize: ".75rem",
  fontWeight: 500,
  color: "var(--color-on-surface-variant)",
};
const drugTitle = {
  margin: 0,
  fontSize: "clamp(1.35rem, 2vw, 1.8rem)",
  lineHeight: 1.25,
  overflowWrap: "anywhere" as const,
};
const drugSubtitle = {
  margin: ".4rem 0 0",
  color: "var(--color-on-surface-variant)",
  lineHeight: 1.5,
};
const badges = { display: "flex", flexWrap: "wrap" as const, gap: ".5rem" };
const heroSummary = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: ".5rem 1.5rem",
  borderTop: "1px solid var(--color-outline-variant)",
  paddingTop: "1rem",
  marginTop: "1.25rem",
  fontSize: ".875rem",
};
const columns = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 24rem), 1fr))",
  gap: "1rem",
  alignItems: "start",
} as const;
const stack = { display: "grid", gap: "1rem", minWidth: 0 } as const;
const sectionTitle = { margin: "0 0 1rem", fontSize: "1rem" };
const facts = { display: "grid", gap: 0, margin: 0 } as const;
const fact = {
  display: "grid",
  gridTemplateColumns: "minmax(8rem, 38%) minmax(0, 1fr)",
  gap: ".75rem",
  padding: ".65rem 0",
  borderTop: "1px solid var(--color-outline-variant)",
} as const;
const term = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".85rem",
} as const;
const description = {
  margin: 0,
  minWidth: 0,
  overflowWrap: "anywhere" as const,
  fontSize: ".875rem",
};
const muted = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".875rem",
  lineHeight: 1.5,
} as const;
const history = { marginTop: "1rem" } as const;
const historyTitle = { margin: "0 0 .5rem", fontSize: ".875rem" } as const;
const retryList = { margin: 0, paddingLeft: "1.25rem" } as const;
const retryItem = {
  display: "flex",
  gap: ".5rem 1rem",
  flexWrap: "wrap" as const,
  padding: ".35rem 0",
  fontSize: ".85rem",
};
