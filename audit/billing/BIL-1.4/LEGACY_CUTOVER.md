# Legacy cutover

The existing M25 clearinghouse pull enumerates tenant provider entities, keeps per-provider cursors, calls `fetchRemittances`, and passes raw 835 to `receiveAdvice`. For Claim.MD that is structurally distinct from account-wide discovery and can reach the posting consumer. Other vendors share this M25 pull path.

The root uses `shouldRunLegacyClaimMdEraPull`: it returns false for Claim.MD when new capture or delivery is enabled and preserves non-Claim.MD vendor pulls. Capture is wired but defaults off; delivery fails startup until M25 staging exists. No SFTP/manual import is removed or altered, and no historical rows/cursors are changed.

Before cutover: inventory existing ERA by source and provider in a private, audited read-only report; reconcile API/SFTP/manual duplicate identities; operator selects bootstrap cursor; enable capture only; certify backlog and retries; resolve ownership; then separately enable M25 staging. Rollback means disable new workers and preserve inbox/cursors; do not reset cursors or delete captured evidence. Existing per-provider Claim.MD path must remain disabled while account-wide capture owns the source.
