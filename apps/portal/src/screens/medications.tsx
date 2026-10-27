import {
  Button,
  Glyph,
  Modal,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  toLocalInput,
  useApiClient,
} from "@chartwarden/ui";
// M31 patient medication view. M13 remains authoritative for orders and caregiver-attested administrations.
// Read requests are independently scoped to the selected patient; this screen never recommends a dose.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { formatPortalInstant, humanize, readError } from "./portal-format";
import { PortalPage } from "./portal-page";

interface Medication {
  medicationOrderId: string;
  drugName: string;
  dose?: string;
  route?: string;
  scheduleSummary?: string;
  isPrn?: boolean;
}

interface Administration {
  drugName?: string;
  administeredAt?: string;
  administeredAmount?: number;
  administeredUnit?: string;
}

type Resource<T> = {
  status: "loading" | "ready" | "error";
  items: T[];
  error: string | null;
};
const loading = <T,>(): Resource<T> => ({
  status: "loading",
  items: [],
  error: null,
});

/** A datetime-local field represents local wall time, NOT an ISO/UTC instant. */
function parseAdministeredAt(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || toLocalInput(parsed) !== value) return null;
  if (parsed.getTime() > Date.now() + 59_999) return null;
  return parsed;
}

function sortAdministrations(items: Administration[]): Administration[] {
  const timestamp = (value?: string): number => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...items].sort((a, b) => timestamp(b.administeredAt) - timestamp(a.administeredAt));
}

function ResourceSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <output className="wx-medications-skeleton" aria-label={label}>
      <span />
      <span />
      <span />
    </output>
  );
}

function ResourceError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string | null;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="wx-medications-resource-error" role="alert">
      <Glyph name="alert-circle" size={22} aria-hidden="true" />
      <div>
        <h3>{title}</h3>
        <p>{message ?? "We couldn't load this information. Please try again."}</p>
      </div>
      <Button tone="secondary" onClick={onRetry}>
        <Glyph name="rotate-ccw" size={16} aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}

function MedicationCard({
  medication,
}: {
  medication: Medication;
}): JSX.Element {
  return (
    <li className="wx-medication-card">
      <div className="wx-medication-card__header">
        <span className="wx-medication-card__icon" aria-hidden="true">
          <Glyph name="pill" size={22} />
        </span>
        <div className="wx-medication-card__name">
          <h3>{medication.drugName || "Medication"}</h3>
          {medication.isPrn ? <StatusPill tone="neutral" label="As needed (PRN)" /> : null}
        </div>
      </div>
      <dl className="wx-medication-card__details">
        <div>
          <dt>Prescribed dose</dt>
          <dd>{medication.dose || "Not specified"}</dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>{medication.route ? humanize(medication.route) : "Not specified"}</dd>
        </div>
        <div className="wx-medication-card__schedule">
          <dt>Schedule</dt>
          <dd>
            {medication.scheduleSummary ||
              (medication.isPrn
                ? "As needed — follow your care team's directions"
                : "Not specified")}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function MedicationList({
  resource,
  retry,
}: {
  resource: Resource<Medication>;
  retry: () => void;
}): JSX.Element {
  if (resource.status === "loading") return <ResourceSkeleton label="Loading active medications" />;
  if (resource.status === "error")
    return (
      <ResourceError title="Medications unavailable" message={resource.error} onRetry={retry} />
    );
  if (resource.items.length === 0) {
    return (
      <div className="wx-medications-empty">
        <Glyph name="pill" size={25} aria-hidden="true" />
        <h3>No active medications to show</h3>
        <p>Medications shared with you by your care team will appear here.</p>
      </div>
    );
  }
  return (
    <ul className="wx-medications-grid" aria-label="Active medications">
      {resource.items.map((medication) => (
        <MedicationCard key={medication.medicationOrderId} medication={medication} />
      ))}
    </ul>
  );
}

function AdministrationHistory({
  resource,
  retry,
}: {
  resource: Resource<Administration>;
  retry: () => void;
}): JSX.Element {
  if (resource.status === "loading")
    return <ResourceSkeleton label="Loading recent administrations" />;
  if (resource.status === "error")
    return (
      <ResourceError
        title="Recent administrations unavailable"
        message={resource.error}
        onRetry={retry}
      />
    );
  if (resource.items.length === 0) {
    return (
      <div className="wx-medications-history-empty">
        <Glyph name="clipboard-check" size={22} aria-hidden="true" />
        <p>No recent administrations to show.</p>
      </div>
    );
  }
  return (
    <ul className="wx-medications-history" aria-label="Recent administrations">
      {sortAdministrations(resource.items).map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the endpoint exposes no administration id; read-only snapshot, never reordered
        <li key={index}>
          <span className="wx-medications-history__icon" aria-hidden="true">
            <Glyph name="check-circle" size={18} />
          </span>
          <div className="wx-medications-history__body">
            <strong>{item.drugName || "Medication"}</strong>
            <span>
              {item.administeredAmount != null && Number.isFinite(item.administeredAmount)
                ? `${item.administeredAmount}${item.administeredUnit ? ` ${item.administeredUnit}` : " (unit not specified)"}`
                : "Amount not available"}
            </span>
          </div>
          <time
            className="wx-medications-history__time"
            dateTime={
              item.administeredAt && Number.isFinite(Date.parse(item.administeredAt))
                ? item.administeredAt
                : undefined
            }
          >
            {formatPortalInstant(item.administeredAt) ?? "Date unavailable"}
          </time>
        </li>
      ))}
    </ul>
  );
}

