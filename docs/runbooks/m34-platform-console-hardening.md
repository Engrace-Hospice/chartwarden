# Platform console hardening (CW-AC-22): address allowlist and the `platform_ops` split

Rollout checklist for two changes that ship together. **Nothing here has been run.** Every step below is an operator step (production
configuration, role assignments to real people), done by a named person under a change ticket. A wrong allowlist locks every operator out
of the console API, so follow the order. **The order matters most for the roles: grant them BEFORE the release is merged** (step 2), because a
merge to `main` deploys and, from that moment, `platform_ops` can no longer do four duties.

| Change | What it does | Where |
| --- | --- | --- |
| Address allowlist | `PLATFORM_CONSOLE_ALLOWED_CIDRS` (unset = no gate). Set: a console request from another address is refused `403 PLATFORM_CONSOLE_ADDRESS_NOT_ALLOWED` and audited; any other route requested from another address is served **without the caller's platform roles and permissions** (audited as `m34.platform_console.authority_stripped`). A list that is set but unusable refuses every console request and strips everywhere. | `apps/backend/src/bootstrap/platform-console-allowlist.ts`, `platform-console-policy.ts`, `packages/auth/src/rbac/platform-authority-strip.ts` |
| Role split | `platform_ops` keeps data entry, support sessions and user lifecycle. Three roles of their own take the BAA upload and register write (`platform_baa_steward`), go-live approval (`platform_go_live_approver`) and tenant pricing (`platform_pricing_operator`). The approver may not share an account with another onboarding role (the grant CLI and a database trigger both refuse it). | `packages/auth/src/roles/templates.ts`, migration `1559_m34_platform_ops_role_split.sql` (expand: no hold, no outage window) |

## What the allowlist covers

The decision is made on the **matched route pattern**, so URL tricks cannot step around a prefix. Covered: `/api/v1/platform/*`,
`/api/v1/ops/*`, the M35 operator billing subtrees `/api/admin/{addons,dunning,plans,pricing,promos,refunds,revenue,subscriptions,usage,webhooks}`,
and the operator-only families `/api/v1/admin/{mdm,system,platform-medicaid-rules,state-rate-schedule-load}`, `/api/v1/admin/messaging/alert-deliveries`,
`/api/v1/admin/billing/npi-verifications` and `/api/admin/external-interfaces/nppes/sync-runs`. The list is `PLATFORM_CONSOLE_ROUTE_PREFIXES`; a family
goes in only when no tenant surface (apps/web, apps/portal) calls it.

**Every other route** (`/api/v1/orgs`, `/api/v1/reporting/admin/*`, the rest of `/api/admin/external-interfaces`, M32 AI safety, M38 terminology admin, and every tenant
route) cannot be refused by prefix, because tenant administrators use most of them. From an address outside the list, such a request instead **loses the caller's platform authority before
any authorization runs**: every reserved platform role (`platform_*`, `ai_safety_owner`, `superadmin`, and with it the `administrator` / `org_admin` a superadmin was expanded into, and the
`platform_alert_audience` binding) is taken off the request, and the permission resolver stops counting those roles' grants for it (it also skips its cache for that request, so a warm cache cannot
give them back). The route then judges the caller as the tenant user it would otherwise be: `/api/v1/orgs` lists the caller's own organization only, `/api/v1/reporting/admin/*` and the other
platform-only routes answer 403, and a user with no platform role is untouched and leaves no row. Each strip is audited (see Monitoring). An operator working from an unlisted address therefore
also stops receiving their tenant alert inbox (`platform_alert_audience`) until they are back on a listed one. When the variable is unset nothing is stripped.

