import { useApiClient, useToast } from "@wardenx/ui";
import {
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

export function useOpenPatientConversation(patientId: string): {
  open: () => Promise<void>;
  opening: boolean;
} {
  const client = useApiClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const request = useRef(0);
  const inFlight = useRef(false);

  // A patient change or unmount invalidates any pending response.
  useEffect(
    () => () => {
      void patientId;
      request.current += 1;
      inFlight.current = false;
    },
    [patientId],
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
      if (result.error || !result.data?.channelId) {
        toast.show(UNAVAILABLE, { tone: "error" });
        return;
      }
      navigate("/messaging", { state: { messagingChannelId: result.data.channelId } });
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

/** A real link to /messaging (keyboard, middle-click, aria-current) whose plain click opens the patient's conversation. */
export function PatientConversationLink({
  patientId,
  children,
  onClick,
  ...rest
}: {
  patientId: string;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
  "aria-current"?: "page";
}): JSX.Element {
  const { open } = useOpenPatientConversation(patientId);
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.();
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (event.button !== 0 || modified) return;
    event.preventDefault();
    void open();
  };
  return (
    <Link to="/messaging" onClick={handle} {...rest}>
      {children}
    </Link>
  );
}
