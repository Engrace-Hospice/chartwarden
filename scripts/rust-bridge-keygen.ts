#!/usr/bin/env bun
/**
 * CW-RUST-M02 — generate the Bun→Rust actor-assertion key pair (decision D2: the owner runs this, nobody else sees the
 * private key).
 *
 *   bun scripts/rust-bridge-keygen.ts [kid]
 *
 * Prints two lines:
 *   CW_ACTOR_SIGNING_KEY=<kid>=<base64url PKCS#8>   → write ONLY the part after the first `=` (i.e. `<kid>=<…>`) to a
 *       0600 file mounted as a compose secret on `api` alone, and point CW_ACTOR_SIGNING_KEY_FILE at it. NEVER put it in
 *       .env.production: compose injects that file into seven containers. Never commit, never paste anywhere.
 *   CW_ACTOR_PUBLIC_KEYS=<kid>=<base64url raw key>  → the `rust` service's environment; safe to share.
 * Rotation: generate with a new kid, add the new public key to CW_ACTOR_PUBLIC_KEYS (comma-separated), switch
 * CW_ACTOR_SIGNING_KEY, then drop the old public key once every api instance has restarted.
 */
import { generateKeyPairSync } from "node:crypto";

const kid = process.argv[2] ?? `k${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid)) throw new Error("kid must match [A-Za-z0-9_-]{1,64}");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url");
const pub = (publicKey.export({ format: "jwk" }) as { x: string }).x;
console.log(`CW_ACTOR_SIGNING_KEY=${kid}=${priv}`);
console.log(`CW_ACTOR_PUBLIC_KEYS=${kid}=${pub}`);
