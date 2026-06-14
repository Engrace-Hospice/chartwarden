// @wardenx/backend — Fastify host entry (M1). Phase 0: builds the server (running the
// seam/eraser boot gate) and exposes it. No feature routes yet — modules mount under
// src/modules/NN-slug/ in Phase 1.
import { buildServer } from "./bootstrap/index";

export { buildServer };
export * from "./bootstrap/index";

// Start only when run directly (not when imported by tests/tooling).
// `import.meta.main` is a Bun runtime flag; cast keeps tsc happy without bun-types.
if ((import.meta as { main?: boolean }).main) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
