import { validateTenantSlug } from "@chartwarden/types";
import {
  Button,
  type FieldErrors,
  Glyph,
  InlineAlert,
  ReverifyLink,
  SelectField,
  TextField,
  focusFirstInvalid,
  isStepUpRequired,
  isValid,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
// apps/admin/src/modules/34-saas-platform — "New tenant" (§4.1 #3, POST /api/v1/platform/tenants). Raw-input provisioning
// (no signup intent): the server step-up gates it and enqueues `tenant.provision`, answering 202, so the tenant appears in the
// inventory once the provisioner has run — this form only reports that the request was accepted. A step-up refusal keeps
// the typed values, stashes them across the Re-verify round trip and restores them on return — never an automatic redirect.
import { useState } from "react";
import type { FormEvent, JSX } from "react";

type PlanLabel = "starter" | "standard" | "enterprise";

const PLAN_OPTIONS: readonly { value: PlanLabel; label: string }[] = [
  { value: "starter", label: "Starter" },
  { value: "standard", label: "Standard" },
  { value: "enterprise", label: "Enterprise" },
];
const NAME_MIN = 2;
const NAME_MAX = 300;
const ADMIN_NAME_MAX = 200;
const SLUG_MESSAGES = {
  format:
    "Use 3–63 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
  punycode: "A slug cannot start with “xn--”.",
  reserved: "That name is reserved. Choose another.",
} as const;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Re-verify leaves the page, so the typed values ride through sessionStorage and are restored once, on return.
const DRAFT_KEY = "wx-tenant-provision-draft";

interface Draft {
  legalName: string;
  billingEmail: string;
  breachEmail: string;
  adminEmail: string;
  adminName: string;
  slug: string;
  plan: PlanLabel;
}

function takeDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    return JSON.parse(raw) as Draft;
  } catch {
    return null;
  }
}

function stashDraft(draft: Draft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage unavailable (private window): the operator retypes after re-verifying.
  }
}

/** Per-field messages for the New tenant form; empty when it can be submitted (#597, F-042). */
export function tenantProvisionErrors(
  form: Pick<
    Draft,
    "legalName" | "billingEmail" | "breachEmail" | "adminEmail" | "adminName"
  > &
    Partial<Pick<Draft, "slug">>,
): FieldErrors<
  | "legalName"
  | "slug"
  | "billingEmail"
  | "breachEmail"
  | "adminEmail"
  | "adminName"
> {
  const errors: FieldErrors<
    | "legalName"
    | "slug"
    | "billingEmail"
    | "breachEmail"
    | "adminEmail"
    | "adminName"
  > = {};
  const slug = (form.slug ?? "").trim();
  if (slug !== "") {
    const verdict = validateTenantSlug(slug);
    if (!verdict.ok) errors.slug = SLUG_MESSAGES[verdict.reason];
  }
  const name = form.legalName.trim();
  if (name.length < NAME_MIN)
    errors.legalName = `Enter the legal business name (at least ${NAME_MIN} characters).`;
  const email = (value: string, missing: string): string | undefined =>
    value.trim() === ""
      ? missing
      : EMAIL_SHAPE.test(value.trim())
        ? undefined
        : "Enter a valid email address, e.g. name@example.com.";
  errors.billingEmail = email(
    form.billingEmail,
    "Enter the billing contact email.",
  );
  errors.breachEmail = email(
    form.breachEmail,
    "Enter the breach notification email.",
  );
  errors.adminEmail = email(form.adminEmail, "Enter the first admin's email.");
  if (form.adminName.trim() === "")
    errors.adminName = "Enter the first admin's full name.";
  return Object.fromEntries(
    Object.entries(errors).filter(([, v]) => v !== undefined),
  );
}

type Outcome = { ok: true } | { ok: false; message: string; stepUp: boolean };

/** The server's own message from the error envelope, when it carries one. */
function serverMessage(err: unknown): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : null;
}

