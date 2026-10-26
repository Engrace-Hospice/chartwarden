// apps/web/src/modules/41-billing-commercial — RUN AN ELIGIBILITY CHECK (M41). The form on the eligibility screen.
//   POST /api/v1/billing/commercial/eligibility/check   { providerEntityId, patientId, planId, serviceDate }
//                                                        (commercial_billing.write, Idempotency-Key per attempt, NO step-up)
// The member id is resolved on the server from the patient's coverage; it is not a field here and is never sent or shown. A refusal
// is shown in our own fixed words chosen by status and code (describeCheckFailure), never the server's text, and leaves the previous
// result on the page. A `replayed` answer is the EARLIER result for the same request, not a new check, and is announced as such.
import { Button, InlineAlert, SelectField, TextField, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type AuthorizationPlan,
  COMMERCIAL_PATHS,
  type CheckFailure,
  describeCheckFailure,
  localToday,
} from "./commercial-model";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Fields {
  planId: string;
  serviceDate: string;
}
type FieldErrors = Partial<Record<keyof Fields, string>>;

export function EligibilityCheckForm({
  providerEntityId,
  patientId,
  plans,
  defaultPlanId,
  onChecked,
}: {
  providerEntityId: string;
  patientId: string;
  plans: readonly AuthorizationPlan[];
  defaultPlanId: string;
  /** The check was answered: `replayed` is true when it is the earlier answer to the same request. */
  onChecked: (result: { planId: string; replayed: boolean }) => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [fields, setFields] = useState<Fields>({
    planId: defaultPlanId,
    serviceDate: localToday(),
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<CheckFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // One key per attempt: kept across a retry of the same body, dropped when a field changes, on success and on a 409.
  const attemptKey = useRef<string | null>(null);

  const edit =
    (name: keyof Fields) =>
    (value: string): void => {
      attemptKey.current = null;
      setFields((prev) => ({ ...prev, [name]: value }));
    };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const errors: FieldErrors = {};
    if (!fields.planId) errors.planId = "Choose a plan.";
    if (!DAY.test(fields.serviceDate)) errors.serviceDate = "Enter the service date.";
    setFieldErrors(errors);
    setFailure(null);
    if (Object.keys(errors).length > 0) return;
    inFlight.current = true;
    setBusy(true);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const { data, error, response } = await client.POST(
        "/api/v1/billing/commercial/eligibility/check",
        {
          params: { header: { "Idempotency-Key": attemptKey.current } },
          body: {
            providerEntityId,
            patientId,
            planId: fields.planId,
            serviceDate: fields.serviceDate,
          },
        },
      );
      if (!error && data) {
        attemptKey.current = null;
        onChecked({ planId: fields.planId, replayed: data.replayed });
        return;
      }
      if (response.status === 401) {
        navigate("/login");
        return;
      }
      if (response.status === 409) attemptKey.current = null;
      const code = (error as { error?: { code?: string } } | undefined)?.error?.code;
      setFailure(describeCheckFailure(response.status, code));
    } catch {
      setFailure(describeCheckFailure(0, undefined));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <form
      className="wx-form-stack"
      noValidate
      aria-label="Run eligibility check"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SelectField
        label="Plan to check"
        required
        value={fields.planId}
        error={fieldErrors.planId}
        onChange={(e) => edit("planId")(e.target.value)}
        options={[
          { value: "", label: "Choose a plan" },
          ...plans.map((p) => ({ value: p.id, label: p.planName })),
        ]}
      />
      <TextField
        label="Service date"
        required
        type="date"
        value={fields.serviceDate}
        error={fieldErrors.serviceDate}
        hint="The date the coverage is checked for. Defaults to today."
        onChange={(e) => edit("serviceDate")(e.target.value)}
      />
      {failure ? (
        <InlineAlert tone="error">
          {failure.text}
          {failure.enrollmentsLink ? (
            <>
              {" "}
              <Link
                to={`${COMMERCIAL_PATHS.enrollments}?entity=${encodeURIComponent(providerEntityId)}`}
              >
                Open enrollments
              </Link>
            </>
          ) : null}
        </InlineAlert>
      ) : null}
      <div className="wx-modal-actions">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Checking…" : "Run eligibility check"}
        </Button>
      </div>
    </form>
  );
}
