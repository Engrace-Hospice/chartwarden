-- compat: expand
-- M8 visit-note drafting (ADR-0114): the database-side guards the fresh DB review found missing or bypassable (C5, D1-D7). Every statement is
-- CREATE OR REPLACE of a guard function from 1517 / 1521 / 1523, one new BEFORE INSERT trigger on each of two tables, and
-- CREATE OR REPLACE TRIGGER (PostgreSQL 14+) where an existing trigger must also fire on UPDATE: nothing is removed, no table or column changes,
-- and the previous release (which only ever writes the legal shapes below) keeps working on it. The 1517-1524 files are not edited.
--
--  D1  1521 `hearthnote_assembled_output_frozen_after_sign`: it resolved the parent from NEW, so `UPDATE ... SET encounter_id = <a draft
--      encounter>, final_cipher = x WHERE id = <signed pin>` passed (the new parent was a draft), and re-parenting alone detached the signed
--      pin from its note. Now the pin's identity is fixed: encounter_id, addendum_id, kind and organization_id never change (the table has
--      no path that does), and part2_derived does not change once the parent read from OLD is signed / cosign_pending / cosigned (sign's own
--      write of the flag and the ciphers runs while the encounter is still `finalized`). The cipher freeze is as before, now also read from OLD.
--  D2  nothing guarded INSERT, and readers take the NEWEST `primary_finalize` pin, so a second pin replaced the signed one. A BEFORE INSERT
--      guard: the kind matches the parent column (primary_finalize with encounter_id, addendum_finalize with addendum_id), the parent is in the
--      row's organization (an unreadable parent fails closed), a primary pin is refused once the encounter is signed / cosign_pending /
--      cosigned / voided (finalize flips draft to `finalized` BEFORE it pins, so `finalized` stays writable), and an addendum pin tests the
--      ADDENDUM (finalizeAddendum flips it to `finalized` before it pins; refused once it is signed or voided), never the parent, which is
--      already signed by then.
--  D3  1523 `hearthnote_signed_section_org_guard`: an ORIGINAL sealed row can be written only while its encounter is `finalized` (sign seals the
--      rows BEFORE the status flips, in both the face-to-face and the normal branch). An amendment row is unchanged (its addendum is `finalized`).
--  D4  1523 `addendum_cosignature_request_org_guard` fired on INSERT only while the application role holds table-wide UPDATE, so
--      `UPDATE ... SET routed_to_membership_id = <another tenant's member>` passed RLS (a foreign key ignores RLS) and its 23503 was an existence
--      oracle. Now BEFORE INSERT OR UPDATE: the same tenancy checks run on UPDATE, supervisor_released_by is checked when set, and the
--      organization, encounter, addendum and siting pair of a request never change.
--  D5  `encounter_signature` kind `addendum_cosignature` (1524) was unconstrained: no addendum, or two rows for one addendum, left the
--      CoP 418.104(c) provenance unattributable or duplicated. A BEFORE INSERT guard: that kind needs an addendum of that encounter and
--      organization, and refuses a second row for the same addendum (an advisory lock per addendum makes the check race-free; a unique index
--      would read as a contracting change).
--  C5 / D6 / D7  1517 `encounter_draft_confirmation_org_guard` (already BEFORE INSERT OR UPDATE) has no status check, so a confirmation could
--      be rewritten after sign (the service refuses it; this is the database's own line), and it never compared the siting pair that 1518 and
--      1523 compare. Now: the siting pair is the encounter's, and an INSERT or UPDATE is refused once the encounter is signed / cosign_pending /
--      cosigned / voided. A non-superuser member of chartwarden_destruction is excepted from the status refusal only (the 1521 shape; it
--      holds no INSERT or UPDATE grant on the table today, the eraser only removes rows).
-- All guards are SECURITY INVOKER (their reads run under the caller's RLS, as 1514 / 1517 / 1521 do). A refusal is restrict_violation (23001);
-- a tenancy refusal is foreign_key_violation (23503), as the guards they extend.
-- Roles are the post-1139 names (chartwarden_*).

-- ── D1: the signed pin is fixed ──────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hearthnote_assembled_output_frozen_after_sign() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.addendum_id IS DISTINCT FROM OLD.addendum_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: a pinned narrative belongs to its encounter or addendum for good (its parent, kind and organization cannot change)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The parent is read from the row as it WAS, never from what the statement wants it to become.
  SELECT e.status::text INTO v_status
    FROM encounter e
   WHERE e.id = COALESCE(OLD.encounter_id, (SELECT a.encounter_id FROM encounter_addendum a WHERE a.id = OLD.addendum_id));
  IF NEW.part2_derived IS DISTINCT FROM OLD.part2_derived
     AND (v_status IS NULL OR v_status IN ('signed', 'cosign_pending', 'cosigned')) THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: the Part 2 flag of the narrative of a signed encounter is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.layer1_cipher IS NOT DISTINCT FROM OLD.layer1_cipher
     AND NEW.layer2_cipher IS NOT DISTINCT FROM OLD.layer2_cipher
     AND NEW.final_cipher IS NOT DISTINCT FROM OLD.final_cipher THEN
    RETURN NEW;
  END IF;
  IF pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
     AND (NEW.layer1_cipher IS NOT DISTINCT FROM OLD.layer1_cipher OR NEW.layer1_cipher = '')
     AND (NEW.layer2_cipher IS NOT DISTINCT FROM OLD.layer2_cipher OR NEW.layer2_cipher IS NULL OR NEW.layer2_cipher = '')
     AND (NEW.final_cipher IS NOT DISTINCT FROM OLD.final_cipher OR NEW.final_cipher = '') THEN
    RETURN NEW;
  END IF;
  IF v_status IS NULL OR v_status IN ('signed', 'cosign_pending', 'cosigned') THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: the narrative of a signed encounter is frozen (a cipher change was rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── D2: a new pin cannot replace a signed one ────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hearthnote_assembled_output_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF (NEW.kind::text = 'primary_finalize' AND NEW.encounter_id IS NULL)
     OR (NEW.kind::text = 'addendum_finalize' AND NEW.addendum_id IS NULL) THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: a primary_finalize pin belongs to an encounter and an addendum_finalize pin to an addendum'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.kind::text = 'primary_finalize' THEN
    SELECT e.status::text INTO v_status
      FROM encounter e
     WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'hearthnote_assembled_output: the encounter must belong to the row''s organization'
        USING ERRCODE = '23503';
    END IF;
    IF v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided') THEN
      RAISE EXCEPTION 'hearthnote_assembled_output: a %-status encounter takes no new pinned narrative', v_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- An addendum's pin is written when the addendum finalizes, while its PARENT encounter is already signed: the addendum's own status decides.
  SELECT a.status::text INTO v_status
    FROM encounter_addendum a
   WHERE a.id = NEW.addendum_id AND a.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: the addendum must belong to the row''s organization'
      USING ERRCODE = '23503';
  END IF;
  IF v_status IN ('signed', 'voided') THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: a %-status addendum takes no new pinned narrative', v_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_hearthnote_assembled_output_insert_guard"
  BEFORE INSERT ON "hearthnote_assembled_output"
  FOR EACH ROW EXECUTE FUNCTION hearthnote_assembled_output_insert_guard();--> statement-breakpoint

-- ── D3: original sealed rows are written by sign, before the status flips ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hearthnote_signed_section_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_amended record;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM encounter e
        WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
          AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
          AND e.location_id IS NOT DISTINCT FROM NEW.location_id) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: the encounter must belong to the row''s organization and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  IF (NEW.addendum_id IS NULL) <> (NEW.amends_section_id IS NULL) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: addendum_id and amends_section_id are both set (an amendment) or both null (an original)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.addendum_id IS NULL THEN
    -- An original row: its output is the encounter's own pin, and the encounter has not been signed yet (sign writes the rows first).
    IF NOT EXISTS (
         SELECT 1 FROM hearthnote_assembled_output o
          WHERE o.id = NEW.assembled_output_id AND o.organization_id = NEW.organization_id AND o.encounter_id = NEW.encounter_id) THEN
      RAISE EXCEPTION 'hearthnote_signed_section: the assembled output must belong to the row''s organization and to that encounter'
        USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM encounter e WHERE e.id = NEW.encounter_id AND e.status::text = 'finalized') THEN
      RAISE EXCEPTION 'hearthnote_signed_section: the sealed sections of a note are written when it is signed, while the encounter is still finalized'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- An amendment row: the addendum is the encounter's and is finalized (its sign transaction writes the rows, before it flips to signed), its own
  -- assembled output carries the row, and the amended row is an ORIGINAL row of the parent's own primary pin with the same section and position.
  IF NOT EXISTS (
       SELECT 1 FROM encounter_addendum a
        WHERE a.id = NEW.addendum_id AND a.organization_id = NEW.organization_id AND a.encounter_id = NEW.encounter_id
          AND a.status::text = 'finalized')
     OR NOT EXISTS (
       SELECT 1 FROM hearthnote_assembled_output o
        WHERE o.id = NEW.assembled_output_id AND o.organization_id = NEW.organization_id AND o.addendum_id = NEW.addendum_id) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: an amendment belongs to a finalized addendum of that encounter, sealed against that addendum''s own output'
      USING ERRCODE = '23503';
  END IF;
  SELECT s.section_id, s."position", s.amends_section_id INTO v_amended
    FROM hearthnote_signed_section s
    JOIN hearthnote_assembled_output po ON po.id = s.assembled_output_id
   WHERE s.id = NEW.amends_section_id AND s.organization_id = NEW.organization_id AND s.encounter_id = NEW.encounter_id
     AND po.encounter_id = NEW.encounter_id AND po.kind::text = 'primary_finalize';
  IF NOT FOUND OR v_amended.amends_section_id IS NOT NULL
     OR v_amended.section_id <> NEW.section_id OR v_amended."position" <> NEW."position" THEN
    RAISE EXCEPTION 'hearthnote_signed_section: an amendment names an original row of the parent''s own pin (never an amendment), with the same section and position'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── D4: the addendum's cosignature request keeps its tenancy on UPDATE too ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION addendum_cosignature_request_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
          OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
          OR NEW.addendum_id IS DISTINCT FROM OLD.addendum_id
          OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
          OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    RAISE EXCEPTION 'addendum_cosignature_request: the organization, encounter, addendum and siting of a request are fixed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM encounter e
        WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
          AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
          AND e.location_id IS NOT DISTINCT FROM NEW.location_id)
     OR NOT EXISTS (
       SELECT 1 FROM encounter_addendum a
        WHERE a.id = NEW.addendum_id AND a.organization_id = NEW.organization_id AND a.encounter_id = NEW.encounter_id)
     OR NOT EXISTS (
       SELECT 1 FROM membership m WHERE m.id = NEW.routed_to_membership_id AND m.organization_id = NEW.organization_id)
     OR (NEW.supervisor_released_by IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM membership m WHERE m.id = NEW.supervisor_released_by AND m.organization_id = NEW.organization_id)) THEN
    RAISE EXCEPTION 'addendum_cosignature_request: the encounter, the addendum (of that encounter), the routed-to member and the releasing member must belong to the row''s organization, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_addendum_cosignature_request_org_guard"
  BEFORE INSERT OR UPDATE ON "addendum_cosignature_request"
  FOR EACH ROW EXECUTE FUNCTION addendum_cosignature_request_org_guard();--> statement-breakpoint

