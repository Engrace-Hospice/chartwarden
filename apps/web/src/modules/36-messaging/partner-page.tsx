// M36 WP 6.6 (ADR-0096 D19-D23, PROPOSED, flag-off) - the PARTNER's page: open the one-time invitation link, enter the 8-digit code you were given by
// phone, read the one shared conversation. Hosted in apps/web as a chromeless route (like /auditor/redeem) but it is NOT the staff app: it never uses the
// staff session or client (partner-api.ts: plain fetch, credentials omitted). Rules this file keeps:
//   - the link rides the URL FRAGMENT, is read once and scrubbed; NOTHING is redeemed until the button is pressed (a link scanner cannot burn it);
//   - the bearer lives in a ref (memory) only: never localStorage, sessionStorage, a cookie, the URL or React state that devtools would label. A reload
//     therefore ends the session (the invitation is single use; staff reissue) - ADR-0096 limit s;
//   - the document title is fixed ("Secure message"); no identifier, name, message or code reaches the URL, title, storage or console; failures are fixed
//     strings; the page logs nothing;
//   - EVERY refusal (revoked, expired, locked, flag off, never existed, wrong stage, bad link) is the ONE neutral state, uniform with the server's 404;
//   - idle and absolute limits are enforced here too: polling touches the server's idle clock, so the page counts only the partner's own input.
import { EXTERNAL_SESSION_IDLE_MINUTES, EXTERNAL_SESSION_MAX_HOURS } from "@chartwarden/types";
import type { PartnerMessageDto } from "@chartwarden/types";
import { Button, CenteredCardLayout, InlineAlert, TextField, t } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { BrandLockup } from "../02-identity/brand-lockup";
import {
  type PartnerResult,
  readPartnerConversation,
  redeemInvitation,
  verifyPartnerCode,
} from "./partner-api";
import { PartnerConversationView } from "./partner-conversation-view";
import { parsePartnerFragment } from "./partner-link";
import type { PartnerInvitation } from "./partner-link";

export const PARTNER_IDLE_MS = EXTERNAL_SESSION_IDLE_MINUTES * 60_000;
export const PARTNER_ABSOLUTE_MS = EXTERNAL_SESSION_MAX_HOURS * 3_600_000;
/** How often the open, visible conversation re-reads. 60 reads a minute per share is the server budget (D10); this is 4 refreshes of at most 4 pages. */
export const PARTNER_POLL_MS = 15_000;
const WATCH_MS = 10_000;
const PAGE_TITLE = "Secure message";
const CODE_INPUT_ID = "partner-code";
const CODE_PATTERN = /^\d{8}$/;
const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "touchstart",
  "wheel",
  "scroll",
] as const;
/** The polite "ends soon" notice appears this long before the idle end. */
const IDLE_WARN_MS = 2 * 60_000;
const IDLE_WARN_MINUTES = IDLE_WARN_MS / 60_000;

type Phase = "ready" | "redeeming" | "code" | "verifying" | "reading" | "ended";
type EndReason = "neutral" | "idle";

const NEUTRAL =
  "This link is not available. It may have ended, been replaced, or never worked. If you were expecting access, ask the person who sent it to you.";
const IDLE = `This session ended after ${EXTERNAL_SESSION_IDLE_MINUTES} minutes of inactivity and the messages were cleared from this page. Ask the person who sent you the link for a new one.`;
const IDLE_WARNING = `This session ends in ${IDLE_WARN_MINUTES} minutes unless you press a key or tap.`;

interface Held {
  bearer: string;
  shareId: string;
  startedAt: number;
}

/** Keeps the page's meta tags honest for its lifetime: no referrer, not indexed. Removed on unmount. */
function usePageHygiene(): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = PAGE_TITLE;
    const added = [
      ["referrer", "no-referrer"],
      ["robots", "noindex, nofollow"],
    ].map(([name, content]) => {
      const meta = document.createElement("meta");
      meta.name = name!;
      meta.content = content!;
      document.head.appendChild(meta);
      return meta;
    });
    return () => {
      document.title = previousTitle;
      for (const meta of added) meta.remove();
    };
  }, []);
}

