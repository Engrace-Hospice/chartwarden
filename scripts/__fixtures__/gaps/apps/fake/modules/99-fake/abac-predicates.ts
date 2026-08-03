// FIXTURE — the aliased getSeam-cast indirection consuming a seam nothing registers. Proves
// check-fitness-gaps.ts's widened alias detection catches this form, not just a literal getSeam call
// (ARCH-018 — the shape M31's abac-predicates.ts used before its seams became real, typed calls).
import { getSeam } from "../../../bootstrap";

const rawSeam = getSeam as unknown as (name: string) => unknown;

export const badRead = () => rawSeam("TotallyUnregisteredSeam");
