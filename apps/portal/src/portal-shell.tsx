import { Breadcrumbs, Glyph } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { PORTAL_BASE_PATH } from "./base-path";
import { PORTAL_NAVIGATION, portalBreadcrumbs, portalNavPath, portalNavTitle } from "./navigation";
import { PortalPatientContext, usePortalPatient } from "./patient-context";

const PATIENT_PATH = /^\/p\/([^/]+)/;

function currentPatientId(pathname: string): string | null {
  const encodedId = PATIENT_PATH.exec(pathname)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

function Brand({
  destination,
  compact = false,
}: {
  destination: string;
  compact?: boolean;
}): JSX.Element {
  return (
    <Link className="wx-portal-brand" to={destination} aria-label="ChartWarden Family Portal home">
      <img
        className="wx-portal-brand__mark"
        src={`${PORTAL_BASE_PATH}/chartwarden-mark.svg`}
        alt=""
      />
      {!compact ? (
        <span>
          <strong>ChartWarden</strong>
          <small>Family Portal</small>
        </span>
      ) : null}
    </Link>
  );
}

function NavigationLinks({
  patientId,
  onNavigate,
}: {
  patientId: string;
  onNavigate?: () => void;
}): JSX.Element {
  return (
    <>
      {(["primary", "secondary"] as const).map((section) => (
        <div className="wx-portal-nav-group" key={section}>
          <span className="wx-portal-nav-group__label">
            {section === "primary" ? "Your care" : "Support & settings"}
          </span>
          {PORTAL_NAVIGATION.filter((item) => item.section === section).map((item) => (
            <NavLink
              key={item.id}
              to={portalNavPath(item.id, patientId)}
              aria-label={item.label}
              end={item.id === "portal.dashboard"}
              onClick={onNavigate}
              className={({ isActive }) => `wx-portal-nav-link${isActive ? " is-active" : ""}`}
            >
              <Glyph name={item.icon} size={20} strokeWidth={1.8} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}

function PortalSidebar({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  return (
    <aside className="wx-portal-sidebar" aria-label="Family Portal sidebar">
      <Brand destination={patientId ? `/p/${encodeURIComponent(patientId)}` : "/patient-picker"} />
      {patientId ? (
        <nav aria-label="Portal navigation">
          <NavigationLinks patientId={patientId} />
        </nav>
      ) : (
        <nav aria-label="Portal account navigation" className="wx-portal-no-patient-nav">
          <NavLink
            to="/patient-picker"
            aria-label="Choose patient"
            className={({ isActive }) => `wx-portal-nav-link${isActive ? " is-active" : ""}`}
          >
            <Glyph name="users" size={20} strokeWidth={1.8} />
            <span>Choose patient</span>
          </NavLink>
          <NavLink
            to="/account"
            aria-label="Account & security"
            className={({ isActive }) => `wx-portal-nav-link${isActive ? " is-active" : ""}`}
          >
            <Glyph name="shield-check" size={20} strokeWidth={1.8} />
            <span>Account & security</span>
          </NavLink>
        </nav>
      )}
      <div className="wx-portal-sidebar__footer">
        <span>Private and secure</span>
        <small>Your access is protected by ChartWarden.</small>
      </div>
    </aside>
  );
}

function PatientIdentity(): JSX.Element {
  const { summary, loading, error } = usePortalPatient();
  return (
    <div className="wx-portal-patient-identity" aria-live="polite">
      <span className="wx-portal-patient-identity__avatar" aria-hidden="true">
        <Glyph name="user" size={18} />
      </span>
      <span>
        <small>Viewing care for</small>
        <strong>
          {loading
            ? "Loading patient…"
            : error || !summary
              ? "Patient unavailable"
              : (summary.patient.preferredName ?? summary.patient.layLabel)}
        </strong>
      </span>
    </div>
  );
}

function PortalHeader({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const { pathname } = useLocation();
  return (
    <header className="wx-portal-topbar">
      <div className="wx-portal-topbar__mobile-brand">
        <Brand
          destination={patientId ? `/p/${encodeURIComponent(patientId)}` : "/patient-picker"}
          compact
        />
      </div>
      <div className="wx-portal-topbar__title">
        {patientId ? <small>Family Portal</small> : null}
        <strong>{patientId ? portalNavTitle(pathname) : "Family Portal"}</strong>
      </div>
      {patientId ? <PatientIdentity /> : null}
      <div className="wx-portal-topbar__actions">
        {patientId ? (
          <Link className="wx-portal-switch-link" to="/patient-picker">
            <Glyph name="users" size={18} />
            <span>Switch patient</span>
          </Link>
        ) : null}
        {!patientId ? <PortalHelp /> : null}
        <NavLink
          className="wx-portal-account-button"
          to="/account"
          aria-label="Account and security"
        >
          <Glyph name="user-circle" size={22} />
        </NavLink>
      </div>
    </header>
  );
}

function PortalHelp(): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="wx-portal-help">
      <button
        ref={triggerRef}
        type="button"
        className="wx-portal-help__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Glyph name="info" size={18} />
        <span>Help</span>
      </button>
      {open ? (
        <dialog className="wx-portal-help__popover" open aria-labelledby="portal-help-title">
          <div>
            <strong id="portal-help-title">Need urgent help?</strong>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close help"
              onClick={() => {
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }}
            >
              <Glyph name="close" size={18} />
            </button>
          </div>
          <p>
            Contact your hospice team directly. Do not use portal messages for emergencies. In an
            emergency, call local emergency services.
          </p>
        </dialog>
      ) : null}
    </div>
  );
}

function PortalAccountMobileNav(): JSX.Element {
  return (
    <nav
      className="wx-portal-mobile-nav wx-portal-context-mobile-nav"
      aria-label="Mobile account navigation"
    >
      <NavLink to="/patient-picker">
        <Glyph name="users" size={22} />
        <span>Choose patient</span>
      </NavLink>
      <NavLink to="/account">
        <Glyph name="shield-check" size={22} />
        <span>Account</span>
      </NavLink>
    </nav>
  );
}

function PortalMobileNav({ patientId }: { patientId: string }): JSX.Element {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const moreActive = PORTAL_NAVIGATION.some(
    (item) => !item.mobile && pathname === portalNavPath(item.id, patientId),
  );
  // External navigation (including browser back/forward) must dismiss the sheet.
  useEffect(() => {
    void pathname;
    void patientId;
    setOpen(false);
  }, [pathname, patientId]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        requestAnimationFrame(() => openerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("a, button") ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
  function close(): void {
    setOpen(false);
    requestAnimationFrame(() => openerRef.current?.focus());
  }
  const fixed = PORTAL_NAVIGATION.filter((item) => item.mobile);
  return (
    <>
      {open ? (
        <div className="wx-portal-mobile-sheet-backdrop" onMouseDown={close}>
          <dialog
            className="wx-portal-mobile-sheet"
            open
            aria-modal="true"
            aria-label="More portal destinations"
            ref={dialogRef}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="wx-portal-mobile-sheet__header">
              <div>
                <small>Family Portal</small>
                <h2>More</h2>
              </div>
              <button type="button" onClick={close} aria-label="Close menu">
                <Glyph name="close" size={22} />
              </button>
            </div>
            <nav aria-label="More portal destinations">
              <NavigationLinks patientId={patientId} onNavigate={close} />
            </nav>
          </dialog>
        </div>
      ) : null}
      <nav className="wx-portal-mobile-nav" aria-label="Mobile portal navigation">
        {fixed.map((item) => (
          <NavLink
            key={item.id}
            to={portalNavPath(item.id, patientId)}
            end={item.id === "portal.dashboard"}
          >
            <Glyph name={item.icon} size={22} />
            <span>{item.label}</span>
          </NavLink>
        ))}
        <button
          ref={openerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={moreActive ? "is-active" : undefined}
          onClick={() => setOpen(true)}
        >
          <Glyph name="more-horizontal" size={22} />
          <span>More</span>
        </button>
      </nav>
    </>
  );
}

function PortalUrgentHelp(): JSX.Element {
  return (
    <aside className="wx-portal-urgent-help" aria-label="Urgent care information">
      <Glyph name="phone" size={20} />
      <div>
        <strong>Need urgent help?</strong>
        <p>
          Contact your hospice team directly. Do not use portal messages for emergencies. In an
          emergency, call local emergency services.
        </p>
      </div>
    </aside>
  );
}

export function PortalAppShell(): JSX.Element {
  const { pathname } = useLocation();
  const patientId = currentPatientId(pathname);
  // Messaging is a bounded workspace: the history scrolls while the composer remains visible.
  // Keep the mode route-driven so no layout class leaks into other portal screens.
  const messagingWorkspace = /^\/p\/[^/]+\/messages\/?$/.test(pathname);
  const shellRef = useRef<HTMLDivElement>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (!messagingWorkspace || !window.visualViewport) {
      setKeyboardOpen(false);
      return;
    }
    const viewport = window.visualViewport;
    const shell = shellRef.current;
    const update = () => {
      // dvh is not keyboard-aware on every mobile browser. Constrain the
      // workspace to the actually visible bottom while the keyboard is open.
      const visibleBottom = viewport.height + viewport.offsetTop;
      const isKeyboardOpen = window.innerWidth < 768 && visibleBottom < window.innerHeight - 120;
      setKeyboardOpen(isKeyboardOpen);
      if (isKeyboardOpen) {
        shell?.style.setProperty("--wx-message-viewport-height", `${Math.floor(visibleBottom)}px`);
      } else {
        shell?.style.removeProperty("--wx-message-viewport-height");
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      shell?.style.removeProperty("--wx-message-viewport-height");
    };
  }, [messagingWorkspace]);
  return (
    <PortalPatientContext patientId={patientId}>
      <div
        ref={shellRef}
        className={`wx-portal-shell${patientId ? "" : " wx-portal-shell--unbound"}${messagingWorkspace ? " wx-portal-shell--messages" : ""}${messagingWorkspace && keyboardOpen ? " wx-portal-shell--keyboard" : ""}`}
      >
        <a className="wx-portal-skip-link" href="#portal-main">
          Skip to main content
        </a>
        <PortalSidebar patientId={patientId} />
        <div className="wx-portal-workspace">
          <PortalHeader patientId={patientId} />
          <main className="wx-portal-main" id="portal-main" tabIndex={-1}>
            <Breadcrumbs items={portalBreadcrumbs(pathname, patientId)} />
            {/* A patient ID alone never grants access (the server enforces that).
                Remounting the routed screen on patient changes also ensures drafts,
                request state, and prior patient data cannot flash before effects run. */}
            <Outlet key={patientId ?? "no-active-patient"} />
          </main>
          {patientId ? <PortalUrgentHelp /> : null}
        </div>
        {patientId ? <PortalMobileNav patientId={patientId} /> : <PortalAccountMobileNav />}
      </div>
    </PortalPatientContext>
  );
}
