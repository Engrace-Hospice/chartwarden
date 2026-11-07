# ERA capture and cursor

The proposed durable identity is `(vendor, account_reference, usage, stream_kind='eras')`; it is independent of BIL-1.1's `last_responseid`. Migration 1356 creates `claimmd_era_stream` and `claimmd_era_inbox` with no seed/bootstrap cursor. An operator must choose and audit the initial cursor; no code in this change selects zero or jumps to newest.

The coordinator gathers pages at a fixed input cursor and calls the commit port only after a terminal short page and stable `last_eraid`. `claimmd-era-store.ts` implements the commit port: it checks the stream lease generation, upserts encrypted source metadata with `(stream_id, era_id)` uniqueness, and advances the cursor in the same transaction. A crash before commit safely rescans. The store has a 90-second lease with generation fencing; the capture service separately retries discovered rows after failed detail downloads.

Inbox columns hold encrypted source metadata, original 835, and structured detail ciphertext plus key IDs/digests. The ERA store encrypts metadata, original 835 files, and structured details with separate AAD item IDs before writes. The BIL-1.1 M23 response cipher reuses the common helper with its existing response AAD.

Recovery: on any page failure or changing watermark the coordinator returns without cursor commit. Capture failure changes only the inbox capture state and retains the discovered identity for the next tick. Vendor page snapshot behavior must be tested with synthetic ERA arriving during page traversal; unchanged watermark is not vendor-certified proof of snapshot stability.
