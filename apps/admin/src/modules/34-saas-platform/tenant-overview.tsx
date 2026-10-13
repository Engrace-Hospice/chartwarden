import {
  Button,
  CeremonyModal,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  TextField,
  useApiClient,
  useRequestGuard,
  useToast,
} from "@wardenx/ui";
// apps/admin/src/modules/34-saas-platform — M34 SaaS Tenant Platform, the §5.2 single-page-of-truth (R2).
// Spec §5.2 (`/tenants/:orgSlug`) — the tenant overview: a context header (identity + lifecycle pill +
// action menu) over the FIVE cards. Backed by GET /api/v1/platform/tenants/{orgSlug} (TenantOverview)
// via the generated typed client; reads run under withPlatformContext server-side (F03/F09 audited).
// The command CTAs POST the §4.1 enqueue routes; the cryptographic shred is the §10 'critical' tone
// paired with the Guardrail CeremonyModal confirm-by-typing ceremony (§5.2 Card 1 / §5.3 / §6 D10).
// The redesign frame: a page head (identity + lifecycle pill + shred) over the five flat cards.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { BAA_TONE, cap, lifecycleTone, statusLabel } from "./saas-status";
import { InvitationCard } from "./invitation-card";
import { ProvisioningCard } from "./provisioning-card";
import { TenantTransitionDialog } from "./tenant-transition-dialog";

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

/** The route requires `destructionCertificateId` as `format: "uuid"`; "" is rejected with a 400. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `transitionReason` / `reason` both carry a minLength of 8 in the published contract. */
const MIN_REASON = 8;

