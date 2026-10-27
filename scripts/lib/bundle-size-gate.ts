// Shared measurement for apps/{web,admin,portal}/scripts/check-bundle-size.ts (#848).
// Fails closed: every eager asset in index.html must resolve inside outDir, and the total must be > 0.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BundleRow {
  readonly path: string;
  readonly bytes: number;
}
export interface BundleMeasurement {
  readonly rows: readonly BundleRow[];
  readonly total: number;
}

const ASSET_RE = /<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+\.js)"/g;

/** `base` is the Vite base without trailing slash ("" for root). Throws on anything unmeasurable. */
export function measureInitialBundle(distDir: string, base: string): BundleMeasurement {
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) throw new Error(`Not found: ${indexHtml} — build the app first.`);
  const urls = new Set<string>();
  for (const m of readFileSync(indexHtml, "utf8").matchAll(ASSET_RE)) urls.add(m[1] ?? "");
  if (urls.size === 0) {
    throw new Error("No <script>/<link modulepreload> assets found in index.html — nothing to measure.");
  }
  const prefix = `${base}/`;
  const rows: BundleRow[] = [];
  for (const url of urls) {
    if (!url.startsWith(prefix)) {
      throw new Error(`Asset ${url} is external or not under the configured base "${prefix}" — cannot measure.`);
    }
    const abs = join(distDir, url.slice(prefix.length));
    if (!existsSync(abs)) {
      throw new Error(`Asset ${url} referenced by index.html is missing from ${distDir} (${abs}).`);
    }
    rows.push({ path: url, bytes: statSync(abs).size });
  }
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  if (total === 0) throw new Error("Measured a zero-byte initial bundle — refusing to pass.");
  return { rows: [...rows].sort((a, b) => b.bytes - a.bytes), total };
}
