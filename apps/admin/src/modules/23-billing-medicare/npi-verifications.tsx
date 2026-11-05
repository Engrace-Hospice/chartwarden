import {
  Button,
  EmptyState,
  InlineAlert,
  Modal,
  Panel,
  ReverifyLink,
  StatusPill,
  type StatusTone,
  TextAreaField,
  isStepUpRequired,
  useApiClient,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/23-billing-medicare — PLATFORM NPI VERIFICATION (ADR-0053 amendment 2026-11-05, precondition 2).
// A tenant can register any valid NPI on its provider entity; the Claim.MD webhook sweep routes a vendor enrollment
// report only to an entity whose CURRENT NPI platform staff verified here. Changing the NPI voids the verification.
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

const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" }) : "—";

export function NpiVerifications(): JSX.Element {
  const client = useApiClient();
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
      const res = await client.POST(
        "/api/v1/admin/billing/npi-verifications/{providerEntityId}/revoke",
        {
          params: { path: { providerEntityId: row.providerEntityId } },
          headers: { "Idempotency-Key": crypto.randomUUID() },
        },
      );
      setBusyId(null);
      if (res.error) {
        setOutcome(failure(res.error, "Could not revoke the verification."));
        return;
      }
      setOutcome({
        ok: true,
        message: `Revoked NPI ${row.npi}. Its enrollment reports are no longer routed.`,
      });
      await load();
    },
    [client, load],
  );

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>NPI verification</h1>
            <p>
              Claim.MD enrollment reports reach a tenant only when platform staff have verified that
              its provider entity owns the NPI. Changing an entity's NPI clears its verification.
            </p>
          </div>
        </header>
        {outcome ? (
          <div className="flex flex-wrap items-center gap-3">
            <InlineAlert tone={outcome.ok ? "success" : "error"}>{outcome.message}</InlineAlert>
            {outcome.stepUp ? <ReverifyLink /> : null}
          </div>
        ) : null}
        <Panel title="Provider entities" icon="shield" flush={Boolean(rows && rows.length > 0)}>
          {rows === null ? (
            <p className="m-0 text-sm">Loading provider entities…</p>
          ) : loadFailed ? (
            <InlineAlert tone="error">Could not load provider entities.</InlineAlert>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No provider entities"
              description="No tenant has registered one yet."
            />
          ) : (
            <div className="wx-list-table-wrap">
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
                            onClick={() => void revoke(r)}
                          >
                            Revoke
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            aria-label={`Verify NPI ${r.npi} for ${r.legalName}`}
                            onClick={() => {
                              setOutcome(null);
                              setVerifying(r);
                            }}
                          >
                            Verify
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
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
    const res = await client.POST(
      "/api/v1/admin/billing/npi-verifications/{providerEntityId}/verify",
      {
        params: { path: { providerEntityId: row.providerEntityId } },
        body: { npi: row.npi, evidence: evidence.trim() },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    setBusy(false);
    if (res.error) {
      setError(failure(res.error, "Could not verify the NPI."));
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
        {error?.stepUp ? <ReverifyLink /> : null}
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
