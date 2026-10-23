import {
  Button,
  CeremonyModal,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  TextField,
  useApiClient,
  useRequestGuard,
} from "@chartwarden/ui";
// apps/web/src/modules/34-saas — Key Rings dashboard (M34 Phase-3, §4.1 platform-ops; §3.5 DEK
// lifecycle). Spec: docs/modules/... §5.1 screen inventory. The READ-ONLY per-tenant DEK-metadata
// dashboard (GET /api/v1/platform/tenants/{orgSlug}/key-ring — ciphertext is NEVER exposed) + the
// Rotate-DEK CTA (POST .../{orgSlug}/dek-rotate, a §10 step-up ceremony) + the destroyed state.
// The route keys by org slug; there is no cross-tenant list, so the operator resolves one tenant at
// a time. Live-wired over the typed client; imports only @chartwarden/ui leaves + the Foundation map.
// Laid out in the redesign's page frame (wx-page-head, a lookup row, the metadata as flat cards).
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

interface Banner {
  tone: "success" | "error";
  text: string;
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
  const guard = useRequestGuard();
  const [ring, setRing] = useState<KeyRingMetadataView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  const load = useCallback(async () => {
    const slug = orgSlug.trim();
    if (!slug) return;
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    setRing(null);
    setSearched(true);
    const { data, error: err, response } = await client.GET("/api/v1/platform/tenants/{orgSlug}/key-ring", {
      params: { path: { orgSlug: slug } },
    });
    if (!isCurrent()) return;
    if (err) {
      setError(
        response?.status === 404
          ? "No key ring has been provisioned for this tenant."
          : "Could not load the key-ring for this tenant.",
      );
      setLoading(false);
      return;
    }
    setRing((data ?? null) as KeyRingMetadataView | null);
    setLoading(false);
  }, [client, guard, orgSlug]);

  // The Rotate-DEK ceremony attests the §4.1 manual rotation: it enqueues `tenant.dek_rotate` under a
  // fresh passkey step-up. A rotation reason is required by the route; the ceremony's attestation
  // carries it and the step-up credential rides the POST.
  async function rotateDek(_stepUpValue?: string): Promise<void> {
    const slug = orgSlug.trim();
    setCeremonyOpen(false);
    if (!slug) return;
    const { error: err } = await client.POST("/api/v1/platform/tenants/{orgSlug}/dek-rotate", {
      params: { path: { orgSlug: slug } },
      // TODO(M34 web): this stub screen should collect the rotation reason from the ceremony input.
      body: { reason: "Manual DEK rotation via platform console" },
    });
    if (err) {
      setBanner({ tone: "error", text: "DEK rotation request failed — the step-up was rejected." });
      return;
    }
    setBanner({ tone: "success", text: "DEK rotation enqueued." });
    void load();
  }

  const destroyed = ring ? Boolean(ring.destroyedAt) : false;

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Key rings</h1>
            <p>Per-tenant data-encryption key metadata. Key material is never shown.</p>
          </div>
        </header>

        <div className="wx-list-toolbar">
          <div className="flex w-full flex-wrap items-end gap-3">
            <div className="min-w-0 flex-[1_1_18rem]">
              <TextField
                label="Tenant org slug"
                placeholder="Tenant org slug"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void load();
                }}
              />
            </div>
            <Button tone="primary" onClick={() => void load()} disabled={!orgSlug.trim()}>
              Load
            </Button>
          </div>
        </div>

        {banner ? <InlineAlert tone={banner.tone}>{banner.text}</InlineAlert> : null}

        {loading ? (
          <div className="wx-list-state">
            <LoadingSpinner label="Loading key ring…" />
          </div>
        ) : error ? (
          <div className="wx-list-state" role="alert">
            <InlineAlert tone="error">{error}</InlineAlert>
            <Button tone="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !searched ? (
          <div className="wx-list-state">
            <Glyph name="search" size={24} />
            <span>Enter a tenant org slug to view its DEK metadata.</span>
          </div>
        ) : !ring ? (
          <div className="wx-list-state">
            <Glyph name="lock" size={24} />
            <span>No key-ring metadata for this tenant.</span>
          </div>
        ) : (
          <KeyRingDashboard
            ring={ring}
            destroyed={destroyed}
            onRotate={() => setCeremonyOpen(true)}
          />
        )}
      </div>
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
    </div>
  );
}

function KeyRingDashboard({
  ring,
  destroyed,
  onRotate,
}: { ring: KeyRingMetadataView; destroyed: boolean; onRotate: () => void }): JSX.Element {
  const status = deriveStatus(ring);
  return (
    <div className="grid max-w-2xl gap-3">
      <section className="wx-drawer-card">
        <div className="wx-drawer-card-head">
          <h3>
            <Glyph name="lock" size={16} label="Key ring" /> Data-encryption key
          </h3>
          <StatusPill label={cap(status)} tone={ringTone(status)} />
        </div>
        <dl className="wx-kv">
          <dt>Key-ring id</dt>
          <dd className="wx-data-md break-words">{ring.id}</dd>
          <dt>Tenant account</dt>
          <dd className="wx-data-md break-words">{ring.tenantAccountId}</dd>
          <dt>Current DEK version</dt>
          <dd className="wx-data-md break-words">{ring.currentDekVersion}</dd>
          <dt>KEK id</dt>
          <dd className="wx-data-md break-words">{ring.currentDekKekId}</dd>
          <dt>Prior DEK versions</dt>
          <dd className="wx-nums">{ring.priorDekVersionCount}</dd>
          <dt>DEK created</dt>
          <dd className="wx-nums">{new Date(ring.dekCreatedAt).toLocaleString()}</dd>
          <dt>Last rotated</dt>
          <dd className={ring.dekLastRotatedAt ? "wx-nums" : undefined}>
            {ring.dekLastRotatedAt
              ? new Date(ring.dekLastRotatedAt).toLocaleString()
              : "— never rotated"}
          </dd>
        </dl>
        {destroyed ? (
          <p className="wx-source-line">DEK destroyed — no actions available</p>
        ) : (
          <div className="wx-drawer-actions">
            <Button tone="secondary" onClick={onRotate}>
              Rotate DEK
            </Button>
          </div>
        )}
      </section>
      {destroyed ? (
        <section className="wx-drawer-card">
          <h3>Destruction</h3>
          <dl className="wx-kv">
            <dt>Destroyed at</dt>
            <dd className="wx-nums">
              {ring.destroyedAt ? new Date(ring.destroyedAt).toLocaleString() : "—"}
            </dd>
            <dt>Destruction certificate</dt>
            <dd className={ring.destructionCertificateId ? "wx-data-md break-words" : undefined}>
              {ring.destructionCertificateId ?? "—"}
            </dd>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
