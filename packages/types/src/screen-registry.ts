// @wardenx/types — screen registry contract (F0-T03, ADR-0030).
// The M1 web shell builds its routes from this registry; each module's web-slice
// (apps/web/src/modules/NN-*) registers its screens into it at app composition, so the
// shell NEVER imports a feature module directly (the frontend analogue of M1's seam registry).
//
// Framework-agnostic on purpose: the renderable `screen` is a generic, so this leaf carries
// NO react dependency (packages/types is also the backend-shared contract leaf). apps/web binds
// the generic to a React component type (see apps/web/src/shell/screen-registry.ts).

export interface ScreenDescriptor<TScreen = unknown> {
  /** Stable id, unique across all modules (e.g. "patient.detail"). */
  id: string;
  /** Router path; may include params, e.g. "/patients/:id". */
  path: string;
  /** Human title for navigation + document title. */
  title: string;
  /** Optional nav grouping label (e.g. "Clinical"). */
  navGroup?: string;
  /** Permission key gating nav visibility. The server remains the authoritative enforcer. */
  requiredPermission?: string;
  /**
   * Render inside the app-shell chrome (Top Nav + nav rail)? Default true. Set false for
   * pre-application surfaces shown standalone — Auth Flow, System Page (ADR-0030: "outside the App
   * Shell"). Chromeless screens are top-level routes and are omitted from the shell nav.
   */
  chrome?: boolean;
  /** The thing to render. apps/web binds TScreen = React.ComponentType. */
  screen: TScreen;
}

export interface ScreenRegistryModule<TScreen = unknown> {
  /** Owning module id (manifest). */
  moduleId: number;
  /** Module slug, e.g. "05-patient". */
  slug: string;
  screens: ScreenDescriptor<TScreen>[];
}

/** Mutable registry the shell reads; module web-slices register into it at boot. */
export interface ScreenRegistry<TScreen = unknown> {
  register(module: ScreenRegistryModule<TScreen>): void;
  modules(): ScreenRegistryModule<TScreen>[];
  screens(): ScreenDescriptor<TScreen>[];
}
