import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/39-consent — M39 CONSENT RECIPIENTS & DPOA (§5.1, Track B / ADR-0030).
// Spec: docs/design/screens/compliance/WARDENX_UI_CONSENT_RECIPIENTS_DPOA.md.
//
// Scoped to ONE consent record: who this consent authorises disclosure TO (D6 named recipients) and who may
// decide UNDER it (D5 named DPOA agents). Reads GET /api/v1/consents/:consentId/recipients and
// /dpoa-agents through the typed client.
//
// Both tables show ACTIVE AND HISTORICAL rows, because that is what the records are for: a recipient row is
// never deleted, only stamped `removed_at` (D6), so a disclosure target that WAS authorised stays legible
// after it is withdrawn. `active` is derived SERVER-side by the pure recipient/DPOA machines — the browser
// never re-decides who is currently authorised.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import {
  ACTIVE_TONE,
  DPOA_ACTIVATION_TONE,
  DPOA_AGENT_KIND_TONE,
  humanize,
  readErrorMessage,
  toneOf,
} from "./consent-status";

interface RecipientRow {
  id: string;
  recipientKind: string;
  recipientDisplayName: string;
  purposeCode: string | null;
  expiresAt: string | null;
  addedAt: string;
  removedAt: string | null;
  removedReasonText: string | null;
  active: boolean;
}
interface AgentRow {
  id: string;
  agentKind: string;
  agentName: string;
  agentRelationship: string;
  scopeKind: string;
  activationCondition: string;
  termKind: string;
  termUntil: string | null;
  removedAt: string | null;
  active: boolean;
}

const cell: CSSProperties = {
  padding: "0.55rem 0.75rem",
  textAlign: "left",
  verticalAlign: "middle",
};
const head: CSSProperties = {
  ...cell,
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 600,
};
const row: CSSProperties = { borderTop: `1px solid ${t.surfaceContainer}` };

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");

export function ConsentRecipientsDpoa(): JSX.Element {
  const client = useApiClient();
  const { consentId } = useParams<{ consentId: string }>();
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!consentId) return;
    let active = true;
    void (async () => {
      setLoading(true);
      const [rRes, aRes] = await Promise.all([
        client.GET("/api/v1/consents/{consentId}/recipients", { params: { path: { consentId } } }),
        client.GET("/api/v1/consents/{consentId}/dpoa-agents", { params: { path: { consentId } } }),
      ]);
      if (!active) return;
      if (rRes.error && aRes.error) {
        setError(readErrorMessage(rRes.response?.status, "consent.read"));
      } else {
        setRecipients(rRes.data?.data ?? []);
        setAgents(aRes.data?.data ?? []);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, consentId]);

  const activeRecipients = useMemo(() => recipients.filter((r) => r.active).length, [recipients]);
  const primary = useMemo(
    () => agents.find((a) => a.active && a.agentKind === "primary") ?? null,
    [agents],
  );

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <>
      <PageHeader title="Recipients & DPOA agents">
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          {activeRecipients} active recipient{activeRecipients === 1 ? "" : "s"} ·{" "}
          {primary ? `primary agent ${primary.agentName}` : "no active primary agent"}
        </p>
      </PageHeader>

      <section style={cardSurface}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Named recipients</h2>
        <p style={{ margin: "0.25rem 0 1rem", color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Who this consent authorises disclosure to. A withdrawn recipient is retained, not deleted
          — a target that was once authorised stays part of the record.
        </p>
        {recipients.length === 0 ? (
          <EmptyState
            title="No named recipients"
            description="This consent type does not enumerate recipients, or none have been named yet."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Recipient</th>
                <th style={head}>Kind</th>
                <th style={head}>Purpose</th>
                <th style={head}>Added</th>
                <th style={head}>Withdrawn</th>
                <th style={head}>State</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id} style={row}>
                  <td style={cell}>{r.recipientDisplayName}</td>
                  <td style={cell}>{humanize(r.recipientKind)}</td>
                  <td style={cell}>{r.purposeCode ?? "—"}</td>
                  <td style={cell}>{day(r.addedAt)}</td>
                  <td style={cell}>{day(r.removedAt)}</td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(ACTIVE_TONE, r.active ? "active" : "removed")}
                      label={r.active ? "Active" : "Withdrawn"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ ...cardSurface, marginTop: "1rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>DPOA agents</h2>
        <p style={{ margin: "0.25rem 0 1rem", color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Who may decide under this consent. Exactly one active primary is required before it can be
          signed (D5); alternates stand by in order.
        </p>
        {agents.length === 0 ? (
          <EmptyState
            title="No named agents"
            description="This consent type does not enumerate DPOA agents, or none have been named yet."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Agent</th>
                <th style={head}>Order</th>
                <th style={head}>Relationship</th>
                <th style={head}>Scope</th>
                <th style={head}>Activates</th>
                <th style={head}>Term</th>
                <th style={head}>State</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} style={row}>
                  <td style={cell}>{a.agentName}</td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(DPOA_AGENT_KIND_TONE, a.agentKind)}
                      label={humanize(a.agentKind)}
                    />
                  </td>
                  <td style={cell}>{a.agentRelationship}</td>
                  <td style={cell}>{humanize(a.scopeKind)}</td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(DPOA_ACTIVATION_TONE, a.activationCondition)}
                      label={humanize(a.activationCondition)}
                    />
                  </td>
                  <td style={cell}>
                    {a.termKind === "until_date" ? day(a.termUntil) : humanize(a.termKind)}
                  </td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(ACTIVE_TONE, a.active ? "active" : "removed")}
                      label={a.active ? "Active" : "Retired"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
