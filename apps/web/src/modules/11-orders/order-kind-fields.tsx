import type { JSX, ReactNode } from "react";

type Kind =
  | "lab"
  | "dme"
  | "level_of_care_change"
  | "recertification"
  | "comfort_kit"
  | "supply"
  | "ancillary_service"
  | "idg_requested";

type Props = {
  kind: Kind;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
};

export function CanonicalOrderFields({
  kind,
  value,
  onChange,
  errors = {},
}: Props): JSX.Element {
  const set = (key: string, next: unknown) =>
    onChange({ ...value, [key]: next });
  const text = (
    key: string,
    label: string,
    required = false,
    placeholder?: string,
  ) => (
    <Field label={label} error={errors[key]} required={required}>
      <input
        aria-invalid={Boolean(errors[key])}
        required={required}
        value={String(value[key] ?? "")}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
        style={control}
      />
    </Field>
  );

  if (kind === "lab")
    return (
      <ClinicalSection
        title="Lab details"
        description="Provide the clinical information needed to identify and perform the requested laboratory test."
      >
        {text(
          "clinicalJustification",
          "Clinical justification",
          false,
          "Why is this test clinically needed?",
        )}
        {text(
          "collectionInstructions",
          "Collection instructions",
          false,
          "Optional specimen or collection instructions",
        )}
        <Field label="Lab priority">
          <select
            value={String(value.priority ?? "routine")}
            onChange={(e) => set("priority", e.target.value)}
            style={control}
          >
            <option value="routine">Routine</option>
            <option value="asap">ASAP</option>
            <option value="stat">STAT</option>
          </select>
        </Field>
        <Field label="LOINC test code" error={errors.testCodes} required>
          <input
            aria-invalid={Boolean(errors.testCodes)}
            value={
              Array.isArray(value.testCodes)
                ? String((value.testCodes[0] as { code?: string })?.code ?? "")
                : ""
            }
            placeholder="Enter LOINC code"
            onChange={(e) =>
              set(
                "testCodes",
                e.target.value
                  ? [
                      {
                        system: "http://loinc.org",
                        code: e.target.value,
                        display: e.target.value,
                      },
                    ]
                  : [],
              )
            }
            style={control}
          />
        </Field>
        <label style={checkField}>
          <input
            type="checkbox"
            checked={Boolean(value.fastingRequired)}
            onChange={(e) => set("fastingRequired", e.target.checked)}
          />
          <span>
            <strong>Fasting required</strong>
            <small style={help}>
              Check only when the patient must fast before collection.
            </small>
          </span>
        </label>
      </ClinicalSection>
    );

  if (kind === "level_of_care_change")
    return (
      <ClinicalSection
        title="Level-of-care change"
        description="Document the requested transition and its clinical justification."
      >
        <Field label="From level">
          <select
            value={String(value.fromLevel ?? "rhc")}
            onChange={(e) => set("fromLevel", e.target.value)}
            style={control}
          >
            {levels.map((x) => (
              <option key={x} value={x}>
                {x.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To level" error={errors.toLevel}>
          <select
            aria-invalid={Boolean(errors.toLevel)}
            value={String(value.toLevel ?? "irc")}
            onChange={(e) => set("toLevel", e.target.value)}
            style={control}
          >
            {levels.map((x) => (
              <option key={x} value={x}>
                {x.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Effective at" error={errors.effectiveAt}>
          <input
            type="datetime-local"
            value={local(value.effectiveAt)}
            onChange={(e) =>
              set(
                "effectiveAt",
                e.target.value ? new Date(e.target.value).toISOString() : "",
              )
            }
            style={control}
          />
        </Field>
        {text(
          "clinicalJustification",
          "Clinical justification",
          false,
          "Explain why the level-of-care change is needed",
        )}
      </ClinicalSection>
    );

  if (kind === "comfort_kit")
    return (
      <ClinicalSection
        title="Comfort kit"
        description="Identify the kit and where it should be deployed."
      >
        {text("kitSku", "Kit SKU", true)}
        <Field label="Deployment site" error={errors.deploymentSite}>
          <select
            value={String(value.deploymentSite ?? "home")}
            onChange={(e) => set("deploymentSite", e.target.value)}
            style={control}
          >
            {["home", "alf", "snf", "ipu"].map((x) => (
              <option key={x} value={x}>
                {x.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        {text("notes", "Notes", false, "Optional instructions or context")}
      </ClinicalSection>
    );

  if (kind === "recertification")
    return (
      <ClinicalSection
        title="Recertification"
        description="Provide the certification period and certifying physician required for this order."
      >
        <Field label="Period end date" error={errors.periodEndDate} required>
          <input
            type="date"
            required
            aria-invalid={Boolean(errors.periodEndDate)}
            value={String(value.periodEndDate ?? "")}
            onChange={(e) => set("periodEndDate", e.target.value)}
            style={control}
          />
        </Field>
        {text("certifyingPhysicianMdmId", "Certifying physician ID", true)}
      </ClinicalSection>
    );

  if (kind === "idg_requested")
    return (
      <ClinicalSection
        title="IDG request"
        description="This order is normally created from an IDG decision. Review its generated clinical details."
      >
        {text("requestedKind", "Requested order kind", true)}
        {text("narrative", "Narrative", true)}
        {text("recommendedTimeframe", "Recommended timeframe")}
      </ClinicalSection>
    );

  return (
    <div style={fallbackBox}>
      <strong>{transitionalKindName(kind)} contract not published</strong>
      <p style={{ margin: ".35rem 0 0" }}>
        This order kind has no published M11 field-level payload contract yet,
        so no typed clinical controls are shown. Existing payload data is
        preserved when editing a draft or correction.
      </p>
    </div>
  );
}

function transitionalKindName(kind: Kind): string {
  switch (kind) {
    case "dme":
      return "DME";
    case "supply":
      return "Supply";
    case "ancillary_service":
      return "Ancillary service";
    default:
      return "Order";
  }
}

function ClinicalSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <fieldset style={fieldset}>
      <legend style={legend}>{title}</legend>
      <p style={descriptionStyle}>{description}</p>
      <div style={fieldsGrid}>{children}</div>
    </fieldset>
  );
}
function Field({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <label style={field}>
      <span>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {children}
      {error ? (
        <small role="alert" style={errorText}>
          {error}
        </small>
      ) : null}
    </label>
  );
}

const levels = ["rhc", "irc", "chc", "gip"] as const;
const local = (v: unknown) => (typeof v === "string" ? v.slice(0, 16) : "");
const fieldset = {
  margin: 0,
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
  minWidth: 0,
} as const;
const legend = { padding: "0 .35rem", fontWeight: 700 } as const;
const descriptionStyle = {
  margin: "0 0 1rem",
  color: "var(--color-on-surface-variant)",
  fontSize: ".875rem",
  lineHeight: 1.5,
} as const;
const fieldsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: "1rem",
} as const;
const field = {
  display: "grid",
  gap: ".4rem",
  alignContent: "start",
  fontSize: ".875rem",
  fontWeight: 600,
} as const;
const control = {
  display: "block",
  width: "100%",
  boxSizing: "border-box" as const,
  minHeight: "2.5rem",
  padding: ".55rem .65rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".45rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
} as const;
const checkField = {
  display: "flex",
  alignItems: "flex-start",
  gap: ".6rem",
  padding: ".65rem 0",
  fontSize: ".875rem",
} as const;
const help = {
  display: "block",
  marginTop: ".2rem",
  color: "var(--color-on-surface-variant)",
  fontWeight: 400,
} as const;
const errorText = {
  color: "var(--color-error)",
  fontWeight: 500,
} as const;
const fallbackBox = {
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
  color: "var(--color-on-surface-variant)",
} as const;
