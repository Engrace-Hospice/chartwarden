// apps/web/src/modules/06-admission — the "Schedule Face-to-Face" drawer for a period that requires a
// face-to-face encounter (sequence >= 3) but has none yet (POST /api/v1/admissions/:id/face-to-face).
// The server derives/validates the clinician's real role (GAP-022); the client only shapes the request.
import {
  Button,
  Glyph,
  IconButton,
  InlineAlert,
  SelectField,
  TextField,
  useApiClient,
} from "@wardenx/ui";
import { useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import { createElectionCertificationApi } from "./election-certification-api";
import { f2fErrorMessage } from "./face-to-face-forms";

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

type ClinicianRole = "hospice_md" | "hospice_np";

const ROLE_OPTIONS = [
  { value: "", label: "Select the performing clinician role" },
  { value: "hospice_md", label: "Hospice physician" },
  { value: "hospice_np", label: "Hospice nurse practitioner" },
];

/** The default encounter window: the 30 days before the period's effective date, through that date. */
export function defaultF2fWindow(periodEffectiveAt: string | null): { start: string; end: string } {
  if (!periodEffectiveAt) return { start: "", end: "" };
  const end = periodEffectiveAt.slice(0, 10);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

export interface F2fScheduleRailProps {
  admissionId: string;
  electionPeriodId: string;
  sequenceNumber: number;
  periodEffectiveAt: string | null;
  /** The signed-in clinician — scheduled as the performer (the server re-checks their grants). */
  clinicianUserId: string;
  onClose: () => void;
  onScheduled: () => void;
}

export function F2fScheduleRail(props: F2fScheduleRailProps): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => createElectionCertificationApi(client), [client]);
  const defaults = defaultF2fWindow(props.periodEffectiveAt);
  const [scheduledDate, setScheduledDate] = useState("");
  const [role, setRole] = useState<ClinicianRole | "">("");
  const [windowStart, setWindowStart] = useState(defaults.start);
  const [windowEnd, setWindowEnd] = useState(defaults.end);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = scheduledDate !== "" && role !== "" && windowStart !== "" && windowEnd !== "";

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await api.scheduleFaceToFace(props.admissionId, {
        electionPeriodId: props.electionPeriodId,
        scheduledDate,
        windowStart,
        windowEnd,
        clinicianRole: role,
        scheduledClinicianId: props.clinicianUserId,
      });
      props.onScheduled();
    } catch (err) {
      setError(f2fErrorMessage(err, "Could not schedule the face-to-face."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="wx-admission-drawer" aria-label="Schedule Face-to-Face">
      <header className="wx-drawer-head">
        <div className="wx-drawer-head-main">
          <h2>Schedule Face-to-Face</h2>
          <div className="wx-row-sub">Period {props.sequenceNumber} · Recertification</div>
        </div>
        <IconButton tone="tertiary" size="sm" aria-label="Close schedule" onClick={props.onClose}>
          <Glyph name="close" size={18} />
        </IconButton>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          {error ? <InlineAlert>{error}</InlineAlert> : null}
          <form className="wx-action-body is-flush" onSubmit={(e) => void submit(e)}>
            <TextField
              label="Scheduled date"
              type="date"
              required
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
            />
            <SelectField
              label="Performer role"
              required
              value={role}
              options={ROLE_OPTIONS}
              onChange={(e) => setRole(e.target.value as ClinicianRole | "")}
            />
            <TextField
              label="Window start"
              type="date"
              required
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
            />
            <TextField
              label="Window end"
              type="date"
              required
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
            />
            <div className="wx-action-row is-end">
              <Button type="submit" disabled={!ready} loading={saving}>
                Schedule face-to-face
              </Button>
            </div>
          </form>
        </section>
      </div>
    </aside>
  );
}
