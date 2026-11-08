// apps/admin/src/modules/36-messaging/settings — shared state chrome for the three M36 settings screens:
// page head and the success/error banner (loading / error / empty / no-access states live in ../ui). Shared `wx-*` classes
// only; no Tailwind utilities, no inline styles.
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";

export function PageHead({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <header className="wx-page-head">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
    </header>
  );
}

export interface Banner {
  readonly ok: boolean;
  readonly message: string;
}

/** The banner is announced by InlineAlert itself (an error is `role="alert"`, a success an `<output>`); a wrapper live region would nest a second one. */
export function BannerView({ banner }: { banner: Banner | null }): JSX.Element | null {
  if (!banner) return null;
  return <InlineAlert tone={banner.ok ? "success" : "error"}>{banner.message}</InlineAlert>;
}
