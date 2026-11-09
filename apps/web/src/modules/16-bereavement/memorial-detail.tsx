// apps/web/src/modules/16-bereavement — ONE MEMORIAL SERVICE (ADR-0109 D10, routes 69-73). Oversight edits, publishes and closes it:
//
//  1. PUBLISH invites, set-based: every family eligible at that moment gets an invitation, and an invitation MAILING RUN is drafted for the
//     families who receive post. No default wording ships: staff write the invitation on that run's page (linked here once it exists).
//  2. THE HEADER DECIDES THE VERSION. Every write carries the version the page READ in `If-Match` and one `Idempotency-Key` per attempt;
//     a 409 reloads the service, closes the dialog and says why.
//  3. A 403 renders nothing; any other failure is announced and never unmounts what is on screen.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { errorMessage, isStaleVersion, isStaleWrite } from "./bereavement-api";
import { dateTime, humanize, shortDate, toneOf } from "./bereavement-status";
import {
  Card,
  CountGrid,
  ErrorText,
  Field,
  Modal,
  SummaryGrid,
  columnStyle,
  dangerButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  useActionStatus,
  useIdempotencyKey,
} from "./bereavement-ui";
import { useLoaded } from "./mailing-load";
import { MemorialFormModal } from "./memorial-form-modal";
import { MemorialInvitations } from "./memorial-invitations";
import {
  MEMORIAL_MANAGE_PERMISSION,
  MEMORIAL_STATUS_TONE,
  canEditMemorial,
  holds,
} from "./program-status";
import { type Memorial, closeMemorial, getMemorial, publishMemorial } from "./programs-api";

const LOAD_FAILED = "The memorial service could not be loaded.";
const MOVED =
  "This service changed while you were working on it. The page has been refreshed: check it and try again.";

type Ceremony = "edit" | "publish" | "held" | "cancelled" | null;

export function MemorialServiceDetail(): JSX.Element | null {
  const { serviceId } = useParams<{ serviceId: string }>();
  return <ServicePage key={serviceId ?? "none"} serviceId={serviceId ?? ""} />;
}

