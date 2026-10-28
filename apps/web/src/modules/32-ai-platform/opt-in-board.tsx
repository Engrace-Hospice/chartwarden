import {
  Button,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/web/src/modules/32-ai-platform — M32 §5.3.1 tenant capability opt-in board
// (`/organization/ai/opt-in`, `ai.tenant_opt_in`). GAP-049.
//
// TENANT-SCOPED, SO IT LIVES IN THE TENANT APP. §5.3 routes it under `/admin/organization/ai` in the
// spec's own path vocabulary, but that is a TENANT admin surface — the org_admin of one hospice deciding
// what their clinicians may use — not the platform-ops console apps/admin hosts. It belongs beside the
// other per-module tenant slices, and its permission key (`ai.tenant_opt_in`) is a tenant key.
//
// ONLY APPROVED / MONITORING CAPABILITIES ARE OFFERED. §5.3.1 is explicit, and the reason matters: a
// capability below APPROVED has no published calibration for a clinical reviewer to attest to, so the
// acknowledgment gate below would be attesting to nothing.
//
// THE ACKNOWLEDGMENT GATE IS A GATE, not a form ornament. §5.3.1 lists four acknowledgments and R10
// records them into `disclosure_acknowledgments` for audit; the submit button stays disabled until the
// ones that apply are complete, and the fourth (§164.528 disclosure accounting) applies only to
// high-risk-tier capabilities. Client-side blocking is a courtesy — the route validates too — but a form
// that let an org_admin submit an empty attestation and only learn at the server is a worse ceremony for
// something that ends up in an audit record with their name on it.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];
type Capability = CapabilityPage["capabilities"][number];
type OptInPage =
  operations["getApiV1AiTenantoptin"]["responses"][200]["content"]["application/json"];
type OptIn = OptInPage["optIns"][number];

const ROUTING_MODES = ["default", "prefer_local", "local_only"] as const;

/** Capability states a tenant may be offered (§5.3.1). */
const OFFERABLE = new Set(["APPROVED", "MONITORING"]);

/** `ai_tenant_opt_in_status`. The enrolled state is `active`, NOT `opted_in` — the record's status, not
 *  the act that created it. */
const OPT_IN_TONE: Record<string, "success" | "warning" | "neutral"> = {
  active: "success",
  paused: "warning",
  opted_out: "neutral",
};

const cap = (s: string): string => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function AiOptInBoard(): JSX.Element {
  const client = useApiClient();
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [optIns, setOptIns] = useState<OptIn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [enrolling, setEnrolling] = useState<Capability | null>(null);
  const [revoking, setRevoking] = useState<Capability | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [caps, opts] = await Promise.all([
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
      client.GET("/api/v1/ai/tenant-opt-in", {}),
    ]);
    if (caps.error || opts.error) {
      setError("AI capability catalog unavailable.");
      setLoading(false);
      return;
    }
    setCapabilities(caps.data.capabilities.filter((c) => OFFERABLE.has(c.lifecycleState)));
    setOptIns(opts.data.optIns);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const optInByCapability = useMemo(
    () => new Map(optIns.map((o) => [o.capabilityId, o])),
    [optIns],
  );

  async function revoke(capability: Capability): Promise<void> {
    // `withdraw`, not `pause`: §5.3.1's revoke button is the permanent one — its own confirmation
    // warns that consumer surfaces fall back immediately. A pause is a different affordance.
    const res = await client.DELETE("/api/v1/ai/tenant-opt-in/{capabilityId}", {
      params: { path: { capabilityId: capability.id } },
      body: { mode: "withdraw", reason: null },
    });
    setRevoking(null);
    setOutcome({
      ok: !res.error,
      message: res.error
        ? "Revocation refused."
        : `${capability.displayName} revoked — consumer surfaces fall back immediately.`,
    });
    if (!res.error) void load();
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="AI capabilities"
            actions={
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Opt this organization into approved AI capabilities after the required compliance
              acknowledgments.
            </div>
          </PageHeader>
        }
        filters={
          outcome ? (
            <div style={{ padding: "0.75rem 1.5rem 0" }}>
              <output aria-live="polite">
                <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
              </output>
            </div>
          ) : null
        }
        table={
          loading && capabilities.length === 0 ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : error ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title={error} description="Retry shortly." />
            </div>
          ) : capabilities.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              {/* Not "no capabilities exist" — the platform has 14; none has reached APPROVED for tenants yet. */}
              <EmptyState
                title="No capabilities available yet"
                description="No AI capability has reached the approved state where a tenant may opt in."
              />
            </div>
          ) : (
            <div style={contentStyle}>
              <div style={capabilityGridStyle}>
                {capabilities.map((c) => {
                  const optIn = optInByCapability.get(c.id);
                  const enrolled = optIn?.status === "active";
                  return (
                    <section key={c.id} style={capabilityCardStyle}>
                      <header style={capabilityHeaderStyle}>
                        <h2 style={capabilityTitleStyle}>{c.displayName}</h2>
                        <StatusPill
                          label={`${cap(c.riskTier)} risk`}
                          tone={
                            c.riskTier === "high"
                              ? "critical"
                              : c.riskTier === "medium"
                                ? "warning"
                                : "neutral"
                          }
                        />
                      </header>
                      <p style={mutedTextStyle}>
                        Backend <code>{c.defaultBackendKey}</code>
                        {c.allowedBackendKeys.length > 1
                          ? ` (+${c.allowedBackendKeys.length - 1} fallback)`
                          : null}
                      </p>
                      {optIn ? (
                        <StatusPill
                          label={cap(optIn.status)}
                          tone={OPT_IN_TONE[optIn.status] ?? "neutral"}
                        />
                      ) : (
                        <StatusPill label="Not enrolled" tone="neutral" />
                      )}
                      {/* Stated per card because it is the thing a tenant admin most needs to know before
                          enrolling: their clinicians can still individually decline. */}
                      <p style={mutedTextStyle}>
                        {c.clinicianOptOutSupported
                          ? "Individual clinicians may opt out of this capability."
                          : "Clinicians cannot individually opt out of this capability."}
                      </p>
                      <div style={{ display: "flex", gap: "0.6rem" }}>
                        {enrolled ? (
                          <Button type="button" tone="danger" onClick={() => setRevoking(c)}>
                            Revoke
                          </Button>
                        ) : (
                          <Button type="button" onClick={() => setEnrolling(c)}>
                            Opt in
                          </Button>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          )
        }
        detail={
          <div style={detailStyle}>
            <section style={railSectionStyle}>
              <h3 style={railTitleStyle}>Eligibility</h3>
              <p style={railTextStyle}>
                Only APPROVED and MONITORING capabilities are offered. Lower lifecycle states are
                withheld because there is no published calibration to attest to.
              </p>
            </section>
            <section style={railSectionStyle}>
              <h3 style={railTitleStyle}>Acknowledgments</h3>
              <p style={railTextStyle}>
                Opt-in requires BAA, ZDR, clinical reviewer, calibration trade-off, and high-risk
                disclosure-accounting acknowledgments when applicable.
              </p>
            </section>
          </div>
        }
        fullPageScroll
      />

      {enrolling ? (
        <OptInDialog
          capability={enrolling}
          onClose={() => setEnrolling(null)}
          onDone={(message, ok) => {
            setEnrolling(null);
            setOutcome({ ok, message });
            if (ok) void load();
          }}
        />
      ) : null}

      {revoking ? (
        <Modal
          open
          ariaLabel="Revoke AI capability"
          role="alertdialog"
          onClose={() => setRevoking(null)}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.9rem", padding: "0.5rem" }}
          >
            <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Revoke {revoking.displayName}?</h2>
            <p style={{ fontSize: "0.85rem" }}>
              Consumer surfaces will fall back to their non-AI behaviour immediately for every
              clinician in this organization. This action is logged.
            </p>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <Button type="button" tone="danger" onClick={() => void revoke(revoking)}>
                Revoke
              </Button>
              <Button type="button" tone="secondary" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

const fieldStyle: React.CSSProperties = {
  padding: "0.55rem 0.75rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "1px solid var(--color-outline)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  width: "100%",
};

/** R10 — the §5.3.1 acknowledgment gate. */
function OptInDialog({
  capability,
  onClose,
  onDone,
}: {
  capability: Capability;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [baaReference, setBaaReference] = useState("");
  const [zdrReference, setZdrReference] = useState("");
  const [reviewerMembershipId, setReviewerMembershipId] = useState("");
  const [attestation, setAttestation] = useState("");
  const [disclosureAck, setDisclosureAck] = useState(false);
  const [tradeOffAck, setTradeOffAck] = useState("");
  const [routingMode, setRoutingMode] = useState<string>("default");
  const [pilot, setPilot] = useState(false);
  const [busy, setBusy] = useState(false);

  const highRisk = capability.riskTier === "high";
  // `local_only` is offerable only when the capability declares a local backend among its allowed set —
  // choosing it otherwise would enrol a tenant into a routing mode nothing can serve.
  const localCapable = capability.allowedBackendKeys.some((k) => k.startsWith("local-"));

  const complete =
    baaReference.trim() !== "" &&
    zdrReference.trim() !== "" &&
    reviewerMembershipId.trim() !== "" &&
    attestation.trim() !== "" &&
    tradeOffAck.trim() !== "" &&
    (!highRisk || disclosureAck);

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.POST("/api/v1/ai/tenant-opt-in", {
      body: {
        capabilityId: capability.id,
        routingMode: routingMode as never,
        pilotEnrollment: pilot,
        acknowledgments: {
          baaReference: baaReference.trim(),
          zdrContractReference: zdrReference.trim(),
          clinicalReviewerMembershipId: reviewerMembershipId.trim(),
          clinicalReviewerAttestationText: attestation.trim(),
          disclosureAccountingAcknowledged: highRisk ? disclosureAck : false,
          calibrationTradeOffAcknowledged: tradeOffAck.trim(),
        },
        orgRoutingPreference: (routingMode === "default" ? "prefer_cloud" : routingMode) as never,
      },
    });
    setBusy(false);
    onDone(
      res.error ? "Opt-in refused." : `${capability.displayName} enabled for this organization.`,
      !res.error,
    );
  }

  return (
    <Modal open ariaLabel="Opt in to AI capability" onClose={onClose} width="38rem">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.8rem",
          padding: "0.5rem",
          maxHeight: "70vh",
          overflowY: "auto",
        }}
      >
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Opt in — {capability.displayName}</h2>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>BAA reference covering generative AI processing</span>
          <input
            value={baaReference}
            onChange={(e) => setBaaReference(e.target.value)}
            style={fieldStyle}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Zero-Data-Retention contract reference</span>
          <input
            value={zdrReference}
            onChange={(e) => setZdrReference(e.target.value)}
            style={fieldStyle}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Clinical reviewer (membership id)</span>
          <input
            value={reviewerMembershipId}
            onChange={(e) => setReviewerMembershipId(e.target.value)}
            style={fieldStyle}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>
            Clinical reviewer attestation — that the current calibration and its trade-offs are
            appropriate for this patient population
          </span>
          <textarea
            value={attestation}
            onChange={(e) => setAttestation(e.target.value)}
            rows={3}
            style={fieldStyle}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Calibration trade-off acknowledgment</span>
          <textarea
            value={tradeOffAck}
            onChange={(e) => setTradeOffAck(e.target.value)}
            rows={2}
            style={fieldStyle}
          />
        </label>
        {highRisk ? (
          <label style={{ display: "flex", gap: "0.5rem", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={disclosureAck}
              onChange={(e) => setDisclosureAck(e.target.checked)}
            />
            <span>
              We acknowledge the §164.528 disclosure-accounting implications of this high-risk
              capability.
            </span>
          </label>
        ) : null}
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Routing mode</span>
          <select
            value={routingMode}
            onChange={(e) => setRoutingMode(e.target.value)}
            style={fieldStyle}
          >
            {ROUTING_MODES.filter((m) => m !== "local_only" || localCapable).map((m) => (
              <option key={m} value={m}>
                {cap(m)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", gap: "0.5rem", fontSize: "0.85rem" }}>
          <input type="checkbox" checked={pilot} onChange={(e) => setPilot(e.target.checked)} />
          <span>Enrol as a pilot tenant</span>
        </label>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !complete}
            loading={busy}
          >
            Opt in
          </Button>
          <Button type="button" tone="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const contentStyle = {
  padding: "0 1.5rem 1.5rem",
};

const capabilityGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))",
  gap: "1rem",
};

const capabilityCardStyle = {
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
} as const;

const capabilityHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "0.5rem",
};

const capabilityTitleStyle = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const mutedTextStyle = {
  margin: 0,
  fontSize: "0.78rem",
  color: "var(--color-on-surface-variant)",
};

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
} as const;

const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
} as const;

const railTextStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
