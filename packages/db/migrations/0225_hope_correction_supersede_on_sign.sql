-- Phase: M10 HOPE correction/inactivation lifecycle.
-- Draft corrections and XX inactivations must not supersede the source record until the new
-- regulatory record is signed. The original INSERT trigger made merely opening a draft destructive.

DROP TRIGGER IF EXISTS "trg_hope_assessment_supersede_on_correction" ON hope_assessment;
DROP FUNCTION IF EXISTS hope_assessment_supersede_on_correction();

CREATE OR REPLACE FUNCTION hope_assessment_supersede_on_correction_sign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'signed'
     AND OLD.status = 'draft'
     AND NEW.corrects_assessment_id IS NOT NULL THEN
    UPDATE hope_assessment
       SET status = 'superseded',
           superseded_by_id = NEW.id,
           updated_at = now()
     WHERE id = NEW.corrects_assessment_id
       AND organization_id = NEW.organization_id
       AND status = 'signed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_hope_assessment_supersede_on_correction_sign"
  AFTER UPDATE ON hope_assessment
  FOR EACH ROW
  WHEN (NEW.corrects_assessment_id IS NOT NULL)
  EXECUTE FUNCTION hope_assessment_supersede_on_correction_sign();
