// apps/admin/src/modules/36-messaging/settings — shared state chrome for the three M36 settings screens:
// page head and the success/error banner (loading / error / empty / no-access states live in ../ui). Shared `wx-*` classes
// + Tailwind utilities only; no inline styles.
import { InlineAlert } from "@wardenx/ui";
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

/** Both live regions stay mounted so a banner appearing or changing is announced (a region inserted with its text is not). */
export function BannerView({ banner }: { banner: Banner | null }): JSX.Element {
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: <output> is the shared loading-spinner marker (screens-smoke settles on none) */}
      <div role="status">
        {banner?.ok ? <InlineAlert tone="success">{banner.message}</InlineAlert> : null}
      </div>
      <div role="alert">
        {banner && !banner.ok ? <InlineAlert tone="error">{banner.message}</InlineAlert> : null}
      </div>
    </>
  );
}
