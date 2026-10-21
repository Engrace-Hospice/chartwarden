// @chartwarden/cost-report — M27 ECR/PI generation barrel (D11, §1.1 / §2.4). Re-exports the pure record
// model + fixed-field kernel (`records`), the ECR text writer (`writer`), the Print Image renderer
// (`pi-renderer`), and the snapshot → artifacts adapter (`snapshot-to-ecr`) the `ecr-generation` worker
// drives. PURE DOMAIN throughout — no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`,
// no MinIO/M22 code (that storage hop is the outbox/worker layer in P3); no PHI (D18).
export * from "./records";
export * from "./writer";
export * from "./pi-renderer";
export * from "./snapshot-to-ecr";
