// apps/backend/src/modules/16-bereavement/routes/contacts.routes.ts — M16 (§4.1) routes 11–18, 26, 32:
// the per-survivor surface. The CONTACT, not the plan, is the operational unit — consent, opt-out, risk
// tier and schedule are all per-person (D1) — so this is where the §2.3 machine is driven from.
//
// Two routes here are reachable by someone who is not staff. §4.1 rows 14 / 15 read
// "`bereavement_window` ∨ `portal_self_service` (contact's own session)", so they compose {@link ABAC_ANY}
// over the two predicates and take `mutatingActorOf` rather than `writeActorOf`: a bereaved person's M31
// session carries NO workforce membership, and §3.3.8 says exactly that — the self-service opt-out row
// records `recorded_by_user_id = NULL`. Requiring a membership here would have made the portal opt-out
// button 403 for the only people it exists for.
import type { FastifyInstance } from "fastify";
import { mutatingActorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import {
  ABAC_ANY,
  ABAC_DISCIPLINE_SELF,
  ABAC_PORTAL_SELF,
  ABAC_WINDOW_CONTACT,
  ABAC_WINDOW_PLAN,
  P,
} from "./guards";
import {
  ConfirmContactBody,
  ContactParams,
  CreateContactBody,
  DismissUnreachableProposalBody,
  FlagComplicatedGriefBody,
  LogDirectContactBody,
  MarkDeceasedBody,
  MarkUnreachableBody,
  OptOutBody,
  PlanParams,
  ReferExternalBody,
  RescindOptOutBody,
  UpdateContactBody,
  parse,
} from "./m16-typebox";
import type { M16WriteService } from "./write-service";

export interface ContactRouteDeps {
  readonly writeService: M16WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();

export function registerBereavedContactRoutes(app: FastifyInstance, deps: ContactRouteDeps): void {
  const { writeService } = deps;

  // 11 — add a bereaved contact to an open plan (lands `proposed`; route 13 confirms it).
  app.post(
    "/api/v1/bereavement/plans/:planId/contacts",
    {
      preHandler: [
        P("bereavement.contact.create"),
        ABAC_WINDOW_PLAN("bereavement.contact.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CreateContactBody, request.body);
      const created = await writeService.createContact(writeActorOf(request), planId, body);
      return reply.code(201).send(created);
    },
  );

  // 12 — update preferences / channels (§4.1: `If-Match` required — a blind channel overwrite could send a
  //      condolence letter to an address the family already corrected).
  app.patch(
    "/api/v1/bereavement/contacts/:contactId",
    {
      preHandler: [
        P("bereavement.contact.update"),
        ABAC_WINDOW_CONTACT("bereavement.contact.update"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(UpdateContactBody, request.body);
      return writeService.updateContact(writeActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 13 — proposed → active. The D6 consent verdict is resolved through M39 server-side and fails CLOSED:
  //      an unconsented condolence call to a grieving family is the harm the rule exists to prevent.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/confirm",
    {
      preHandler: [
        P("bereavement.contact.confirm"),
        ABAC_WINDOW_CONTACT("bereavement.contact.confirm"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(ConfirmContactBody, request.body);
      return writeService.confirmContact(writeActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 14 — per-contact opt-out (D9). Staff OR the survivor's own portal session.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/opt-out",
    {
      preHandler: [
        P("bereavement.contact.opt_out"),
        ABAC_ANY(
          ABAC_WINDOW_CONTACT("bereavement.contact.opt_out"),
          ABAC_PORTAL_SELF("bereavement.contact.opt_out"),
        ),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(OptOutBody, request.body);
      return writeService.optOutContact(mutatingActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 15 — undo an opt-out. The D9 90-day window binds the SELF-SERVICE path; a counselor rescind with a
  //      documented reason is not bound by it (§2.3), because a survivor who calls back at month 5 asking
  //      to re-enrol should not be told the software forgot how.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/rescind-opt-out",
    {
      preHandler: [
        P("bereavement.contact.rescind_opt_out"),
        ABAC_ANY(
          ABAC_WINDOW_CONTACT("bereavement.contact.rescind_opt_out"),
          ABAC_PORTAL_SELF("bereavement.contact.rescind_opt_out"),
        ),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(RescindOptOutBody, request.body);
      return writeService.rescindOptOut(mutatingActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 16 — the survivor themselves died. §2.3's only terminal state, so the verification is mandatory.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/mark-deceased",
    {
      preHandler: [
        P("bereavement.contact.mark_deceased"),
        ABAC_WINDOW_CONTACT("bereavement.contact.mark_deceased"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(MarkDeceasedBody, request.body);
      return writeService.markContactDeceased(writeActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 17 — accept the nightly detector's 3-strikes proposal. The threshold is enforced by the §2.3 machine,
  //      so a UI that fires it early is refused rather than silently trusted.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/mark-unreachable",
    {
      preHandler: [
        P("bereavement.contact.mark_unreachable"),
        ABAC_WINDOW_CONTACT("bereavement.contact.mark_unreachable"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(MarkUnreachableBody, request.body);
      return writeService.markContactUnreachable(writeActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 34 — "keep trying": the counselor declines the detector's unreachable proposal. Same decision authority as
  //      route 17, so it shares `bereavement.contact.mark_unreachable`; no status change, no event.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/dismiss-unreachable-proposal",
    {
      preHandler: [
        P("bereavement.contact.mark_unreachable"),
        ABAC_WINDOW_CONTACT("bereavement.contact.mark_unreachable"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(DismissUnreachableProposalBody, request.body);
      return writeService.dismissUnreachableProposal(writeActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 18 — §7.7 complicated grief / suicidal ideation. Ends the M16 program for this survivor and routes
  //      them to the named M40 external resource; §4.1 adds `discipline_can_provide_bereavement(self)`.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/flag-complicated-grief",
    {
      preHandler: [
        P("bereavement.contact.flag_complicated_grief"),
        ABAC_WINDOW_CONTACT("bereavement.contact.flag_complicated_grief"),
        ABAC_DISCIPLINE_SELF("bereavement.contact.flag_complicated_grief"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(FlagComplicatedGriefBody, request.body);
      return writeService.flagComplicatedGrief(writeActorOf(request), contactId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 26 — an ad-hoc contact-log row for a touchpoint that never had a scheduled outreach. §2.5 is STRICTER
  //      here than the schedule generator: an ad-hoc kind must be one the survivor allows, because a
  //      counselor making an extra call has no regulatory obligation to override the family's wishes.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/log-direct",
    {
      preHandler: [
        P("bereavement.contact_log.write"),
        ABAC_WINDOW_CONTACT("bereavement.contact_log.write"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(LogDirectContactBody, request.body);
      const logged = await writeService.logDirectContact(writeActorOf(request), contactId, body);
      return reply.code(201).send(logged);
    },
  );

  // 32 — log a referral to an M40 external grief resource WITHOUT ending the program (contrast route 18,
  //      which does). Both exist because "we gave them a number" and "we handed their care over" are
  //      different clinical facts, and collapsing them would misreport §7.7 on the survey record.
  app.post(
    "/api/v1/bereavement/contacts/:contactId/refer-external",
    {
      preHandler: [
        P("bereavement.referral.create"),
        ABAC_WINDOW_CONTACT("bereavement.referral.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { contactId } = parse(ContactParams, request.params);
      const body = parse(ReferExternalBody, request.body);
      const logged = await writeService.referExternal(writeActorOf(request), contactId, body);
      return reply.code(201).send(logged);
    },
  );
}