**Not covered** (a network-level allow is the layer for these, and it is the owner's change): the sign-in and credential routes (`/api/auth/*`) an operator uses on the same hostname and the static console shell. None holds
platform authority to withhold, so this is exposure of the page and the sign-in and factor forms, not of a platform power; an address is not authentication, and MFA and step-up still apply. The Socket.IO realtime channel attaches to the HTTP server below Fastify's hooks and
is not touched either; it serves the caller's own channels by membership and reads no platform role.

The address is Fastify's `request.ip`: the socket peer, with `X-Forwarded-For` honoured only through hops in `TRUSTED_PROXY_CIDRS`. No header is
read for the decision. **The allowlist is only as good as `TRUSTED_PROXY_CIDRS`**: with the proxy missing from it, every request looks like it
comes from the proxy; with a range wider than the proxy in it, a client inside that range can choose its own address.
`deploy/production/.env.production.example` trusts `172.16.0.0/12` (every docker bridge) for nginx on the host: **before relying on the allowlist, narrow
it to the compose network's gateway or subnet.** Production refuses to boot with the allowlist set and no valid `TRUSTED_PROXY_CIDRS`
(`assertProductionEnv`, also run by `deploy.sh` before it migrates). A list is unusable, and so refuses the whole console, when an entry is not an IP
or CIDR, has a `/0`, is a keyword or hostname, carries a zone id, or spans public address space wider than a site: an entry must lie wholly inside private space (10/8, 172.16/12,
192.168/16, 100.64/10, loopback, link-local, ULA, the documentation ranges) or be a `/24` (IPv6 `/48`) or narrower, and an IPv6 range that overlaps `::ffff:0:0/96` (`::/80`, `::1/64`, ...) matches
IPv4 and is refused. `TRUSTED_PROXY_CIDRS` is held to the same rule when the allowlist is set, so a CDN-wide trusted list (every Cloudflare range, say) will refuse to boot: the allowlist
needs the proxy hop itself, not a provider's whole network.

## Needs a decision from the owner before anything is run

1. **The production CIDR list**: the office, VPN or bastion egress addresses the operators use. Include a second, independent path (a bastion or a second
   VPN) so one network outage does not lock everyone out. `203.0.113.0/24` is a documentation range, not a value to use.
2. **Who gets which role.** Each platform operator today holds `platform_ops` and with it every power. Decide for each named person:

   | Role | Powers | May not share an account with |
   | --- | --- | --- |
   | `platform_ops` | data entry, onboarding wizard (attest, skip, org profile, compliance officer), support sessions, user lifecycle, BAA register read | `platform_go_live_approver` |
   | `platform_baa_steward` | signed-BAA upload, platform BAA register (read and write) | `platform_go_live_approver` |
   | `platform_pricing_operator` | sign a tenant onto a plan, change its billing service mode | `platform_go_live_approver` |
   | `platform_go_live_approver` | approve / revoke go-live; reads the wizard, the tenant's clearinghouse choice and plan contract its console panel shows | all three above |

   `superadmin` still stands for every role by design and is outside the conflict rule; keep it to the named people ADR-0112 allows. The rule is per
   **account**: one person with two accounts is not detectable here, which is why the go-live guards keep comparing accounts (uploader, register writer,
   attester) as well. The console's tenant inventory (`GET /api/v1/platform/tenants`) remains `platform_ops`-only, so a duty-role account reaches a tenant by its link.
3. **Alerts.** Tenant alert-audience bindings are still sourced from `platform_ops` holders only, so an account holding only a duty role receives no tenant alerts.

## Order of work

1. **Inventory (read-only).** On the production database:

   ```sql
   -- who holds platform_ops today, on which membership
   SELECT u.email, m.id AS membership_id, o.slug AS org, mr.expires_at
     FROM membership_role mr
     JOIN role r ON r.id = mr.role_id AND r.organization_id IS NULL AND r.key = 'platform_ops'
     JOIN membership m ON m.id = mr.membership_id
     JOIN "user" u ON u.id = m.user_id
     JOIN organization o ON o.id = m.organization_id
    WHERE m.status = 'active' AND (mr.expires_at IS NULL OR mr.expires_at > now());
   ```

   Record the result and the decisions from the section above on the change ticket.
2. **Grant the new roles to the named operators, BEFORE the merge**, from a checkout of this release. The roles confer nothing until the release is live, so this is safe
   early, and a grant the conflict rule refuses fails here, not in a window:

   ```bash
   DATABASE_ADMIN_URL=<owner connection> bun run db:platform-role grant \
     --email <operator email> --org <platform org slug> --role platform_baa_steward --ticket CHG-<n>
   # likewise platform_go_live_approver and platform_pricing_operator for the people chosen.
   ```

   An account that holds `platform_ops` cannot be granted the approver (and the reverse): the approver is a different person's account. The CLI prints the template
   permissions it granted; it warns if the permission mirror lacks a key (run `bun run db:sync:permissions`). Migration 1559's trigger refuses the same pair for any other writer,
   but it arrives with the merge, so until then the CLI is the only check.

   **Do not merge until each new role has a holder** (a merge deploys at once, and a duty with no holder is unavailable):

   ```sql
   SELECT r.key AS role, count(DISTINCT m.user_id) AS holders
     FROM role r
     LEFT JOIN membership_role mr ON mr.role_id = r.id AND (mr.expires_at IS NULL OR mr.expires_at > now())
     LEFT JOIN membership m ON m.id = mr.membership_id AND m.status = 'active'
    WHERE r.organization_id IS NULL
      AND r.key IN ('platform_baa_steward', 'platform_go_live_approver', 'platform_pricing_operator')
    GROUP BY r.key;
   ```

   Every row must show at least 1. A role row that does not exist yet means nobody was granted it.

   **Each grantee needs a passkey enrolled before the merge.** The three duty roles require a passkey, as `platform_ops` does
   (`PASSKEY_REQUIRED_ROLE_KEYS`; it binds while `CHARTWARDEN_MFA_ENFORCEMENT` is on, which production has). An operator with a duty role and only an
   authenticator-app factor is held at enrolment (`403 MFA_ENROLMENT_REQUIRED`) on the first request after the release is live: have each person
   enrol a passkey in the console now, and confirm it, as part of this step. The go-live approver is by rule a different account from `platform_ops`, so it is the
   likeliest to have none.
3. **Merge.** Migration 1559 is declared `-- compat: expand` (default predicates and a trigger; nothing dropped), so `deploy.sh` applies it normally: no `--hold-contract`
   halt and no hand-applied step. From the moment the release is live: the BAA upload and register write need `platform_baa_steward`, go-live approval needs
   `platform_go_live_approver`, tenant pricing needs `platform_pricing_operator`; `platform_ops` is refused `403` on those four even though its row still holds the keys
   (inert until step 6). If step 2 was skipped for any of them, that duty is unavailable until its role is granted; a grant takes effect within 5 minutes
   (role keys are re-read on every request, cached permission sets live up to 5 minutes).
4. **Verify the split.** With one account per role:
   - the approver loads the go-live panel (wizard, clearinghouse and plan contract all read) and approves a go-live on a test tenant; `platform_ops`, the steward and the pricing operator are each refused `403`;
   - the steward uploads a BAA and writes the register; `platform_ops` reads the register but is refused the write;
   - the pricing operator signs a plan; `platform_ops` is refused;
   - no account holds the approver beside another onboarding role (this must return no rows; the trigger now refuses a new pair, this finds one a gap before the merge could have left):

     ```sql
     SELECT m.user_id, array_agg(DISTINCT r.key ORDER BY r.key) AS roles
       FROM membership_role mr
       JOIN membership m ON m.id = mr.membership_id
       JOIN role r ON r.id = mr.role_id AND r.organization_id IS NULL
      WHERE (mr.expires_at IS NULL OR mr.expires_at > now())
        AND r.key IN ('platform_ops', 'platform_baa_steward', 'platform_pricing_operator', 'platform_go_live_approver')
      GROUP BY m.user_id
     HAVING bool_or(r.key = 'platform_go_live_approver') AND count(DISTINCT r.key) > 1;
     ```
   - holders per key (each moved key should show the new role, plus `platform_ops` until step 6):

     ```sql
     SELECT rp.permission_key, array_agg(DISTINCT r.key) AS roles
       FROM role_permission rp JOIN role r ON r.id = rp.role_id
      WHERE rp.permission_key IN ('tenant_baa_document.upload_platform','platform_tenant_baa.write_platform',
                                  'go_live.approve_platform','subscription.onboard_platform')
      GROUP BY rp.permission_key;
     ```
5. **Turn the allowlist on, last and alone.** Only after step 4 passes:
   1. Confirm `TRUSTED_PROXY_CIDRS` in `.env.production` lists exactly the reverse proxy hops (narrow `172.16.0.0/12` as above) and the proxy sets `X-Forwarded-For` with
      `$proxy_add_x_forwarded_for` (`deploy/production/nginx/chartwarden-platform-proxy.conf` does).
   2. Set `PLATFORM_CONSOLE_ALLOWED_CIDRS=<list>` in `.env.production` (`deploy/production/.env.production.example` has the line). Include the address you are working from.
   3. Run the deploy's env check (`assertProductionEnv`; `deploy.sh` runs it first) and restart `api`.
   4. **From a listed address** open the console and load a tenant: it works. **From an unlisted one** (a phone hotspot) the console API answers `403`. Then read the refusal:

      ```sql
      SELECT created_at, correlation_id, retention_class, context
        FROM audit_event WHERE event_type = 'm34.platform_console.access_refused'
       ORDER BY created_at DESC LIMIT 10;
      ```

      `context.sourceIp` must be the unlisted address you used. If it shows the proxy's address, `TRUSTED_PROXY_CIDRS` is wrong: unset the variable (below), fix it, repeat.
   5. **A route outside the console, from an unlisted address:** as an operator who also holds a tenant role, `GET /api/v1/orgs` answers only that tenant's own organization (from a listed address it answers every
      organization), and `GET /api/v1/reporting/admin/lag` answers `403`. Then read the strip:

      ```sql
      SELECT created_at, correlation_id, retention_class, context
        FROM audit_event WHERE event_type = 'm34.platform_console.authority_stripped'
       ORDER BY created_at DESC LIMIT 10;
      ```

      `context.sourceIp` is the unlisted address, `context.strippedRoleKeys` the platform roles the operator held, `context.route` the first route the strip was made on in that minute.
