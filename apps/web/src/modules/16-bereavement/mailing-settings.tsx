// apps/web/src/modules/16-bereavement — MAILING SETTINGS (ADR-0109 D10, routes 42-43). Bereavement oversight.
//
// The four mailings a tenant can configure: the quarterly newsletter, the December holiday card, Mother's Day and Father's Day. (The
// decedent-birthday mailing is deferred and never offered.) Reading the settings needs `bereavement.mailing.read`; changing them
// needs `bereavement.mailing.manage`, and a reader without it sees the settings read-only. A 403 on the read renders nothing.
// Each mailing is its own card with its own version, so saving one never overwrites another.
import { Button, LoadingSpinner, PageHeader, useApiClient } from "@chartwarden/ui";
import { useCallback } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import { type MailingConfig, listMailingConfigs } from "./bereavement-api";
import {
  ErrorText,
  Notice,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  useActionStatus,
} from "./bereavement-ui";
import { MailingConfigCard } from "./mailing-config-card";
import { useLoaded } from "./mailing-load";
import {
  CONFIGURABLE_MAILING_KEYS,
  MAILING_MANAGE_PERMISSION,
  mailingLabel,
} from "./mailing-status";

const CONFIGS_LOAD_FAILED = "The mailing settings could not be loaded.";

/** The mailings a tenant can configure, in the order the program lists them. */
const configurable = (configs: readonly MailingConfig[]): MailingConfig[] =>
  CONFIGURABLE_MAILING_KEYS.flatMap((key) => configs.filter((c) => c.mailingKey === key));

export function MailingSettings(): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const mayManage = session?.permissions?.includes(MAILING_MANAGE_PERMISSION) ?? false;
  const fetchConfigs = useCallback(async () => {
    const { configs, error, status } = await listMailingConfigs(client);
    return { data: configs, error, status };
  }, [client]);
  const { state, reload, patch } = useLoaded<MailingConfig[]>(fetchConfigs, CONFIGS_LOAD_FAILED);
  const { announce, region } = useActionStatus();

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the mailing settings" />;
  if (state.kind === "error") {
    return (
      <div className="wx-kit-column" style={columnStyle}>
        <ErrorText>{state.message}</ErrorText>
        <div>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const saved = (next: MailingConfig): void => {
    patch((prev) => prev.map((c) => (c.mailingKey === next.mailingKey ? next : c)));
    announce(`The ${mailingLabel(next.mailingKey)} settings were saved.`);
  };

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Mailing settings</span>}
        actions={
          <Link to="/bereavement/mailings" style={ghostButtonStyle}>
            Mailing runs
          </Link>
        }
      />
      <span style={mutedStyle}>
        A run is drafted automatically before each enabled mailing's date. The wording here is what
        a new run starts with; each run's wording can still be edited before it is generated.
      </span>
      {region}
      {state.notice ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{state.notice}</ErrorText>
          <Button
            size="sm"
            tone="secondary"
            loading={state.refreshing}
            onClick={() => void reload()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {mayManage ? null : (
        <Notice tone="info">You can read these settings but not change them.</Notice>
      )}
      {configurable(state.data).map((config) => (
        <MailingConfigCard
          key={`${config.mailingKey}:${config.version}`}
          config={config}
          readOnly={!mayManage}
          onSaved={saved}
          onReload={() => void reload()}
        />
      ))}
    </div>
  );
}