export function PartnerPage(): JSX.Element {
  usePageHygiene();
  const [invitation, setInvitation] = useState<PartnerInvitation | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [reason, setReason] = useState<EndReason>("neutral");
  const [partnerName, setPartnerName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [messages, setMessages] = useState<readonly PartnerMessageDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [idleWarning, setIdleWarning] = useState(false);
  const held = useRef<Held | null>(null);
  /** Bumped when a session ends or the page unmounts, so a late network answer can never revive it. */
  const sessionGen = useRef(0);
  /** Bumped per read; only the newest read may write messages (an overlapping older one is dropped). */
  const refreshSeq = useRef(0);
  const idleWarningRef = useRef(false);
  const lastInput = useRef(Date.now());
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Take the invitation out of the fragment ONCE and remove it from the address bar and the history entry.
  const fragmentTaken = useRef(false); // survives React StrictMode's simulated remount, which would otherwise find the fragment already scrubbed
  useEffect(() => {
    if (fragmentTaken.current) return;
    fragmentTaken.current = true;
    const parsed = parsePartnerFragment(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (parsed) setInvitation(parsed);
    else {
      setReason("neutral");
      setPhase("ended");
    }
  }, []);

  /** Drop the bearer and every message from memory. The only way out of a session. */
  const end = useCallback((why: EndReason) => {
    held.current = null;
    sessionGen.current += 1;
    refreshSeq.current += 1;
    idleWarningRef.current = false;
    setIdleWarning(false);
    setRefreshing(false);
    setMessages([]);
    setCode("");
    setNotice(null);
    setReason(why);
    setPhase("ended");
  }, []);

  /** A non-ok result: the closed kinds map to one neutral end, a rate-limit note, or a retry note. Never response text. */
  const refuse = useCallback(
    (r: PartnerResult<unknown>, whileReading: boolean): void => {
      if (r.kind === "gone") {
        end("neutral");
        return;
      }
      if (r.kind === "limited") {
        if (whileReading) {
          setRefreshFailed(true);
          setNotice(null);
        } else setNotice("Too many attempts. Wait a minute and try again.");
      } else if (r.kind === "bad-code")
        setNotice("That code is not correct. Check it with the person who gave it to you.");
      else if (whileReading) setRefreshFailed(true);
      else setNotice("We could not reach the service. Check your connection and try again.");
    },
    [end],
  );

  const refresh = useCallback(
    async (opts: { signal?: AbortSignal; manual?: boolean } = {}): Promise<void> => {
      const { signal, manual = false } = opts;
      const h = held.current;
      if (!h) return;
      const seq = ++refreshSeq.current;
      // Only a manual refresh shows busy: a background poll must not toggle the button.
      if (manual) setRefreshing(true);
      const r = await readPartnerConversation(h.bearer, h.shareId, signal);
      if (signal?.aborted || held.current !== h || seq !== refreshSeq.current) return;
      setRefreshing(false);
      if (r.kind === "ok") {
        setMessages(r.data);
        setRefreshFailed(false);
      } else refuse(r, true);
    },
    [refuse],
  );

  async function open(): Promise<void> {
    if (!invitation) return;
    const gen = sessionGen.current;
    setPhase("redeeming");
    setNotice(null);
    const r = await redeemInvitation(invitation.organizationId, invitation.token);
    if (sessionGen.current !== gen) return; // ended or unmounted meanwhile: do not resurrect it
    if (r.kind !== "ok") {
      if (r.kind === "gone") return end("neutral");
      setNotice(
        r.kind === "limited"
          ? "Too many attempts. Wait a minute and try again."
          : "We could not reach the service. Check your connection and try again.",
      );
      setPhase("ready");
      return;
    }
    // The single-use token is spent: drop it so it cannot be offered again.
    setInvitation(null);
    held.current = { bearer: r.data.sessionToken, shareId: r.data.shareId, startedAt: Date.now() };
    lastInput.current = Date.now();
    setPhase("code");
  }

  async function submitCode(): Promise<void> {
    const h = held.current;
    if (!h) return;
    if (!CODE_PATTERN.test(code)) {
      setNotice("Enter the 8-digit code exactly as you were given it.");
      return;
    }
    const gen = sessionGen.current;
    setPhase("verifying");
    setNotice(null);
    const r = await verifyPartnerCode(h.bearer, h.shareId, code);
    if (sessionGen.current !== gen) return; // ended or unmounted meanwhile: do not resurrect it
    if (r.kind !== "ok") {
      if (r.kind !== "gone") setPhase("code");
      refuse(r, false);
      return;
    }
    // D13: activation rotated the bearer; the enrolment one is dead. A null token (already active) keeps the one held.
    if (r.data.sessionToken) held.current = { ...h, bearer: r.data.sessionToken };
    setPartnerName(r.data.partnerName);
    setExpiresAt(r.data.expiresAt);
    setCode("");
    setPhase("reading");
    void refresh({ manual: false });
  }

  // Input resets the page's idle clock. Polling does not (it would keep the server's clock alive forever).
  useEffect(() => {
    const mark = (): void => {
      lastInput.current = Date.now();
      if (idleWarningRef.current) {
        idleWarningRef.current = false;
        setIdleWarning(false);
      }
    };
    // Capture: a scroll inside an element does not bubble to the window.
    for (const e of INPUT_EVENTS)
      window.addEventListener(e, mark, { passive: true, capture: true });
    return () => {
      for (const e of INPUT_EVENTS) window.removeEventListener(e, mark, { capture: true });
    };
  }, []);

  // An unmount ends every in-flight answer's right to write, and the bearer does not outlive the component.
  useEffect(
    () => () => {
      sessionGen.current += 1;
      refreshSeq.current += 1;
      held.current = null;
    },
    [],
  );

  // While a session is held: enforce the idle and absolute limits, and (reading only) poll while the tab is visible.
  useEffect(() => {
    if (phase !== "code" && phase !== "verifying" && phase !== "reading") return;
    /** True when a limit passed and the session was ended. Also raises the polite warning shortly before the idle end. */
    const limitsPassed = (): boolean => {
      const h = held.current;
      if (!h) return true;
      const now = Date.now();
      if (now - h.startedAt >= PARTNER_ABSOLUTE_MS) {
        end("neutral");
        return true;
      }
      const idleFor = now - lastInput.current;
      if (idleFor >= PARTNER_IDLE_MS) {
        end("idle");
        return true;
      }
      const warn = idleFor >= PARTNER_IDLE_MS - IDLE_WARN_MS;
      if (warn !== idleWarningRef.current) {
        idleWarningRef.current = warn;
        setIdleWarning(warn);
      }
      return false;
    };
    const watch = setInterval(limitsPassed, WATCH_MS);
    if (phase !== "reading") return () => clearInterval(watch);
    const controller = new AbortController();
    const poll = (): void => {
      if (document.hidden || limitsPassed()) return;
      void refresh({ signal: controller.signal });
    };
    const timer = setInterval(poll, PARTNER_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(watch);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      controller.abort();
    };
  }, [phase, end, refresh]);

  // Move focus to the new step's heading so a keyboard or screen-reader user lands on it; after a failed code check, back to the code input.
  const previousPhase = useRef<Phase>(phase);
  useEffect(() => {
    const was = previousPhase.current;
    previousPhase.current = phase;
    if (was === "verifying" && phase === "code") {
      document.getElementById(CODE_INPUT_ID)?.focus();
      return;
    }
    headingRef.current?.focus();
  }, [phase]);

  if (phase === "ended") {
    return (
      <CenteredCardLayout brand={<BrandLockup />}>
        <h1 ref={headingRef} tabIndex={-1} style={titleStyle}>
          Secure message
        </h1>
        <InlineAlert tone="error">{reason === "idle" ? IDLE : NEUTRAL}</InlineAlert>
      </CenteredCardLayout>
    );
  }

  const expiry = new Date(expiresAt);
  const accessEndsText = Number.isNaN(expiry.getTime())
    ? "your access ends"
    : expiry.toLocaleString();
  // Always mounted while a session is held, so a screen reader announces the text when it appears.
  const idleNotice = (
    <div role="status" style={mutedStyle}>
      {idleWarning ? IDLE_WARNING : ""}
    </div>
  );

  if (phase === "reading") {
    return (
      <main style={readingWrap}>
        <BrandLockup />
        {idleNotice}
        <PartnerConversationView
          partnerName={partnerName}
          messages={messages}
          accessEndsText={accessEndsText}
          headingRef={headingRef}
          onRefresh={() => void refresh({ manual: true })}
          refreshing={refreshing}
          refreshFailed={refreshFailed}
        />
      </main>
    );
  }

  const gate = phase === "code" || phase === "verifying";
  return (
    <CenteredCardLayout brand={<BrandLockup />}>
      <form
        style={{ display: "flex", flexDirection: "column", gap: t.space4 }}
        onSubmit={(e) => {
          e.preventDefault();
          void (gate ? submitCode() : open());
        }}
      >
        <div>
          <h1 ref={headingRef} tabIndex={-1} style={titleStyle}>
            Secure message
          </h1>
          <p style={mutedStyle}>
            {gate
              ? "Enter the 8-digit code the organization gave you by phone or in person. It is not in the link."
              : "You have been given time-limited, read-only access to one conversation. The link works once. Next you will enter a code you were given separately."}
          </p>
        </div>
        {gate ? idleNotice : null}
        {notice && !gate ? <InlineAlert tone="error">{notice}</InlineAlert> : null}
        {gate ? (
          <TextField
            id={CODE_INPUT_ID}
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            error={notice}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
            style={{ minHeight: "2.75rem" }}
          />
        ) : null}
        <Button
          type="submit"
          size="lg"
          style={{ width: "100%", minHeight: "2.75rem" }}
          loading={phase === "redeeming" || phase === "verifying"}
          disabled={!gate && !invitation}
        >
          {gate ? "Continue" : "Open the conversation"}
        </Button>
      </form>
    </CenteredCardLayout>
  );
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.25rem",
  color: t.onSurface,
};
const mutedStyle: CSSProperties = {
  margin: `${t.space2} 0 0`,
  color: t.onSurfaceVariant,
  fontSize: "0.875rem",
};
const readingWrap: CSSProperties = {
  maxWidth: "40rem",
  margin: "0 auto",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
};
