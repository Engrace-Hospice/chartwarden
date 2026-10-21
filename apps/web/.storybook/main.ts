// Storybook (R0.5) — visual reference for the @chartwarden/ui library against the Lantern system.
// Hosted in apps/web because the Lantern tokens (CSS vars) + self-hosted fonts live here; stories
// import components from "@chartwarden/ui" and render them under the real index.css theme. react-vite
// reuses apps/web/vite.config.ts (Tailwind v4 plugin), so the design layer resolves exactly as the
// app sees it. Run `bun run storybook`; CI builds via `bun run build-storybook`.
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-themes"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
