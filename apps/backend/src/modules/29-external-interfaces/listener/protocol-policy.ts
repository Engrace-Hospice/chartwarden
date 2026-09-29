// apps/backend/src/modules/29-external-interfaces/listener/protocol-policy.ts — may an INBOUND listener bind
// cleartext `mllp_plain`? (F-179, #248).
//
// F-178 refused `mllp_plain` for the OUTBOUND worker; an inbound `mllp_plain` listener is the same cleartext PHI
// on the wire (a partner sends ADT/ORU over a plain socket), so it gets the same rule and the SAME decision
// function — never a second copy of the production test:
//
//   · production            → never allowed (an `M29_ALLOW_MLLP_PLAIN` opt-in is ignored, and boot refuses it).
//   · non-production        → allowed only with the explicit `M29_ALLOW_MLLP_PLAIN=true` opt-in.
//
// FAIL CLOSED. Every caller defaults to the environment-derived answer, so a supervisor or registry built
// without the option refuses plain rather than silently binding it.
import { checkProtocol, resolveDestinationPolicy } from "../outbound/destination-policy";

type Env = Readonly<Record<string, string | undefined>>;

/** Fixed, PHI-free refusal label (safe for logs, alerts and the boot outcome). */
export const PLAIN_LISTENER_REFUSAL = "plain_protocol_refused" as const;

/** Whether an inbound `mllp_plain` listener may bind under `env` (production is never; else opt-in only). */
export function inboundPlainAllowed(env: Env): boolean {
  return resolveDestinationPolicy(env).allowPlain;
}

/** null = the protocol may bind; otherwise the fixed refusal label. */
export function listenerProtocolRefusal(
  protocol: "mllp_tls" | "mllp_plain",
  allowPlain: boolean,
): typeof PLAIN_LISTENER_REFUSAL | null {
  return checkProtocol(protocol, { allowPlain, allowLoopback: false }) === null
    ? null
    : PLAIN_LISTENER_REFUSAL;
}

/** Thrown by the registry when asked to bind a plain listener the policy forbids — before any socket exists. */
export class PlainListenerRefusedError extends Error {
  readonly code = "M29_LISTENER_PLAIN_REFUSED";
  constructor(readonly feedId: string) {
    super("inbound mllp_plain listener refused: cleartext PHI is not permitted in this deployment");
    this.name = "PlainListenerRefusedError";
  }
}
