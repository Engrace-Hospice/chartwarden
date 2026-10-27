// apps/web/src/modules/41-billing-commercial — the shared frame of the per-claim read screens (send gate, timeline; issue #822): one read of
// one claim keyed by its id, a loading status, a not-found state (404) and a retryable error, and the page head with a way back to the
// claim. A failed read is never rendered as an empty or passing result.
import { Button, EmptyState, LoadingSpinner } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { COMMERCIAL_PATHS } from "./commercial-model";

type Load<T> =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly data: T };

export interface ClaimRead<T> {
  readonly data?: T | undefined;
  readonly response: { readonly status: number };
}

interface Props<T> {
  readonly title: string;
  readonly description: string;
  readonly read: (claimId: string) => Promise<ClaimRead<T>>;
  readonly children: (data: T) => ReactNode;
}

/** Keyed by claim id so moving between claims starts clean (no stale rows from another claim). */
export function ClaimSubpage<T>(props: Props<T>): JSX.Element {
  const { claimId = "" } = useParams();
  return <ClaimSubpageView key={claimId} claimId={claimId} {...props} />;
}

function ClaimSubpageView<T>({
  claimId,
  title,
  description,
  read,
  children,
}: Props<T> & { claimId: string }): JSX.Element {
  const [load, setLoad] = useState<Load<T>>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger; `read` is a stable module-level call per screen.
  useEffect(() => {
    let active = true;
    read(claimId)
      .then(({ data, response }) => {
        if (!active) return;
        if (data) setLoad({ status: "ready", data });
        else setLoad({ status: response.status === 404 ? "missing" : "error" });
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [claimId, reloadKey]);

  if (load.status === "loading") {
    return (
      <output className="wx-list-state" aria-live="polite">
        <LoadingSpinner />
      </output>
    );
  }
  if (load.status !== "ready") {
    return (
      <div className="wx-list-state" role="alert">
        <h1 className="wx-sr-only">{title}</h1>
        <EmptyState
          title={load.status === "missing" ? "Claim not found" : `${title} unavailable`}
          description={
            load.status === "missing"
              ? "This commercial claim does not exist, or it is outside your scope."
              : `The ${title.toLowerCase()} could not be loaded.`
          }
        />
        {load.status === "error" ? <Button onClick={retry}>Try again</Button> : null}
        <Link to={COMMERCIAL_PATHS.queue} className="wx-btn-secondary">
          Back to the claim queue
        </Link>
      </div>
    );
  }
  return (
    <div className="wx-with-rail-main">
      <header className="wx-page-head">
        <div>
          <p className="wx-row-sub">
            <Link to={COMMERCIAL_PATHS.queue}>Commercial claims</Link> /{" "}
            <Link to={COMMERCIAL_PATHS.claim(claimId)}>Claim</Link> / {title}
          </p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      <BillingTabs />
      {children(load.data)}
    </div>
  );
}
