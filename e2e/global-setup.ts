// e2e/global-setup.ts — fails fast with a clear message when the local stack isn't up, instead of
// every spec timing out independently on the first `page.goto`.
async function main(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  try {
    const res = await fetch(baseURL, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok && res.status !== 404) {
      throw new Error(`unexpected status ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `e2e global-setup: ${baseURL} is not reachable (${(err as Error).message}). Bring up the local stack first: \`bun run db:reset\` (or the individual \`db:up\`/\`db:migrate\`/\`db:seed:all\` steps it composes — see package.json), then \`bun run dev\` — see docs/START_PROJECT.md.`,
    );
  }
}

export default main;
