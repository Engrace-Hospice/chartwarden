// apps/web/src/modules/06-admission/election-addendum-drawer.tsx — the right-hand drawer for ONE election
// statement addendum version (FY2027, 42 CFR 418.24(c)/(d)), on the admission-drawer pattern (aside.
// wx-admission-drawer, flat wx-drawer-card sections, wx-kv label/value rows). A draft is edited and furnished
// here; a furnished version records its signature, a refusal (reason required, (c)(9)), or why a signature is
// not required ((d)(4)). A scanned signed (or refused) paper copy can be uploaded instead — also on a draft
// that was furnished on paper outside WardenX (election-addendum-scan-form.tsx). Furnished versions are
// read-only — a plan-of-care change makes a new version. The server validates every step; its message is
// shown verbatim on refusal.
import {
  Button,
  Glyph,
  IconButton,
  InlineAlert,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
} from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type {
  AddendumItem,
  AddendumVersion,
  ElectionAddendumApi,
  ItemCategory,
} from "./election-addendum-api";
import {
  ADDENDUM_STATUS_LABEL,
  ADDENDUM_STATUS_TONE,
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  EXEMPTION_OPTIONS,
  FURNISH_OPTIONS,
  REFUSAL_MIN,
  acknowledgementLabel,
  usDate,
} from "./election-addendum-format";
import { ScannedCopyForm } from "./election-addendum-scan-form";

export interface AddendumPermissions {
  readonly write: boolean;
  readonly acknowledge: boolean;
}

type AckMode = "signature" | "upload" | "refusal" | "not_required";
type Exemption = "death" | "revocation" | "discharge";

const EMPTY_ITEM: AddendumItem = { category: "condition", description: "", reasonNotCovered: "" };

function DiagnosisRows({ v }: { v: AddendumVersion }): JSX.Element {
  const line = (d: { icd10Code: string | null; description: string }) =>
    d.icd10Code ? `${d.description} (${d.icd10Code})` : d.description;
  return (
    <dl className="wx-kv">
      <dt>Terminal</dt>
      <dd>{v.terminalDiagnosis.map(line).join("; ") || "Not recorded"}</dd>
      <dt>Related</dt>
      <dd>{v.relatedDiagnoses.map(line).join("; ") || "None identified"}</dd>
    </dl>
  );
}

