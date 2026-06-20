// apps/web/src/shell — M1 app-shell barrel (ADR-0030).
export { AppShell } from "./app";
export type { AppShellProps } from "./app";
export { AppLayout, HomeScreen } from "./layout";
export { createScreenRegistry } from "./screen-registry";
export type { WebScreen, WebScreenDescriptor, WebScreenModule } from "./screen-registry";
export { SessionProvider, useSession } from "./session";
export type { Session, SessionProviderProps } from "./session";
export { systemScreens, NotFound, Forbidden, ServerError, Offline, Maintenance, SessionExpired, Suspended } from "./system-pages";
