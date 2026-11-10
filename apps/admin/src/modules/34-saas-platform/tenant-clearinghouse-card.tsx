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
  isStepUpReturn,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { NoticeFilingsDrawer } from "./notice-filings-drawer";
import { VerifyBaa } from "./onboarding/clearinghouse-baa-verify";
import { MODE_LABEL, VENDOR_LABEL, isTransmitting } from "./onboarding/clearinghouse-model";
import type { ClearinghouseView } from "./onboarding/clearinghouse-model";
import { ReleaseCredentials } from "./onboarding/clearinghouse-release";
import { SwitchToVendor } from "./onboarding/clearinghouse-switch";
import { ContractModeBanner } from "./onboarding/contract-mode-banner";
import { ModeUnconfirmedNotice } from "./onboarding/mode-unconfirmed-notice";
import { releaseDraftKey } from "./onboarding/permissions";
import { useLoad } from "./onboarding/use-load";
import { isOnboardingOpen } from "./onboarding/wizard-model";
import { cap } from "./saas-status";
import { useReveal } from "./use-reveal";

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  verified: "progress",
  active: "success",
};

function Body({
  orgSlug,
  tenantStatus,
  onOpenFilings,
  restoredReason,
  returnedFromStepUp,
}: {
  orgSlug: string;
  tenantStatus: string;
  onOpenFilings: () => void;
  restoredReason: string | undefined;
  returnedFromStepUp: boolean;
}): JSX.Element {
  const client = useApiClient();
  const [modeUnconfirmed, setModeUnconfirmed] = useState(false);
  // What the last release freed, reported outside the actions row; any next action on the card clears it.
  const [released, setReleased] = useState<number | null>(null);
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
      <div className="wx-drawer-actions" onClickCapture={() => setReleased(null)}>
        <SwitchToVendor
          orgSlug={orgSlug}
          view={view}
          tenantStatus={tenantStatus}
          returnedFromStepUp={returnedFromStepUp}
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
        <ReleaseCredentials
          orgSlug={orgSlug}
          view={view}
          onReleased={setReleased}
          restoredReason={restoredReason}
        />
        <Button tone="secondary" size="sm" onClick={onOpenFilings}>
          Notices filed outside ChartWarden
        </Button>
      </div>
      {/* always mounted, so a screen reader announces the text when it appears */}
      <output className="wx-row-sub" aria-live="polite">
        {released === null
          ? ""
          : released === 0
            ? "This tenant held no earlier credentials."
            : `Released ${released} earlier credential${released === 1 ? "" : "s"}.`}
      </output>
    </>
  );
}

export function TenantClearinghouseCard({
  orgSlug,
  tenantStatus,
}: { orgSlug: string; tenantStatus: string }): JSX.Element {
  // A Re-verify from the release dialog comes back to the card open (the dialog reopens with the typed reason). Only on that return:
  // every mount consumes the release draft, so a draft left behind (Back from /step-up) is dropped by the next visit and never opens
  // the card on a later, unrelated step-up return; the audited clearinghouse read never happens without a click.
  // The marker is read once, then cleared from history, so Back/Forward or a reload never re-asserts it.
  const location = useLocation();
  const navigate = useNavigate();
  const [returnedFromStepUp] = useState(() => isStepUpReturn(location.state));
  const draft = useStepUpMemoryDraft<{ reason: string }>(releaseDraftKey(orgSlug));
  const restoredReason = returnedFromStepUp ? draft?.reason : undefined;
  useEffect(() => {
    if (!isStepUpReturn(location.state)) return;
    const { pathname, search, hash } = location;
    navigate({ pathname, search, hash }, { replace: true, state: null });
  }, [location, navigate]);
  const reveal = useReveal(restoredReason !== undefined);
  const [filingsOpen, setFilingsOpen] = useState(false);
  return (
    <>
      <section className="wx-drawer-card" aria-label="Clearinghouse">
        <div className="wx-drawer-card-head">
          <h3>Clearinghouse</h3>
          <Button tone="secondary" size="sm" {...reveal.toggleProps} onClick={reveal.onToggle}>
            Show clearinghouse
          </Button>
        </div>
        {reveal.mounted ? (
          <div id={reveal.sectionId} hidden={!reveal.open}>
            <Body
              orgSlug={orgSlug}
              tenantStatus={tenantStatus}
              onOpenFilings={() => setFilingsOpen(true)}
              restoredReason={restoredReason}
              returnedFromStepUp={returnedFromStepUp}
            />
          </div>
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
