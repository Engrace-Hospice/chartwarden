// M36 WP 6.7 (ADR-0099 D1-D5, D12, D14, D15, PROPOSED, flag-off) - the FAMILY CONTACT's page: open the one-time link, enter the 8-digit code the care team gave
// you by phone, read and write text in one conversation. Hosted in apps/web as a chromeless public route (like /partner/share) but it is NOT the staff app:
// it never uses the staff session or client (family-api.ts: plain fetch, credentials omitted). Rules this file keeps:
//   - the link rides the URL FRAGMENT; it is read once and scrubbed from the address bar before anything else happens;
//   - the bearer lives in a ref (memory) only: never localStorage, sessionStorage, a cookie, the URL, the title or the DOM. A reload therefore ends the
//     session (the link is single use; staff reissue). The token is never rendered and nothing is logged;
//   - EVERY refusal (revoked, expired, locked, flag off, never existed, wrong stage, bad link) is the ONE neutral state, uniform with the server's 404, and
//     it shows the number from the fragment; no server text is ever shown;
//   - the not-an-emergency notice and the agency number are in the frame of every state (family-contact-frame.tsx);
//   - nothing polls: the contact refreshes by pressing Refresh or by sending (D5).
import type { FamilyContactMessageDto, FamilyContactStateDto } from "@chartwarden/types";
import { Button, InlineAlert, TextField, t } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  type FamilyResult,
  readFamilyMessages,
  readFamilyState,
  redeemFamilyInvitation,
  sendFamilyMessage,
  verifyFamilyCode,
} from "./family-api";
import { FamilyContactFrame, mutedStyle, tapStyle } from "./family-contact-frame";
import { FamilyConversation, type SendOutcome } from "./family-conversation";
import { type FamilyInvitation, parseFamilyFragment } from "./family-link";
import { ft } from "./family-text";

/** Pages followed per refresh; a longer thread shows the rest through "Show more messages". */
const REFRESH_PAGES = 4;
const CODE_INPUT_ID = "family-code";
const CODE_PATTERN = /^\d{8}$/;
const NOINDEX = [
  ["robots", "noindex, nofollow"],
  ["referrer", "no-referrer"],
] as const;

type Phase = "opening" | "retry" | "code" | "verifying" | "reading" | "dead";

/** Keeps the page neutral for its lifetime: a title that reveals nothing, never indexed, no referrer. Removed on unmount. */
function usePageHygiene(): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = ft("family.page.title");
    const added = NOINDEX.map(([name, content]) => {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      return meta;
    });
    return () => {
      document.title = previousTitle;
      for (const meta of added) meta.remove();
    };
  }, []);
}