-- ── D5: one provenance row per amending addendum's cosignature ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION encounter_signature_addendum_cosignature_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind::text <> 'addendum_cosignature' THEN
    RETURN NEW;
  END IF;
  IF NEW.addendum_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM encounter_addendum a
        WHERE a.id = NEW.addendum_id AND a.encounter_id = NEW.encounter_id AND a.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'encounter_signature: an addendum cosignature names an addendum of its own encounter and organization'
      USING ERRCODE = '23503';
  END IF;
  -- Two concurrent inserts for one addendum take turns, so the second sees the first.
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter_signature:addendum_cosignature:' || NEW.addendum_id::text, 0));
  IF EXISTS (
       SELECT 1 FROM encounter_signature s
        WHERE s.addendum_id = NEW.addendum_id AND s.kind::text = 'addendum_cosignature') THEN
    RAISE EXCEPTION 'encounter_signature: this addendum already has its cosignature signature'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_signature_addendum_cosignature_guard"
  BEFORE INSERT ON "encounter_signature"
  FOR EACH ROW EXECUTE FUNCTION encounter_signature_addendum_cosignature_guard();--> statement-breakpoint

-- ── C5 / D6 / D7: a confirmation is frozen with the note, and carries the encounter's siting ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION encounter_draft_confirmation_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  SELECT e.status::text INTO v_status
    FROM encounter e
   WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
     AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
     AND e.location_id IS NOT DISTINCT FROM NEW.location_id;
  IF NOT FOUND
     OR NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.resolved_by_membership_id AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'encounter_draft_confirmation: the encounter and the resolving member must belong to the row''s organization, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  IF v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')
     AND NOT (pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
              AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'encounter_draft_confirmation: the confirmations of a signed encounter are frozen (a note is changed only through an addendum)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
