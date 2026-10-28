import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  LoadingSpinner,
  Modal,
  StatusPill,
  formatDateOnly,
  humanizeIdentifier,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [formError, setFormError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [revoke, setRevoke] = useState<Credential | null>(null);
  const [type, setType] = useState("rn");
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 10));
  const [expiresAt, setExpiresAt] = useState("");
  const [issuingBody, setIssuingBody] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const loadRequest = useRef(0);
  useEffect(() => {
    const membership = params.get("membership");
    if (membership) setMembershipId(membership);
  }, [params]);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    if (!membershipId) {
      setRows([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api(client).GET("/api/v1/memberships/{membershipId}/credentials", {
        params: { path: { membershipId } },
      });
      if (request !== loadRequest.current) return;
      if (res.error) {
        setError("Credentials could not be loaded.");
        return;
      }
      setRows((res.data ?? []) as Credential[]);
    } catch {
      if (request === loadRequest.current) setError("Credentials could not be loaded.");
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [client, membershipId]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    if (expiresAt && expiresAt < effectiveAt) {
      setFormError("Expiration date must be on or after the effective date.");
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      const res = await api(client).POST("/api/v1/memberships/{membershipId}/credentials", {
        params: { path: { membershipId } },
        body: {
          credentialType: type,
          effectiveAt,
          ...(expiresAt ? { expiresAt } : {}),
          ...(issuingBody.trim() ? { issuingBody: issuingBody.trim() } : {}),
        },
      });
      if (res.error) {
        setFormError("Credential could not be added. Review the details and try again.");
        return;
      }
      setAddOpen(false);
      setNotice("Credential added.");
      await load();
    } catch {
      setFormError("Credential could not be added. Review the details and try again.");
    } finally {
      setBusy(false);
    }
  };
  const confirmRevoke = async () => {
    if (!revoke || reason.trim().length < 3) return;
    setRevokeError(null);
    setBusy(true);
    try {
      const res = await api(client).DELETE(
        "/api/v1/memberships/{membershipId}/credentials/{credentialId}",
        {
          params: { path: { membershipId, credentialId: revoke.id } },
          body: { reason: reason.trim() },
        },
      );
      if (res.error) {
        setRevokeError("Credential could not be revoked. Please try again.");
        return;
      }
      setRevoke(null);
      setNotice("Credential revoked.");
      await load();
    } catch {
      setRevokeError("Credential could not be revoked. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const activeRows = rows.filter((row) => row.status === "active" && !row.revokedAt);
  const today = new Date().toISOString().slice(0, 10);
  const withinThirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const expiringSoon = activeRows.filter(
    (row) => row.expiresAt && row.expiresAt >= today && row.expiresAt <= withinThirtyDays,
  ).length;
  const revokedCount = rows.filter((row) => row.revokedAt).length;
  return (
    <div className="wx-work-page wx-credential-page">
      <header className="wx-page-head">
        <div>
          <h1>Clinician credentials</h1>
          <p>Review licenses and certifications used to verify scheduling eligibility.</p>
        </div>
      </header>

      <section className="wx-form-section" aria-label="Choose a clinician">
        <div className="wx-form-section-head">
          <span className="wx-form-section-icon" aria-hidden>
            <Glyph name="users" size={20} />
          </span>
          <div>
            <h2>Choose a clinician</h2>
            <p>Search by name or email to view the current credential record.</p>
          </div>
        </div>
        <div style={{ maxWidth: "32rem" }}>
          <MembershipLookupField
            label="Clinician"
            value={membershipId}
            valueLabel={memberLabel}
            onChange={(id, option) => {
              setMembershipId(id);
              setMemberLabel(option?.searchLabel ?? "");
              setNotice(null);
              setError(null);
            }}
          />
        </div>
      </section>

      {notice ? (
        <output className="wx-work-notice">
          <Glyph name="check-circle" size={18} />
          {notice}
        </output>
      ) : null}
      {error ? (
        <div className="wx-form-alert" role="alert">
          <Glyph name="alert-circle" size={18} />
          <p>{error}</p>
          {membershipId ? (
            <Button tone="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {!membershipId ? (
        <div className="wx-list-state">
          <EmptyState
            title="Select a clinician"
            description="Choose a staff member to view their clinical credentials."
          />
        </div>
      ) : loading ? (
        <LoadingSpinner />
      ) : error ? null : (
        <>
          <div className="wx-work-summary" aria-label="Credential overview">
            <KpiCard
              icon="check-circle"
              tone="success"
              label="Active"
              value={activeRows.length}
              detail="Current credentials"
            />
            <KpiCard
              icon="clock"
              tone="warning"
              label="Expiring soon"
              value={expiringSoon}
              detail="Within 30 days"
            />
            <KpiCard
              icon="x-circle"
              label="Revoked"
              value={revokedCount}
              detail="Historical records"
            />
          </div>
          <section className="wx-form-section" aria-labelledby="credential-list-heading">
            <div className="wx-work-panel-head">
              <div className="wx-form-section-head" style={{ marginBottom: 0 }}>
                <span className="wx-form-section-icon" aria-hidden>
                  <Glyph name="file-check" size={20} />
                </span>
                <div>
                  <h2 id="credential-list-heading">Credential record</h2>
                  <p>
                    {memberLabel || "Selected clinician"} · {rows.length} recorded
                  </p>
                </div>
              </div>
              {canGrant ? (
                <Button
                  onClick={() => {
                    setFormError(null);
                    setAddOpen(true);
                  }}
                >
                  <Glyph name="plus" size={16} />
                  Add credential
                </Button>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <div className="wx-list-state" style={{ marginTop: "1.25rem" }}>
                <EmptyState
                  title="No credentials recorded"
                  description="Add a current credential before assigning visits that require one."
                />
              </div>
            ) : (
              <div className="wx-list-table-wrap" style={{ marginTop: "1.25rem" }}>
                <table className="wx-list-table wx-list-table-static wx-credential-table">
                  <caption className="wx-sr-only">
                    Clinical credentials for {memberLabel || "selected clinician"}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Credential</th>
                      <th scope="col">Effective</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="wx-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong className="wx-row-title">{label(row.credentialType)}</strong>
                          <span className="wx-row-sub">
                            {row.issuingBody || "Issuing authority not recorded"}
                          </span>
                          {row.revokedReason ? (
                            <span className="wx-row-sub">Reason: {row.revokedReason}</span>
                          ) : null}
                        </td>
                        <td className="wx-nums">{formatDateOnly(row.effectiveAt)}</td>
                        <td className="wx-nums">
                          {row.expiresAt ? formatDateOnly(row.expiresAt) : "No expiration"}
                        </td>
                        <td>
                          <StatusPill
                            label={row.revokedAt ? "Revoked" : humanizeIdentifier(row.status)}
                            tone={row.status === "active" && !row.revokedAt ? "success" : "neutral"}
                          />
                        </td>
                        <td className="wx-cell-end">
                          {canRevoke && !row.revokedAt ? (
                            <Button
                              size="sm"
                              tone="tertiary"
                              onClick={() => {
                                setReason("");
                                setRevokeError(null);
                                setRevoke(row);
                              }}
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <Modal
        open={addOpen}
        onClose={busy ? undefined : () => setAddOpen(false)}
        ariaLabel="Add clinical credential"
        width="30rem"
      >
        <div className="wx-modal-body">
          <div className="wx-form-section-head" style={{ marginBottom: 0 }}>
            <span className="wx-form-section-icon" aria-hidden>
              <Glyph name="file-check" size={20} />
            </span>
            <div>
              <h2>Add clinical credential</h2>
              <p>Dates and issuing authority are saved to the clinician's record.</p>
            </div>
          </div>
          {formError ? (
            <div className="wx-form-alert" role="alert">
              <Glyph name="alert-circle" size={18} />
              <p>{formError}</p>
            </div>
          ) : null}
          <div className="wx-form-field">
            <label htmlFor="credential-type">Credential type</label>
            <select
              id="credential-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setFormError(null);
              }}
            >
              {Object.entries(TYPES).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </div>
          <div className="wx-form-field">
            <label htmlFor="credential-issuer">Issuing authority</label>
            <input
              id="credential-issuer"
              value={issuingBody}
              onChange={(event) => {
                setIssuingBody(event.target.value);
                setFormError(null);
              }}
              placeholder="State board or certifying organization"
            />
          </div>
          <div className="wx-form-grid">
            <div className="wx-form-field">
              <label htmlFor="credential-effective">Effective date</label>
              <input
                id="credential-effective"
                type="date"
                value={effectiveAt}
                onChange={(event) => {
                  setEffectiveAt(event.target.value);
                  setFormError(null);
                }}
                required
              />
            </div>
            <div className="wx-form-field">
              <label htmlFor="credential-expires">Expiration date</label>
              <input
                id="credential-expires"
                type="date"
                min={effectiveAt}
                value={expiresAt}
                onChange={(event) => {
                  setExpiresAt(event.target.value);
                  setFormError(null);
                }}
                aria-invalid={Boolean(expiresAt && expiresAt < effectiveAt)}
              />
              <span className="wx-form-hint">Leave blank if the credential does not expire.</span>
            </div>
          </div>
          <div className="wx-modal-actions">
            <Button tone="tertiary" onClick={() => setAddOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button disabled={busy || !effectiveAt} onClick={() => void save()}>
              <Glyph name="plus" size={16} />
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
        <div className="wx-modal-body">
          <div className="wx-form-section-head" style={{ marginBottom: 0 }}>
            <span className="wx-form-section-icon" aria-hidden>
              <Glyph name="alert-circle" size={20} />
            </span>
            <div>
              <h2>Revoke credential?</h2>
              <p>This clinician may no longer qualify for visits requiring this credential.</p>
            </div>
          </div>
          {revokeError ? (
            <div className="wx-form-alert" role="alert">
              <Glyph name="alert-circle" size={18} />
              <p>{revokeError}</p>
            </div>
          ) : null}
          <div className="wx-form-field">
            <label htmlFor="credential-revoke-reason">Reason for revocation</label>
            <textarea
              id="credential-revoke-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setRevokeError(null);
              }}
              minLength={3}
              rows={3}
              placeholder="Document why this credential is being revoked"
              aria-invalid={reason.length > 0 && reason.trim().length < 3}
            />
            <span className="wx-form-hint">At least 3 characters are required.</span>
          </div>
          <div className="wx-modal-actions">
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
