-- Fixture: a migration after the 1143 rename that still names the old audit function.
CREATE TRIGGER "fixture_audit" AFTER INSERT OR UPDATE OR DELETE ON fixture
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