export function TenantOverview(): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [orgSlug] = useState(orgSlugFromPath);
  const [tenant, setTenant] = useState<TenantOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [shredOpen, setShredOpen] = useState(false);
  const [transitionOpen, setTransitionOpen] = useState(false);
  // The ceremony used to send `destructionCertificateId: ""` and a canned reason, then ignore the
  // result — so the shred failed validation every time and the console reported success anyway
  // (#29). These are the operator inputs the TODO in this file always said it needed.
  const [certId, setCertId] = useState("");
  const [shredReason, setShredReason] = useState("");
  const [shredError, setShredError] = useState<string | null>(null);
  const [shredBusy, setShredBusy] = useState(false);

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/tenants/{orgSlug}", {
      params: { path: { orgSlug } },
    });
    if (!isCurrent()) return;
    if (err) {
      setError("Tenant not found.");
      setLoading(false);
      return;
    }
    setTenant(data as unknown as TenantOverview);
    setLoading(false);
  }, [client, guard, orgSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotateDek = useCallback(async () => {
    const { error: err } = await client.POST("/api/v1/platform/tenants/{orgSlug}/dek-rotate", {
      params: { path: { orgSlug } },
      // TODO(M34 web, #29): still a canned reason — this should collect the operator's own
      // justification, so the audit trail records why THIS rotation happened rather than a constant.
      // Unlike the shred, this payload is valid (it clears the contract's minLength of 8) and the
      // rotation does succeed, so it is left for the follow-up rather than fixed half-way here.
      body: { reason: "Manual DEK rotation via platform console" },
    });
    if (err) {
      // Previously `if (!err) void load()` — a refused rotation did nothing at all and said nothing,
      // the same silent-failure shape as the shred (#29).
      toast.show(errorMessage(err, "The DEK rotation was refused."), { tone: "error" });
      return;
    }
    toast.show("DEK rotation enqueued.", { tone: "success" });
    void load();
  }, [client, orgSlug, load, toast]);

  const confirmShred = useCallback(async () => {
    const cert = certId.trim();
    const reason = shredReason.trim();
    // Validated here as well as server-side so the operator gets the reason immediately, in the
    // ceremony, rather than a silent no-op — which is precisely how the old version failed.
    if (!UUID_RE.test(cert)) {
      setShredError("Enter the M4 destruction-certificate id. It must be a UUID.");
      return;
    }
    if (reason.length < MIN_REASON) {
      setShredError(`Enter a transition reason of at least ${MIN_REASON} characters.`);
      return;
    }
    setShredError(null);
    setShredBusy(true);
    const { error: err } = await client.POST("/api/v1/platform/tenants/{orgSlug}/shred", {
      params: { path: { orgSlug } },
      body: { transitionReason: reason, destructionCertificateId: cert },
    });
    setShredBusy(false);
    if (err) {
      // The ceremony STAYS OPEN. A failed shred that closes the dialog is indistinguishable from a
      // successful one, because success is a 202 that merely enqueues `tenant.shred` and leaves the
      // tenant in `destruction_pending` — exactly what a failure leaves behind too.
      setShredError(errorMessage(err, "The shred was refused. The tenant has NOT been shredded."));
      return;
    }
    // Say what actually happened: the destruction is enqueued, not finished.
    toast.show(
      `Cryptographic shred enqueued for ${tenant?.legalBusinessName ?? orgSlug}. It is not complete until the job reports done.`,
      { tone: "success" },
    );
    setShredOpen(false);
    setCertId("");
    setShredReason("");
    void load();
  }, [client, orgSlug, load, certId, shredReason, toast, tenant]);

  if (loading)
    return (
      <div className="wx-list-drawer">
        <div className="wx-list-drawer-main">
          <div className="wx-list-state">
            <LoadingSpinner label="Loading tenant…" />
          </div>
        </div>
      </div>
    );
  if (error || !tenant)
    return (
      <div className="wx-list-drawer">
        <div className="wx-list-drawer-main">
          <div className="wx-list-state" role="alert">
            <InlineAlert tone="error">{error ?? "No tenant."}</InlineAlert>
            <Button tone="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );

  const shreddable = tenant.status === "destruction_pending";

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>{tenant.legalBusinessName}</h1>
            <p>
              <span className="wx-data-md">{tenant.orgSlug}</span> · {tenant.planLabel}
            </p>
          </div>
          <div className="wx-list-toolbar-end">
            <StatusPill label={statusLabel(tenant.status)} tone={lifecycleTone(tenant.status)} />
            {shreddable ? (
              <Button tone="danger" onClick={() => setShredOpen(true)}>
                Cryptographic shred
              </Button>
            ) : null}
          </div>
        </header>

        {tenant.status === "provisioning" ? (
          <ProvisioningCard orgSlug={orgSlug} onChanged={() => void load()} />
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <LifecycleCard tenant={tenant} onTransition={() => setTransitionOpen(true)} />
          <OnboardingCard
            tenant={tenant}
            onOpen={() => navigate(`/tenants/${encodeURIComponent(tenant.orgSlug)}/onboarding`)}
          />
          <KeyRingCard tenant={tenant} onRotate={() => void rotateDek()} />
          <SupportCard tenant={tenant} />
          <ExportsCard />
          <InvitationCard orgSlug={orgSlug} tenantAccountId={tenant.id} />
        </div>
      </div>

      <TenantTransitionDialog
        open={transitionOpen}
        orgSlug={orgSlug}
        tenantName={tenant.legalBusinessName}
        fromStatus={tenant.status}
        onClose={() => setTransitionOpen(false)}
        onDone={() => {
          setTransitionOpen(false);
          toast.show("Tenant status updated.", { tone: "success" });
          void load();
        }}
      />

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
            {/* The two values the route REQUIRES. They live in the attestation slot rather than in
                CeremonyModal itself so the shared component (15 other call sites) is untouched. */}
            <div className="mt-3 grid gap-3">
              <TextField
                id="shred-cert-id"
                label="M4 destruction-certificate id"
                hint="The approved certificate this destruction is recorded against."
                value={certId}
                onChange={(e) => setCertId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                autoComplete="off"
                spellCheck={false}
                className="wx-data-md"
              />
              <TextField
                id="shred-reason"
                label="Transition reason"
                value={shredReason}
                onChange={(e) => setShredReason(e.target.value)}
                placeholder="Why this tenant is being shredded now"
                autoComplete="off"
              />
              {shredError ? <InlineAlert tone="error">{shredError}</InlineAlert> : null}
            </div>
          </>
        }
        legalText="I confirm the retention period has elapsed, no legal hold is active, and the M4 destruction certificate is approved."
        signer={{ name: "Platform Operator", role: "platform_ops" }}
        stepUp={{
          type: "text",
          label: "Type the legal business name to confirm",
          placeholder: tenant.legalBusinessName,
        }}
        commitLabel={shredBusy ? "Shredding…" : "Shred tenant key"}
        onCommit={(typed) => {
          if (shredBusy) return;
          // A mismatched name used to fall through to nothing at all — the same silent no-op this
          // fix exists to remove. Say so instead.
          if (
            (typed ?? "").trim().toLowerCase() !== tenant.legalBusinessName.trim().toLowerCase()
          ) {
            setShredError("The typed name does not match the tenant's legal business name.");
            return;
          }
          void confirmShred();
        }}
        onCancel={() => {
          setShredOpen(false);
          setShredError(null);
        }}
      />
    </div>
  );
}

/**
 * The server's own message when the envelope carries one, else `fallback`. A shred refusal must say
 * WHY — "it didn't work" is barely better than the silent failure this replaces.
 */
function errorMessage(err: unknown, fallback: string): string {
  const envelope = (err as { error?: { message?: unknown } } | null)?.error;
  const message = envelope?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : fallback;
}

// ── card shell — a flat redesign card: title row (+ optional CTA) over its body ─────────────────────────
function Card({
  title,
  cta,
  children,
}: { title: ReactNode; cta?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="wx-drawer-card">
      <div className="wx-drawer-card-head">
        <h3>{title}</h3>
        {cta}
      </div>
      {children}
    </section>
  );
}

// ── Card 1 — Lifecycle: current status + last status event + Transition CTA ──────────────────────────
function LifecycleCard({
  tenant,
  onTransition,
}: { tenant: TenantOverview; onTransition: () => void }): JSX.Element {
  const ev = tenant.latestStatusEvent;
  return (
    <Card
      title="Lifecycle"
      cta={
        <Button tone="secondary" size="sm" onClick={onTransition}>
          Transition status
        </Button>
      }
    >
      <div>
        <StatusPill label={statusLabel(tenant.status)} tone={lifecycleTone(tenant.status)} />
      </div>
      <dl className="wx-kv">
        <dt>Last status event</dt>
        <dd>
          {ev ? (
            <>
              {statusLabel(ev.toStatus)}{" "}
              <span className="wx-nums wx-row-sub">
                · {new Date(ev.occurredAt).toLocaleString()}
              </span>
              {ev.reason ? <span className="wx-row-sub">{ev.reason}</span> : null}
            </>
          ) : (
            "—"
          )}
        </dd>
      </dl>
    </Card>
  );
}

// ── Card 2 — Onboarding: eleven-step progress + Open onboarding CTA ───────────────────────────────────
function OnboardingCard({
  tenant,
  onOpen,
}: { tenant: TenantOverview; onOpen: () => void }): JSX.Element {
  const { totalTasks, doneTasks, currentStep } = tenant.onboarding;
  const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  return (
    <Card
      title="Onboarding"
      cta={
        <Button tone="secondary" size="sm" onClick={onOpen}>
          Open onboarding
        </Button>
      }
    >
      <span className="wx-nums text-sm">
        {doneTasks} / {totalTasks} steps complete
      </span>
      <progress
        value={pct}
        max={100}
        aria-label={`${pct}% complete`}
        className="h-2 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-[var(--color-primary)] [&::-webkit-progress-bar]:bg-[var(--color-surface-container)] [&::-webkit-progress-value]:bg-[var(--color-primary)]"
      />
      <span className="wx-row-sub">
        {currentStep
          ? `Current step: ${currentStep}`
          : totalTasks === 0
            ? "Not started"
            : "All steps complete"}
      </span>
    </Card>
  );
}

// ── Card 3 — Key ring: DEK version + last rotated + Rotate CTA / "DEK destroyed" state ────────────────
function KeyRingCard({
  tenant,
  onRotate,
}: { tenant: TenantOverview; onRotate: () => void }): JSX.Element {
  const kr = tenant.keyRing;
  const destroyed = Boolean(kr?.destroyedAt);
  return (
    <Card
      title="Key ring"
      cta={
        kr && !destroyed ? (
          <Button tone="secondary" size="sm" onClick={onRotate}>
            Rotate DEK
          </Button>
        ) : undefined
      }
    >
      {!kr ? (
        <span className="text-sm">No key ring provisioned.</span>
      ) : destroyed ? (
        <p className="wx-source-line">
          <Glyph name="lock" size={16} label="DEK destroyed" />
          <span className="wx-source-text">
            DEK destroyed{" "}
            <span className="wx-nums">{new Date(kr.destroyedAt as string).toLocaleString()}</span>
          </span>
        </p>
      ) : (
        <dl className="wx-kv">
          <dt>Current DEK version</dt>
          <dd className="wx-data-md">{kr.currentDekVersion}</dd>
          <dt>Last rotated</dt>
          <dd className="wx-nums">
            {kr.dekLastRotatedAt ? new Date(kr.dekLastRotatedAt).toLocaleString() : "Never"}
          </dd>
        </dl>
      )}
    </Card>
  );
}

// ── Card 4 — Support & compliance: active grants + sessions + BAA + Start-session CTA ─────────────────
function SupportCard({ tenant }: { tenant: TenantOverview }): JSX.Element {
  const canStart = tenant.activeGrants > 0;
  return (
    <Card
      title="Support & compliance"
      cta={
        <Button
          tone="secondary"
          size="sm"
          disabled={!canStart}
          title={canStart ? undefined : "No active consent grant"}
        >
          Start support session
        </Button>
      }
    >
      <dl className="wx-kv">
        <dt>Active grants</dt>
        <dd className="wx-nums">{tenant.activeGrants}</dd>
        <dt>Active sessions</dt>
        <dd className="wx-nums">{tenant.activeSessions}</dd>
        <dt>BAA status</dt>
        <dd>
          {tenant.baa ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill
                label={cap(tenant.baa.status)}
                tone={BAA_TONE[tenant.baa.status] ?? "neutral"}
              />
              {tenant.baa.expiresOn ? (
                <span className="wx-nums wx-row-sub">
                  expires {new Date(tenant.baa.expiresOn).toLocaleDateString()}
                </span>
              ) : null}
            </span>
          ) : (
            "No BAA on record."
          )}
        </dd>
      </dl>
    </Card>
  );
}

// ── Card 5 — Exports & activity: recent DSAR/export + Request CTAs ────────────────────────────────────
function ExportsCard(): JSX.Element {
  return (
    <Card
      title="Exports & activity"
      cta={
        <div className="wx-drawer-actions">
          <Button tone="secondary" size="sm">
            Request DSAR
          </Button>
          <Button tone="secondary" size="sm">
            Request export
          </Button>
        </div>
      }
    >
      <p className="wx-source-line">
        <span className="wx-source-text">
          Recent DSAR and tenant-export jobs appear here. Platform-ops requests are recorded with{" "}
          <span className="wx-data-md">actor_kind=platform_ops_initiated_for_tenant</span>.
        </span>
      </p>
    </Card>
  );
}