6. **Clean up (when every operator is on the new roles).** Take the four now-inert keys off the platform-owned `platform_ops` row, so the console stops showing buttons that answer 403. This is a
   `contract` change for the previous release, which is why it is a separate step and not part of the migration:

   ```sql
   DELETE FROM role_permission rp USING role r
    WHERE rp.role_id = r.id AND r.organization_id IS NULL AND r.key = 'platform_ops'
      AND rp.permission_key IN ('tenant_baa_document.upload_platform', 'platform_tenant_baa.write_platform',
                                'go_live.approve_platform', 'subscription.onboard_platform');
   ```

   Run it in a transaction on the owner connection that first sets the change ticket and the platform organization, as the grant CLI does
   (`SELECT set_config('app.correlation_id', 'CHG-<n>', true), set_config('app.org_id', '<platform org id>', true)`), so the M4 trigger rows carry them. It deletes up to four rows
   (fewer if a key was never on the row): check the reported count before `COMMIT`.
   A fresh `db:platform-role grant platform_ops` already grants the new template, so only a database that predates this release needs the step.
7. **Optional second layer (owner's change, not made here):** an `allow`/`deny` list on the platform nginx vhost closes what the application list does not cover (the sign-in routes and the
   console shell). The repo vhost is edited in place on the host per `deploy/production/README.md`; never overwrite the live vhost.

