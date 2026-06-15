// @wardenx/ui — use-feature-flag (spec §5.1). Resolves a single flag for the current org.
// Unknown / unset keys resolve to `false` (Phase-1 scope flags are default-off).
import { useFeatureFlagContext } from "../providers/feature-flag-provider";

export function useFeatureFlag(key: string): boolean {
  const { flags } = useFeatureFlagContext();
  return flags[key] ?? false;
}
