// apps/admin/src/modules/34-saas-platform — the tenant hub's clearinghouse card: which clearinghouse the tenant uses and how far it got,
// the banner when a vendor is chosen but the contract's billing mode is still None, and the way into the notices the tenant recorded as
// "filed outside ChartWarden" (where an operator can withdraw a wrong record). Read on request, like the contract: every read of a tenant's
// billing setup is audited, so a visit to the hub does not make one.
import {
  Button,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { NoticeFilingsDrawer } from "./notice-filings-drawer";
import { VerifyBaa } from "./onboarding/clearinghouse-baa-verify";
import { MODE_LABEL, VENDOR_LABEL, isTransmitting } from "./onboarding/clearinghouse-model";
import type { ClearinghouseView } from "./onboarding/clearinghouse-model";
import { SwitchToVendor } from "./onboarding/clearinghouse-switch";
import { ContractModeBanner } from "./onboarding/contract-mode-banner";
import { ModeUnconfirmedNotice } from "./onboarding/mode-unconfirmed-notice";
import { useLoad } from "./onboarding/use-load";
import { isOnboardingOpen } from "./onboarding/wizard-model";
import { cap } from "./saas-status";

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  verified: "progress",
  active: "success",
};

function Body({
  orgSlug,
  tenantStatus,
  onOpenFilings,
}: { orgSlug: string; tenantStatus: string; onOpenFilings: () => void }): JSX.Element {
  const client = useApiClient();
  const [modeUnconfirmed, setModeUnconfirmed] = useState(false);
  const load = useLoad<ClearinghouseView>(`hub-clearinghouse:${orgSlug}`, () =>
    client.GET("/api/v1/platform/tenants/{orgSlug}/clearinghouse", {
      params: { path: { orgSlug } },
    }),
  );
  if (load.failure) {
    return (
      <>
        <InlineAlert tone="error">Could not load the clearinghouse.</InlineAlert>
        <Button tone="secondary" size="sm" onClick={() => void load.reload()}>
          Try again
        </Button>
      </>
    );
  }
  const view = load.data;
  if (!view) return <LoadingSpinner label="Loading the clearinghouse…" />;
  const chosen = view.vendor !== null && view.source === "tenant";
  const vendor = view.vendor ?? "";
  return (
    <>
      {modeUnconfirmed ? <ModeUnconfirmedNotice orgSlug={orgSlug} /> : null}
      {chosen && isTransmitting(view) ? <ContractModeBanner orgSlug={orgSlug} /> : null}
      {chosen ? (
        <dl className="wx-kv">
          <dt>Clearinghouse</dt>
          <dd>{VENDOR_LABEL[vendor] ?? vendor}</dd>
          {view.mode ? (
            <>
              <dt>Mode</dt>
              <dd>{MODE_LABEL[view.mode]}</dd>
            </>
          ) : null}
          {isTransmitting(view) && view.status ? (
            <>
              <dt>Status</dt>
              <dd>
                <StatusPill label={cap(view.status)} tone={STATUS_TONE[view.status] ?? "neutral"} />
              </dd>
              <dt>Credential</dt>
              <dd>{view.hasSecret ? "Secret on file" : "None"}</dd>
              <dt>Vendor BAA</dt>
              <dd>
                {view.baa
                  ? `${view.baa.documentRef}${view.baa.verified ? "" : " (not verified yet)"}`
                  : "The tenant has not recorded one"}
              </dd>
            </>
          ) : null}
        </dl>
      ) : isOnboardingOpen(tenantStatus) ? (
        <p>
          No clearinghouse is chosen yet.{" "}
          <Link to={`/tenants/${encodeURIComponent(orgSlug)}/onboarding/clearinghouse_selected`}>
            Open the clearinghouse step
          </Link>
          .
        </p>
      ) : tenantStatus === "provisioning" ? (
        // The wizard's steps open when provisioning finishes, so a link there is a dead end too.
        <p>
          No clearinghouse is chosen yet. The clearinghouse step opens when provisioning finishes.
        </p>
      ) : (
        // The wizard's step is read-only once onboarding is closed, so a link there is a dead end.
        <p>
          No clearinghouse is chosen yet. Onboarding is closed for this tenant, so its billing admin
          chooses one from the tenant side.
        </p>
      )}
      {chosen && !isTransmitting(view) ? (
        <p className="wx-row-sub">
          ChartWarden transmits nothing for this tenant: it files its own notices and claims.
        </p>
      ) : null}
      <div className="wx-drawer-actions">
        <SwitchToVendor
          orgSlug={orgSlug}
          view={view}
          tenantStatus={tenantStatus}
          reload={() => load.reload(true)}
          onSwitched={async (modeConfirmed) => {
            setModeUnconfirmed(!modeConfirmed);
            await load.reload(true);
          }}
        />
        {chosen ? (
          <VerifyBaa
            orgSlug={orgSlug}
            view={view}
            reload={() => load.reload(true)}
            onVerified={() => load.reload(true)}
          />
        ) : null}
        <Button tone="secondary" size="sm" onClick={onOpenFilings}>
          Notices filed outside ChartWarden
        </Button>
      </div>
    </>
  );
}

export function TenantClearinghouseCard({
  orgSlug,
  tenantStatus,
}: { orgSlug: string; tenantStatus: string }): JSX.Element {
  const [shown, setShown] = useState(false);
  const [filingsOpen, setFilingsOpen] = useState(false);
  return (
    <>
      <section className="wx-drawer-card" aria-label="Clearinghouse">
        <div className="wx-drawer-card-head">
          <h3>Clearinghouse</h3>
          {shown ? undefined : (
            <Button tone="secondary" size="sm" onClick={() => setShown(true)}>
              Show clearinghouse
            </Button>
          )}
        </div>
        {shown ? (
          <Body
            orgSlug={orgSlug}
            tenantStatus={tenantStatus}
            onOpenFilings={() => setFilingsOpen(true)}
          />
        ) : (
          <span className="wx-row-sub">
            Reading the clearinghouse and the contract's billing mode is recorded in the audit
            trail.
          </span>
        )}
      </section>
      {filingsOpen ? (
        <NoticeFilingsDrawer orgSlug={orgSlug} onClose={() => setFilingsOpen(false)} />
      ) : null}
    </>
  );
}
