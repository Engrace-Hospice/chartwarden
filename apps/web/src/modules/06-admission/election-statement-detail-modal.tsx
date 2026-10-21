import { StatusPill, useApiClient } from "@chartwarden/ui";
import { useMemo } from "react";
import type { JSX } from "react";
import { stateLabel } from "./admission-status";
import { createElectionCertificationApi } from "./election-certification-api";
import {
  DetailField,
  DetailGrid,
  DetailModal,
  DetailSection,
  detailStatusTone,
  formatDetailDate,
  formatDetailDateTime,
} from "./election-certification-detail-ui";

export interface ElectionStatementSnapshot {
  effectiveDate: string | null;
  signerKind: string;
  signedAt: string | null;
  sourceType: "structured" | "uploaded";
}

export interface ElectionStatementDetailModalProps {
  open: boolean;
  statementId: string | null;
  snapshot: ElectionStatementSnapshot | null;
  onOpenChange: (open: boolean) => void;
}

export function ElectionStatementDetailModal({
  open,
  statementId,
  snapshot,
  onOpenChange,
}: ElectionStatementDetailModalProps): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => createElectionCertificationApi(client), [client]);

  return (
    <DetailModal
      open={open}
      resourceId={statementId}
      title="Election Statement"
      errorMessage="Unable to load Election Statement details."
      load={api.getElectionStatement}
      onOpenChange={onOpenChange}
    >
      {(detail) => (
        <>
          <DetailSection title="Election">
            <DetailGrid>
              <DetailField
                label="Status"
                value={
                  <StatusPill
                    label={stateLabel(detail.state)}
                    tone={detailStatusTone(detail.state)}
                  />
                }
              />
              <DetailField
                label="Effective date"
                value={formatDetailDate(snapshot?.effectiveDate)}
              />
              <DetailField
                label="Statement type"
                value={
                  snapshot
                    ? snapshot.sourceType === "uploaded"
                      ? "Uploaded document"
                      : "Structured"
                    : "Not provided"
                }
              />
              <DetailField label="Version" value={String(detail.version)} />
            </DetailGrid>
          </DetailSection>

          <DetailSection title="Signature">
            <DetailGrid>
              <DetailField
                label="Signed by"
                value={snapshot?.signerKind ? stateLabel(snapshot.signerKind) : "Not provided"}
              />
              <DetailField label="Signed at" value={formatDetailDateTime(snapshot?.signedAt)} />
            </DetailGrid>
          </DetailSection>
        </>
      )}
    </DetailModal>
  );
}
