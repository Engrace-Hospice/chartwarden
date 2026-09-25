-- Allow the application role to remove HOPE answers that become
-- non-applicable after a controlling answer changes.

GRANT DELETE ON TABLE public.hope_assessment_answer TO wardenx_app;