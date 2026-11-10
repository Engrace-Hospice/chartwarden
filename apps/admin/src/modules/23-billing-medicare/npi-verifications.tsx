import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  Modal,
  ReverifyLink,
  StatusPill,
  type StatusTone,
  TableScroll,
  TextAreaField,
  isStepUpRequired,
  sendWrite,
  useApiClient,
  useIdempotencyKeeper,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/23-billing-medicare — PLATFORM NPI VERIFICATION (ADR-0053 amendment 2026-11-05, precondition 2).
// A tenant can register any valid NPI on its provider entity; the Claim.MD webhook sweep routes a vendor enrollment
// report only to an entity whose CURRENT NPI platform staff verified here. Changing the NPI stops it routing.
//
//   GET  /api/v1/admin/billing/npi-verifications                       — every tenant's provider entities + state
//   POST /api/v1/admin/billing/npi-verifications/:providerEntityId/verify — { npi (the one checked), evidence }
//   POST /api/v1/admin/billing/npi-verifications/:providerEntityId/revoke
// Writes need `billing.rule_config.platform_admin`, a platform-ops role, a fresh step-up and an Idempotency-Key. A stale
// session gets STEP_UP_REQUIRED and a Re-verify link; nothing typed here is worth stashing for that round trip.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

type Row =
  operations["getApiV1AdminBillingNpiverifications"]["responses"][200]["content"]["application/json"][number];

const STATE: Record<Row["state"], { label: string; tone: StatusTone }> = {
  verified: { label: "Verified", tone: "success" },
  unverified: { label: "Not verified", tone: "warning" },
  revoked: { label: "Revoked", tone: "error" },
};

interface Outcome {
  readonly ok: boolean;
  readonly message: string;
  readonly stepUp?: boolean;
}

const failure = (error: unknown, fallback: string): Outcome =>
  isStepUpRequired(error)
    ? {
        ok: false,
        message: "This needs a fresh verification. Re-verify, then try again.",
        stepUp: true,
      }
    : {
        ok: false,
        message: (error as { error?: { message?: string } })?.error?.message ?? fallback,
      };

/** A write whose request got no answer at all: the change may or may not have landed. */
const UNREACHABLE: Outcome = {
  ok: false,
  message:
    "Could not reach the server. Check your connection, and confirm the current state before trying again.",
};

const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—";

