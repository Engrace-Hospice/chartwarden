// apps/backend/src/modules/10-hope — M10 (HOPE Engine) backend module surface.
//
// M10-T05 lands the three §2 / D10 owned seams (HopeTimepointProvider / HopeJ2051Provider /
// HopeSubmissionProvider) registered into the M1 registry via `registerHopeSeams` (driven from the
// composition root's wireModuleSeams()). Routes, outbox/jobs, eraser, and screens land in later M10 tasks.
export {
  type HopeSeamDeps,
  type HopeSeamSeed,
  type HopeSeamStore,
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
  createInMemoryHopeSeamStore,
  getHopeJ2051Provider,
  getHopeSubmissionProvider,
  getHopeTimepointProvider,
  registerHopeSeams,
} from "./seams/index";
