# Worker coexistence and cutover

When account response capture is active, M23 `ack_999` and `ack_277ca` provider-scoped Claim.MD polling is skipped; other clearinghouse vendors are unchanged. M41's existing Claim.MD legacy acknowledgment worker already no-ops. M25's existing `shouldRunLegacyClaimMdEraPull` coordinates legacy ERA pulls against new capture/delivery flags. Resolver, acknowledgment dispatch, ERA capture, and delivery remain independent flags.

Configuration cannot coordinate old and new deployed versions. Before any controlled cutover, quiesce old Claim.MD pollers across all worker versions, retain legacy cursors, verify account/environment cursor bootstrap, and roll forward only after shadow comparison. Rollback requires quiescing account capture before restoring legacy polling; never run both versions concurrently without a verified shared lease protocol.
