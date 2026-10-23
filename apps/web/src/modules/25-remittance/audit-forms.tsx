import { Button, SelectField, TextAreaField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the audit-request intake form (milestone 7a-1). The authority kind (RAC, UPIC,
// SMRC, other) is a LABEL only: it selects no rule and sets no date. Claims are picked through the shared claim
// lookup, never pasted. Every date is typed from the request letter; the due date is recorded afterwards, from the
// notice, in the detail panel.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ClaimLookupField, ProviderEntityLookupField } from "../../shell/entity-lookups";
import { ActionModal, ErrorAlert, FormButtons, Hint } from "./action-ui";
import { AUDIT_AUTHORITY_KINDS, createAuditRequest } from "./audit-api";
import { humanize } from "./remittance-status";

const KIND_LABEL: Record<string, string> = {
  rac: "RAC",
  upic: "UPIC",
  smrc: "SMRC",
  other: "Other",
};

export function AuditIntakeModal({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [authorityKind, setAuthorityKind] = useState<(typeof AUDIT_AUTHORITY_KINDS)[number]>("rac");
  const [authorityName, setAuthorityName] = useState("");
  const [requestReference, setRequestReference] = useState("");
  const [requestDatedOn, setRequestDatedOn] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [claims, setClaims] = useState<readonly { id: string; label: string }[]>([]);
  const claimIds = claims.map((c) => c.id);
  const [pickerKey, setPickerKey] = useState(0);
  const [providerEntityId, setProviderEntityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A claim carries its own provider entity; the entity is only asked for when no claim is linked.
  const needsEntity = claimIds.length === 0;
  const blocked =
    receivedOn === "" ||
    (authorityKind === "other" && authorityName.trim() === "") ||
    (needsEntity && providerEntityId === "");

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await createAuditRequest(client, {
      authorityKind,
      receivedOn,
      ...(authorityName.trim() ? { authorityName: authorityName.trim() } : {}),
      ...(requestReference.trim() ? { requestReference: requestReference.trim() } : {}),
      ...(requestDatedOn ? { requestDatedOn } : {}),
      ...(scopeNote.trim() ? { scopeNote: scopeNote.trim() } : {}),
      ...(claimIds.length > 0 ? { claimIds } : { providerEntityId }),
    });
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated(res.value.id);
  }

  return (
    <ActionModal ariaLabel="Log an audit request" onClose={onClose} width="40rem">
      <SelectField
        label="Authority (a label only)"
        value={authorityKind}
        onChange={(e) => setAuthorityKind(e.target.value as typeof authorityKind)}
        options={AUDIT_AUTHORITY_KINDS.map((k) => ({
          value: k,
          label: KIND_LABEL[k] ?? humanize(k),
        }))}
      />
      <TextField
        label={authorityKind === "other" ? "Authority name" : "Authority name (optional)"}
        value={authorityName}
        onChange={(e) => setAuthorityName(e.target.value)}
        maxLength={200}
      />
      <TextField
        label="Request reference (optional)"
        value={requestReference}
        onChange={(e) => setRequestReference(e.target.value)}
        maxLength={120}
      />
      <TextField
        label="Date on the request letter (optional)"
        type="date"
        value={requestDatedOn}
        onChange={(e) => setRequestDatedOn(e.target.value)}
      />
      <TextField
        label="Date received"
        type="date"
        value={receivedOn}
        onChange={(e) => setReceivedOn(e.target.value)}
      />
      <TextAreaField
        label="Scope (optional)"
        value={scopeNote}
        onChange={(e) => setScopeNote(e.target.value)}
        rows={3}
        maxLength={2000}
      />
      <ClaimLookupField
        key={pickerKey}
        label="Add a claim"
        value=""
        onChange={(id, option) => {
          if (!id || claimIds.includes(id)) return;
          setClaims((cs) => [...cs, { id, label: option?.searchLabel ?? id.slice(0, 8) }]);
          setPickerKey((k) => k + 1);
        }}
      />
      {claimIds.length > 0 ? (
        <ul className="wx-action-hint wx-action-list" aria-label="Linked claims">
          {claims.map((c) => (
            <li key={c.id}>
              {c.label}{" "}
              <Button
                size="sm"
                tone="tertiary"
                aria-label={`Remove claim ${c.label}`}
                onClick={() => setClaims((cs) => cs.filter((x) => x.id !== c.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <ProviderEntityLookupField
          label="Provider entity (when no claim is linked)"
          value={providerEntityId}
          onChange={(id) => setProviderEntityId(id)}
        />
      )}
      <Hint>
        No due date is set here. Record it from the notice once you have it; until then the request
        shows "No due date recorded".
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Log request"
        busy={busy}
        blocked={blocked}
        onSubmit={() => void submit()}
        onCancel={onClose}
      />
    </ActionModal>
  );
}