function RecordAdministrationDialog({
  open,
  onClose,
  medications,
  patientId,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  medications: Medication[];
  patientId: string;
  onRecorded: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [route, setRoute] = useState("");
  const [administeredAt, setAdministeredAt] = useState(() => toLocalInput(new Date()));
  const [attestation, setAttestation] = useState("");
  const [review, setReview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const patientRef = useRef(patientId);

  useEffect(() => {
    mounted.current = true;
    patientRef.current = patientId;
    return () => {
      mounted.current = false;
    };
  }, [patientId]);

  useEffect(() => {
    if (open) setAdministeredAt(toLocalInput(new Date()));
  }, [open]);

  const selected = medications.find((medication) => medication.medicationOrderId === orderId);
  const validAmount = amount.trim() !== "" && Number.isFinite(Number(amount)) && Number(amount) > 0;
  const parsedTime = parseAdministeredAt(administeredAt);
  const canReview = Boolean(
    selected && validAmount && unit.trim() && route.trim() && parsedTime && attestation.trim(),
  );

  function changeMedication(id: string): void {
    setOrderId(id);
    setFeedback(null);
    setUncertain(false);
    setReview(false);
    setConfirmed(false);
    // Never automatically copy a prescribed dose into the amount actually given.
    setAmount("");
    setUnit("");
    setRoute("");
  }

  function reviewSubmission(event: FormEvent): void {
    event.preventDefault();
    if (inFlight.current || recorded || !canReview) return;
    setFeedback(null);
    setConfirmed(false);
    setReview(true);
  }

  async function submit(): Promise<void> {
    // Guard in the handler, not just via the visual button state.
    if (
      inFlight.current ||
      uncertain ||
      !review ||
      !confirmed ||
      recorded ||
      !canReview ||
      !parsedTime ||
      !selected
    )
      return;
    inFlight.current = true;
    setSubmitting(true);
    setFeedback(null);
    const requestPatient = patientId;
    try {
      const result = await client.POST("/api/v1/portal/administrations/caregiver-attested", {
        body: {
          medicationOrderId: selected.medicationOrderId,
          administeredAt: parsedTime.toISOString(),
          administeredAmount: Number(amount),
          administeredUnit: unit.trim(),
          route: route.trim(),
          caregiverAttestationText: attestation.trim(),
        },
      });
      if (!mounted.current || patientRef.current !== requestPatient) return;
      if ("error" in result) {
        if (result.response?.status !== 403 && result.response?.status !== 401) setUncertain(true);
        setFeedback(
          result.response?.status === 403
            ? "Your account isn't authorized to record an administration. Contact your hospice team for help."
            : result.response?.status === 401
              ? "Your session has ended. Please sign in again."
              : "We couldn't confirm whether this dose was recorded. Check recent administrations or contact your care team before submitting again.",
        );
        return;
      }
      setRecorded(true);
      setFeedback(null);
      onRecorded();
    } catch {
      if (mounted.current && patientRef.current === requestPatient) {
        setUncertain(true);
        setFeedback(
          "We couldn't confirm whether this dose was recorded. Check recent administrations or contact your care team before submitting again.",
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && patientRef.current === requestPatient) setSubmitting(false);
    }
  }

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      ariaLabel="Record a dose given"
      width="39rem"
    >
      <div className="wx-medications-dialog">
        <header className="wx-medications-dialog__header">
          <span aria-hidden="true">
            <Glyph name="clipboard-check" size={22} />
          </span>
          <div>
            <h2>Record a dose given</h2>
            <p>
              Only record medication that has already been given. This does not change the
              prescription.
            </p>
          </div>
        </header>
        {recorded ? (
          <div className="wx-medications-dialog__complete" role="status">
            <Glyph name="check-circle" size={30} aria-hidden="true" />
            <h3>Administration recorded</h3>
            <p>
              Your report was received. It will appear in recent administrations if available in the
              record.
            </p>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : review ? (
          <div className="wx-medications-review">
            <h3>Check these details before recording</h3>
            <p>This is a report of what was given, not a request to administer a dose.</p>
            <dl>
              <div>
                <dt>Medication</dt>
                <dd>{selected?.drugName ?? "Medication"}</dd>
              </div>
              <div>
                <dt>Amount given</dt>
                <dd>
                  {amount} {unit.trim()}
                </dd>
              </div>
              <div>
                <dt>Route used</dt>
                <dd>{route.trim()}</dd>
              </div>
              <div>
                <dt>Date and time given</dt>
                <dd>{formatPortalInstant(parsedTime?.toISOString()) ?? "Date unavailable"}</dd>
              </div>
              <div>
                <dt>Caregiver attestation</dt>
                <dd className="wx-medications-review__attestation">{attestation.trim()}</dd>
              </div>
            </dl>
            <label className="wx-medications-review__check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={submitting}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>I confirm this information accurately describes a dose already given.</span>
            </label>
            {feedback ? (
              <p className="wx-medications-dialog__feedback" role="alert">
                {feedback}
              </p>
            ) : null}
            <footer>
              <Button
                tone="secondary"
                disabled={submitting}
                onClick={
                  uncertain
                    ? onClose
                    : () => {
                        setReview(false);
                        setConfirmed(false);
                        setFeedback(null);
                      }
                }
              >
                {uncertain ? "Close and check history" : "Edit details"}
              </Button>
              {!uncertain ? (
                <Button
                  type="button"
                  loading={submitting}
                  disabled={!confirmed || submitting}
                  onClick={() => void submit()}
                >
                  Confirm and record
                </Button>
              ) : null}
            </footer>
          </div>
        ) : (
          <form className="wx-medications-form" onSubmit={reviewSubmission}>
            <p className="wx-medications-form__note">
              <Glyph name="info" size={17} aria-hidden="true" /> Only a primary caregiver or
              healthcare DPOA may record an administration. Your care team can help with access.
            </p>
            <SelectField
              label="Medication"
              value={orderId}
              onChange={(event) => changeMedication(event.target.value)}
              required
              options={[
                { value: "", label: "Select a medication…", disabled: true },
                ...medications.map((medication) => ({
                  value: medication.medicationOrderId,
                  label: medication.drugName,
                })),
              ]}
            />
            {selected ? (
              <div
                className="wx-medications-form__prescription"
                aria-label="Prescription reference"
              >
                <strong>Prescription reference</strong>
                <span>
                  {selected.dose || "Dose not specified"} ·{" "}
                  {selected.route ? humanize(selected.route) : "Route not specified"}
                </span>
                <small>
                  {selected.scheduleSummary ||
                    (selected.isPrn ? "As needed (PRN)" : "Schedule not specified")}
                </small>
              </div>
            ) : null}
            <div className="wx-medications-form__grid">
              <TextField
                label="Amount actually given"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
                placeholder="e.g. 5"
              />
              <TextField
                label="Unit actually given"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                required
                placeholder="e.g. mg"
              />
              <TextField
                label="Route used"
                value={route}
                onChange={(event) => setRoute(event.target.value)}
                required
                placeholder="e.g. oral"
              />
              <div className="wx-medications-form__date">
                <label htmlFor="wx-medication-administered-at">Date and time given</label>
                <input
                  id="wx-medication-administered-at"
                  type="datetime-local"
                  value={administeredAt}
                  max={toLocalInput(new Date())}
                  onChange={(event) => setAdministeredAt(event.target.value)}
                  required
                />
                <small>
                  Enter when the medication was actually administered, not when you are recording
                  it.
                </small>
              </div>
            </div>
            <TextAreaField
              label="Caregiver attestation"
              value={attestation}
              onChange={(event) => setAttestation(event.target.value)}
              placeholder="Describe what was given and confirm that you personally know it was administered."
              rows={3}
              required
            />
            {administeredAt && !parsedTime ? (
              <p className="wx-medications-form__invalid" role="alert">
                Enter a valid administration date and time that is not in the future.
              </p>
            ) : null}
            <footer>
              <Button tone="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canReview}>
                Review administration
              </Button>
            </footer>
          </form>
        )}
      </div>
    </Modal>
  );
}

/** Keying the page prevents in-flight reads or form drafts from crossing patient boundaries. */
export function PortalMedicationList(): JSX.Element {
  const { patientId } = usePortalPatient();
  return <MedicationPageForPatient key={patientId ?? "no-patient"} patientId={patientId} />;
}

function MedicationPageForPatient({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const [meds, setMeds] = useState<Resource<Medication>>(loading);
  const [history, setHistory] = useState<Resource<Administration>>(loading);
  const [medAttempt, setMedAttempt] = useState(0);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    void medAttempt;
    void patientId; // the session is patient-bound: a patient switch refetches
    let active = true;
    setMeds(loading());
    void (async () => {
      try {
        const result = await client.GET("/api/v1/portal/medications/active", {});
        if (!active) return;
        setMeds(
          "error" in result
            ? {
                status: "error",
                items: [],
                error: readError(result.response?.status),
              }
            : {
                status: "ready",
                items: (result.data?.items ?? []) as unknown as Medication[],
                error: null,
              },
        );
      } catch {
        if (active) setMeds({ status: "error", items: [], error: readError(undefined) });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, medAttempt, patientId]);

  useEffect(() => {
    void historyAttempt;
    void patientId;
    let active = true;
    setHistory(loading());
    void (async () => {
      try {
        const result = await client.GET("/api/v1/portal/administrations/recent", {});
        if (!active) return;
        setHistory(
          "error" in result
            ? {
                status: "error",
                items: [],
                error: readError(result.response?.status),
              }
            : {
                status: "ready",
                items: (result.data?.items ?? []) as Administration[],
                error: null,
              },
        );
      } catch {
        if (active)
          setHistory({
            status: "error",
            items: [],
            error: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, historyAttempt, patientId]);

  const retryMeds = useCallback(() => setMedAttempt((n) => n + 1), []);
  const retryHistory = useCallback(() => setHistoryAttempt((n) => n + 1), []);
  const activeCount = meds.status === "ready" ? meds.items.length : null;

  return (
    <PortalPage
      title="Medications"
      subtitle="Review medications shared by your care team and recently recorded doses."
      width="workspace"
      actions={
        meds.status === "ready" && meds.items.length > 0 && patientId ? (
          <Button onClick={() => setDialogOpen(true)}>
            <Glyph name="clipboard-check" size={18} aria-hidden="true" /> Record a dose given
          </Button>
        ) : null
      }
    >
      <div className="wx-medications-page">
        <div className="wx-medications-intro" role="note">
          <Glyph name="info" size={20} aria-hidden="true" />
          <p>
            For your reference: follow your hospice team's medication instructions. This portal does
            not change prescriptions or recommend doses.
          </p>
        </div>
        <section aria-labelledby="wx-medications-active-title" className="wx-medications-section">
          <div className="wx-medications-section__heading">
            <div>
              <span className="wx-medications-eyebrow">YOUR CARE</span>
              <h2 id="wx-medications-active-title">Current medications</h2>
              <p>Medication details available in your care record.</p>
            </div>
            {activeCount !== null ? (
              <span className="wx-medications-count">
                {activeCount} {activeCount === 1 ? "medication" : "medications"}
              </span>
            ) : null}
          </div>
          <MedicationList resource={meds} retry={retryMeds} />
        </section>
        <div className="wx-medications-lower">
          <section
            className="wx-medications-section"
            aria-labelledby="wx-medications-history-title"
          >
            <div className="wx-medications-section__heading">
              <div>
                <span className="wx-medications-eyebrow">RECENTLY RECORDED</span>
                <h2 id="wx-medications-history-title">Recent administrations</h2>
                <p>Reports of doses already given.</p>
              </div>
              <button
                type="button"
                className="wx-medications-refresh"
                onClick={retryHistory}
                disabled={history.status === "loading"}
              >
                <Glyph name="rotate-ccw" size={16} aria-hidden="true" /> Refresh
              </button>
            </div>
            <AdministrationHistory resource={history} retry={retryHistory} />
          </section>
          <aside className="wx-medications-record-card" aria-label="Administration guidance">
            <span className="wx-medications-record-card__icon" aria-hidden="true">
              <Glyph name="clipboard-check" size={23} />
            </span>
            <h2>Record a dose given</h2>
            <p>Authorized caregivers can report a dose that has already been administered.</p>
            <p>This records an administration; it does not change an order.</p>
            {meds.status === "ready" && meds.items.length > 0 && patientId ? (
              <Button tone="secondary" onClick={() => setDialogOpen(true)}>
                Record administration <Glyph name="arrow-right" size={17} aria-hidden="true" />
              </Button>
            ) : (
              <span className="wx-medications-record-card__hint">
                Medication information must be available before a dose can be recorded.
              </span>
            )}
          </aside>
        </div>
      </div>
      {patientId && dialogOpen && meds.status === "ready" ? (
        <RecordAdministrationDialog
          patientId={patientId}
          medications={meds.items}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onRecorded={retryHistory}
        />
      ) : null}
    </PortalPage>
  );
}
