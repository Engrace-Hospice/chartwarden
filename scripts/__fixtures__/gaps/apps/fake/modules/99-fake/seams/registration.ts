// FIXTURE — a module-local "M99_REQUIRED_SEAMS" array must NOT be trusted as the canonical bootstrap
// REQUIRED_SEAMS registry (ARCH-018: an unanchored regex matched ANY identifier merely ENDING in
// REQUIRED_SEAMS, so a module's own "seams I consume" documentation array falsely counted as a real
// registration). This array intentionally does not register anything.
export const M99_REQUIRED_SEAMS = ["SomeSeamNobodyReallyRegisters"];