/** Read-only non-covered list: type on the left, the item and its patient-facing reason on the right. */
export function NonCoveredList({ items }: { items: readonly AddendumItem[] }): JSX.Element {
  return (
    <dl className="wx-kv">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stored order is the identity.
        <div key={i}>
          <dt>{CATEGORY_LABEL[it.category]}</dt>
          <dd>
            {it.description}
            <span className="wx-row-sub">{it.reasonNotCovered}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ItemEditor({
  items,
  onChange,
}: {
  items: AddendumItem[];
  onChange: (next: AddendumItem[]) => void;
}): JSX.Element {
  const set = (i: number, patch: Partial<AddendumItem>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="wx-addendum-items">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved; order is the identity.
        <fieldset key={i} className="wx-addendum-item">
          <legend className="wx-visually-hidden">Non-covered item {i + 1}</legend>
          <SelectField
            label="Type"
            value={it.category}
            options={CATEGORY_OPTIONS}
            onChange={(e) => set(i, { category: e.target.value as ItemCategory })}
          />
          <TextField
            label="Condition, item, service, or drug"
            value={it.description}
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <TextAreaField
            label="Reason not covered"
            value={it.reasonNotCovered}
            onChange={(e) => set(i, { reasonNotCovered: e.target.value })}
          />
          <div className="wx-action-row">
            {it.source ? (
              <p className="wx-pa-source">
                <Glyph name="link" size={12} />
                <span>From the {it.source === "problem" ? "plan of care" : it.source}</span>
              </p>
            ) : null}
            <Button
              tone="tertiary"
              size="sm"
              aria-label={`Remove item ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="wx-action-row">
        <Button tone="secondary" size="sm" onClick={() => onChange([...items, { ...EMPTY_ITEM }])}>
          <Glyph name="plus" size={14} /> Add item
        </Button>
      </div>
    </div>
  );
}

export function ElectionAddendumDrawer({
  admissionId,
  version: v,
  api,
  can,
  onChanged,
  onClose,
}: {
  admissionId: string;
  version: AddendumVersion;
  api: ElectionAddendumApi;
  can: AddendumPermissions;
  onChanged: () => void;
  onClose: () => void;
}): JSX.Element {
  const [items, setItems] = useState<AddendumItem[]>(v.items);
  const [none, setNone] = useState(v.noNonCoveredItems);
  const [explanation, setExplanation] = useState(v.clinicalExplanation ?? "");
  const [references, setReferences] = useState(v.guidelineReferences ?? "");
  const [method, setMethod] = useState<"paper" | "electronic_with_paper_copy">("paper");
  const [mode, setMode] = useState<AckMode>(v.status === "draft" ? "upload" : "signature");
  const [signer, setSigner] = useState<"beneficiary" | "representative">("beneficiary");
  const [repName, setRepName] = useState("");
  const [repRelationship, setRepRelationship] = useState("");
  const [reason, setReason] = useState("");
  const [exemption, setExemption] = useState<Exemption>("death");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // A different version selected: reset the editor to its stored content.
  useEffect(() => {
    setItems(v.items);
    setNone(v.noNonCoveredItems);
    setExplanation(v.clinicalExplanation ?? "");
    setReferences(v.guidelineReferences ?? "");
    setMode(v.status === "draft" ? "upload" : "signature");
    setError(null);
    setTouched(false);
  }, [v]);

  const editable = v.status === "draft" && can.write;
  const acknowledgeable = (v.status === "furnished" || v.status === "draft") && can.acknowledge;

  const run = async (op: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await op();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(() =>
      api.save(admissionId, v, {
        items: none ? [] : items,
        noNonCoveredItems: none,
        clinicalExplanation: explanation.trim() || null,
        guidelineReferences: references.trim() || null,
      }),
    );

  const refusalError =
    touched && mode === "refusal" && reason.trim().length < REFUSAL_MIN
      ? `Document why the addendum was not signed (at least ${REFUSAL_MIN} characters).`
      : undefined;

  const acknowledge = () => {
    setTouched(true);
    if (mode === "refusal") {
      if (reason.trim().length < REFUSAL_MIN) return;
      void run(() => api.refuse(admissionId, v, reason.trim()));
    } else if (mode === "signature") {
      void run(() =>
        api.sign(admissionId, v, {
          signerKind: signer,
          representativeName: signer === "representative" ? repName.trim() || null : null,
          representativeRelationship:
            signer === "representative" ? repRelationship.trim() || null : null,
        }),
      );
    } else {
      void run(() => api.notRequired(admissionId, v, exemption, note.trim() || null));
    }
  };

  const ackOptions =
    v.status === "draft"
      ? [
          { value: "upload", label: "Upload signed paper copy" },
          { value: "not_required", label: "Signature not required — left care" },
        ]
      : [
          { value: "signature", label: "Signature received" },
          { value: "upload", label: "Upload signed paper copy" },
          { value: "refusal", label: "Refused to sign" },
          { value: "not_required", label: "Signature not required" },
        ];

  const openDocument = (documentId: string, versionId: string | null) =>
    void (async () => {
      setError(null);
      try {
        const url = await api.documentUrl(documentId, versionId);
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (e) {
        setError(e instanceof Error ? e.message : "The document is not available.");
      }
    })();
  const ackLabel = acknowledgementLabel(v);

  return (
    <aside className="wx-admission-drawer" aria-label={`Addendum version ${v.versionNumber}`}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon wx-addendum-icon" aria-hidden>
          <Glyph name="file-text" size={16} />
        </span>
        <div className="wx-addendum-head-text">
          <h2>Version {v.versionNumber}</h2>
          <div className="wx-row-sub">
            {v.trigger === "initial" ? "Initial addendum" : "Plan of care update"} ·{" "}
            {usDate(v.triggeredAt)}
          </div>
        </div>
        <IconButton tone="tertiary" size="sm" aria-label="Close addendum details" onClick={onClose}>
          <Glyph name="close" size={16} />
        </IconButton>
      </header>

      <div className="wx-drawer-body">
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Status</h3>
            <StatusPill
              label={ADDENDUM_STATUS_LABEL[v.status]}
              tone={ADDENDUM_STATUS_TONE[v.status]}
            />
          </div>
          <dl className="wx-kv">
            <dt>Hospice</dt>
            <dd>{v.hospiceName ?? "—"}</dd>
            <dt>Patient</dt>
            <dd>{v.patientName ?? "—"}</dd>
            <dt>MRN</dt>
            <dd className="wx-nums">{v.medicalRecordNumber ?? "—"}</dd>
            <dt>Due</dt>
            <dd className="wx-nums">{usDate(v.dueAt)}</dd>
            <dt>Furnished</dt>
            <dd className="wx-nums">{usDate(v.furnishedAt)}</dd>
            {ackLabel ? (
              <>
                <dt>Acknowledgement</dt>
                <dd>{ackLabel}</dd>
              </>
            ) : null}
            {v.signedAt ? (
              <>
                <dt>Signed</dt>
                <dd className="wx-nums">
                  {usDate(v.signedAt)}
                  {v.signerKind === "representative" && v.representativeName
                    ? ` · ${v.representativeName}${v.representativeRelationship ? ` (${v.representativeRelationship})` : ""}`
                    : ""}
                </dd>
              </>
            ) : null}
            {v.refusalReason ? (
              <>
                <dt>Refusal reason</dt>
                <dd>{v.refusalReason}</dd>
              </>
            ) : null}
            {v.signatureNotRequiredReason ? (
              <>
                <dt>Not required</dt>
                <dd>
                  {EXEMPTION_OPTIONS.find((o) => o.value === v.signatureNotRequiredReason)?.label}
                  {v.signatureNotRequiredNote ? ` — ${v.signatureNotRequiredNote}` : ""}
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        {v.documentId || v.acknowledgementDocumentId ? (
          <section className="wx-drawer-card">
            <h3>Documents</h3>
            <dl className="wx-kv wx-addendum-docs">
              {v.documentId ? (
                <>
                  <dt>
                    {v.contentSource === "scanned_paper" ? "Record notice" : "Printed addendum"}
                  </dt>
                  <dd>
                    <Button
                      tone="tertiary"
                      size="sm"
                      onClick={() => openDocument(v.documentId as string, null)}
                    >
                      <Glyph name="file-text" size={14} /> Open PDF
                    </Button>
                  </dd>
                </>
              ) : null}
              {v.acknowledgementDocumentId ? (
                <>
                  <dt>{v.status === "refused" ? "Scanned refusal" : "Scanned signed copy"}</dt>
                  <dd>
                    <Button
                      tone="tertiary"
                      size="sm"
                      onClick={() =>
                        openDocument(
                          v.acknowledgementDocumentId as string,
                          v.acknowledgementDocumentVersionId,
                        )
                      }
                    >
                      <Glyph name="file-check" size={14} /> Open scan
                    </Button>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        <section className="wx-drawer-card">
          <h3>Terminal illness and related conditions</h3>
          <DiagnosisRows v={v} />
          <p className="wx-pa-source">
            <Glyph name="lock" size={12} />
            <span>From the plan of care</span>
          </p>
        </section>

        <section className="wx-drawer-card">
          <h3>Not covered by the hospice</h3>
          {editable ? (
            <>
              <SelectField
                label="Determination"
                value={none ? "none" : "list"}
                options={[
                  { value: "list", label: "Some items are not covered" },
                  { value: "none", label: "Everything is related and covered" },
                ]}
                onChange={(e) => setNone(e.target.value === "none")}
              />
              {none ? null : <ItemEditor items={items} onChange={setItems} />}
              <TextAreaField
                label="Clinical explanation"
                hint="In plain language: why these are unrelated and not needed for pain or symptom management."
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
              />
              <TextAreaField
                label="Guideline references"
                value={references}
                onChange={(e) => setReferences(e.target.value)}
              />
              <div className="wx-action-row is-end">
                <Button tone="secondary" loading={busy} onClick={() => void save()}>
                  Save draft
                </Button>
              </div>
            </>
          ) : v.contentSource === "scanned_paper" ? (
            <p className="wx-pa-source">
              <Glyph name="file-check" size={12} />
              <span>
                On the signed paper copy. This version was completed on paper; open the scan for its
                determinations.
              </span>
            </p>
          ) : v.noNonCoveredItems ? (
            <p className="wx-row-sub">Everything is related to the terminal illness and covered.</p>
          ) : v.items.length === 0 ? (
            <p className="wx-row-sub">No items recorded yet.</p>
          ) : (
            <NonCoveredList items={v.items} />
          )}
        </section>

        {editable ? (
          <section className="wx-drawer-card">
            <h3>Furnish in writing</h3>
            <SelectField
              label="How it was given"
              value={method}
              options={FURNISH_OPTIONS}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            />
            <p className="wx-row-sub">
              Save your edits first. Furnishing prints the addendum and closes its due window.
            </p>
            <div className="wx-action-row is-end">
              <Button
                loading={busy}
                onClick={() => void run(() => api.furnish(admissionId, v, method))}
              >
                Furnish addendum
              </Button>
            </div>
          </section>
        ) : null}

        {acknowledgeable ? (
          <section className="wx-drawer-card">
            <h3>Acknowledgement of receipt</h3>
            <SelectField
              label="Record"
              value={mode}
              options={ackOptions}
              onChange={(e) => {
                setMode(e.target.value as AckMode);
                setTouched(false);
              }}
            />
            {mode === "signature" ? (
              <>
                <SelectField
                  label="Signed by"
                  value={signer}
                  options={[
                    { value: "beneficiary", label: "Beneficiary" },
                    { value: "representative", label: "Representative" },
                  ]}
                  onChange={(e) => setSigner(e.target.value as typeof signer)}
                />
                {signer === "representative" ? (
                  <>
                    <TextField
                      label="Representative name"
                      required
                      value={repName}
                      onChange={(e) => setRepName(e.target.value)}
                    />
                    <TextField
                      label="Relationship"
                      value={repRelationship}
                      onChange={(e) => setRepRelationship(e.target.value)}
                    />
                  </>
                ) : null}
                <p className="wx-row-sub">
                  Signing only acknowledges receipt; it is not agreement with the determinations.
                </p>
              </>
            ) : mode === "upload" ? (
              <ScannedCopyForm
                admissionId={admissionId}
                version={v}
                api={api}
                onAttached={onChanged}
              />
            ) : mode === "refusal" ? (
              <TextAreaField
                label="Why it was not signed"
                required
                value={reason}
                error={refusalError}
                onChange={(e) => setReason(e.target.value)}
              />
            ) : (
              <>
                <SelectField
                  label="Reason"
                  value={exemption}
                  options={EXEMPTION_OPTIONS}
                  onChange={(e) => setExemption(e.target.value as Exemption)}
                />
                <TextAreaField
                  label="Note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </>
            )}
            {mode === "upload" ? null : (
              <div className="wx-action-row is-end">
                <Button loading={busy} onClick={acknowledge}>
                  Record
                </Button>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
