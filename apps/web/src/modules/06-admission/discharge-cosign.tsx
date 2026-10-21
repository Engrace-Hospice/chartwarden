import { InlineAlert, LoadingSpinner, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/06-admission — for-cause discharge physician cosign (42 CFR 418.26(b): medical director, physician designee or the patient's IDG physician)
// (WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER "For cause: cosign required → pending"; M6 route 40,
// POST /api/v1/discharges/:id/cosign-for-cause). A for-cause discharge is filed as `pending_cosign` and
// the admission stays active until this cosign lands (D11). The server gates on
// `discharge.cosign_for_cause` plus the `discharge.is_order_signer` ABAC predicate and an `ifVersion` optimistic
// lock. M6 exposes no discharge-event read, so the screen takes the version from `?version=` (the
// filing response carries it, and the discharge workflow links here with it) and otherwise sends the
// row's insert default, 0 — a stale value comes back as VERSION_MISMATCH and is shown as such, never
// retried blindly. `?admissionId=` puts the screen in the patient workspace frame the other
// end-of-episode workflows use (end-of-episode-ui.tsx).
import { type JSX, type ReactNode, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { type CosignOrderDraft, CosignOrderFields } from "./discharge-order-ui";
import {
  AdmissionPanel,
  AttestTile,
  EpisodeWorkspace,
  Field,
  LockedField,
  ReviewList,
  Section,
  StepNav,
  type WhatHappensItem,
  WhatHappensList,
  WhatHappensPanel,
  WorkflowFooter,
  WorkflowHead,
  bodyText,
  endOfEpisodeMessage,
  errorCodeOf,
  errorFieldOf,
  linearSteps,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { authFailureRedirect } from "./write-workflow";

const TITLE = "Cosign for-cause discharge";
const STEPS = ["Filed", "Physician cosign", "Discharged"] as const;
const NPI = /^[0-9]{10}$/;

const COSIGN_MESSAGES: Record<string, string> = {
  INVALID_STATE:
    "This discharge is not awaiting a physician cosign. It may already be cosigned or voided.",
  VERSION_MISMATCH:
    "This discharge changed since the link was created. Open it again from the admission and retry.",
  FORBIDDEN:
    "Only the medical director, a physician designee, or this patient's IDG physician can cosign a for-cause discharge (42 CFR 418.26(b)).",
  PHYSICIAN_SIGNER_INVALID:
    "The capacity you chose doesn't match your roles or this patient's IDG. Choose another, or let it be detected.",
};

const COSIGN_CASCADE: readonly WhatHappensItem[] = [
  { icon: "clipboard-check", text: "The admission becomes Discharged." },
  { icon: "calendar-check", text: "The current benefit period completes — cause: discharge." },
  { icon: "receipt", text: "Billing drafts the NOTR and the final claim." },
  { icon: "file-text", text: "A discharge summary is generated for the chart." },
];

type FieldErrors = Partial<Record<"name" | "npi", string>>;

export function validateCosign(name: string, npi: string): FieldErrors {
  const e: FieldErrors = {};
  if (!name.trim()) e.name = "Enter the cosigning physician's name.";
  if (!NPI.test(npi.trim())) e.npi = "Enter the 10-digit NPI.";
  return e;
}

/** The workspace frame: the patient workspace when the admission is known, else a bare column. */
function CosignFrame({
  admissionId,
  children,
}: {
  admissionId: string | null;
  children: ReactNode;
}): JSX.Element {
  const admission = useEpisodeAdmission(admissionId);
  const cascade = (
    <WhatHappensPanel title="When you cosign">
      <WhatHappensList items={COSIGN_CASCADE} compact />
      <p style={{ ...bodyText, marginTop: "0.75rem", fontSize: "0.75rem" }}>
        Until a cosign is recorded the admission stays active.
      </p>
    </WhatHappensPanel>
  );
  if (admissionId && admission === null) return <LoadingSpinner />;
  if (!admissionId || admission === null || admission === "error")
    return (
      <div className="wx-with-rail">
        <div className="wx-with-rail-main">{children}</div>
        <aside className="wx-with-rail-side" aria-label="What happens next">
          {cascade}
        </aside>
      </div>
    );
  return (
    <EpisodeWorkspace
      patientId={admission.patientId}
      backTo={`/admissions/${admission.id}`}
      rail={
        <>
          <AdmissionPanel admission={admission} />
          {cascade}
        </>
      }
    >
      {children}
    </EpisodeWorkspace>
  );
}

export function DischargeCosign(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const versionParam = Number(search.get("version") ?? "0");
  const ifVersion = Number.isInteger(versionParam) && versionParam >= 0 ? versionParam : 0;
  const admissionId = search.get("admissionId");

  const [name, setName] = useState(session?.displayName ?? "");
  const [npi, setNpi] = useState("");
  const [attested, setAttested] = useState(false);
  // 42 CFR 418.26(b) — the cosign IS the written discharge order: capacity + the order as written.
  const [order, setOrder] = useState<CosignOrderDraft>({
    capacity: "",
    orderText: "",
    orderReference: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!id)
    return <InlineAlert tone="error">No discharge was specified for this cosign.</InlineAlert>;

  const submit = async () => {
    const e = validateCosign(name, npi);
    setErrors(e);
    if (Object.keys(e).length > 0 || !attested) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const { error, response } = await client.POST("/api/v1/discharges/{id}/cosign-for-cause", {
        params: { path: { id } },
        body: {
          cosignerName: name.trim(),
          cosignerNpi: npi.trim(),
          ...(order.capacity ? { capacity: order.capacity } : {}),
          ...(order.orderText.trim() ? { orderText: order.orderText.trim() } : {}),
          ...(order.orderReference.trim() ? { orderReference: order.orderReference.trim() } : {}),
          ifVersion,
        },
      });
      if (error) {
        const code = errorCodeOf(error);
        const redirect = authFailureRedirect(response?.status, code, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        if (errorFieldOf(error) === "cosignerNpi") setErrors({ npi: "Enter the 10-digit NPI." });
        setSubmitError(
          endOfEpisodeMessage(
            response?.status,
            code,
            COSIGN_MESSAGES,
            "The cosign could not be saved. Try again.",
          ),
        );
        return;
      }
      setDone(true);
    } catch {
      setSubmitError("The cosign could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const back = admissionId ? `/admissions/${admissionId}` : "/admissions";
  const current = done ? STEPS.length : 1;

  return (
    <CosignFrame admissionId={admissionId}>
      <div className="wx-hope-workspace">
        <StepNav
          label="For-cause discharge progress"
          heading="For-cause discharge"
          steps={linearSteps(STEPS, current)}
          activeId={done ? null : String(current)}
        />
        <main className="wx-hope-main">
          <WorkflowHead
            title={TITLE}
            stepLine={done ? "Cosigned" : `Step 2 of ${STEPS.length} · ${STEPS[1]}`}
          />

          {done ? (
            <Section icon="check-circle" title="Discharge cosigned">
              <InlineAlert tone="success">
                The for-cause discharge was cosigned. The admission is now discharged.
              </InlineAlert>
            </Section>
          ) : (
            <>
              <Section
                icon="file-text"
                title="Discharge being cosigned"
                description="Review the for-cause narrative on the admission before cosigning."
              >
                <ReviewList
                  rows={[
                    { term: "Discharge reason", value: "For cause" },
                    { term: "Discharge reference", value: id },
                  ]}
                />
              </Section>

              <Section
                icon="shield-check"
                title="Physician attestation"
                description="Your name and NPI are stored on the discharge record. You may be asked to confirm your identity."
              >
                <div style={{ display: "grid", gap: "0.875rem" }}>
                  <div className="wx-field-grid">
                    <Field id="cosign-name" label="Cosigner name" required error={errors.name}>
                      <input
                        id="cosign-name"
                        type="text"
                        value={name}
                        maxLength={200}
                        autoComplete="name"
                        aria-invalid={errors.name ? true : undefined}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </Field>
                    <Field id="cosign-npi" label="NPI" required hint="10 digits" error={errors.npi}>
                      <input
                        id="cosign-npi"
                        type="text"
                        inputMode="numeric"
                        value={npi}
                        maxLength={10}
                        aria-invalid={errors.npi ? true : undefined}
                        onChange={(e) => setNpi(e.target.value.replace(/\D/g, ""))}
                      />
                    </Field>
                    <LockedField
                      id="cosign-version"
                      label="Record version"
                      value={String(ifVersion)}
                      source="From the filed discharge"
                    />
                  </div>
                  <CosignOrderFields value={order} onChange={setOrder} />
                  <AttestTile checked={attested} onChange={setAttested}>
                    I reviewed the for-cause reason and narrative and agree the patient should be
                    discharged for cause.
                  </AttestTile>
                  {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
                </div>
              </Section>
            </>
          )}

          <WorkflowFooter note="For-cause discharge">
            {done ? (
              <Link to={back} className="wx-btn-primary">
                {admissionId ? "Open admission" : "Back to admissions"}
              </Link>
            ) : (
              <>
                <Link to={back} className="wx-btn-secondary">
                  Cancel
                </Link>
                <button
                  type="button"
                  className="wx-btn-primary"
                  onClick={() => void submit()}
                  disabled={busy || !attested}
                  title={attested ? undefined : "Confirm the attestation first"}
                >
                  {busy ? "Cosigning…" : "Cosign discharge"}
                </button>
              </>
            )}
          </WorkflowFooter>
        </main>
      </div>
    </CosignFrame>
  );
}