function ServicePage({ serviceId }: { serviceId: string }): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const mayManage = holds(session?.permissions, MEMORIAL_MANAGE_PERMISSION);
  const fetchService = useCallback(() => getMemorial(client, serviceId), [client, serviceId]);
  const { state, reload, adopt } = useLoaded<Memorial>(fetchService, LOAD_FAILED);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const keys = useIdempotencyKey();
  const { announce, region } = useActionStatus();
  const descId = useId();

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the memorial service" />;
  if (state.kind === "error") {
    return state.status === 404 ? (
      <EmptyState title="Not found" description="This memorial service does not exist." />
    ) : (
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

  const service = state.data;
  const open = (next: Ceremony): void => {
    setActionError(null);
    setCeremony(next);
  };

  const transition = async (name: "publish" | "held" | "cancelled"): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    const key = keys.keyFor(`${name}:${service.version}`);
    const res =
      name === "publish"
        ? await publishMemorial(client, service.serviceId, service.version, key)
        : await closeMemorial(client, service.serviceId, service.version, name, key);
    keys.settle(res.status);
    inFlight.current = false;
    setBusy(false);
    if (res.error || !res.data) {
      const message = isStaleVersion(res.status, res.error)
        ? MOVED
        : errorMessage(res.error, "The service could not be changed.");
      if (isStaleWrite(res.status)) {
        void reload();
        setCeremony(null);
        announce(message);
        return;
      }
      setActionError(message);
      return;
    }
    adopt(res.data);
    void reload(); // a write answers without the join link: the detail read carries it
    setCeremony(null);
    announce(
      name === "publish"
        ? `Published. ${res.data.invitedCount} families invited.`
        : name === "held"
          ? "The service is marked as held."
          : "The service was cancelled.",
    );
  };

  const counts = service.rsvpCounts;
  const offers = {
    edit: mayManage && canEditMemorial(service.status),
    publish: mayManage && service.status === "draft",
    close: mayManage && service.status === "published",
  };
  const confirm =
    ceremony === "publish"
      ? {
          title: "Publish this memorial service",
          text: "Publishing invites every family eligible right now and drafts an invitation mailing for the families who receive post. No invitation wording is filled in for you: write it on the invitation mailing's page before generating it.",
          action: "Publish",
          style: primaryButtonStyle,
        }
      : ceremony === "held"
        ? {
            title: "Mark the service as held",
            text: "Marking it held closes RSVPs. Attendance can still be recorded on each invitation.",
            action: "Mark held",
            style: primaryButtonStyle,
          }
        : ceremony === "cancelled"
          ? {
              title: "Cancel this memorial service",
              text: "A cancelled service cannot be reopened. Families who answered online see that it was cancelled.",
              action: "Yes, cancel the service",
              style: dangerButtonStyle,
            }
          : null;

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{service.title}</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill
              label={humanize(service.status)}
              tone={toneOf(MEMORIAL_STATUS_TONE, service.status)}
            />
            <Link to="/bereavement/memorials" style={ghostButtonStyle}>
              All services
            </Link>
          </div>
        }
      />
      {region}
      {state.notice ? (
        <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{state.notice}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}

      <Card title="Summary">
        <SummaryGrid>
          <Field label="Starts" value={dateTime(service.startsAt)} />
          <Field label="Ends" value={dateTime(service.endsAt)} />
          <Field label="Modality" value={humanize(service.modality)} />
          <Field label="Venue" value={service.venueText ?? "—"} />
          <Field label="Join link" value={service.joinUrl ?? (service.hasJoinUrl ? "Set" : "—")} />
          <Field label="Capacity" value={service.capacity ?? "No limit"} />
          <Field label="RSVP by" value={shortDate(service.rsvpBy)} />
          <Field
            label="Invites families bereaved within"
            value={`${service.inviteWindowMonths} months`}
          />
          <Field label="Published" value={dateTime(service.publishedAt)} />
        </SummaryGrid>
        {service.description ? (
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{service.description}</p>
        ) : null}
        <CountGrid
          entries={[
            { label: "Invited", value: service.invitedCount },
            { label: "Coming", value: counts.yes },
            { label: "Maybe", value: counts.maybe },
            { label: "Not coming", value: counts.no },
            { label: "No answer yet", value: counts.invited },
            { label: "Guests expected", value: counts.guestsExpected },
            { label: "Attended", value: counts.attended },
            { label: "Did not attend", value: counts.noShow },
          ]}
        />
      </Card>

      {service.mailingRunId ? (
        <Card title="Invitation mailing">
          <span style={mutedStyle}>
            The printed invitation is a mailing run. Its wording is written there by staff: none is
            filled in for you.
          </span>
          <Link to={`/bereavement/mailings/runs/${service.mailingRunId}`} style={linkStyle}>
            Invitation mailing
          </Link>
        </Card>
      ) : null}

      <Card title="Actions">
        {!mayManage ? (
          <span style={mutedStyle}>Your role can view this service but not change it.</span>
        ) : !Object.values(offers).some(Boolean) ? (
          <span style={mutedStyle}>No actions are available for this service.</span>
        ) : (
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            {offers.edit ? (
              <Button tone="secondary" disabled={busy} onClick={() => open("edit")}>
                Edit
              </Button>
            ) : null}
            {offers.publish ? (
              <Button disabled={busy} onClick={() => open("publish")}>
                Publish
              </Button>
            ) : null}
            {offers.close ? (
              <>
                <Button disabled={busy} onClick={() => open("held")}>
                  Mark held
                </Button>
                <Button tone="secondary" disabled={busy} onClick={() => open("cancelled")}>
                  Cancel service
                </Button>
              </>
            ) : null}
          </div>
        )}
        {actionError && !confirm ? <ErrorText>{actionError}</ErrorText> : null}
      </Card>

      {mayManage ? (
        <MemorialInvitations
          service={service}
          onRecorded={(m) => {
            announce(m, { focus: false });
            void reload();
          }}
        />
      ) : null}

      {ceremony === "edit" ? (
        <MemorialFormModal
          service={service}
          onClose={() => setCeremony(null)}
          onStale={(message) => {
            setCeremony(null);
            announce(message);
            void reload();
          }}
          onSaved={(saved) => {
            adopt(saved);
            void reload(); // the PATCH answers without the join link: the detail read carries it
            setCeremony(null);
            announce("The service was saved.");
          }}
        />
      ) : null}
      {confirm && (ceremony === "publish" || ceremony === "held" || ceremony === "cancelled") ? (
        <Modal
          title={confirm.title}
          onClose={() => setCeremony(null)}
          busy={busy}
          role="alertdialog"
          describedBy={descId}
          cancelLabel="Go back"
          footer={
            <button
              type="button"
              style={confirm.style}
              disabled={busy}
              onClick={() => void transition(ceremony)}
            >
              {busy ? "Saving…" : confirm.action}
            </button>
          }
        >
          <span id={descId} style={mutedStyle}>
            {confirm.text}
          </span>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
    </div>
  );
}
