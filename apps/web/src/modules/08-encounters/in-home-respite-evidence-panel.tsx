import { Button, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";

interface InHomeRespiteEvidenceRow {
  readonly id: string;
  readonly serviceId: string;
  readonly version: number;
  readonly sourceEncounterId: string;
  readonly sourceEncounterVersion: number;
  readonly serviceDate: string;
  readonly serviceStartedAt: string;
  readonly serviceEndedAt: string;
  readonly observedDurationSeconds: number;
  readonly timeSource: "evv" | "clinician";
  readonly supersedesId: string | null;
  readonly createdAt: string;
}

function isEvidenceRow(value: unknown): value is InHomeRespiteEvidenceRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.serviceId === "string" &&
    Number.isInteger(row.version) &&
    typeof row.sourceEncounterId === "string" &&
    Number.isInteger(row.sourceEncounterVersion) &&
    typeof row.serviceDate === "string" &&
    typeof row.serviceStartedAt === "string" &&
    typeof row.serviceEndedAt === "string" &&
    Number.isInteger(row.observedDurationSeconds) &&
    (row.timeSource === "evv" || row.timeSource === "clinician") &&
    (row.supersedesId === null || typeof row.supersedesId === "string") &&
    typeof row.createdAt === "string"
  );
}

function durationLabel(seconds: number): string {
  const wholeMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  return hours > 0
    ? `${hours} hr${hours === 1 ? "" : "s"}${minutes > 0 ? ` ${minutes} min` : ""}`
    : `${minutes} min`;
}

function utcTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : `${date.toISOString().slice(11, 16)} UTC`;
}

/** Small M8 clinical capture/read surface. It never displays a price or payer-ready state. */
export function InHomeRespiteEvidencePanel({
  encounterId,
  encounterStatus,
}: {
  readonly encounterId: string;
  readonly encounterStatus: string;
}): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const canRecord = session?.permissions?.includes("encounter.author") === true;
  const [rows, setRows] = useState<readonly InHomeRespiteEvidenceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.GET("/api/v1/encounters/{encounterId}/in-home-respite", {
        params: { path: { encounterId } },
      });
      if (result.error) throw new Error("The clinical evidence could not be loaded.");
      if (!Array.isArray(result.data) || !result.data.every(isEvidenceRow)) {
        throw new Error("The clinical evidence response could not be read. Reload the encounter.");
      }
      setRows(result.data);
      setLoaded(true);
    } catch {
      setError("The clinical evidence could not be loaded. Check your access and try again.");
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [client, encounterId]);

  useEffect(() => {
    if (encounterStatus !== "signed" && encounterStatus !== "cosigned") return;
    void load();
  }, [encounterStatus, load]);

  const record = async () => {
    if (!canRecord || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.POST("/api/v1/encounters/{encounterId}/in-home-respite", {
        params: { path: { encounterId } },
      });
      if (result.error || !isEvidenceRow(result.data)) {
        throw new Error("The delivered service evidence could not be recorded.");
      }
      setConfirmed(false);
      await load();
    } catch {
      setError("The delivered service evidence could not be recorded. Reload and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (encounterStatus !== "signed" && encounterStatus !== "cosigned") return null;

  const currentId = rows[0]?.id;
  return (
    <section
      aria-labelledby="in-home-respite-evidence-title"
      style={{
        border: "1px solid var(--wx-border-subtle)",
        borderRadius: 12,
        padding: 16,
        background: "var(--wx-surface)",
        display: "grid",
        gap: 12,
      }}
    >
      <div>
        <h2 id="in-home-respite-evidence-title" style={{ margin: 0, fontSize: "1rem" }}>
          In-home respite service evidence
        </h2>
        <p style={{ margin: "0.4rem 0 0", color: "var(--wx-text-muted)" }}>
          This records delivered clinical service evidence from the signed encounter. Reimbursement
          policy and institutional billing format are not yet qualified.
        </p>
      </div>

      {loading ? <output aria-live="polite">Loading service evidence…</output> : null}
      {!loading && loaded && rows.length === 0 ? (
        <p style={{ margin: 0 }}>
          No in-home respite service evidence is recorded for this encounter.
        </p>
      ) : null}
      {rows.map((row) => (
        <div
          key={row.id}
          style={{
            borderInlineStart: "3px solid var(--wx-border-subtle)",
            paddingInlineStart: 12,
          }}
        >
          <strong>
            {row.id === currentId ? "Current evidence" : `Superseded version ${row.version}`}
          </strong>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(9rem, auto) 1fr",
              gap: 6,
              margin: "8px 0 0",
            }}
          >
            <dt>Service date</dt>
            <dd style={{ margin: 0 }} className="tabular-nums">
              {row.serviceDate}
            </dd>
            <dt>Recorded interval</dt>
            <dd style={{ margin: 0 }} className="tabular-nums">
              {utcTime(row.serviceStartedAt)}–{utcTime(row.serviceEndedAt)}
            </dd>
            <dt>Observed duration</dt>
            <dd style={{ margin: 0 }}>{durationLabel(row.observedDurationSeconds)}</dd>
            <dt>Time source</dt>
            <dd style={{ margin: 0 }}>{row.timeSource === "evv" ? "EVV" : "Clinician recorded"}</dd>
            <dt>Evidence version</dt>
            <dd style={{ margin: 0 }}>{row.version}</dd>
          </dl>
        </div>
      ))}

      {canRecord && rows.length === 0 && loaded ? (
        <div style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            <span>This signed note documents delivered in-home respite care.</span>
          </label>
          <Button onClick={() => void record()} disabled={!confirmed || busy} loading={busy}>
            Record clinical service evidence
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ margin: 0, color: "var(--wx-danger-text)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
