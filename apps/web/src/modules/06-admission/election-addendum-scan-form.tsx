// apps/web/src/modules/06-admission/election-addendum-scan-form.tsx — "Upload signed paper copy" for one election
// statement addendum version (FY2027, 42 CFR 418.24(c)(9)). Patients often sign the paper addendum at the bedside;
// staff scan it and attach it here. The file goes through the verified M22 upload ceremony (prepare → upload →
// verify), then the server attaches that exact version as the acknowledgement. A draft that was furnished on paper
// outside WardenX also needs the date it was handed over ((c)(10)) — the server furnishes and signs in one step.
// An INCOMPLETE draft is not blocked: the signed paper copy IS the furnished addendum, so the form says plainly
// that the scan will stand as the addendum's content (the server records `contentSource: scanned_paper`).
// Kit controls only (the shared scanned-upload kit); the server re-checks every rule, its message shown verbatim.
import { Button, InlineAlert, SelectField, TextAreaField, TextField } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { UploadStage } from "../../shell/document-workflows";
import type { AddendumVersion, ElectionAddendumApi } from "./election-addendum-api";
import {
  draftContentGaps,
  localDateToIso,
  scannedCopyProblem,
  todayInput,
} from "./election-addendum-format";
import { ScannedFileField, type ScannedUploadStage, UploadStageNotice } from "./scanned-upload";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,image/jpeg,image/png,image/tiff";

type Outcome = "signed" | "refused";
type Stage = ScannedUploadStage;

export function ScannedCopyForm({
  admissionId,
  version: v,
  api,
  onAttached,
}: {
  admissionId: string;
  version: AddendumVersion;
  api: ElectionAddendumApi;
  onAttached: () => void;
}): JSX.Element {
  const today = todayInput();
  const needsFurnishDate = v.status === "draft";
  // Only a never-furnished draft can carry its content on paper (a furnished version is complete by definition).
  const gaps = needsFurnishDate ? draftContentGaps(v) : [];
  const [file, setFile] = useState<File | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("signed");
  const [signerKind, setSignerKind] = useState<"beneficiary" | "representative">("beneficiary");
  const [representativeName, setRepresentativeName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [reason, setReason] = useState("");
  const [paperDate, setPaperDate] = useState(today);
  const [furnishedDate, setFurnishedDate] = useState(today);
  const [stage, setStage] = useState<Stage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const problem = scannedCopyProblem(
      {
        file,
        outcome,
        signerKind,
        representativeName,
        paperDate,
        furnishedDate,
        reason,
        needsFurnishDate,
      },
      today,
    );
    if (problem || !file) {
      setError(problem ?? "Choose the scanned paper copy to upload.");
      return;
    }
    setBusy(true);
    setError(null);
    const onStage = (s: UploadStage) => setStage(s === "complete" ? "attaching" : s);
    const furnished = needsFurnishDate ? { furnishedAt: localDateToIso(furnishedDate) } : {};
    try {
      await api.attachScannedCopy(
        admissionId,
        v,
        outcome === "signed"
          ? {
              file,
              onStage,
              ...furnished,
              outcome,
              signerKind,
              representativeName:
                signerKind === "representative" ? representativeName.trim() : null,
              representativeRelationship:
                signerKind === "representative" ? relationship.trim() || null : null,
              signedAt: localDateToIso(paperDate),
            }
          : {
              file,
              onStage,
              ...furnished,
              outcome,
              reason: reason.trim(),
              refusedAt: localDateToIso(paperDate),
            },
      );
      setStage("idle");
      onAttached();
    } catch (e) {
      setStage("idle");
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wx-addendum-scan">
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {gaps.length > 0 ? (
        <InlineAlert tone="info">
          This draft is not complete in WardenX (missing: {gaps.join("; ")}). That is fine: the
          scanned paper copy will stand as the addendum's content, and nothing needs to be filled in
          here first.
        </InlineAlert>
      ) : null}
      <ScannedFileField
        accept={ACCEPT}
        hint="PDF, JPEG, PNG or TIFF, up to 25 MB."
        disabled={busy}
        onFile={setFile}
      />
      <SelectField
        label="The paper copy shows"
        value={outcome}
        disabled={busy}
        options={[
          { value: "signed", label: "A signature acknowledging receipt" },
          { value: "refused", label: "A refusal to sign" },
        ]}
        onChange={(e) => setOutcome(e.target.value as Outcome)}
      />
      {outcome === "signed" ? (
        <>
          <SelectField
            label="Signed by"
            value={signerKind}
            disabled={busy}
            options={[
              { value: "beneficiary", label: "Beneficiary" },
              { value: "representative", label: "Representative" },
            ]}
            onChange={(e) => setSignerKind(e.target.value as typeof signerKind)}
          />
          {signerKind === "representative" ? (
            <>
              <TextField
                label="Representative name"
                required
                disabled={busy}
                value={representativeName}
                onChange={(e) => setRepresentativeName(e.target.value)}
              />
              <TextField
                label="Relationship"
                disabled={busy}
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
              />
            </>
          ) : null}
        </>
      ) : (
        <TextAreaField
          label="Why it was not signed"
          required
          disabled={busy}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      <TextField
        type="date"
        label={outcome === "signed" ? "Signature date" : "Date of refusal"}
        hint="As written on the paper copy."
        required
        max={today}
        disabled={busy}
        value={paperDate}
        onChange={(e) => setPaperDate(e.target.value)}
      />
      {needsFurnishDate ? (
        <TextField
          type="date"
          label="Date furnished"
          hint="This version was never furnished in WardenX. Enter the day the paper addendum was handed over."
          required
          max={paperDate || today}
          disabled={busy}
          value={furnishedDate}
          onChange={(e) => setFurnishedDate(e.target.value)}
        />
      ) : null}
      <UploadStageNotice stage={stage} />
      <p className="wx-row-sub">
        The scan is filed in the patient's documents and linked to this version. The printed
        addendum stays on file alongside it.
      </p>
      <div className="wx-action-row is-end">
        <Button loading={busy} onClick={() => void submit()}>
          Upload and attach
        </Button>
      </div>
    </div>
  );
}
