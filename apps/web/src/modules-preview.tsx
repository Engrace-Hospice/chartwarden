// Dev-only visual harness (mock ApiClient, no backend) for the module screens under review. Not a build entry:
// vite.config.ts builds index.html only. Open `vite` at /modules-preview.html?m=15[&at=<route>][&dark].
// Each module contributes its real screen registry plus typed fixtures (see ./modules-preview/).
import "@fontsource-variable/inter";
import "./index.css";
import {
  ApiClientProvider,
  FeatureFlagProvider,
  SystemStatusProvider,
  ToastProvider,
} from "@chartwarden/ui";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { preview15 } from "./modules-preview/m15";
import { preview16 } from "./modules-preview/m16";
import { preview19 } from "./modules-preview/m19";
import { preview20 } from "./modules-preview/m20";
import { createMockClient } from "./modules-preview/mock-client";
import type { ModulePreview } from "./modules-preview/types";
import { SessionProvider } from "./shell/session";
import type { Session } from "./shell/session";

const previews: Record<string, ModulePreview> = {
  "15": preview15,
  "16": preview16,
  "19": preview19,
  "20": preview20,
};

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.has("dark"));

const root = document.getElementById("root");
if (!root) throw new Error("modules-preview: #root is missing");
const preview = previews[params.get("m") ?? ""];

if (!preview) {
  root.textContent = `modules-preview: pass ?m=${Object.keys(previews).join("|")}`;
} else {
  const session: Session = {
    userId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    membershipId: "m-lopez",
    displayName: "Maria Lopez",
    permissions: [
      ...preview.screens.screens.flatMap((s) =>
        s.requiredPermission ? [s.requiredPermission] : [],
      ),
      ...preview.extraPermissions,
    ],
  };
  createRoot(root).render(
    <SessionProvider session={session}>
      <MemoryRouter initialEntries={[params.get("at") ?? preview.start]}>
        <ApiClientProvider client={createMockClient(preview.fixtures)}>
          <FeatureFlagProvider flags={{}}>
            <SystemStatusProvider components={[]}>
              <ToastProvider>
                <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>
                  <Routes>
                    {preview.screens.screens.map((s) => (
                      <Route
                        key={s.id}
                        path={s.path}
                        element={
                          <Suspense fallback={null}>
                            <s.screen />
                          </Suspense>
                        }
                      />
                    ))}
                  </Routes>
                </div>
              </ToastProvider>
            </SystemStatusProvider>
          </FeatureFlagProvider>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}
