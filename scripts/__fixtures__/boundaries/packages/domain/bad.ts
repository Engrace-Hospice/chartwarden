// FIXTURE — intentional violation: the pure domain leaf imports packages/db.
// Proves dependency-cruiser goes RED (domain-is-pure / module boundary).
import { x } from "../db/index";
export const y = x;