/** Refusal codes that name the Subdomain field: shown on it, not in the general alert. */
const SLUG_REFUSAL_CODES: readonly string[] = [
  "INVALID_TENANT_SLUG",
  "TENANT_SLUG_UNAVAILABLE",
];
function isSlugRefusal(err: unknown): boolean {
  const code = (err as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && SLUG_REFUSAL_CODES.includes(code);
}

export function TenantProvisionDrawer({
  onClose,
  onAccepted,
}: {
  onClose: () => void;
  onAccepted: () => void;
}): JSX.Element {
  const client = useApiClient();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const [draft] = useState(takeDraft);
  const [legalName, setLegalName] = useState(draft?.legalName ?? "");
  const [billingEmail, setBillingEmail] = useState(draft?.billingEmail ?? "");
  const [breachEmail, setBreachEmail] = useState(draft?.breachEmail ?? "");
  const [adminEmail, setAdminEmail] = useState(draft?.adminEmail ?? "");
  const [adminName, setAdminName] = useState(draft?.adminName ?? "");
  const [slug, setSlug] = useState(draft?.slug ?? "");
  const [plan, setPlan] = useState<PlanLabel>(draft?.plan ?? "standard");
  const [slugRefusal, setSlugRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Provisioning is queued, not instant, so the tenant is not in the list yet; locking the form after acceptance stops
  // a second click from enqueueing a duplicate `tenant.provision`.
  const [accepted, setAccepted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const name = legalName.trim();
  // Errors appear after the first submit attempt; the button stays enabled so a refusal always explains itself.
  const [attempted, setAttempted] = useState(false);
  const fieldValues = {
    legalName,
    slug,
    billingEmail,
    breachEmail,
    adminEmail,
    adminName,
  };
  const errors = attempted ? tenantProvisionErrors(fieldValues) : {};
  const slugError = errors.slug ?? slugRefusal ?? undefined;

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy || accepted) return;
    if (!isValid(tenantProvisionErrors(fieldValues))) {
      setAttempted(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setOutcome(null);
    setSlugRefusal(null);
    let error: unknown;
    try {
      ({ error } = await client.POST("/api/v1/platform/tenants", {
        body: {
          legalBusinessName: name,
          billingContactEmail: billingEmail.trim(),
          breachNotificationContactEmail: breachEmail.trim(),
          firstAdminEmail: adminEmail.trim(),
          firstAdminFullName: adminName.trim(),
          planLabel: plan,
          ...(slug.trim() === "" ? {} : { slug: slug.trim() }),
        },
      }));
    } catch {
      setBusy(false);
      setOutcome({
        ok: false,
        stepUp: false,
        message:
          "Could not reach the server. Nothing was requested; try again.",
      });
      return;
    }
    setBusy(false);
    if (error) {
      if (isSlugRefusal(error)) {
        setSlugRefusal(
          serverMessage(error) ?? "That subdomain cannot be used.",
        );
        requestAnimationFrame(() =>
          document.getElementById("prov-slug")?.focus(),
        );
        return;
      }
      const stepUp = isStepUpRequired(error);
      setOutcome({
        ok: false,
        stepUp,
        message: stepUp
          ? "Confirm it’s you before provisioning a tenant."
          : (serverMessage(error) ??
            "Could not request provisioning. Check the details and try again."),
      });
      return;
    }
    setAccepted(true);
    setOutcome({ ok: true });
    onAccepted();
  }

  return (
    <aside className="wx-admission-drawer" aria-label="New tenant" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="building" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>New tenant</h2>
          <span className="wx-row-sub">
            Provisions a hospice tenant and invites its first admin.
          </span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <form
        className="wx-drawer-body"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <section className="wx-drawer-card">
          <TextField
            id="prov-legal-name"
            label="Legal business name"
            required
            error={errors.legalName}
            value={legalName}
            maxLength={NAME_MAX}
            onChange={(e) => setLegalName(e.target.value)}
          />
          <TextField
            id="prov-slug"
            label="Subdomain (optional)"
            hint="The tenant's address, e.g. sunrise for sunrise.chartwarden.com. Leave blank to generate one. It cannot be changed or reused later."
            error={slugError}
            value={slug}
            maxLength={63}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugRefusal(null);
            }}
          />
          <SelectField
            label="Plan"
            value={plan}
            options={PLAN_OPTIONS}
            onChange={(e) => setPlan(e.target.value as PlanLabel)}
          />
        </section>
        <section className="wx-drawer-card">
          <TextField
            id="prov-billing-email"
            label="Billing contact email"
            required
            error={errors.billingEmail}
            type="email"
            value={billingEmail}
            onChange={(e) => setBillingEmail(e.target.value)}
          />
          <TextField
            id="prov-breach-email"
            label="Breach notification email"
            required
            error={errors.breachEmail}
            type="email"
            value={breachEmail}
            onChange={(e) => setBreachEmail(e.target.value)}
          />
        </section>
        <section className="wx-drawer-card">
          <TextField
            id="prov-admin-name"
            label="First admin full name"
            required
            error={errors.adminName}
            value={adminName}
            maxLength={ADMIN_NAME_MAX}
            onChange={(e) => setAdminName(e.target.value)}
          />
          <TextField
            id="prov-admin-email"
            label="First admin email"
            required
            error={errors.adminEmail}
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </section>
        {outcome ? (
          <div className="flex flex-wrap items-center gap-3">
            <InlineAlert tone={outcome.ok ? "success" : "error"}>
              {outcome.ok
                ? "Provisioning requested. Open the tenant to follow its progress once it appears in the list."
                : outcome.message}
            </InlineAlert>
            {!outcome.ok && outcome.stepUp ? (
              <ReverifyLink
                onNavigate={() =>
                  stashDraft({
                    legalName,
                    billingEmail,
                    breachEmail,
                    adminEmail,
                    adminName,
                    slug,
                    plan,
                  })
                }
              />
            ) : null}
          </div>
        ) : null}
        <div className="wx-drawer-actions">
          <Button type="submit" disabled={busy || accepted}>
            {busy ? "Requesting…" : accepted ? "Requested" : "Provision tenant"}
          </Button>
          <Button tone="secondary" onClick={onClose}>
            {accepted ? "Close" : "Cancel"}
          </Button>
        </div>
      </form>
    </aside>
  );
}
