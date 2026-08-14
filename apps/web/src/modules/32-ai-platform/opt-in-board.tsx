import {
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
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
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader title="AI capabilities" breadcrumb="Organization" />
      {outcome ? (
        <output aria-live="polite">
          <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
        </output>
      ) : null}
      {loading && capabilities.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : capabilities.length === 0 ? (
        // Not "no capabilities exist" — the platform has 14; none has reached APPROVED for tenants yet.
        <EmptyState
          title="No capabilities available yet"
          description="No AI capability has reached the approved state where a tenant may opt in."
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))",
            gap: "1rem",
          }}
        >
          {capabilities.map((c) => {
            const optIn = optInByCapability.get(c.id);
            const enrolled = optIn?.status === "active";
            return (
              <section
                key={c.id}
                style={{
                  border: "1px solid var(--color-outline-variant)",
                  borderRadius: "var(--radius-lg, 0.75rem)",
                  background: "var(--color-surface)",
                  padding: "1rem 1.1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.6rem",
                }}
              >
                <header style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                  <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>{c.displayName}</h2>
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
                <p style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
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
                <p style={{ fontSize: "0.78rem", color: "var(--color-on-surface-variant)" }}>
                  {c.clinicianOptOutSupported
                    ? "Individual clinicians may opt out of this capability."
                    : "Clinicians cannot individually opt out of this capability."}
                </p>
                <div style={{ display: "flex", gap: "0.6rem" }}>
                  {enrolled ? (
                    <button type="button" onClick={() => setRevoking(c)} style={buttonStyle(false)}>
                      Revoke
                    </button>
                  ) : (
                    <button type="button" onClick={() => setEnrolling(c)} style={buttonStyle(true)}>
                      Opt in
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

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
              <button type="button" onClick={() => void revoke(revoking)} style={buttonStyle(true)}>
                Revoke
              </button>
              <button type="button" onClick={() => setRevoking(null)} style={buttonStyle(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function buttonStyle(primary: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "0.55rem 1.1rem",
    borderRadius: "var(--radius-md, 0.5rem)",
    border: primary ? "none" : "1px solid var(--color-outline)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-on-primary)" : "var(--color-primary)",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
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
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !complete}
            style={buttonStyle(true, busy || !complete)}
          >
            {busy ? "Submitting…" : "Opt in"}
          </button>
          <button type="button" onClick={onClose} style={buttonStyle(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
