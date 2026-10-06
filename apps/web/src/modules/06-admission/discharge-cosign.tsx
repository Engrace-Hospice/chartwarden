import { Button, InlineAlert, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — for-cause discharge medical-director cosign
// (WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER "For cause: cosign required → pending"; M6 route 40,
// POST /api/v1/discharges/:id/cosign-for-cause). A for-cause discharge is filed as `pending_cosign` and
// the admission stays active until this cosign lands (D11). The server gates on
// `discharge.cosign_for_cause` plus the medical-director ABAC predicate and an `ifVersion` optimistic
// lock. M6 exposes no discharge-event read, so the screen takes the version from `?version=` (the
// filing response carries it) and otherwise sends the row's insert default, 0 — a stale value comes
// back as VERSION_MISMATCH and is shown as such, never retried blindly.
import { type JSX, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { ReviewItem } from "./death-pronouncement";
import {
  CascadePanel,
  EpisodeActions,
  EpisodeField,
  EpisodePage,
  EpisodeSection,
  LockedField,
  WorkflowSteps,
  endOfEpisodeMessage,
  errorCodeOf,
  errorFieldOf,
} from "./end-of-episode-ui";
import { authFailureRedirect } from "./write-workflow";

const STEPS = ["Filed", "Medical director cosign", "Discharged"] as const;
const NPI = /^[0-9]{10}$/;

const COSIGN_MESSAGES: Record<string, string> = {
  INVALID_STATE:
    "This discharge is not awaiting a medical-director cosign. It may already be cosigned or voided.",
  VERSION_MISMATCH:
    "This discharge changed since the link was created. Open it again from the admission and retry.",
  FORBIDDEN: "Only the organization's medical director can cosign a for-cause discharge.",
};

const COSIGN_CASCADE = [
  { label: "Admission → Discharged", detail: "The admission leaves active status." },
  { label: "Election period closed", detail: "The current benefit period completes with cause." },
  { label: "Final claim and NOTR", detail: "Billing opens the discharge notice and final claim." },
  { label: "Discharge summary", detail: "A discharge summary document is generated." },
];

type FieldErrors = Partial<Record<"name" | "npi", string>>;

export function validateCosign(name: string, npi: string): FieldErrors {
  const e: FieldErrors = {};
  if (!name.trim()) e.name = "Enter the cosigning medical director's name.";
  if (!NPI.test(npi.trim())) e.npi = "Enter the 10-digit NPI.";
  return e;
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
        body: { cosignerName: name.trim(), cosignerNpi: npi.trim(), ifVersion },
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

  return (
    <EpisodePage
      title="Cosign for-cause discharge"
      subtitle="A for-cause discharge takes effect only after the medical director cosigns it."
      breadcrumb={
        <>
          <Link to="/admissions">Admissions</Link>
          {admissionId ? (
            <>
              {" "}
              / <Link to={back}>Admission</Link>
            </>
          ) : null}{" "}
          / For-cause cosign
        </>
      }
      railLabel="What happens next"
      rail={
        <CascadePanel
          title="When you cosign"
          items={COSIGN_CASCADE}
          footnote="Until a cosign is recorded the admission stays active."
        />
      }
    >
      <WorkflowSteps steps={STEPS} current={done ? 3 : 1} label="For-cause discharge progress" />

      {done ? (
        <EpisodeSection icon="check-circle" title="Discharge cosigned">
          <InlineAlert tone="success">
            The for-cause discharge was cosigned. The admission is now discharged.
          </InlineAlert>
          <div style={{ marginTop: "0.75rem" }}>
            <Button onClick={() => navigate(back)}>
              {admissionId ? "Open admission" : "Back to admissions"}
            </Button>
          </div>
        </EpisodeSection>
      ) : (
        <>
          <EpisodeSection
            icon="file-text"
            title="Discharge being cosigned"
            description="Review the for-cause narrative on the admission before cosigning."
          >
            <dl className="wx-field-grid" style={{ margin: 0 }}>
              <ReviewItem term="Discharge reason" value="For cause" />
              <ReviewItem term="Discharge reference" value={id} />
            </dl>
          </EpisodeSection>

          <EpisodeSection
            icon="shield-check"
            title="Medical director attestation"
            description="Your name and NPI are stored on the discharge record."
          >
            <div className="wx-field-grid">
              <EpisodeField
                htmlFor="cosign-name"
                label="Cosigner name"
                code="cosignerName"
                required
                error={errors.name}
              >
                <input
                  id="cosign-name"
                  type="text"
                  value={name}
                  maxLength={200}
                  autoComplete="name"
                  aria-invalid={errors.name ? true : undefined}
                  onChange={(e) => setName(e.target.value)}
                />
              </EpisodeField>
              <EpisodeField
                htmlFor="cosign-npi"
                label="NPI"
                code="cosignerNpi"
                required
                hint="10 digits"
                error={errors.npi}
              >
                <input
                  id="cosign-npi"
                  type="text"
                  inputMode="numeric"
                  value={npi}
                  maxLength={10}
                  aria-invalid={errors.npi ? true : undefined}
                  onChange={(e) => setNpi(e.target.value.replace(/\D/g, ""))}
                />
              </EpisodeField>
              <LockedField
                id="cosign-version"
                label="Record version"
                code="ifVersion"
                value={String(ifVersion)}
                source="From the filed discharge"
              />
              <label
                className="wx-field-grid-full"
                style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}
              >
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(e) => setAttested(e.target.checked)}
                  style={{ marginTop: "0.2rem" }}
                />
                <span style={{ fontSize: "0.875rem" }}>
                  I reviewed the for-cause reason and narrative and agree the patient should be
                  discharged for cause.
                </span>
              </label>
            </div>
          </EpisodeSection>

          <EpisodeActions error={submitError}>
            <Button tone="secondary" onClick={() => navigate(back)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              loading={busy}
              disabled={busy || !attested}
              title={attested ? undefined : "Confirm the attestation first"}
            >
              Cosign discharge
            </Button>
          </EpisodeActions>
          <p style={{ margin: 0, fontSize: "0.75rem", color: t.onSurfaceVariant }}>
            You may be asked to confirm your identity before the cosign is saved.
          </p>
        </>
      )}
    </EpisodePage>
  );
}
