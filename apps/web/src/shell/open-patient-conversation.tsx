import { useApiClient, useToast } from "@wardenx/ui";
import {
  type CSSProperties,
  type JSX,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "./session";

// apps/web/src/shell — open THIS patient's care-team conversation. Plain /messaging lands on the first
// conversation in the list (another patient's), so every patient-scoped "message" entry point resolves
// the care-team channel first and hands its id to the messaging workspace through router state.

const UNAVAILABLE = "The care team conversation is unavailable or your access has changed.";
const FAILED = "The care team conversation could not be opened. Try again.";
const REQUEST_TIMEOUT_MS = 15_000;
const OPENING_STATUS = "Opening care team conversation…";

export interface PatientConversation {
  open: () => Promise<void>;
  opening: boolean;
}

type Client = ReturnType<typeof useApiClient>;
type Outcome = { channelId: string } | { failure: "unavailable" | "error" };
interface SharedRequest {
  promise: Promise<Outcome>;
  applied: boolean;
}

// One request per user, organisation and patient across every hook instance (tab, banner menu, care-team tile), so clicking
// two entry points before the first response sends one POST and navigates once.
const sharedRequests = new Map<string, SharedRequest>();

/** Test-only: drop every shared in-flight request so tests do not depend on order. */
export function resetSharedConversationRequests(): void {
  sharedRequests.clear();
}

async function resolveChannel(client: Client, patientId: string): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A request that never settles must not capture every later click for the page lifetime.
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ failure: "error" }), REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([requestChannel(client, patientId), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestChannel(client: Client, patientId: string): Promise<Outcome> {
  try {
    const result = await client.POST("/api/v1/messaging/patients/{patientId}/care-team-channel", {
      params: { path: { patientId } },
    });
    const data = result.data;
    // A response for another patient must never be followed.
    if (result.error || !data?.channelId || (data.patientId && data.patientId !== patientId)) {
      return { failure: "unavailable" };
    }
    return { channelId: data.channelId };
  } catch {
    return { failure: "error" };
  }
}

function sharedRequestFor(client: Client, patientId: string, scope: string): SharedRequest {
  const key = `${scope}:${patientId}`;
  const existing = sharedRequests.get(key);
  if (existing) return existing;
  const entry: SharedRequest = {
    applied: false,
    promise: resolveChannel(client, patientId).finally(() => {
      if (sharedRequests.get(key) === entry) sharedRequests.delete(key);
    }),
  };
  sharedRequests.set(key, entry);
  return entry;
}

export function useOpenPatientConversation(patientId: string): PatientConversation {
  const client = useApiClient();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const scope = `${session?.organizationId ?? ""}:${session?.userId ?? ""}`;
  const [opening, setOpening] = useState(false);
  const request = useRef(0);
  const inFlight = useRef(false);

  // A patient/client change or unmount invalidates any pending response and frees the guard.
  // `client` must be stable (created once at module scope in main.tsx) or this resets every render.
  useEffect(
    () => () => {
      void client;
      void patientId;
      request.current += 1;
      inFlight.current = false;
      setOpening(false);
    },
    [client, patientId],
  );

  const open = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    const mine = ++request.current;
    const shared = sharedRequestFor(client, patientId, scope);
    const outcome = await shared.promise;
    try {
      if (mine !== request.current) return;
      // The first live instance applies the outcome; the others only stop showing "opening".
      if (shared.applied) return;
      shared.applied = true;
      if ("channelId" in outcome) {
        navigate("/messaging", { state: { messagingChannelId: outcome.channelId } });
      } else {
        toast.show(outcome.failure === "error" ? FAILED : UNAVAILABLE, { tone: "error" });
      }
    } finally {
      if (mine === request.current) {
        inFlight.current = false;
        setOpening(false);
      }
    }
  }, [client, navigate, patientId, scope, toast]);

  return { open, opening };
}

/**
 * Link-looking entry point for a patient's care-team conversation. Every primary or modified click
 * (and middle click) runs `open` in the same tab. The href is the patient's chart, never /messaging:
 * a browser-menu "open in new tab" cannot be intercepted and /messaging would select another
 * patient's thread. The caller owns the hook so it outlives menus that unmount on close. Only the
 * clicked link renders the status region (outside the anchor, so the link's name never changes), so
 * links sharing one hook announce "opening" once.
 */
export function PatientConversationLink({
  patientId,
  conversation,
  children,
  onClick,
  ...rest
}: {
  patientId: string;
  conversation: PatientConversation;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  "aria-current"?: "page";
}): JSX.Element {
  const { open, opening } = conversation;
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (!opening) setClicked(false);
  }, [opening]);
  const run = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    onClick?.();
    if (opening) return;
    setClicked(true);
    void open();
  };
  return (
    <>
      <Link
        to={`/patients/${patientId}`}
        onClick={(event) => {
          if (event.button === 0) run(event);
        }}
        onAuxClick={(event) => {
          if (event.button === 1) run(event);
        }}
        aria-busy={opening || undefined}
        aria-disabled={opening || undefined}
        {...rest}
      >
        {children}
      </Link>
      {clicked ? <output className="wx-sr-only">{opening ? OPENING_STATUS : ""}</output> : null}
    </>
  );
}
