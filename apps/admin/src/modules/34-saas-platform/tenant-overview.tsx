import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/34-saas — M34 SaaS Tenant Platform, the §5.2 single-page-of-truth (R2).
// Spec §5.2 (`/tenants/:orgSlug`) — the tenant overview: a context header (identity + lifecycle pill +
// action menu) over the FIVE cards. Backed by GET /api/v1/platform/tenants/{orgSlug} (TenantOverview)
// via the generated typed client; reads run under withPlatformContext server-side (F03/F09 audited).
// The command CTAs POST the §4.1 enqueue routes; the cryptographic shred is the §10 'critical' tone
// paired with the Guardrail CeremonyModal confirm-by-typing ceremony (§5.2 Card 1 / §5.3 / §6 D10).
// Lantern: No-Line cards, mono identifiers (wx-data-md), tabular-nums, CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { BAA_TONE, cap, lifecycleTone, statusLabel } from "./saas-status";

interface StatusEvent {
  id: string;
  toStatus: string;
  occurredAt: string;
  reason: string;
}

interface TenantOverview {
  id: string;
  organizationId: string;
  orgSlug: string;
  legalBusinessName: string;
  status: string;
  planLabel: string;
  createdAt: string;
  updatedAt: string;
  latestStatusEvent: StatusEvent | null;
  keyRing: {
    currentDekVersion: string;
    dekLastRotatedAt: string | null;
    destroyedAt: string | null;
  } | null;
  onboarding: { totalTasks: number; doneTasks: number; currentStep: string | null };
  baa: { status: string; expiresOn: string | null } | null;
  activeGrants: number;
  activeSessions: number;
}

// The screen reads :orgSlug from the route; until the Register phase wires routing, fall back to the
// last path segment so the live-wired component renders against the real path it is mounted at.
function orgSlugFromPath(): string {
  const segs = window.location.pathname.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

export function TenantOverview(): JSX.Element {
  const client = useApiClient();
  const [orgSlug] = useState(orgSlugFromPath);
  const [tenant, setTenant] = useState<TenantOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shredOpen, setShredOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/tenants/{orgSlug}", {
      params: { path: { orgSlug } },
    });
    if (err) {
      setError("Tenant not found.");
      setLoading(false);
      return;
    }
    setTenant(data as unknown as TenantOverview);
    setLoading(false);
  }, [client, orgSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotateDek = useCallback(async () => {
    const { error: err } = await client.POST("/api/v1/platform/tenants/{orgSlug}/dek-rotate", {
      params: { path: { orgSlug } },
      // TODO(M34 web): this stub screen should collect the rotation reason from an operator input.
      body: { reason: "Manual DEK rotation via platform console" },
    });
    if (!err) void load();
  }, [client, orgSlug, load]);

  const confirmShred = useCallback(async () => {
    await client.POST("/api/v1/platform/tenants/{orgSlug}/shred", {
      params: { path: { orgSlug } },
      // TODO(M34 web): this stub screen should collect the transition reason + destruction-certificate id.
      body: {
        transitionReason: "Tenant offboarding via platform console",
        destructionCertificateId: "",
      },
    });
    setShredOpen(false);
    void load();
  }, [client, orgSlug, load]);

  if (loading) return <LoadingSpinner />;
  if (error || !tenant)
    return <EmptyState title="Unavailable" description={error ?? "No tenant."} />;

  const shreddable = tenant.status === "destruction_pending";

  return (
    <>
      <DetailPageLayout
        header={
          <PageHeader
            title={tenant.legalBusinessName}
            breadcrumb={
              <>
                <span className="wx-data-md">{tenant.orgSlug}</span> · {tenant.planLabel}
              </>
            }
            actions={
              <>
                <StatusPill
                  label={statusLabel(tenant.status)}
                  tone={lifecycleTone(tenant.status)}
                />
                {shreddable ? (
                  <button
                    type="button"
                    onClick={() => setShredOpen(true)}
                    style={{ color: "var(--color-alert)" }}
                  >
                    Cryptographic shred
                  </button>
                ) : null}
              </>
            }
          />
        }
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
            gap: "1rem",
          }}
        >
          <LifecycleCard tenant={tenant} />
          <OnboardingCard tenant={tenant} />
          <KeyRingCard tenant={tenant} onRotate={() => void rotateDek()} />
          <SupportCard tenant={tenant} />
          <ExportsCard />
        </div>
      </DetailPageLayout>

      {/* §5.2 Card 1 / §6 D10 — the shred is irreversible: confirm-by-typing the legal business name. */}
      <CeremonyModal
        open={shredOpen}
        title="Cryptographic shred"
        epcs
        attestation={
          <>
            This permanently destroys the DEK for <strong>{tenant.legalBusinessName}</strong> (
            <span className="wx-data-md">{tenant.orgSlug}</span>). All tenant PHI becomes
            cryptographically irrecoverable. This cannot be undone.
          </>
        }
        legalText="I confirm the retention period has elapsed, no legal hold is active, and the M4 destruction certificate is approved."
        signer={{ name: "Platform Operator", role: "platform_ops" }}
        stepUp={{
          type: "text",
          label: "Type the legal business name to confirm",
          placeholder: tenant.legalBusinessName,
        }}
        commitLabel="Shred tenant key"
        onCommit={(typed) => {
          if (
            (typed ?? "").trim().toLowerCase() === tenant.legalBusinessName.trim().toLowerCase()
          ) {
            void confirmShred();
          }
        }}
        onCancel={() => setShredOpen(false)}
      />
    </>
  );
}

