// apps/web/src/modules/06-admission — the Face-to-Face right rail of the patient Election & Certification
// workspace (2026-09-25 redesign: the Admissions census drawer pattern, mockup frame 03_20_25 — icon-tile
// header, flat drawer cards, label/value rows). Replaces the earlier centered detail modal.
//
// FY2027 CoP: shows the encounter modality and how it was attested, and hosts the two write steps — record
// completion with the modality (R-F2F-05, telehealth through 2027-12-31 with the (A)–(C) attestation) and
// attest via a linked signed visit note or a written attestation (R-F2F-06, § 418.22(b)(4)). Only fields
// the platform models are drawn; the server enforces every rule (ADR-0030).
import {
  Glyph,
  IconButton,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { stateLabel } from "./admission-status";
import {
  type F2fEncounterLocation,
  type FaceToFaceDetail,
  createElectionCertificationApi,
} from "./election-certification-api";
import {
  detailStatusTone,
  formatBoolean,
  formatDetailDate,
} from "./election-certification-detail-ui";
import { F2F_LOCATION_LABEL, F2fAttestationForm, F2fCompletionForm } from "./face-to-face-forms";

export interface FaceToFaceSnapshot {
  sequenceNumber: number;
  performerRole: string;
  performerUserId?: string | null;
  encounterDate: string | null;
  encounterLocation?: F2fEncounterLocation | null;
  attestationNoteEncounterId?: string | null;
  withinWindow: boolean | null;
  windowOverride: boolean;
  attested: boolean;
}

export interface FaceToFaceRailProps {
  faceToFaceId: string;
  patientId: string | null;
  snapshot: FaceToFaceSnapshot;
  /** Hospice MD / NP may record completion and attest (the server re-checks performer + ABAC). */
  canManage: boolean;
  onClose: () => void;
  /** Called after a successful write so the workspace reloads its ladder. */
  onChanged: () => void;
}

function attestationSource(s: FaceToFaceSnapshot): string {
  if (!s.attested) return "Not attested";
  return s.attestationNoteEncounterId ? "Linked signed visit note" : "Written attestation";
}

export function FaceToFaceRail({
  faceToFaceId,
  patientId,
  snapshot,
  canManage,
  onClose,
  onChanged,
}: FaceToFaceRailProps): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => createElectionCertificationApi(client), [client]);
  const [detail, setDetail] = useState<FaceToFaceDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDetail(undefined);
    try {
      setDetail(await api.getFaceToFace(faceToFaceId));
    } catch {
      setDetail(null);
    }
  }, [api, faceToFaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = () => {
    setError(null);
    void load();
    onChanged();
  };
  const state = detail?.state ?? null;
  const location = snapshot.encounterLocation ?? null;

  return (
    <aside className="wx-admission-drawer" aria-label="Face-to-Face details">
      <header className="wx-drawer-head">
        <span className="wx-rail-icon wx-f2f-icon" aria-hidden>
          <Glyph name="stethoscope" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <div className="wx-drawer-title-row">
            <h2>Face-to-Face</h2>
            {state ? <StatusPill label={stateLabel(state)} tone={detailStatusTone(state)} /> : null}
          </div>
          <div className="wx-row-sub">Period {snapshot.sequenceNumber} · Recertification</div>
        </div>
        <IconButton
          tone="tertiary"
          size="sm"
          aria-label="Close Face-to-Face details"
          onClick={onClose}
        >
          <Glyph name="close" size={18} />
        </IconButton>
      </header>

      <div className="wx-drawer-body">
        {detail === undefined ? (
          <LoadingSpinner />
        ) : detail === null ? (
          <InlineAlert>Unable to load Face-to-Face details.</InlineAlert>
        ) : (
          <>
            <section className="wx-drawer-card">
              <h3>Encounter</h3>
              <dl className="wx-kv">
                <dt>Benefit period</dt>
                <dd>Period {snapshot.sequenceNumber}</dd>
                <dt>Performer role</dt>
                <dd>
                  {snapshot.performerRole ? stateLabel(snapshot.performerRole) : "Not provided"}
                </dd>
                <dt>Encounter date</dt>
                <dd className="wx-nums">{formatDetailDate(snapshot.encounterDate)}</dd>
                <dt>Modality</dt>
                <dd>{location ? F2F_LOCATION_LABEL[location] : "Not recorded"}</dd>
                <dt>Version</dt>
                <dd className="wx-nums">{detail.version}</dd>
              </dl>
            </section>

            <section className="wx-drawer-card">
              <h3>Compliance</h3>
              <dl className="wx-kv">
                <dt>Within window</dt>
                <dd>{formatBoolean(snapshot.withinWindow)}</dd>
                <dt>Window override</dt>
                <dd>{formatBoolean(snapshot.windowOverride)}</dd>
                <dt>Attested</dt>
                <dd>{formatBoolean(snapshot.attested)}</dd>
                <dt>Attestation</dt>
                <dd>{attestationSource(snapshot)}</dd>
              </dl>
              {location === "telehealth" ? (
                <p className="wx-action-hint">
                  Telehealth recertification encounters on or after Jan 1, 2027 are reported on the
                  claim as HCPCS <span className="wx-code">G0679</span> (revenue code{" "}
                  <span className="wx-code">0657</span>).
                </p>
              ) : null}
            </section>

            {canManage && (state === "scheduled" || state === "completed") ? (
              <section className="wx-drawer-card">
                <h3>{state === "scheduled" ? "Record completion" : "Attest encounter"}</h3>
                {error ? <InlineAlert>{error}</InlineAlert> : null}
                {state === "scheduled" ? (
                  <F2fCompletionForm
                    api={api}
                    faceToFaceId={faceToFaceId}
                    version={detail.version}
                    onDone={done}
                    onError={setError}
                  />
                ) : (
                  <F2fAttestationForm
                    api={api}
                    faceToFaceId={faceToFaceId}
                    version={detail.version}
                    patientId={patientId}
                    encounterDate={snapshot.encounterDate}
                    performerUserId={snapshot.performerUserId ?? null}
                    onDone={done}
                    onError={setError}
                  />
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
