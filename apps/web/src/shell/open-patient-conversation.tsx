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

// apps/web/src/shell — open THIS patient's care-team conversation. Plain /messaging lands on the first
// conversation in the list (another patient's), so every patient-scoped "message" entry point resolves
// the care-team channel first and hands its id to the messaging workspace through router state.

const UNAVAILABLE = "The care team conversation is unavailable or your access has changed.";
const FAILED = "The care team conversation could not be opened. Try again.";
const OPENING_STATUS = "Opening care team conversation…";

export interface PatientConversation {
  open: () => Promise<void>;
  opening: boolean;
}

export function useOpenPatientConversation(patientId: string): PatientConversation {
  const client = useApiClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const request = useRef(0);
  const inFlight = useRef(false);

  // A patient/client change or unmount invalidates any pending response and frees the guard.
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
    try {
      const result = await client.POST("/api/v1/messaging/patients/{patientId}/care-team-channel", {
        params: { path: { patientId } },
      });
      if (mine !== request.current) return;
      const data = result.data;
      // A response for another patient must never be followed.
      if (result.error || !data?.channelId || (data.patientId && data.patientId !== patientId)) {
        toast.show(UNAVAILABLE, { tone: "error" });
        return;
      }
      navigate("/messaging", { state: { messagingChannelId: data.channelId } });
    } catch {
      if (mine !== request.current) return;
      toast.show(FAILED, { tone: "error" });
    } finally {
      if (mine === request.current) {
        inFlight.current = false;
        setOpening(false);
      }
    }
  }, [client, navigate, patientId, toast]);

  return { open, opening };
}

/**
 * Link-looking entry point for a patient's care-team conversation. Every primary or modified click
 * (and middle click) runs `open` in the same tab. The href is the patient's chart, never /messaging:
 * a browser-menu "open in new tab" cannot be intercepted and /messaging would select another
 * patient's thread. The caller owns the hook so it outlives menus that unmount on close.
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
  const run = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    onClick?.();
    if (!opening) void open();
  };
  return (
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
      <span className="wx-sr-only" role="status">
        {opening ? OPENING_STATUS : ""}
      </span>
    </Link>
  );
}
