// @wardenx/ui — feature-flag-provider (spec §5.1). Holds the org's resolved flags
// (GET /api/v1/system/feature-flags). Phase-1 scope flags stay default-off, so an unknown
// key resolves to false (PHASE_1_PLAN §3 — no route may hard-depend on a flag being on).
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";
import type { FeatureFlags } from "../types";

export interface FeatureFlagContextValue {
  flags: FeatureFlags;
}

const FeatureFlagContext = createContext<FeatureFlagContextValue | null>(null);

export interface FeatureFlagProviderProps {
  flags: FeatureFlags;
  children: ReactNode;
}

export function FeatureFlagProvider({ flags, children }: FeatureFlagProviderProps): JSX.Element {
  return <FeatureFlagContext.Provider value={{ flags }}>{children}</FeatureFlagContext.Provider>;
}

export function useFeatureFlagContext(): FeatureFlagContextValue {
  const ctx = useContext(FeatureFlagContext);
  if (ctx === null) {
    throw new Error("useFeatureFlag must be used within a <FeatureFlagProvider>");
  }
  return ctx;
}
