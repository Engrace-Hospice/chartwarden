import {
  Button,
  Glyph,
  InlineAlert,
  ReverifyLink,
  SelectField,
  TextField,
  isStepUpRequired,
  useApiClient,
  useDrawerA11y,
} from "@wardenx/ui";
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
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Re-verify leaves the page, so the typed values ride through sessionStorage and are restored once, on return.
const DRAFT_KEY = "wx-tenant-provision-draft";

interface Draft {
  legalName: string;
  billingEmail: string;
  breachEmail: string;
  adminEmail: string;
  adminName: string;
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

type Outcome = { ok: true } | { ok: false; message: string; stepUp: boolean };

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
  const [plan, setPlan] = useState<PlanLabel>(draft?.plan ?? "standard");
  const [busy, setBusy] = useState(false);
  // Provisioning is queued, not instant, so the tenant is not in the list yet; locking the form after acceptance stops
  // a second click from enqueueing a duplicate `tenant.provision`.
  const [accepted, setAccepted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const name = legalName.trim();
  const valid =
    name.length >= NAME_MIN &&
    name.length <= NAME_MAX &&
    EMAIL_SHAPE.test(billingEmail.trim()) &&
    EMAIL_SHAPE.test(breachEmail.trim()) &&
    EMAIL_SHAPE.test(adminEmail.trim()) &&
    adminName.trim().length > 0;

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!valid || busy || accepted) return;
    setBusy(true);
    setOutcome(null);
    const { error } = await client.POST("/api/v1/platform/tenants", {
      body: {
        legalBusinessName: name,
        billingContactEmail: billingEmail.trim(),
        breachNotificationContactEmail: breachEmail.trim(),
        firstAdminEmail: adminEmail.trim(),
        firstAdminFullName: adminName.trim(),
        planLabel: plan,
      },
    });
    setBusy(false);
    if (error) {
      setOutcome({
        ok: false,
        stepUp: isStepUpRequired(error),
        message: isStepUpRequired(error)
          ? "Confirm it’s you before provisioning a tenant."
          : "Could not request provisioning. Check the details and try again.",
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
      <form className="wx-drawer-body" onSubmit={(e) => void submit(e)}>
        <section className="wx-drawer-card">
          <TextField
            id="prov-legal-name"
            label="Legal business name"
            value={legalName}
            maxLength={NAME_MAX}
            onChange={(e) => setLegalName(e.target.value)}
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
            type="email"
            value={billingEmail}
            onChange={(e) => setBillingEmail(e.target.value)}
          />
          <TextField
            id="prov-breach-email"
            label="Breach notification email"
            type="email"
            value={breachEmail}
            onChange={(e) => setBreachEmail(e.target.value)}
          />
        </section>
        <section className="wx-drawer-card">
          <TextField
            id="prov-admin-name"
            label="First admin full name"
            value={adminName}
            maxLength={ADMIN_NAME_MAX}
            onChange={(e) => setAdminName(e.target.value)}
          />
          <TextField
            id="prov-admin-email"
            label="First admin email"
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </section>
        {outcome ? (
          <div className="flex flex-wrap items-center gap-3">
            <InlineAlert tone={outcome.ok ? "success" : "error"}>
              {outcome.ok
                ? "Provisioning requested. The tenant appears in the list once it has been created."
                : outcome.message}
            </InlineAlert>
            {!outcome.ok && outcome.stepUp ? (
              <ReverifyLink
                onNavigate={() =>
                  stashDraft({ legalName, billingEmail, breachEmail, adminEmail, adminName, plan })
                }
              />
            ) : null}
          </div>
        ) : null}
        <div className="wx-drawer-actions">
          <Button type="submit" disabled={!valid || busy || accepted}>
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