export function NpiVerifications(): JSX.Element {
  const client = useApiClient();
  // One Idempotency-Key per write intent: a retry after "could not reach the server" replays it (the first request may have landed).
  const keeper = useIdempotencyKeeper();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [verifying, setVerifying] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/admin/billing/npi-verifications");
    setLoadFailed(Boolean(res.error));
    setRows(res.error ? [] : res.data);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (row: Row) => {
      setBusyId(row.providerEntityId);
      setOutcome(null);
      try {
        // Success is "no error AND response.ok", and a rejected request (offline) is a failure, never an exception.
        const sent = await sendWrite(keeper, `revoke:${row.providerEntityId}:${row.npi}`, (key) =>
          client.POST("/api/v1/admin/billing/npi-verifications/{providerEntityId}/revoke", {
            params: { path: { providerEntityId: row.providerEntityId } },
            headers: { "Idempotency-Key": key },
          }),
        );
        if (sent.status !== "ok") {
          setOutcome(
            sent.status === "unreachable"
              ? UNREACHABLE
              : failure(sent.res.error, "Could not revoke the verification."),
          );
          return;
        }
        setOutcome({
          ok: true,
          message: `Revoked NPI ${row.npi}. Its enrollment reports are no longer routed.`,
        });
        await load();
      } finally {
        setBusyId(null); // also when the reload after a landed write throws: the row never stays locked
      }
    },
    [client, load, keeper],
  );

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>NPI verification</h1>
            <p>
              Claim.MD enrollment reports reach a tenant only when platform staff have verified that
              its provider entity owns the NPI. An entity whose NPI changes is unverified until
              checked again.
            </p>
          </div>
        </header>
        {outcome ? (
          <div className="wx-drawer-title-row">
            <InlineAlert tone={outcome.ok ? "success" : "error"}>{outcome.message}</InlineAlert>
            {outcome.stepUp ? <ReverifyLink /> : null}
          </div>
        ) : null}
        <EntitiesBody
          rows={rows}
          loadFailed={loadFailed}
          busyId={busyId}
          onRevoke={(row) => void revoke(row)}
          onVerify={(row) => {
            setOutcome(null);
            setVerifying(row);
          }}
        />
      </div>
      {verifying ? (
        <VerifyDialog
          row={verifying}
          onClose={() => setVerifying(null)}
          onDone={async (message) => {
            setVerifying(null);
            setOutcome({ ok: true, message });
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function EntitiesBody({
  rows,
  loadFailed,
  busyId,
  onRevoke,
  onVerify,
}: {
  rows: readonly Row[] | null;
  loadFailed: boolean;
  busyId: string | null;
  onRevoke: (row: Row) => void;
  onVerify: (row: Row) => void;
}): JSX.Element {
  if (rows === null)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading provider entities…" />
      </div>
    );
  if (loadFailed)
    return (
      <div className="wx-list-state">
        <InlineAlert tone="error">Could not load provider entities.</InlineAlert>
      </div>
    );
  if (rows.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="shield" size={24} />
        <strong>No provider entities</strong>
        <span className="wx-row-sub">No tenant has registered one yet.</span>
      </div>
    );
  return (
    <TableScroll>
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Provider entities and NPI verification</caption>
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Provider entity</th>
            <th scope="col">NPI</th>
            <th scope="col">Status</th>
            <th scope="col">Since</th>
            <th scope="col">
              <span className="wx-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.providerEntityId}>
              <td>{r.organizationName}</td>
              <td>
                <span className="wx-row-title">{r.legalName}</span>
              </td>
              <td className="wx-nums">{r.npi}</td>
              <td>
                <StatusPill label={STATE[r.state].label} tone={STATE[r.state].tone} />
              </td>
              <td className="wx-nums">
                {formatDate(r.state === "revoked" ? r.revokedAt : r.verifiedAt)}
              </td>
              <td>
                {r.state === "verified" ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    loading={busyId === r.providerEntityId}
                    aria-label={`Revoke NPI ${r.npi} for ${r.legalName}`}
                    onClick={() => onRevoke(r)}
                  >
                    Revoke
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    aria-label={`Verify NPI ${r.npi} for ${r.legalName}`}
                    onClick={() => onVerify(r)}
                  >
                    Verify
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function VerifyDialog({
  row,
  onClose,
  onDone,
}: {
  row: Row;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const keeper = useIdempotencyKeeper();
  const [evidence, setEvidence] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Outcome | null>(null);
  const evidenceError =
    attempted && evidence.trim().length < 3
      ? "Say how you confirmed ownership (3+ characters)."
      : undefined;

  const submit = async () => {
    setAttempted(true);
    if (evidence.trim().length < 3) return;
    setBusy(true);
    setError(null);
    const body = { npi: row.npi, evidence: evidence.trim() };
    // One key per verification (entity + NPI + evidence): a retry after no answer replays it, a changed evidence text is a new one.
    const sent = await sendWrite(keeper, `${row.providerEntityId}:${JSON.stringify(body)}`, (key) =>
      client.POST("/api/v1/admin/billing/npi-verifications/{providerEntityId}/verify", {
        params: { path: { providerEntityId: row.providerEntityId } },
        body,
        headers: { "Idempotency-Key": key },
      }),
    );
    setBusy(false);
    if (sent.status !== "ok") {
      setError(
        sent.status === "unreachable"
          ? UNREACHABLE
          : failure(sent.res.error, "Could not verify the NPI."),
      );
      return;
    }
    await onDone(`Verified NPI ${row.npi} for ${row.legalName}.`);
  };

  return (
    <Modal open onClose={busy ? undefined : onClose} ariaLabel="Verify NPI" width="32rem">
      <div className="wx-modal-body">
        <h2>Verify NPI {row.npi}</h2>
        <p>
          Confirm that <strong>{row.legalName}</strong> ({row.organizationName}) owns this NPI, for
          example against the NPPES record and a call to the provider's listed contact.
        </p>
        <TextAreaField
          label="How you confirmed it (for the audit record)"
          hint="Do not include patient information."
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          error={evidenceError}
          rows={3}
        />
        {error ? <InlineAlert tone="error">{error.message}</InlineAlert> : null}
        {error?.stepUp ? (
          <div className="wx-drawer-actions">
            <ReverifyLink />
          </div>
        ) : null}
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Verify NPI
          </Button>
        </div>
      </div>
    </Modal>
  );
}
