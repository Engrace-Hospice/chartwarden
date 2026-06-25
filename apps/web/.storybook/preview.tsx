// Storybook preview (R0.5) — loads the exact Lantern runtime the app uses: the self-hosted type
// trio + index.css (@theme tokens, wx-* layer, type-scale utilities, keyframes). The theme toolbar
// toggles the `.dark` class on <html> so every story can be checked in both light and twilight dark.
import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react-vite";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../src/index.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
  decorators: [
    withThemeByClassName({
      themes: { Light: "", Dark: "dark" },
      defaultTheme: "Light",
    }),
  ],
};

export default preview;
