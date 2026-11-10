// apps/web/src/modules/34-saas/wizard — step 8, Billing: MAC credentials, on the tenant's side. The Medicare submitter credential the
// organization's claims go out under: add it, replace it (the replacement is pinned to the version the member read: If-Match, an integer; a
// first create carries none), and test it against the MAC portal. The client secret is write-only: sealed under the organization's own
// key, never returned, never shown, never stashed through a Re-verify. Every write needs a fresh step-up and one Idempotency-Key per intent.
// A tenant that does not bill Medicare through ChartWarden skips the step through the frame ("This does not apply to us").
import {
  Button,
  FactList,
  InlineAlert,
  LoadingSpinner,
  type operations,
  stashStepUpMemoryDraft,
  useApiClient,
  useLoad,
  useOpsWrite,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { BILLING_ERROR_COPY, isAboutAnInput, isStalePin } from "./billing-errors";
import { bodyFingerprint } from "./body-fingerprint";
import { useEditorFocus } from "./editor-focus";
import {
  BLANK_MAC_FORM,
  type EntityOption,
  JURISDICTIONS,
  MacCredentialForm,
  type MacErrors,
  type MacForm,
  validateMac,
} from "./mac-credential-form";
import type { Credential } from "./mac-credential-table";
import { MacCredentialTable } from "./mac-credential-table";
import { type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { SkipEntry } from "./skip-entry";
import { StaleDataNotice } from "./stale-data-notice";
import { WriteFailureNotice } from "./write-failure";

type CredentialPage =
  operations["getApiV1BillingMaccredentials"]["responses"][200]["content"]["application/json"];
type EntityPage =
  operations["getApiV1Providerentities"]["responses"][200]["content"]["application/json"];

const LIST = "/api/v1/billing/mac-credentials";
const TEST = "/api/v1/billing/mac-credentials/{providerEntityId}/test";
const READ_KEY = "billing.mac_credential.read";
const ADMIN_KEY = "billing.mac_credential.admin";
const DRAFT_KEY = "wizard:mac_configured:credential";
const PAGE_LIMIT = 100;

interface Draft {
  readonly form: MacForm;
  /** The version the member read when the editor opened (null: a first credential). Sent from here, never re-read. */
  readonly pinnedVersion: number | null;
}
interface TestResult {
  readonly providerEntityId: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function MacPanel(props: StepPanelProps): JSX.Element {
  if (!props.held.has(READ_KEY)) {
    return (
      <section className="wx-drawer-card" aria-label="MAC credentials">
        <div className="wx-drawer-card-head">
          <h3>MAC credentials</h3>
        </div>
        <InlineAlert tone="info">
          Your role cannot view the MAC credentials. Ask your administrator.
        </InlineAlert>
        <SkipEntry skip={props.skip} heading="Not billing Medicare through ChartWarden?">
          If your organization does not send Medicare claims through ChartWarden, you can skip this
          step.
        </SkipEntry>
      </section>
    );
  }
  return <MacBody {...props} />;
}

function MacBody({ step, view, held, onChanged, skip }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const entities = useLoad<EntityPage>(
    "mac-entities",
    () => client.GET("/api/v1/provider-entities", { params: { query: { limit: PAGE_LIMIT } } }),
    BILLING_ERROR_COPY,
  );
  const credentials = useLoad<CredentialPage>(
    "mac-credentials",
    () => client.GET(LIST, { params: { query: { limit: PAGE_LIMIT } } }),
    BILLING_ERROR_COPY,
  );
  const restored = useStepUpMemoryDraft<Draft>(DRAFT_KEY);
  const [editing, setEditing] = useState<{ pinnedVersion: number | null } | null>(
    restored ? { pinnedVersion: restored.pinnedVersion } : null,
  );
  const [form, setForm] = useState<MacForm>(restored?.form ?? BLANK_MAC_FORM);
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<MacErrors>({});
  const [tested, setTested] = useState<TestResult | null>(null);
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const probe = useOpsWrite(BILLING_ERROR_COPY);

  const canWrite = held.has(ADMIN_KEY) && isStepOpenForWork(view, step);
  const entityList: EntityOption[] = entities.data?.items ?? [];
  const items: Credential[] = credentials.data?.items ?? [];
  const nameOf = (id: string): string => entityList.find((e) => e.id === id)?.legalName ?? id;
  const editorOpen = editing !== null && canWrite && !entities.loading;
  const editorHeading = useEditorFocus(editorOpen, "mac");

  function open(existing: Credential | null): void {
    write.clear();
    setErrors({});
    setSecret("");
    setForm(
      existing
        ? {
            providerEntityId: existing.providerEntityId,
            macJurisdiction:
              JURISDICTIONS.find((j) => j.value === existing.macJurisdiction)?.value ??
              BLANK_MAC_FORM.macJurisdiction,
            submitterId: existing.submitterId,
            tradingPartnerId: existing.tradingPartnerId,
            clientId: existing.clientId,
            baaRecordRef: existing.baaRecordRef ?? "",
          }
        : {
            ...BLANK_MAC_FORM,
            providerEntityId: entityList.length === 1 ? (entityList[0]?.id ?? "") : "",
          },
    );
    setEditing({ pinnedVersion: existing?.version ?? null });
  }

  function close(): void {
    setEditing(null);
    setSecret("");
  }

  async function save(): Promise<void> {
    if (!editing) return;
    write.clear();
    const found = validateMac(form, secret);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = {
      providerEntityId: form.providerEntityId,
      macJurisdiction: form.macJurisdiction,
      submitterId: form.submitterId.trim(),
      tradingPartnerId: form.tradingPartnerId.trim(),
      clientId: form.clientId.trim(),
      clientSecret: secret,
      ...(form.baaRecordRef.trim() ? { baaRecordRef: form.baaRecordRef.trim() } : {}),
    };
    const pinned = editing.pinnedVersion;
    // a digest, not the body: the client secret is in it and is never held outside its input
    const fingerprint = `save:${pinned ?? "new"}:${await bodyFingerprint(body)}`;
    const outcome = await write.run(
      fingerprint,
      (key) =>
        client.POST(LIST, {
          body,
          headers: {
            "Idempotency-Key": key,
            ...(pinned !== null ? { "If-Match": String(pinned) } : {}),
          },
        }),
      async () => {
        await Promise.all([credentials.reload(true), onChanged()]);
        close();
      },
    );
    if (!outcome.ok && isStalePin(outcome.failure)) {
      // Changed since it was read (409 STALE_VERSION), or no pin was sent (428): the form's pin is stale, so it closes, the list is read
      // again, and the member opens the form on what it says now and enters the secret again.
      close();
      await credentials.reload(true);
    }
  }

  async function test(providerEntityId: string): Promise<void> {
    setTested(null);
    probe.clear();
    const outcome = await probe.run(`test:${providerEntityId}`, (key) =>
      client.POST(TEST, {
        params: { path: { providerEntityId } },
        headers: { "Idempotency-Key": key },
      }),
    );
    if (!outcome.ok) return;
    setTested({ providerEntityId, ok: outcome.data.ok, detail: outcome.data.detail });
    await credentials.reload(true);
  }

  const failure = write.failure;
  const creating = editing !== null && editing.pinnedVersion === null;
  const noEntities = entities.data !== null && entityList.length === 0;
  const lastTested = items.some((c) => c.lastSandboxTestAt !== null);

  return (
    <>
      <section className="wx-drawer-card" aria-label="MAC credentials">
        <div className="wx-drawer-card-head">
          <h3>MAC credentials</h3>
          {canWrite && !editing && !noEntities && items.length === 0 && !credentials.failure ? (
            <Button size="sm" tone="secondary" data-editor-return="mac" onClick={() => open(null)}>
              Add MAC credential
            </Button>
          ) : null}
        </div>
        <p className="wx-row-sub">
          The Medicare submitter credential your claims go out under. Mark this step done once it is
          on file and has passed a test.
        </p>
        <FactList
          ariaLabel="What settles this step"
          facts={[
            {
              key: "one",
              label: "A MAC credential is on file",
              state: items.length > 0 ? "ok" : "pending",
            },
            {
              key: "tested",
              label: "The credential has passed a test against the MAC portal",
              state: lastTested ? "ok" : "pending",
            },
          ]}
        />
        {credentials.loading && !credentials.data ? (
          <LoadingSpinner label="Loading the MAC credentials" />
        ) : null}
        {credentials.failure ? (
          <div className="wx-form-stack">
            <InlineAlert tone="error">
              Could not load the MAC credentials. {credentials.failure.message}
            </InlineAlert>
            <div>
              <Button size="sm" tone="secondary" onClick={() => void credentials.reload()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
        <StaleDataNotice stale={credentials.stale} onReload={() => void credentials.reload()} />
        {noEntities ? <p>Add a provider entity first: a credential belongs to one.</p> : null}
        {entities.failure && canWrite ? (
          <InlineAlert tone="error">
            Could not load your provider entities, so a credential cannot be added right now.{" "}
            {entities.failure.message}
          </InlineAlert>
        ) : null}
        {credentials.data && items.length === 0 && !noEntities ? (
          <p>No MAC credential yet.</p>
        ) : null}
        {items.length > 0 ? (
          <MacCredentialTable
            items={items}
            nameOf={nameOf}
            canWrite={canWrite}
            testing={probe.busy}
            onReplace={open}
            onTest={(id) => void test(id)}
          />
        ) : null}
        {tested ? (
          <InlineAlert tone={tested.ok ? "success" : "error"}>
            {tested.ok ? "The MAC portal answered. " : "The MAC portal test did not pass. "}
            {tested.detail}
          </InlineAlert>
        ) : null}
        {probe.failure ? <WriteFailureNotice failure={probe.failure} /> : null}
      </section>

      {/* A refusal that closed the form (a stale pin) is still read here, under the list, not in a form that is gone. */}
      {failure && !editing && !isAboutAnInput(failure) ? (
        <WriteFailureNotice failure={failure} />
      ) : null}

      {editorOpen && editing ? (
        <MacCredentialForm
          form={form}
          secret={secret}
          errors={{ ...failure?.fieldErrors, ...errors }}
          entities={entityList}
          creating={creating}
          busy={write.busy}
          headingRef={editorHeading}
          failure={
            failure && !isAboutAnInput(failure) ? (
              <WriteFailureNotice
                failure={failure}
                onReverify={() =>
                  stashStepUpMemoryDraft<Draft>(DRAFT_KEY, {
                    form,
                    pinnedVersion: editing.pinnedVersion,
                  })
                }
              />
            ) : null
          }
          onChange={(next) => {
            setForm(next);
            setErrors({});
          }}
          onSecret={setSecret}
          onCancel={() => {
            close();
            write.clear();
          }}
          onSubmit={() => void save()}
        />
      ) : null}

      <SkipEntry skip={skip} heading="Not billing Medicare through ChartWarden?">
        If your organization does not send Medicare claims through ChartWarden, you can skip this
        step.
      </SkipEntry>
    </>
  );
}
