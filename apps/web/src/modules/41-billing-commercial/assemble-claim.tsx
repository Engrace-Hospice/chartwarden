// apps/web/src/modules/41-billing-commercial — ASSEMBLE A COMMERCIAL CLAIM (M41, spec section 5).
//   POST /api/v1/billing/commercial/claims/assemble   commercial_billing.write, Idempotency-Key per attempt; 201 opens the new claim
// The server builds the claim from the shared clinical facts and the plan's contract rates; this form only names what to bill: the
// provider entity, the patient, the service dates and, optionally, the plan and clearinghouse. There is no dry run, so nothing is
// previewed. Refusals are shown in fixed words by status and code (assemble-claim-model.ts), never the server's message.
// Idempotency: one key per attempt. The server stores every answer under the key for 24h and replays it for the same body, so the
// key is kept only when no HTTP response arrived (a thrown fetch) and dropped on any response and on any field change.
import { Button, InlineAlert, SelectField, TextField, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { PatientLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { ASSEMBLE_CLEARINGHOUSE_PATTERN, describeAssembleFailure } from "./assemble-claim-model";
import { CommercialTabs, EntityGate, EntityPicker } from "./commercial-chrome";
import { COMMERCIAL_PATHS } from "./commercial-model";
import { useAuthorizationPlans } from "./use-authorization-plans";
import { useProviderEntity } from "./use-provider-entity";

const WRITE_PERMISSION = "commercial_billing.write";
const AUTO_PLAN = "";

interface Fields {
  patientId: string;
  serviceFrom: string;
  serviceTo: string;
  planId: string;
  clearinghouseKey: string;
}
type FieldErrors = Partial<Record<keyof Fields, string>>;

const EMPTY: Fields = {
  patientId: "",
  serviceFrom: "",
  serviceTo: "",
  planId: AUTO_PLAN,
  clearinghouseKey: "",
};

function validate(fields: Fields): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.patientId) errors.patientId = "Choose a patient.";
  if (!fields.serviceFrom) errors.serviceFrom = "Enter the first day to bill.";
  if (!fields.serviceTo) errors.serviceTo = "Enter the last day to bill.";
  if (fields.serviceFrom && fields.serviceTo && fields.serviceTo < fields.serviceFrom) {
    errors.serviceTo = "The last day cannot be before the first day.";
  }
  if (fields.clearinghouseKey && !ASSEMBLE_CLEARINGHOUSE_PATTERN.test(fields.clearinghouseKey)) {
    errors.clearinghouseKey =
      "Use 1 to 40 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.";
  }
  return errors;
}

export function CommercialAssembleClaim(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const canWrite = (useSession()?.permissions ?? []).includes(WRITE_PERMISSION);
  const { state: entities, entityId, setEntityId, retry: retryEntities } = useProviderEntity();
  const { plans, retry: retryPlans } = useAuthorizationPlans(entityId);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const attemptKey = useRef<string | null>(null);

  const edit =
    (name: keyof Fields) =>
    (value: string): void => {
      attemptKey.current = null;
      setFields((prev) => ({ ...prev, [name]: value }));
    };

  const pickEntity = (id: string): void => {
    attemptKey.current = null;
    setFields((prev) => ({ ...prev, planId: AUTO_PLAN })); // a plan belongs to one entity
    setEntityId(id);
  };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const errors = validate(fields);
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    inFlight.current = true;
    setBusy(true);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const { data, error, response } = await client.POST(
        "/api/v1/billing/commercial/claims/assemble",
        {
          params: { header: { "Idempotency-Key": attemptKey.current } },
          body: {
            providerEntityId: entityId,
            patientId: fields.patientId,
            serviceFrom: fields.serviceFrom,
            serviceTo: fields.serviceTo,
            ...(fields.planId ? { planId: fields.planId } : {}),
            ...(fields.clearinghouseKey ? { clearinghouseKey: fields.clearinghouseKey } : {}),
          },
        },
      );
      attemptKey.current = null; // any HTTP response retires the key
      if (data) {
        navigate(`${COMMERCIAL_PATHS.claim(data.claimId)}?entity=${encodeURIComponent(entityId)}`);
        return;
      }
      if (response.status === 401) {
        navigate("/login");
        return;
      }
      const code = (error as { error?: { code?: string } } | undefined)?.error?.code;
      setServerError(describeAssembleFailure(response.status, code));
    } catch {
      setServerError(describeAssembleFailure(0, undefined)); // no response: the key is kept for the retry
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const planOptions = [
    { value: AUTO_PLAN, label: "Choose automatically" },
    ...(plans.state === "ready"
      ? plans.plans.map((p) => ({ value: p.id, label: p.planName }))
      : []),
  ];

  return (
    <div className="wx-list-drawer-main">
      <header className="wx-page-head">
        <div>
          <h1>Assemble commercial claim</h1>
          <p>
            Build a claim for a patient whose primary payer is a commercial plan. The server works
            out the lines and prices from the stay and the plan's contract rates.
          </p>
        </div>
      </header>

      <BillingTabs />
      <CommercialTabs />

      <EntityGate state={entities} hasEntity={entityId !== ""} onRetry={retryEntities}>
        {canWrite ? (
          <form
            className="wx-form-stack"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="wx-filter-panel">
              <EntityPicker state={entities} value={entityId} onChange={pickEntity} />
            </div>
            <PatientLookupField
              label="Patient"
              required
              value={fields.patientId}
              error={fieldErrors.patientId}
              onChange={edit("patientId")}
            />
            <TextField
              label="Service from"
              required
              type="date"
              value={fields.serviceFrom}
              error={fieldErrors.serviceFrom}
              onChange={(e) => edit("serviceFrom")(e.target.value)}
            />
            <TextField
              label="Service to"
              required
              type="date"
              value={fields.serviceTo}
              error={fieldErrors.serviceTo}
              onChange={(e) => edit("serviceTo")(e.target.value)}
            />
            <SelectField
              label="Plan"
              value={fields.planId}
              hint={
                plans.state === "error"
                  ? "Plans could not be loaded, so the plan is chosen automatically."
                  : "Leave on automatic unless more than one plan of the payer covers the dates."
              }
              onChange={(e) => edit("planId")(e.target.value)}
              options={planOptions}
            />
            {plans.state === "error" ? (
              <Button tone="tertiary" size="sm" onClick={retryPlans}>
                Reload plans
              </Button>
            ) : null}
            <TextField
              label="Clearinghouse key"
              autoComplete="off"
              spellCheck={false}
              value={fields.clearinghouseKey}
              error={fieldErrors.clearinghouseKey}
              hint="Leave blank to use the clearinghouse the plan is routed to."
              onChange={(e) => edit("clearinghouseKey")(e.target.value)}
            />
            {serverError ? <InlineAlert tone="error">{serverError}</InlineAlert> : null}
            <div className="wx-modal-actions">
              <Button tone="tertiary" size="sm" onClick={() => navigate(COMMERCIAL_PATHS.queue)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Assembling…" : "Assemble claim"}
              </Button>
            </div>
          </form>
        ) : (
          <InlineAlert tone="info">You are not allowed to assemble commercial claims.</InlineAlert>
        )}
      </EntityGate>
    </div>
  );
}
