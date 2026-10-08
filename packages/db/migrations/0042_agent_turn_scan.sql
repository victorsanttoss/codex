-- Same explicit system-only scan contract as the outbox scheduler (0029).
-- The helper returns tenant ids only; all plans are loaded under tenant RLS.
CREATE POLICY system_scan ON agent_turns FOR SELECT
  USING (current_setting('app.system_scan', true) = 'on');
