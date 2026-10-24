// M36 WP 6.7 (ADR-0099 D6, D9, D18, PROPOSED) - the staff "Family" lane: the people the patient has agreed may write to the care team without an app, with consent,
// link state, how long a message has waited, and the high-volume / closed / blocked chips. Selecting a row opens its thread in a flat right-hand drawer. Holders
// of messaging.family.manage also see Invite and Settings; the rest of the manage actions live in the drawer. The tenant flag gates creating an invitation and
// replying only (the backend answers 404), so the list, revoke, close and block keep working when it is off and the screen says so calmly.
import {
  type CreatedFamilyInvitationDto,
  FAMILY_MANAGE_PERMISSION,
  FAMILY_MESSAGING_FLAG_KEY,
  FAMILY_RESPOND_PERMISSION,
} from "@chartwarden/types";
import { Button, EmptyState, PageHeader, useFeatureFlag } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { FamilyGate } from "./family-failure";
import { FamilyInviteDialog } from "./family-invite";
import { FamilyRow } from "./family-row";
import { FamilySecrets } from "./family-secrets";
import { FamilySettingsPanel } from "./family-settings";
import { ft } from "./family-text";
import { FamilyThreadDrawer } from "./family-thread";
import { useFamilyContacts } from "./use-family";
import "./export.css";
import "./family.css";

function useFlag(key: string): boolean {
  try {
    return useFeatureFlag(key);
  } catch {
    return false; // no provider mounted: fail closed
  }
}

export function FamilyLane(): JSX.Element {
  const { view, reload, refreshFailed } = useFamilyContacts();
  const permissions = useSession()?.permissions ?? [];
  const canManage = permissions.includes(FAMILY_MANAGE_PERMISSION);
  const canRespond = permissions.includes(FAMILY_RESPOND_PERMISSION);
  const flagOn = useFlag(FAMILY_MESSAGING_FLAG_KEY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [made, setMade] = useState<CreatedFamilyInvitationDto | null>(null);
  const [message, setMessage] = useState<{ text: string | null; seq: number }>({
    text: null,
    seq: 0,
  });
  const listRef = useRef<HTMLUListElement>(null);
  const say = (text: string | null): void => setMessage((m) => ({ text, seq: m.seq + 1 }));
  const now = Date.now();

  return (
    <>
      <PageHeader title={ft("family.lane.title")} breadcrumb={ft("family.lane.breadcrumb")}>
        <p className="wx-export-detail">{ft("family.lane.intro")}</p>
        {canManage ? (
          <div className="wx-export-actions">
            <Button
              type="button"
              tone="primary"
              disabled={!flagOn}
              onClick={() => setInviting(true)}
            >
              {ft("family.manage.invite")}
            </Button>
            <Button type="button" tone="secondary" onClick={() => setSettingsOpen(true)}>
              {ft("family.manage.settings")}
            </Button>
          </div>
        ) : null}
      </PageHeader>
      <section className="wx-export wx-family" aria-label={ft("family.lane.title")}>
        {flagOn ? null : (
          <div className="wx-export-notice" role="note">
            <p>{ft("family.lane.notOn")}</p>
            <p className="wx-export-detail">{ft("family.lane.notOn.detail")}</p>
          </div>
        )}
        <output key={message.seq} className="wx-export-status" aria-live="polite">
          {message.text}
        </output>
        {refreshFailed && view.status === "ready" ? (
          <div className="wx-export-error" role="alert">
            <p>{ft("family.lane.loadFailed")}</p>
            <Button type="button" tone="secondary" size="lg" onClick={reload}>
              {ft("family.lane.retry")}
            </Button>
          </div>
        ) : null}
        <FamilyGate
          view={view}
          retry={reload}
          failedText={ft("family.lane.loadFailed")}
          deniedText={ft("family.lane.denied")}
        >
          {(contacts) => {
            const selected = contacts.find((c) => c.contactId === selectedId) ?? null;
            return contacts.length === 0 ? (
              <EmptyState
                title={ft("family.lane.empty.title")}
                description={ft("family.lane.empty.text")}
              />
            ) : (
              <div className="wx-family-layout" data-open={selected ? "true" : undefined}>
                <ul
                  ref={listRef}
                  tabIndex={-1}
                  className="wx-export-rows"
                  aria-label={ft("family.lane.list")}
                >
                  {contacts.map((c) => (
                    <FamilyRow
                      key={c.contactId}
                      contact={c}
                      selected={c.contactId === selectedId}
                      now={now}
                      onSelect={setSelectedId}
                    />
                  ))}
                </ul>
                {selected ? (
                  <FamilyThreadDrawer
                    key={selected.contactId}
                    contact={selected}
                    canManage={canManage}
                    canReply={canRespond && flagOn}
                    onClose={() => {
                      setSelectedId(null);
                      listRef.current?.focus();
                    }}
                    onChanged={(text) => {
                      say(text);
                      reload();
                    }}
                  />
                ) : null}
              </div>
            );
          }}
        </FamilyGate>
      </section>
      {inviting ? (
        <FamilyInviteDialog
          flagOn={flagOn}
          onCancel={() => setInviting(false)}
          onOpenSettings={() => {
            setInviting(false);
            setSettingsOpen(true);
          }}
          onCreated={(dto) => {
            setMade(dto); // the secrets come back exactly once: surface them whatever happens to the dialog
            setInviting(false);
            reload();
          }}
        />
      ) : null}
      {settingsOpen ? <FamilySettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      {made ? (
        <FamilySecrets
          made={made}
          onDone={() => {
            setMade(null);
            say(ft("family.secrets.gone"));
          }}
        />
      ) : null}
    </>
  );
}
