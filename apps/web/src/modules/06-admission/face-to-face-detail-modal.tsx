import { StatusPill, useApiClient } from "@wardenx/ui";
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

export interface FaceToFaceSnapshot {
  sequenceNumber: number;
  performerRole: string;
  encounterDate: string | null;
  withinWindow: boolean | null;
  windowOverride: boolean;
  attested: boolean;
}

export interface FaceToFaceDetailModalProps {
  open: boolean;
  faceToFaceId: string | null;
  snapshot: FaceToFaceSnapshot | null;
  onOpenChange: (open: boolean) => void;
}

export function FaceToFaceDetailModal({
  open,
  faceToFaceId,
  snapshot,
  onOpenChange,
}: FaceToFaceDetailModalProps): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => createElectionCertificationApi(client), [client]);

  return (
    <DetailModal
      open={open}
      resourceId={faceToFaceId}
      title="Face-to-Face"
      errorMessage="Unable to load Face-to-Face details."
      load={api.getFaceToFace}
      onOpenChange={onOpenChange}
    >
      {(detail) => (
        <>
          <DetailSection title="Encounter">
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
                label="Benefit period"
                value={snapshot ? `Period ${snapshot.sequenceNumber}` : "Not provided"}
              />
              <DetailField
                label="Performer role"
                value={
                  snapshot?.performerRole ? stateLabel(snapshot.performerRole) : "Not provided"
                }
              />
              <DetailField
                label="Encounter date"
                value={formatDetailDate(snapshot?.encounterDate)}
              />
              <DetailField label="Version" value={String(detail.version)} />
            </DetailGrid>
          </DetailSection>

          <DetailSection title="Compliance">
            <DetailGrid>
              <DetailField
                label="Within required window"
                value={formatBoolean(snapshot?.withinWindow)}
              />
              <DetailField
                label="Window override applied"
                value={formatBoolean(snapshot?.windowOverride)}
              />
              <DetailField label="Attested" value={formatBoolean(snapshot?.attested)} />
            </DetailGrid>
          </DetailSection>
        </>
      )}
    </DetailModal>
  );
}
