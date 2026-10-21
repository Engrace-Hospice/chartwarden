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
  formatBoolean,
  formatDetailDate,
} from "./election-certification-detail-ui";

export interface CtiSnapshot {
  sequenceNumber: number;
  effectiveAt: string | null;
  scheduledEndAt: string | null;
  sourceType?: "structured" | "uploaded";
  hospiceMdSigned: boolean;
  attendingMdSigned: boolean;
  signedLate: boolean;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface CtiDetailModalProps {
  open: boolean;
  ctiId: string | null;
  snapshot: CtiSnapshot | null;
  onOpenChange: (open: boolean) => void;
}

export function CtiDetailModal({
  open,
  ctiId,
  snapshot,
  onOpenChange,
}: CtiDetailModalProps): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => createElectionCertificationApi(client), [client]);

  return (
    <DetailModal
      open={open}
      resourceId={ctiId}
      title="CTI"
      errorMessage="Unable to load CTI details."
      load={api.getCti}
      onOpenChange={onOpenChange}
    >
      {(detail) => (
        <>
          <DetailSection title="Certification">
            <DetailGrid>
              <DetailField
                label="Certification"
                value={
                  snapshot
                    ? snapshot.sequenceNumber === 1
                      ? "Initial Certification"
                      : "Recertification"
                    : "Not provided"
                }
              />
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
                label="Source"
                value={
                  snapshot
                    ? snapshot.sourceType === "uploaded"
                      ? "Uploaded document"
                      : "Structured CTI"
                    : "Not provided"
                }
              />
              <DetailField label="Version" value={String(detail.version)} />
            </DetailGrid>
          </DetailSection>

          <DetailSection title="Benefit period">
            <DetailGrid>
              <DetailField
                label="Period"
                value={snapshot ? `Period ${snapshot.sequenceNumber}` : "Not provided"}
              />
              <DetailField
                label="Effective date"
                value={formatDetailDate(snapshot?.effectiveAt ?? snapshot?.periodStart)}
              />
              <DetailField
                label="Scheduled end"
                value={formatDetailDate(snapshot?.scheduledEndAt ?? snapshot?.periodEnd)}
              />
            </DetailGrid>
          </DetailSection>

          <DetailSection title="Signatures">
            <DetailGrid>
              <DetailField
                label="Hospice Medical Director"
                value={formatBoolean(snapshot?.hospiceMdSigned)}
              />
              {snapshot?.sequenceNumber === 1 ? (
                <DetailField
                  label="Attending Physician"
                  value={formatBoolean(snapshot.attendingMdSigned)}
                />
              ) : null}
            </DetailGrid>
          </DetailSection>

          <DetailSection title="Compliance">
            <DetailGrid>
              <DetailField label="Late certification" value={formatBoolean(snapshot?.signedLate)} />
            </DetailGrid>
          </DetailSection>
        </>
      )}
    </DetailModal>
  );
}