// ── card shell (No-Line: surface-lowest fill + soft shadow + xl radius, no border) ───────────────────
function Card({
  title,
  cta,
  children,
}: { title: ReactNode; cta?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section
      style={{
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl, 1rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2
          style={{
            margin: 0,
            fontSize: "0.6875rem",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--color-on-surface-variant)",
          }}
        >
          {title}
        </h2>
        {cta}
      </header>
      {children}
    </section>
  );
}

const fieldLabel = { fontSize: "0.7rem", color: "var(--color-on-surface-variant)" } as const;
const fieldValue = { fontSize: "0.9rem", color: "var(--color-on-surface)" } as const;
const ctaButton: React.CSSProperties = { fontSize: "0.75rem" };

// ── Card 1 — Lifecycle: current status + last status event + Transition CTA ──────────────────────────
function LifecycleCard({ tenant }: { tenant: TenantOverview }): JSX.Element {
  const ev = tenant.latestStatusEvent;
  return (
    <Card
      title="Lifecycle"
      cta={
        <button type="button" style={ctaButton}>
          Transition status
        </button>
      }
    >
      <div>
        <StatusPill label={statusLabel(tenant.status)} tone={lifecycleTone(tenant.status)} />
      </div>
      <div>
        <div style={fieldLabel}>Last status event</div>
        {ev ? (
          <div style={fieldValue}>
            {statusLabel(ev.toStatus)}{" "}
            <span className="tabular-nums" style={{ color: "var(--color-on-surface-variant)" }}>
              · {new Date(ev.occurredAt).toLocaleString()}
            </span>
            {ev.reason ? (
              <div style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
                {ev.reason}
              </div>
            ) : null}
          </div>
        ) : (
          <div style={fieldValue}>—</div>
        )}
      </div>
    </Card>
  );
}

// ── Card 2 — Onboarding: eleven-step progress + Open onboarding CTA ───────────────────────────────────
function OnboardingCard({ tenant }: { tenant: TenantOverview }): JSX.Element {
  const { totalTasks, doneTasks, currentStep } = tenant.onboarding;
  const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  return (
    <Card
      title="Onboarding"
      cta={
        <button type="button" style={ctaButton}>
          Open onboarding
        </button>
      }
    >
      <div style={{ ...fieldValue, fontVariantNumeric: "tabular-nums" }}>
        {doneTasks} / {totalTasks} steps complete
      </div>
      <div
        aria-label={`${pct}% complete`}
        style={{
          height: "0.5rem",
          borderRadius: "9999px",
          background: "var(--color-surface-container)",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--color-primary)" }} />
      </div>
      {currentStep ? (
        <div style={fieldLabel}>Current step: {currentStep}</div>
      ) : (
        <div style={fieldLabel}>{totalTasks === 0 ? "Not started" : "All steps complete"}</div>
      )}
    </Card>
  );
}

// ── Card 3 — Key Ring: DEK version + last rotated + Rotate CTA / "DEK destroyed" state ────────────────
function KeyRingCard({
  tenant,
  onRotate,
}: { tenant: TenantOverview; onRotate: () => void }): JSX.Element {
  const kr = tenant.keyRing;
  const destroyed = Boolean(kr?.destroyedAt);
  return (
    <Card
      title="Key Ring"
      cta={
        kr && !destroyed ? (
          <button type="button" style={ctaButton} onClick={onRotate}>
            Rotate DEK
          </button>
        ) : undefined
      }
    >
      {!kr ? (
        <div style={fieldValue}>No key ring provisioned.</div>
      ) : destroyed ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--color-on-surface-variant)",
          }}
        >
          <Glyph name="lock" size={16} label="DEK destroyed" />
          <span style={fieldValue}>
            DEK destroyed{" "}
            <span className="tabular-nums">
              {new Date(kr.destroyedAt as string).toLocaleString()}
            </span>
          </span>
        </div>
      ) : (
        <>
          <div>
            <div style={fieldLabel}>Current DEK version</div>
            <div style={fieldValue} className="wx-data-md">
              {kr.currentDekVersion}
            </div>
          </div>
          <div>
            <div style={fieldLabel}>Last rotated</div>
            <div style={fieldValue} className="tabular-nums">
              {kr.dekLastRotatedAt ? new Date(kr.dekLastRotatedAt).toLocaleString() : "Never"}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Card 4 — Support & Compliance: active grants + sessions + BAA + Start-session CTA ─────────────────
function SupportCard({ tenant }: { tenant: TenantOverview }): JSX.Element {
  const canStart = tenant.activeGrants > 0;
  return (
    <Card
      title="Support & Compliance"
      cta={
        <button
          type="button"
          style={ctaButton}
          disabled={!canStart}
          title={canStart ? undefined : "No active consent grant"}
        >
          Start support session
        </button>
      }
    >
      <div style={{ display: "flex", gap: "1.5rem" }}>
        <div>
          <div style={fieldLabel}>Active grants</div>
          <div style={{ ...fieldValue, fontVariantNumeric: "tabular-nums" }}>
            {tenant.activeGrants}
          </div>
        </div>
        <div>
          <div style={fieldLabel}>Active sessions</div>
          <div style={{ ...fieldValue, fontVariantNumeric: "tabular-nums" }}>
            {tenant.activeSessions}
          </div>
        </div>
      </div>
      <div>
        <div style={fieldLabel}>BAA status</div>
        {tenant.baa ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <StatusPill
              label={cap(tenant.baa.status)}
              tone={BAA_TONE[tenant.baa.status] ?? "neutral"}
            />
            {tenant.baa.expiresOn ? (
              <span
                className="tabular-nums"
                style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}
              >
                expires {new Date(tenant.baa.expiresOn).toLocaleDateString()}
              </span>
            ) : null}
          </div>
        ) : (
          <div style={fieldValue}>No BAA on record.</div>
        )}
      </div>
    </Card>
  );
}

// ── Card 5 — Exports & Activity: recent DSAR/export + Request CTAs ────────────────────────────────────
function ExportsCard(): JSX.Element {
  return (
    <Card
      title="Exports & Activity"
      cta={
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="button" style={ctaButton}>
            Request DSAR
          </button>
          <button type="button" style={ctaButton}>
            Request export
          </button>
        </div>
      }
    >
      <div style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
        Recent DSAR and tenant-export jobs appear here. Platform-ops requests are recorded with{" "}
        <span className="wx-data-md">actor_kind=platform_ops_initiated_for_tenant</span>.
      </div>
    </Card>
  );
}