export function FamilyPage(): JSX.Element {
  usePageHygiene();
  const [phase, setPhase] = useState<Phase>("opening");
  const [state, setState] = useState<FamilyContactStateDto | null>(null);
  const [code, setCode] = useState("");
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly FamilyContactMessageDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const bearer = useRef<string | null>(null);
  const invitation = useRef<FamilyInvitation | null>(null);
  /** Bumped when the session ends or the page unmounts, so a late network answer can never revive it. */
  const gen = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fragmentTaken = useRef(false); // survives React StrictMode's simulated remount, which would otherwise find the fragment already scrubbed

  const die = useCallback((): void => {
    bearer.current = null;
    invitation.current = null;
    gen.current += 1;
    setMessages([]);
    setNextCursor(null);
    setState(null);
    setCode("");
    setPhase("dead");
  }, []);

  /** Re-reads the thread from its start, following the cursor for at most REFRESH_PAGES pages. */
  const refresh = useCallback(
    async (manual: boolean): Promise<void> => {
      const held = bearer.current;
      if (!held) return;
      const mine = gen.current;
      if (manual) setRefreshing(true);
      const all: FamilyContactMessageDto[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < REFRESH_PAGES; page += 1) {
        const r: FamilyResult<{
          messages: readonly FamilyContactMessageDto[];
          nextCursor: string | null;
        }> = await readFamilyMessages(held, cursor);
        if (gen.current !== mine) return;
        if (r.kind === "gone") return die();
        if (r.kind !== "ok") {
          setRefreshing(false);
          setRefreshFailed(true);
          return;
        }
        all.push(...r.data.messages);
        cursor = r.data.nextCursor;
        if (!cursor) break;
      }
      setMessages(all);
      setNextCursor(cursor);
      setRefreshFailed(false);
      setRefreshing(false);
    },
    [die],
  );

  const more = useCallback(async (): Promise<void> => {
    const held = bearer.current;
    if (!held || !nextCursor) return;
    const mine = gen.current;
    setLoadingMore(true);
    const r = await readFamilyMessages(held, nextCursor);
    if (gen.current !== mine) return;
    setLoadingMore(false);
    if (r.kind === "gone") return die();
    if (r.kind !== "ok") return setRefreshFailed(true);
    setMessages((m) => [...m, ...r.data.messages]);
    setNextCursor(r.data.nextCursor);
  }, [die, nextCursor]);

  const open = useCallback(async (): Promise<void> => {
    const link = invitation.current;
    if (!link) return;
    const mine = gen.current;
    setPhase("opening");
    const redeemed = await redeemFamilyInvitation(link.organizationId, link.token);
    if (gen.current !== mine) return;
    if (redeemed.kind === "gone") return die();
    if (redeemed.kind !== "ok") return setPhase("retry"); // the token was not spent by a failure we could not read; the link may be tried again
    invitation.current = null; // the single-use token is spent: it cannot be offered again
    bearer.current = redeemed.data.sessionToken;
    // The link is spent, so a blip on the first state read must not strand the family: try it a few times before the neutral state.
    let read = await readFamilyState(redeemed.data.sessionToken);
    for (let attempt = 0; attempt < 2 && read.kind === "failed"; attempt += 1) {
      if (gen.current !== mine) return;
      read = await readFamilyState(redeemed.data.sessionToken);
    }
    if (gen.current !== mine) return;
    if (read.kind !== "ok") return die();
    setState(read.data);
    setPhase("code");
  }, [die]);

  // Take the link out of the fragment ONCE, remove it from the address bar and the history entry, then open.
  useEffect(() => {
    if (fragmentTaken.current) return;
    fragmentTaken.current = true;
    const parsed = parseFamilyFragment(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (!parsed.invitation) {
      setPhase("dead");
      return;
    }
    invitation.current = parsed.invitation;
    void open();
  }, [open]);

  // The bearer does not outlive the component. (`gen` is not bumped here: React StrictMode's simulated unmount would drop the redeem answer in flight.)
  useEffect(
    () => () => {
      bearer.current = null;
    },
    [],
  );

  async function submitCode(): Promise<void> {
    const held = bearer.current;
    if (!held) return;
    if (!CODE_PATTERN.test(code)) {
      setCodeNotice(ft("family.code.format"));
      return;
    }
    const mine = gen.current;
    setPhase("verifying");
    setCodeNotice(null);
    const r = await verifyFamilyCode(held, code);
    if (gen.current !== mine) return;
    if (r.kind === "gone") return die(); // the fifth wrong code is a neutral 404
    if (r.kind !== "ok") {
      setPhase("code");
      setCodeNotice(
        r.kind === "bad-code"
          ? ft("family.code.invalid")
          : r.kind === "limited"
            ? ft("family.code.limited")
            : ft("family.contact.network"),
      );
      return;
    }
    // Activation rotated the bearer; the enrolment one is dead. A null token (already active) keeps the one held.
    if (r.data.sessionToken) bearer.current = r.data.sessionToken;
    setState(r.data);
    setCode("");
    setPhase("reading");
    void refresh(false);
  }

  const send = useCallback(
    async (body: string): Promise<SendOutcome> => {
      const held = bearer.current;
      if (!held) return "failed";
      const mine = gen.current;
      const r = await sendFamilyMessage(held, body);
      if (gen.current !== mine) return "failed";
      if (r.kind === "gone") {
        die();
        return "failed";
      }
      if (r.kind === "ok") {
        void refresh(false);
        return "ok";
      }
      if (r.kind === "closed") setState((s) => (s ? { ...s, closed: true } : s));
      return r.kind === "closed" ? "closed" : r.kind === "limited" ? "limited" : "failed";
    },
    [die, refresh],
  );

  // Move focus to the new step's heading; after a failed code check, back to the code input.
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

  const agencyPhone = state?.agencyPhone ?? null;
  const bereaved = state?.mode === "bereavement";

  if (phase === "dead") {
    return (
      <FamilyContactFrame
        heading={ft("family.dead.heading")}
        headingRef={headingRef}
        agencyPhone={null}
      >
        <InlineAlert tone="error">{ft("family.dead.text")}</InlineAlert>
      </FamilyContactFrame>
    );
  }

  if (phase === "reading" && state) {
    return (
      <FamilyContactFrame
        heading={ft("family.contact.heading")}
        headingRef={headingRef}
        agencyPhone={agencyPhone}
        bereavementPhone={bereaved ? state.bereavementPhone : null}
      >
        <FamilyConversation
          mode={state.mode}
          closed={state.closed}
          messages={messages}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          refreshing={refreshing}
          refreshFailed={refreshFailed}
          onRefresh={() => void refresh(true)}
          onMore={() => void more()}
          onSend={send}
        />
      </FamilyContactFrame>
    );
  }

  const gate = phase === "code" || phase === "verifying";
  return (
    <FamilyContactFrame
      heading={gate ? ft("family.code.heading") : ft("family.contact.heading")}
      headingRef={headingRef}
      agencyPhone={agencyPhone}
      bereavementPhone={bereaved ? (state?.bereavementPhone ?? null) : null}
    >
      {gate ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: t.space4 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode();
          }}
        >
          <p style={mutedStyle}>{ft("family.code.help")}</p>
          <TextField
            id={CODE_INPUT_ID}
            label={ft("family.code.label")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={16}
            error={codeNotice}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
            style={{ minHeight: "2.75rem" }}
          />
          <Button type="submit" size="lg" style={tapStyle} loading={phase === "verifying"}>
            {phase === "verifying" ? ft("family.code.checking") : ft("family.code.submit")}
          </Button>
        </form>
      ) : phase === "retry" ? (
        <>
          <InlineAlert tone="error">{ft("family.contact.network")}</InlineAlert>
          <Button type="button" size="lg" style={tapStyle} onClick={() => void open()}>
            {ft("family.contact.retry")}
          </Button>
        </>
      ) : (
        <output style={mutedStyle}>{ft("family.contact.opening")}</output>
      )}
    </FamilyContactFrame>
  );
}
