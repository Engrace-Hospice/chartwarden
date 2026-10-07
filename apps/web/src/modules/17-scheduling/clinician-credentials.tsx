import {
  Button,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { MembershipLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";

type Credential = {
  id: string;
  membershipId: string;
  credentialType: string;
  status: string;
  effectiveAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  issuingBody: string | null;
};
const TYPES: Record<string, string> = {
  rn: "Registered Nurse (RN)",
  lpn: "Licensed Practical Nurse (LPN)",
  chha: "Certified Home Health Aide",
  msw: "Medical Social Worker (MSW)",
  chaplain: "Chaplain",
  volunteer: "Volunteer",
  md: "Physician (MD / DO)",
  np: "Nurse Practitioner (NP)",
  pa: "Physician Assistant (PA)",
};
const label = (v: string) => TYPES[v] ?? v;
const api = (client: unknown) =>
  client as {
    GET: (p: string, o: unknown) => Promise<{ data?: unknown; error?: unknown }>;
    POST: (p: string, o: unknown) => Promise<{ data?: unknown; error?: unknown }>;
    DELETE: (p: string, o: unknown) => Promise<{ error?: unknown }>;
  };

export function ClinicianCredentials(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const session = useSession();
  const permissions = session?.permissions ?? [];
  const canGrant = permissions.includes("membership_credential.grant");
  const canRevoke = permissions.includes("membership_credential.revoke");
  const [membershipId, setMembershipId] = useState("");
  const [memberLabel, setMemberLabel] = useState("");
  const [rows, setRows] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [revoke, setRevoke] = useState<Credential | null>(null);
  const [type, setType] = useState("rn");
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 10));
  const [expiresAt, setExpiresAt] = useState("");
  const [issuingBody, setIssuingBody] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const membership = params.get("membership");
    if (membership) setMembershipId(membership);
  }, [params]);
  const load = useCallback(async () => {
    if (!membershipId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await api(client).GET("/api/v1/memberships/{membershipId}/credentials", {
      params: { path: { membershipId } },
    });
    setLoading(false);
    if (res.error) {
      setError("Credentials could not be loaded.");
      return;
    }
    setRows((res.data ?? []) as Credential[]);
  }, [client, membershipId]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    if (expiresAt && expiresAt < effectiveAt) {
      setError("Expiration date must be on or after the effective date.");
      return;
    }
    setBusy(true);
    const res = await api(client).POST("/api/v1/memberships/{membershipId}/credentials", {
      params: { path: { membershipId } },
      body: {
        credentialType: type,
        effectiveAt,
        ...(expiresAt ? { expiresAt } : {}),
        ...(issuingBody.trim() ? { issuingBody: issuingBody.trim() } : {}),
      },
    });
    setBusy(false);
    if (res.error) {
      setError("Credential could not be added. Review the details and try again.");
      return;
    }
    setAddOpen(false);
    setNotice("Credential added.");
    await load();
  };
  const confirmRevoke = async () => {
    if (!revoke || reason.trim().length < 3) return;
    setBusy(true);
    const res = await api(client).DELETE(
      "/api/v1/memberships/{membershipId}/credentials/{credentialId}",
      {
        params: { path: { membershipId, credentialId: revoke.id } },
        body: { reason: reason.trim() },
      },
    );
    setBusy(false);
    if (res.error) {
      setError("Credential could not be revoked. Please try again.");
      return;
    }
    setRevoke(null);
    setNotice("Credential revoked.");
    await load();
  };
  return (
    <div style={{ maxWidth: "72rem", margin: "0 auto", padding: "1.5rem" }}>
      <PageHeader title="Clinician Credentials" breadcrumb="Scheduling">
        <p
          style={{
            margin: "0.25rem 0",
            color: "var(--color-on-surface-variant)",
          }}
        >
          Manage clinical licenses and certifications used when scheduling visits.
        </p>
      </PageHeader>
      <div style={{ maxWidth: "32rem", margin: "1.25rem 0" }}>
        <MembershipLookupField
          label="Clinician"
          value={membershipId}
          valueLabel={memberLabel}
          onChange={(id, option) => {
            setMembershipId(id);
            setMemberLabel(option?.searchLabel ?? "");
            setNotice(null);
          }}
        />
      </div>
      {notice ? (
        <output
          style={{
            color: "var(--color-success)",
            display: "block",
            marginBottom: "1rem",
          }}
        >
          {notice}
        </output>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      ) : null}
      {!membershipId ? (
        <EmptyState
          title="Select a clinician"
          description="Choose a staff member to view their clinical credentials."
        />
      ) : loading ? (
        <LoadingSpinner />
      ) : (
        <section
          style={{
            border: "1px solid var(--color-outline-variant)",
            borderRadius: "0.75rem",
            padding: "1.25rem",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              alignItems: "center",
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Clinical credentials</h2>
              <p
                style={{
                  margin: ".3rem 0",
                  color: "var(--color-on-surface-variant)",
                }}
              >
                {memberLabel || "Selected clinician"}
              </p>
            </div>
            {canGrant ? (
              <Button
                onClick={() => {
                  setError(null);
                  setAddOpen(true);
                }}
              >
                Add credential
              </Button>
            ) : null}
          </div>
          {rows.length === 0 ? (
            <EmptyState
              title="No credentials recorded"
              description="This clinician cannot be scheduled for credentialed visits until an active credential is recorded."
            />
          ) : (
            <div style={{ display: "grid", gap: ".75rem", marginTop: "1rem" }}>
              {rows.map((row) => (
                <article
                  key={row.id}
                  style={{
                    padding: "1rem",
                    border: "1px solid var(--color-outline-variant)",
                    borderRadius: ".5rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "1rem",
                    }}
                  >
                    <div>
                      <strong>{label(row.credentialType)}</strong>
                      <p
                        style={{
                          margin: ".35rem 0",
                          color: "var(--color-on-surface-variant)",
                        }}
                      >
                        {row.issuingBody || "Issuing authority not recorded"}
                      </p>
                      <small>
                        Effective {row.effectiveAt}
                        {row.expiresAt
                          ? ` · Expires ${row.expiresAt}`
                          : " · No expiration recorded"}
                      </small>
                      {row.revokedReason ? (
                        <small style={{ display: "block" }}>
                          Revocation reason: {row.revokedReason}
                        </small>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: "grid",
                        justifyItems: "end",
                        gap: ".5rem",
                      }}
                    >
                      <StatusPill
                        label={row.revokedAt ? "Revoked" : row.status}
                        tone={row.status === "active" && !row.revokedAt ? "success" : "neutral"}
                      />
                      {canRevoke && !row.revokedAt ? (
                        <Button
                          size="sm"
                          tone="danger"
                          onClick={() => {
                            setReason("");
                            setRevoke(row);
                          }}
                        >
                          Revoke credential
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      <Modal
        open={addOpen}
        onClose={busy ? undefined : () => setAddOpen(false)}
        ariaLabel="Add clinical credential"
        width="30rem"
      >
        <div style={{ padding: "1.25rem", display: "grid", gap: ".85rem" }}>
          <h2 style={{ margin: 0 }}>Add clinical credential</h2>
          <label>
            Credential type *
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              style={{ display: "block", width: "100%" }}
            >
              {Object.entries(TYPES).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Issuing authority
            <input
              value={issuingBody}
              onChange={(e) => setIssuingBody(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Effective date *
            <input
              type="date"
              value={effectiveAt}
              onChange={(e) => setEffectiveAt(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Expiration date
            <input
              type="date"
              min={effectiveAt}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: ".5rem",
            }}
          >
            <Button tone="tertiary" onClick={() => setAddOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button disabled={busy || !effectiveAt} onClick={() => void save()}>
              {busy ? "Saving…" : "Add credential"}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={revoke !== null}
        onClose={busy ? undefined : () => setRevoke(null)}
        ariaLabel="Revoke clinical credential"
        width="30rem"
      >
        <div style={{ padding: "1.25rem", display: "grid", gap: ".85rem" }}>
          <h2 style={{ margin: 0 }}>Revoke this clinical credential?</h2>
          <p style={{ margin: 0 }}>
            This clinician will no longer be considered clinically credentialed under this license.
            This may prevent future visit assignments that require it.
          </p>
          <label>
            Reason *
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
              rows={3}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: ".5rem",
            }}
          >
            <Button tone="tertiary" onClick={() => setRevoke(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              tone="danger"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void confirmRevoke()}
            >
              {busy ? "Revoking…" : "Revoke credential"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
