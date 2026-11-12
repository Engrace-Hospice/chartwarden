// apps/web/src/modules/34-saas/wizard — step 8, Billing: MAC credentials, on the tenant's side. The Medicare submitter credential the
// organization's claims go out under: add it (for each provider entity that has none), replace it (pinned to the version the member
// read), and check that the MAC portal for its jurisdiction answers. That check does NOT check the credential itself, and nothing on this
// panel says it does. The client secret is write-only: sealed under the organization's own key, never returned, shown or stashed. Every
// write needs a fresh step-up, carries one Idempotency-Key per intent, and (the save, not the check) voids a pending go-live attestation.
// A tenant that does not bill Medicare through ChartWarden skips the step through the frame, which this panel only hints at.
import {
  InlineAlert,
  PendingAttestationWarning,
  type operations,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import { useCallback } from "react";
import type { JSX } from "react";
import { useDraftScope } from "./billing-drafts";
import { BILLING_ERROR_COPY } from "./billing-errors";
import { BillingFailureNotice } from "./billing-failure-notice";
import { MacCredentialForm } from "./mac-credential-form";
import { MacListSection, PAGE_LIMIT } from "./mac-list-section";
import { type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { StatusLine, usePanelStatus } from "./panel-status";
import { SkipHint } from "./skip-entry";
import { useMacCheck } from "./use-mac-check";
import { useMacEditor } from "./use-mac-editor";

type CredentialPage =
  operations["getApiV1BillingMaccredentials"]["responses"][200]["content"]["application/json"];
type EntityPage =
  operations["getApiV1Providerentities"]["responses"][200]["content"]["application/json"];

const LIST = "/api/v1/billing/mac-credentials";
const READ_KEY = "billing.mac_credential.read";
const ADMIN_KEY = "billing.mac_credential.admin";
/** Neutral until the provider entities load: never the raw id, which is neither a name nor something to read out. */
const UNKNOWN_ENTITY = "A provider entity";

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
        <SkipHint skip={props.skip} />
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
  const scope = useDraftScope();
  const status = usePanelStatus();
  const { reload } = credentials;
  const reloadBoth = useCallback(async (): Promise<void> => {
    try {
      await Promise.all([reload(true), onChanged()]);
    } catch {
      // nothing to add: a failed quiet reload already raised `stale`
    }
  }, [reload, onChanged]);

  const entityList = entities.data?.items ?? [];
  const items = credentials.data?.items ?? [];
  const nameOf = (id: string): string =>
    entityList.find((e) => e.id === id)?.legalName ?? UNKNOWN_ENTITY;
  const canWrite = held.has(ADMIN_KEY) && isStepOpenForWork(view, step);
  const check = useMacCheck({
    nameOf,
    announce: status.announce,
    reload: () => reload(true),
  });
  const editor = useMacEditor({
    canWrite,
    stepKey: step.key,
    scope,
    announce: status.announce,
    onSaved: reloadBoth,
    onMoved: reloadBoth,
  });

  // A provider entity holds one credential: Add offers the entities that have none, Replace the one that has.
  const withoutCredential = entityList.filter(
    (e) => !items.some((c) => c.providerEntityId === e.id),
  );
  // An editor open, a save running or a portal check running: the others wait, so none bumps the version the editor is pinned to.
  const locked = editor.editing !== null || editor.busy || check.busy;
  const only = withoutCredential.length === 1 ? (withoutCredential[0]?.id ?? null) : null;
  const listsLoaded = credentials.data !== null && entities.data !== null;

  return (
    <>
      <StatusLine control={status} />
      <MacListSection
        credentials={credentials}
        entities={entities}
        nameOf={nameOf}
        canWrite={canWrite}
        locked={locked}
        canAdd={canWrite && listsLoaded && withoutCredential.length > 0}
        onAdd={() => editor.open(null, only)}
        onReplace={(c) => editor.open(c, null)}
        onCheck={(id) => void check.check(id)}
        checkFailure={check.failure}
        extra={check.notice}
      />

      {editor.failure && !editor.editing && !editor.failureBesideInput ? (
        <BillingFailureNotice failure={editor.failure} />
      ) : null}

      {editor.editing !== null && canWrite && !entities.loading ? (
        <MacCredentialForm
          form={editor.form}
          secret={editor.secret}
          errors={editor.errors}
          entities={editor.creating ? withoutCredential : entityList}
          creating={editor.creating}
          busy={editor.busy}
          locked={check.busy}
          headingRef={editor.headingRef}
          warning={<PendingAttestationWarning view={view} audience="tenant" />}
          failure={
            editor.failure && !editor.failureBesideInput ? (
              <BillingFailureNotice failure={editor.failure} onReverify={editor.reverify} />
            ) : null
          }
          onChange={editor.change}
          onSecret={editor.setSecret}
          onCancel={editor.close}
          onSubmit={() => void editor.save()}
        />
      ) : null}
      {editor.notice}

      <SkipHint skip={skip} />
    </>
  );
}
