import {
  Button,
  InlineAlert,
  SelectField,
  StatusPill,
  TextAreaField,
  useApiClient,
} from "@wardenx/ui";
// @wardenx/portal — §5.1 Amendment request (`/p/:patientId/amendments`). HIPAA §164.526: a caregiver may ask
// for a correction to the record. The submit (POST /portal/amendments/submit) goes to M5, which owns the
// amendment workflow; M31 holds only the reference + a status mirror it lists back (GET /portal/amendments).
// The portal never edits the record directly — it forwards a request and reflects its state.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { day, humanize, readError, statusTone } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface Amendment {
  id?: string;
  targetKind?: string;
  requestedChange?: string;
  status?: string;
  submittedAt?: string;
}
type TargetKind = "patient_demographic" | "encounter_narrative";

const TARGET_OPTIONS = [
  { value: "patient_demographic", label: "Personal details (name, address, contact)" },
  { value: "encounter_narrative", label: "Something written about a visit" },
] as const;

export function PortalAmendments(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Amendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<TargetKind>("patient_demographic");
  const [requestedChange, setRequestedChange] = useState("");
  const [submitState, setSubmitState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/portal/amendments", {});
    if (res.error) setError(readError(res.response?.status));
    else setRows((res.data?.items ?? []) as unknown as Amendment[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitState(null);
    setSubmitting(true);
    const res = await client.POST("/api/v1/portal/amendments/submit", {
      body: { targetKind, requestedChange },
    });
    setSubmitting(false);
    if (res.error) {
      setSubmitState({ tone: "err", msg: readError(res.response?.status) });
      return;
    }
    setSubmitState({ tone: "ok", msg: "Your request was submitted. Your team will review it." });
    setRequestedChange("");
    await load();
  }

  return (
    <PortalPage
      title="Request a correction"
      subtitle="Ask your team to fix something in the record (HIPAA §164.526)."
    >
      <PortalCard heading="New request">
        <form className="wx-portal-form" onSubmit={(e) => void submit(e)}>
          <SelectField
            label="What should be corrected?"
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value as TargetKind)}
            options={TARGET_OPTIONS}
          />
          <TextAreaField
            label="Requested change"
            hint="Explain what is incorrect and what it should say instead."
            value={requestedChange}
            onChange={(e) => setRequestedChange(e.target.value)}
            required
            rows={3}
            placeholder="Describe what should be corrected and why."
          />
          <Button type="submit" loading={submitting} disabled={requestedChange.trim().length === 0}>
            Submit request
          </Button>
          {submitState ? (
            <InlineAlert tone={submitState.tone === "err" ? "error" : "success"}>
              {submitState.msg}
            </InlineAlert>
          ) : null}
        </form>
      </PortalCard>

      <PortalLoadState
        loading={loading}
        error={error}
        empty={rows.length === 0}
        emptyTitle="No requests yet"
        emptyDescription="Correction requests you submit will be tracked here."
        onRetry={() => void load()}
      >
        <PortalCard heading="Your requests">
          <table className="wx-portal-data-table">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>About</th>
                <th>Request</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={a.id ?? i}>
                  <td data-label="Submitted">{day(a.submittedAt)}</td>
                  <td data-label="About">{a.targetKind ? humanize(a.targetKind) : "—"}</td>
                  <td data-label="Request">{a.requestedChange ?? "—"}</td>
                  <td data-label="Status">
                    {a.status ? (
                      <StatusPill tone={statusTone(a.status)} label={humanize(a.status)} />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}
