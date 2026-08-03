// apps/web/src/shell — M1 app-shell barrel (ADR-0030).
export { AppShell } from "./app";
export type { AppShellProps } from "./app";
export { AppLayout, HomeScreen } from "./layout";
export { createScreenRegistry } from "./screen-registry";
export type { WebScreen, WebScreenDescriptor, WebScreenModule } from "./screen-registry";
export { ActorSessionProvider, SessionProvider, useSession, useSessionState } from "./session";
export type {
  ActorSessionProviderProps,
  Session,
  SessionProviderProps,
  SessionState,
  SessionStatus,
} from "./session";
export { canSeeScreen, guardChromedRoute, toSession } from "./actor-session";
export type { ActorContextResponse, RouteGuardOutcome } from "./actor-session";
export { setGlobalResponseSignal, signalForStatus } from "./global-response-signal";
export type { GlobalResponseSignal } from "./global-response-signal";
export {
  systemScreens,
  NotFound,
  Forbidden,
  ServerError,
  Offline,
  Maintenance,
  SessionExpired,
  Suspended,
} from "./system-pages";
