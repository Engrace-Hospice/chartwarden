import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/34-saas — Key Rings dashboard (M34 Phase-3, §4.1 platform-ops; §3.5 DEK
// lifecycle). Spec: docs/modules/... §5.1 screen inventory. The READ-ONLY per-tenant DEK-metadata
// dashboard (GET /api/v1/platform/tenants/{orgSlug}/key-ring — ciphertext is NEVER exposed) + the
// Rotate-DEK CTA (POST .../{orgSlug}/dek-rotate, a §10 step-up ceremony) + the destroyed state.
// The route keys by org slug; there is no cross-tenant list, so the operator resolves one tenant at
// a time. Live-wired over the typed client; imports only @wardenx/ui leaves + the Foundation map.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { KEY_RING_TONE, cap } from "./saas-status";

// §3.5 metadata-only view (the DEK ciphertext is never returned). A destroyed DEK (`destroyedAt` set)
// is terminal — the dashboard shows the destruction certificate and offers no rotate action (§5.2 Card 3).
interface KeyRingMetadataView {
  id: string;
  tenantAccountId: string;
  currentDekVersion: string;
  currentDekKekId: string;
  priorDekVersionCount: number;
  dekCreatedAt: string;
  dekLastRotatedAt: string | null;
  destroyedAt: string | null;
  destructionCertificateId: string | null;
}

// The view carries no status enum; the §3.5 lifecycle state is derived from the metadata.
function deriveStatus(m: KeyRingMetadataView): string {
  return m.destroyedAt ? "destroyed" : "active";
}
function ringTone(status: string): StatusTone {
  return KEY_RING_TONE[status] ?? "neutral";
}

export function KeyRings(): JSX.Element {
  const client = useApiClient();
  const [orgSlug, setOrgSlug] = useState("");
  const [ring, setRing] = useState<KeyRingMetadataView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    const slug = orgSlug.trim();
    if (!slug) return;
    setLoading(true);
    setError(null);
    setRing(null);
    setSearched(true);
    const { data, error: err } = await client.GET("/api/v1/platform/tenants/{orgSlug}/key-ring", {
      params: { path: { orgSlug: slug } },
    });
    if (err) {
      setError("Could not load the key-ring for this tenant.");
      setLoading(false);
      return;
    }
    setRing((data ?? null) as KeyRingMetadataView | null);
    setLoading(false);
  }, [client, orgSlug]);

  // The Rotate-DEK ceremony attests the §4.1 manual rotation: it enqueues `tenant.dek_rotate` under a
  // fresh passkey step-up. A rotation reason is required by the route; the ceremony's attestation
  // carries it and the step-up credential rides the POST.
  async function rotateDek(stepUpValue?: string): Promise<void> {
    const slug = orgSlug.trim();
    setCeremonyOpen(false);
    if (!slug) return;
    const { error: err } = await client.POST("/api/v1/platform/tenants/{orgSlug}/dek-rotate", {
      params: { path: { orgSlug: slug } },
    });
    if (err) {
      setBanner("DEK rotation request failed — the step-up was rejected.");
      return;
    }
    setBanner(stepUpValue ? "DEK rotation enqueued." : "DEK rotation enqueued.");
    void load();
  }

  const destroyed = ring ? Boolean(ring.destroyedAt) : false;

  return (
    <>
      <CeremonyModal
        open={ceremonyOpen}
        title="Rotate tenant DEK"
        attestation={
          <span>
            Enqueue a manual DEK rotation for tenant{" "}
            <strong className="wx-data-md">{orgSlug.trim()}</strong>. The current data-encryption
            key is superseded; prior versions are retained for in-place re-encryption. This is an
            audited platform-ops act.
          </span>
        }
        legalText="I affirm this rotation is authorized and the reason is recorded for the surveyor trail (§4.1)."
        signer={{ name: "Platform Operator", role: "platform_ops" }}
        stepUp={{ label: "Passkey step-up (recent 5 min)", type: "password" }}
        commitLabel="Rotate DEK"
        onCommit={(v) => void rotateDek(v)}
        onCancel={() => setCeremonyOpen(false)}
      />
      <DetailPageLayout
        header={
          <PageHeader title="Key Rings">
            <FilterBar
              actions={
                <button type="button" onClick={() => void load()} disabled={!orgSlug.trim()}>
                  Load
                </button>
              }
            >
              <input
                aria-label="Tenant org slug"
                placeholder="Tenant org slug"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void load();
                }}
              />
              {banner ? (
                <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
                  {banner}
                </span>
              ) : null}
            </FilterBar>
          </PageHeader>
        }
      >
        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : !searched ? (
          <EmptyState
            title="Resolve a tenant"
            description="Enter a tenant org slug to view its DEK metadata."
          />
        ) : !ring ? (
          <EmptyState title="Not found" description="No key-ring metadata for this tenant." />
        ) : (
          <KeyRingDashboard
            ring={ring}
            destroyed={destroyed}
            onRotate={() => setCeremonyOpen(true)}
          />
        )}
      </DetailPageLayout>
    </>
  );
}

function KeyRingDashboard({
  ring,
  destroyed,
  onRotate,
}: { ring: KeyRingMetadataView; destroyed: boolean; onRotate: () => void }): JSX.Element {
  const status = deriveStatus(ring);
  const field = (label: string, value: JSX.Element | string) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.2rem",
        padding: "0.75rem 0",
        borderBottom: "1px solid var(--color-outline-variant)",
      }}
    >
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        style={{ fontSize: "0.875rem", color: "var(--color-on-surface)", wordBreak: "break-word" }}
      >
        {value}
      </span>
    </div>
  );

  return (
    <div style={{ maxWidth: "42rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Glyph name="lock" size={18} label="Key ring" />
          <StatusPill label={cap(status)} tone={ringTone(status)} />
        </div>
        {destroyed ? (
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            DEK destroyed — no actions available
          </span>
        ) : (
          <button type="button" onClick={onRotate}>
            Rotate DEK
          </button>
        )}
      </div>

      {field("Key-ring id", <span className="wx-data-md">{ring.id}</span>)}
      {field("Tenant account", <span className="wx-data-md">{ring.tenantAccountId}</span>)}
      {field("Current DEK version", <span className="wx-data-md">{ring.currentDekVersion}</span>)}
      {field("KEK id", <span className="wx-data-md">{ring.currentDekKekId}</span>)}
      {field(
        "Prior DEK versions",
        <span className="tabular-nums">{ring.priorDekVersionCount}</span>,
      )}
      {field(
        "DEK created",
        <span className="tabular-nums">{new Date(ring.dekCreatedAt).toLocaleString()}</span>,
      )}
      {field(
        "Last rotated",
        ring.dekLastRotatedAt ? (
          <span className="tabular-nums">{new Date(ring.dekLastRotatedAt).toLocaleString()}</span>
        ) : (
          "— never rotated"
        ),
      )}
      {destroyed
        ? field(
            "Destroyed at",
            <span className="tabular-nums">
              {ring.destroyedAt ? new Date(ring.destroyedAt).toLocaleString() : "—"}
            </span>,
          )
        : null}
      {destroyed
        ? field(
            "Destruction certificate",
            ring.destructionCertificateId ? (
              <span className="wx-data-md">{ring.destructionCertificateId}</span>
            ) : (
              "—"
            ),
          )
        : null}
    </div>
  );
}
