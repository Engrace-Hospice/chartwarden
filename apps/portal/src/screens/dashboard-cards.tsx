// @chartwarden/portal — the Family Care Dashboard cards. Presentational only: the dashboard container owns
// every request, and each card renders its own loading / error / empty state so one failing source never
// blanks the home.
import { Glyph, type GlyphName } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";

export type CardResource<T> =
  | { status: "loading"; items: readonly T[] }
  | { status: "ready"; items: readonly T[] }
  | { status: "error"; items: readonly T[]; error: string };

export interface DashboardMedication {
  medicationOrderId: string;
  drugName: string;
  dose?: string;
  scheduleSummary?: string;
  isPrn?: boolean;
}

export interface DashboardMessage {
  messageId: string;
  body: string;
  sentAt: string;
  direction: "incoming" | "outgoing";
  senderLabel: string;
}

const PREVIEW_MEDICATIONS = 3;

export function FamilyIcon({ name, size = 22 }: { name: GlyphName; size?: number }): JSX.Element {
  return (
    <span className="wx-family-icon" aria-hidden="true">
      <Glyph name={name} size={size} strokeWidth={1.8} />
    </span>
  );
}

export function CardSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <output className="wx-portal-dashboard-skeleton is-compact" aria-label={label}>
      <span />
      <span />
      <span />
    </output>
  );
}

/**
 * One card's read failure. `role="status"` (not alert) so several failing cards don't interrupt at once;
 * after a retry, focus moves to `focusId` (the card heading) because this button unmounts while loading.
 */
