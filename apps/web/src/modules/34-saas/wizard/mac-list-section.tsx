// apps/web/src/modules/34-saas/wizard — step 8's card: what the step needs, its facts, and the credentials on file (or why they could not
// be read). It draws; the panel decides what may be done (the editor and the portal check are the panel's).
import {
  Button,
  FactList,
  InlineAlert,
  type Loaded,
  LoadingSpinner,
  StaleNotice,
  type operations,
} from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { BillingFailureNotice } from "./billing-failure-notice";
import { type Credential, MacCredentialTable } from "./mac-credential-table";
import { macFactsOf } from "./mac-facts";
import type { forScope } from "./use-mac-editor";

type CredentialPage =
  operations["getApiV1BillingMaccredentials"]["responses"][200]["content"]["application/json"];
type EntityPage =
  operations["getApiV1Providerentities"]["responses"][200]["content"]["application/json"];

export const PAGE_LIMIT = 100;

export function MacListSection({
  credentials,
  entities,
  nameOf,
  canWrite,
  locked,
  canAdd,
  onAdd,
  onReplace,
  onCheck,
  checkFailure,
  extra,
}: {
  credentials: Loaded<CredentialPage>;
  entities: Loaded<EntityPage>;
  nameOf: (providerEntityId: string) => string;
  canWrite: boolean;
  /** An editor is open or a write is running: Replace and the check wait. */
  locked: boolean;
  /** Some provider entity has no credential yet, and the member may add one. */
  canAdd: boolean;
  onAdd: () => void;
  onReplace: (credential: Credential) => void;
  onCheck: (providerEntityId: string) => void;
  checkFailure: ReturnType<typeof forScope>;
  extra?: ReactNode;
}): JSX.Element {
  const items = credentials.data?.items ?? [];
  const entityCount = entities.data?.items.length ?? 0;
  const noEntities = entities.data !== null && entityCount === 0;
  const truncated = credentials.data?.hasMore === true || entities.data?.nextCursor != null;
  return (
    <section className="wx-drawer-card" aria-label="MAC credentials on this step">
      <div className="wx-drawer-card-head">
        <h3>MAC credentials</h3>
        {canAdd && !locked && !credentials.failure ? (
          <Button size="sm" tone="secondary" data-editor-return="mac" onClick={onAdd}>
            Add MAC credential
          </Button>
        ) : null}
      </div>
      <p className="wx-row-sub">
        The Medicare submitter credential your claims go out under, one for each provider entity.
        You can check that the MAC portal for its jurisdiction answers; that does not check the
        credential itself. Then mark this step done with evidence.
      </p>
      <FactList ariaLabel="What settles this step" facts={macFactsOf(items, nameOf)} />
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
      <StaleNotice stale={credentials.stale} onReload={() => void credentials.reload()} />
      {noEntities ? (
        <p className="wx-row-sub">Add a provider entity first: a credential belongs to one.</p>
      ) : null}
      {entities.failure && canWrite ? (
        <InlineAlert tone="error">
          Could not load your provider entities, so a credential cannot be added right now.{" "}
          {entities.failure.message}
        </InlineAlert>
      ) : null}
      {credentials.data && items.length === 0 && !noEntities ? (
        <p className="wx-row-sub">No MAC credential yet.</p>
      ) : null}
      {items.length > 0 ? (
        <MacCredentialTable
          items={items}
          nameOf={nameOf}
          canWrite={canWrite}
          locked={locked}
          onReplace={onReplace}
          onTest={onCheck}
        />
      ) : null}
      {truncated ? (
        <p className="wx-row-sub">
          Showing the first {PAGE_LIMIT}. Ask ChartWarden for help if the one you need is missing.
        </p>
      ) : null}
      {checkFailure ? <BillingFailureNotice failure={checkFailure} /> : null}
      {extra}
    </section>
  );
}
