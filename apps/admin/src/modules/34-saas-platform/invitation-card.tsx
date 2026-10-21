// apps/admin/src/modules/34-saas-platform — the tenant's first-admin invitations (spec §5.1). Backed by
// GET / POST / DELETE /api/v1/platform/tenant-invitations. The provisioning job sends the first invitation; this is
// how platform ops see its state and, when it expired or the email was lost, send a fresh single-use link to the
// same address (a resend revokes the earlier pending link server-side) or revoke the pending one.
import {
  Button,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  useApiClient,
  useRequestGuard,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface InvitationRow {
  id: string;
  tenantAccountId: string;
  firstAdminEmail: string;
  status: string;
  issuedAt: string;
  expiresAt: string | null;
}

/** Safety cap on following the global invitation list's cursor. */
const MAX_PAGES = 50;

const TONE: Record<string, StatusTone> = {
  pending: "progress",
  accepted: "success",
  expired: "warning",
  revoked: "neutral",
};

function serverMessage(err: unknown): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

export function InvitationCard({
  orgSlug,
  tenantAccountId,
}: { orgSlug: string; tenantAccountId: string }): JSX.Element {
  const client = useApiClient();
  const guard = useRequestGuard();
  const [rows, setRows] = useState<InvitationRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    try {
      // The list is global (every tenant, newest first, cursor-paginated), so keep paging until the end: an older
      // tenant's invitations are not on the first page.
      const mine: InvitationRow[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error } = await client.GET(
          "/api/v1/platform/tenant-invitations",
          cursor ? { params: { query: { cursor } } } : {},
        );
        if (!isCurrent()) return;
        if (error || !data) {
          setLoadError(true);
          return;
        }
        mine.push(
          ...(data.items as unknown as InvitationRow[]).filter(
            (i) => i.tenantAccountId === tenantAccountId,
          ),
        );
        if (!data.nextCursor) break;
        cursor = data.nextCursor as string;
      }
      setLoadError(false);
      setRows(mine.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)));
    } catch {
      if (isCurrent()) setLoadError(true);
    }
  }, [client, guard, tenantAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(run: () => Promise<{ error?: unknown }>, refusal: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { error } = await run();
      if (error) {
        setActionError(serverMessage(error) ?? refusal);
        return;
      }
      await load();
    } catch {
      setActionError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const latest = rows?.[0];
  const canResend = latest !== undefined && latest.status !== "accepted";
  const canRevoke = latest?.status === "pending";

  return (
    <section className="wx-drawer-card" aria-label="First-admin invitation">
      <div className="wx-drawer-card-head">
        <h3>First-admin invitation</h3>
      </div>
      {loadError ? <InlineAlert tone="error">Could not load invitations.</InlineAlert> : null}
      {rows === null && !loadError ? <LoadingSpinner label="Loading invitations…" /> : null}
      {rows?.length === 0 ? <p>No invitation on record.</p> : null}
      {rows && rows.length > 0 ? (
        <ul className="wx-kv" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2">
              <span>{i.firstAdminEmail}</span>
              <StatusPill label={i.status} tone={TONE[i.status] ?? "neutral"} />
              <span className="wx-nums wx-row-sub">
                {i.expiresAt ? `expires ${new Date(i.expiresAt).toLocaleDateString()}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {actionError ? <InlineAlert tone="error">{actionError}</InlineAlert> : null}
      {latest && (canResend || canRevoke) ? (
        <div className="wx-drawer-actions">
          {canRevoke ? (
            <Button
              tone="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    client.DELETE("/api/v1/platform/tenant-invitations/{id}", {
                      params: { path: { id: latest.id } },
                    }),
                  "The revoke was refused.",
                )
              }
            >
              Revoke
            </Button>
          ) : null}
          {canResend ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    client.POST("/api/v1/platform/tenant-invitations", {
                      body: { orgSlug, firstAdminEmail: latest.firstAdminEmail },
                    }),
                  "The invitation could not be sent.",
                )
              }
            >
              Resend invitation
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
