// @chartwarden/ui — shared Tailwind config seed (spec §5.1 theme/tailwind.config.ts). Each
// frontend app spreads this into its own tailwind.config to inherit WardenX brand tokens.
// Typed locally (not against `tailwindcss`) so the leaf adds no build-time dependency; the
// shape is the subset every app extends.
import { brandColors } from "../../core/theme/colors";

export interface SharedTailwindConfig {
  theme: {
    extend: {
      colors: Record<string, string>;
    };
  };
}

export const sharedTailwindConfig: SharedTailwindConfig = {
  theme: {
    extend: {
      colors: {
        brand: brandColors.primary,
        surface: brandColors.surface,
        muted: brandColors.muted,
      },
    },
  },
};

export default sharedTailwindConfig;