## If operators are locked out

- **Wrong or unusable allowlist:** remove `PLATFORM_CONSOLE_ALLOWED_CIDRS` from `.env.production` and restart `api` (`docker compose up -d api`). No deploy or migration is needed; the gate is off again at once.
  A boot that refuses with a `PLATFORM_CONSOLE_ALLOWED_CIDRS` problem means the value is unusable: fix or remove it.
- **A role grant is wrong:** `bun run db:platform-role revoke ...` then grant the right one. Role keys are re-read on every request; cached permission sets expire within 5 minutes.
- **A duty is unavailable because nobody holds its role yet:** grant the role (step 2). In an emergency, a `superadmin` holds every role.
- **Put the four keys back on `platform_ops`** (only to return to the previous release):

  ```sql
  INSERT INTO role_permission (organization_id, role_id, permission_key)
  SELECT NULL, r.id, k.key
    FROM role r, (VALUES ('tenant_baa_document.upload_platform'), ('platform_tenant_baa.write_platform'),
                         ('go_live.approve_platform'), ('subscription.onboard_platform')) AS k(key)
   WHERE r.organization_id IS NULL AND r.key = 'platform_ops'
  ON CONFLICT (role_id, permission_key) DO NOTHING;
  ```

## Monitoring

A refusal that carries a session writes a platform-scoped `audit_event` (`m34.platform_console.access_refused`, severity `warn`, compliance retention, no tenant), one per user, source address and
reason a minute (a further refusal inside the minute adds to `suppressedSincePreviousRow` on that key's next row), at most 10 a minute per user and 300 in all. The row's
`actor_user_id` and `source_ip` columns are empty (it is written by the system actor through the platform writer): the address, method, matched route template and the operator's user and
organization ids are in `context`, so review it with the `context` fields (ops runbook 16.4). A refusal naming a known operator is usually a changed office or VPN address.

A **strip** (a platform operator's request to any other route from an unlisted address) writes `m34.platform_console.authority_stripped` the same way (platform-scoped, severity `warn`, outcome
`denied`, compliance retention, no tenant) through the same throttle: one row per user, source address and reason a minute, with the repeats counted in `suppressedSincePreviousRow` on that key's next
row, so a strip is never one undeletable row per request. `context` carries the address, method, matched route template (`unmatched` for a path that matches no route), the operator's user and
organization ids and `strippedRoleKeys` (role-catalog names, never a person's data). The strip itself is made before the row is written, so a failed or slow audit write is logged and never leaves the
authority in place. The audit is lossy under load by design (it shares the refusals' 10 rows a minute per user and 300 a minute in all, and the repeat count lives in the API process): a stolen session rotating more
than ten addresses a minute leaves no row past the tenth, and the stripped caller holds tenant authority only, with the routes it uses audited on their own. A strip naming a known operator is
usually a changed office or VPN address (a list that is valid but wrong demotes operators on every route, so step 5.5 above is not optional); one naming nobody you know is the signal this
control exists for. A caller with no platform role
(every tenant user) is never stripped and leaves no row.

An **anonymous** refusal (a scan or probe; the routes are public) is held to one row per source address and reason a minute and 60 a minute in all, under the operational retention class (one year).
The counts live in the API process and are lost on a restart; past a limit a refusal leaves no row of its own, and the first one a window turns away logs one process warning
(`platform console refusals are being held back from the audit log`); only repeats of a key that already has a row are counted on its next row, so a refusal a limit turns away for a new key
leaves nothing but that warning. A write that definitely fails gives its slot back, so the next refusal for that key tries again and logs again; one that merely times out keeps it (it may still commit).
The audit write is bounded to 2 seconds, so a database that stops answering cannot hold the response; a failed write is
logged and the request is still refused.
