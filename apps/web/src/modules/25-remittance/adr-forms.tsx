import { SelectField, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the two ADR forms (hospice ADR/TPE/QIC PRD, milestone 2a): "Log an ADR"
// (claim, MAC, review type, the date on the ADR letter) and "MAC response windows" (the organization's per-MAC
// rules, each with its source and a verified-on date). The server derives the due date and owns every refusal;
// the forms only collect facts and show the server's message verbatim (ADR-0030).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { ActionModal, ButtonRow, ErrorAlert, FormButtons, Hint } from "./action-ui";
import {
  type AdrReviewType,
  type MacRulesPage,
  createAdr,
  isUuid,
  loadMacRules,
  saveMacRule,
} from "./remittance-api";
import { humanize } from "./remittance-status";

const REVIEW_TYPES: readonly AdrReviewType[] = ["adr", "re_adr"];
const REVIEW_LABEL: Record<AdrReviewType, string> = { adr: "ADR", re_adr: "Re-ADR" };

export function LogAdrModal({
  onClose,
  onLogged,
}: {
  readonly onClose: () => void;
  readonly onLogged: (id: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [claimId, setClaimId] = useState("");
  const [macName, setMacName] = useState("");
  const [reviewType, setReviewType] = useState<AdrReviewType>("adr");
  const [requestedOn, setRequestedOn] = useState("");
  const [adrReference, setAdrReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = !isUuid(claimId) || macName.trim() === "" || requestedOn === "";

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await createAdr(client, {
      claimId: claimId.trim(),
      macName: macName.trim(),
      reviewType,
      requestedOn,
      ...(adrReference.trim() ? { adrReference: adrReference.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onLogged(res.value.id);
  }

  return (
    <ActionModal ariaLabel="Log an ADR" onClose={onClose}>
      <TextField
        label="Claim ID"
        value={claimId}
        onChange={(e) => setClaimId(e.target.value)}
        error={claimId && !isUuid(claimId) ? "Enter the claim's UUID." : undefined}
      />
      <TextField
        label="MAC"
        value={macName}
        onChange={(e) => setMacName(e.target.value)}
        maxLength={120}
      />
      <SelectField
        label="Review type"
        value={reviewType}
        onChange={(e) => setReviewType(e.target.value as AdrReviewType)}
        options={REVIEW_TYPES.map((t) => ({ value: t, label: REVIEW_LABEL[t] }))}
      />
      <TextField
        label="Date on the ADR letter"
        type="date"
        value={requestedOn}
        onChange={(e) => setRequestedOn(e.target.value)}
      />
      <TextField
        label="MAC reference (optional)"
        value={adrReference}
        onChange={(e) => setAdrReference(e.target.value)}
        maxLength={120}
      />
      <Hint>
        The response due date comes from the response window set for this MAC under "MAC response
        windows". Without a rule, the platform default is used and marked unverified.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Log ADR"
        busy={busy}
        blocked={blocked}
        onSubmit={() => void submit()}
        onCancel={onClose}
      />
    </ActionModal>
  );
}

export function MacRulesModal({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const client = useApiClient();
  const [rules, setRules] = useState<MacRulesPage["items"]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [macName, setMacName] = useState("");
  const [reviewType, setReviewType] = useState<AdrReviewType>("adr");
  const [days, setDays] = useState("45");
  const [sourceNote, setSourceNote] = useState("");
  const [verifiedOn, setVerifiedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    const res = await loadMacRules(client);
    if (res.ok) setRules(res.value.items);
    else setLoadError(res.message);
  }

  useEffect(() => {
    void reload();
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once on open
  }, []);

  const responseDays = Number(days);
  const blocked =
    macName.trim() === "" ||
    !Number.isInteger(responseDays) ||
    responseDays < 1 ||
    responseDays > 365;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await saveMacRule(client, {
      macName: macName.trim(),
      reviewType,
      responseDays,
      ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}),
      ...(verifiedOn ? { verifiedOn } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setMacName("");
    setSourceNote("");
    setVerifiedOn("");
    await reload();
  }

  return (
    <ActionModal ariaLabel="MAC response windows" onClose={onClose} width="42rem">
      <ErrorAlert message={loadError} />
      {rules.length === 0 ? (
        <Hint>
          No rules yet. Until you add one, ADRs use the platform default and show as unverified.
        </Hint>
      ) : (
        <table className="wx-table">
          <thead>
            <tr>
              <th>MAC</th>
              <th>Type</th>
              <th>Days</th>
              <th>Verified</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.macName}</td>
                <td>{humanize(r.reviewType)}</td>
                <td>{r.responseDays}</td>
                <td>{r.verifiedOn ?? "Unverified"}</td>
                <td>{r.sourceNote ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="wx-action-title">Add or update a rule</h3>
      <TextField label="MAC" value={macName} onChange={(e) => setMacName(e.target.value)} />
      <SelectField
        label="Review type"
        value={reviewType}
        onChange={(e) => setReviewType(e.target.value as AdrReviewType)}
        options={REVIEW_TYPES.map((t) => ({ value: t, label: REVIEW_LABEL[t] }))}
      />
      <TextField
        label="Response window (days)"
        type="number"
        value={days}
        onChange={(e) => setDays(e.target.value)}
      />
      <TextField
        label="Source (letter, MAC page)"
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        maxLength={500}
      />
      <TextField
        label="Verified on (leave blank if unconfirmed)"
        type="date"
        value={verifiedOn}
        onChange={(e) => setVerifiedOn(e.target.value)}
      />
      <ErrorAlert message={error} />
      <ButtonRow end>
        <FormButtons
          submitLabel="Save rule"
          busy={busy}
          blocked={blocked}
          onSubmit={() => void save()}
          onCancel={onClose}
        />
      </ButtonRow>
    </ActionModal>
  );
}
