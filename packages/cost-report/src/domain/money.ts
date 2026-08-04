// @wardenx/cost-report — M27 money/ratio kernel (D8). Re-exports the shared penny-exact CENTS kernel —
// see packages/shared/src/money/kernel.ts (ARCH-021) — that every Phase-2 worksheet, allocation,
// apportionment, and settlement file imports: `toDecimal`/`fromDecimal`, `sumCents`, `ratio`, and the
// largest-remainder `allocateProportional`. Cost-report math is REGULATORY math: a cent off in a
// settlement line is a real cap-settlement consequence and an audit trigger, so all amounts cross every
// boundary as INTEGER CENTS and the only fractional arithmetic is internal to the kernel, via
// `decimal.js`, immediately rounded back to whole cents with an EXPLICIT, deterministic rounding mode.
// This module previously carried a verbatim copy of the kernel (byte-identical to
// packages/billing/src/domain/money.ts); both now depend on the single shared implementation so a
// rounding/allocation fix lands once for every regulatory calculator.
export * from "@wardenx/shared/money";