export function CardError({
  message,
  onRetry,
  focusId,
}: { message: string; onRetry: () => void; focusId?: string }): JSX.Element {
  function retry(): void {
    onRetry();
    if (focusId) requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> marks loading spinners in the portal (screens-smoke test); an error is a polite status, not a spinner.
    <div className="wx-portal-dashboard-error" role="status">
      <span aria-hidden="true">
        <Glyph name="alert-circle" size={20} />
      </span>
      <div>
        <strong>This information is unavailable</strong>
        <p>{message}</p>
      </div>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

function CardFooterLink({ to, children }: { to: string; children: ReactNode }): JSX.Element {
  return (
    <Link className="wx-family-card__footer-link" to={to}>
      {children}
      <Glyph name="arrow-right" size={17} />
    </Link>
  );
}

function FamilyCard({
  id,
  icon,
  title,
  subtitle,
  badge,
  footer,
  className = "",
  children,
}: {
  id: string;
  icon: GlyphName;
  title: string;
  subtitle?: string | undefined;
  badge?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className={`wx-family-card ${className}`.trim()} aria-labelledby={id}>
      <header className="wx-family-card__header">
        <FamilyIcon name={icon} />
        <div>
          <h2 id={id} tabIndex={-1}>
            {title}
          </h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {badge}
      </header>
      <div className="wx-family-card__body">{children}</div>
      {footer ? <div className="wx-family-card__footer">{footer}</div> : null}
    </section>
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

function medicationSchedule(medication: DashboardMedication): string | null {
  const schedule = medication.scheduleSummary?.trim() ?? "";
  const asNeeded = medication.isPrn && !/as needed/i.test(schedule) ? "as needed" : "";
  return [schedule, asNeeded].filter(Boolean).join(" ") || null;
}

export function MedicationsCard({
  resource,
  activeCount,
  to,
  onRetry,
}: {
  resource: CardResource<DashboardMedication>;
  activeCount: number | null;
  to: string;
  onRetry: () => void;
}): JSX.Element {
  const count = activeCount ?? (resource.status === "ready" ? resource.items.length : null);
  return (
    <FamilyCard
      id="family-medications-heading"
      icon="pill"
      title="Medications"
      subtitle={
        count !== null && count > 0
          ? plural(count, "active medication", "active medications")
          : undefined
      }
      footer={<CardFooterLink to={to}>View all medications</CardFooterLink>}
    >
      {resource.status === "loading" ? (
        <CardSkeleton label="Loading medications" />
      ) : resource.status === "error" ? (
        <CardError
          message={resource.error}
          onRetry={onRetry}
          focusId="family-medications-heading"
        />
      ) : resource.items.length === 0 ? (
        <p className="wx-family-card__lead">No active medications are shared with you right now.</p>
      ) : (
        <ul className="wx-family-list">
          {resource.items.slice(0, PREVIEW_MEDICATIONS).map((medication) => {
            const schedule = medicationSchedule(medication);
            return (
              <li key={medication.medicationOrderId}>
                <Link to={to} className="wx-family-list__row">
                  <span className="wx-family-check" aria-hidden="true">
                    <Glyph name="check" size={14} strokeWidth={2.6} />
                  </span>
                  <span className="wx-family-list__copy">
                    <strong>
                      {[medication.drugName || "Medication", medication.dose]
                        .filter(Boolean)
                        .join(" ")}
                    </strong>
                    {schedule ? <small>{schedule}</small> : null}
                  </span>
                  <Glyph name="chevron-right" size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </FamilyCard>
  );
}

function messageTime(iso: string): string {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = instant.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (instant.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (instant.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${instant.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export function RecentMessagesCard({
  resource,
  unreadCount,
  to,
  onRetry,
}: {
  resource: CardResource<DashboardMessage>;
  unreadCount: number | null;
  to: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <FamilyCard
      id="family-messages-heading"
      icon="message-square"
      title="Recent messages"
      badge={
        unreadCount !== null && unreadCount > 0 ? (
          <span className="wx-family-badge">{unreadCount} new</span>
        ) : null
      }
      footer={<CardFooterLink to={to}>View all messages</CardFooterLink>}
    >
      {resource.status === "loading" ? (
        <CardSkeleton label="Loading recent messages" />
      ) : resource.status === "error" ? (
        <CardError message={resource.error} onRetry={onRetry} focusId="family-messages-heading" />
      ) : resource.items.length === 0 ? (
        <p className="wx-family-card__lead">
          No messages yet. Your care team can answer questions here.
        </p>
      ) : (
        <ul className="wx-family-messages">
          {resource.items.map((message) => (
            <li key={message.messageId}>
              <strong>{message.direction === "outgoing" ? "You" : message.senderLabel}</strong>
              <p>{message.body}</p>
              <time dateTime={message.sentAt}>{messageTime(message.sentAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </FamilyCard>
  );
}

export function DocumentsCard({
  newCount,
  to,
}: {
  newCount: number | null;
  to: string;
}): JSX.Element {
  return (
    <FamilyCard
      id="family-documents-heading"
      icon="file-text"
      title="Documents"
      footer={<CardFooterLink to={to}>View documents</CardFooterLink>}
    >
      {newCount !== null && newCount > 0 ? (
        <Link className="wx-family-highlight" to={to}>
          <Glyph name="file-text" size={18} />
          <span>{plural(newCount, "new document", "new documents")}</span>
          <Glyph name="chevron-right" size={18} />
        </Link>
      ) : null}
      <p className="wx-family-card__lead">Shared care documents and forms.</p>
    </FamilyCard>
  );
}

export function BereavementCard({ to }: { to: string }): JSX.Element {
  return (
    <FamilyCard
      id="family-bereavement-heading"
      icon="heart"
      title="Bereavement support"
      className="wx-family-card--leafy"
      footer={<CardFooterLink to={to}>Explore support</CardFooterLink>}
    >
      <p className="wx-family-card__lead">Resources, counseling, and guidance for families.</p>
    </FamilyCard>
  );
}

export function CarePlanCard({ to }: { to: string }): JSX.Element {
  return (
    <FamilyCard
      id="family-care-plan-heading"
      icon="clipboard-check"
      title="Care plan"
      footer={<CardFooterLink to={to}>View care plan</CardFooterLink>}
    >
      <p className="wx-family-card__lead">
        See the goals and care plan summary your hospice team has shared with you.
      </p>
    </FamilyCard>
  );
}

export function NeedHelpCard({ messagesTo }: { messagesTo: string }): JSX.Element {
  // ponytail: no portal API exposes the hospice's phone number, so there is no tel: link —
  // add one here once the care summary carries a verified tenant contact number.
  return (
    <section className="wx-family-help" aria-labelledby="family-help-heading">
      <div className="wx-family-help__intro">
        <Glyph name="phone" size={26} />
        <div>
          <h2 id="family-help-heading">Need help now?</h2>
          <p>
            Call your hospice care team using the number they gave you. Messages are not for
            emergencies.
          </p>
        </div>
      </div>
      <Link className="wx-family-help__action" to={messagesTo}>
        <Glyph name="mail" size={18} />
        Send a message
      </Link>
      <p className="wx-family-help__emergency">
        <Glyph name="alert-circle" size={18} />
        In an emergency, call 911.
      </p>
    </section>
  );
}
