-- M10 (revisão Codex #1): a policy combinada de niche_knowledge/niche_configs
-- liberava DELETE/UPDATE só com app.niche_id (sem app.curation) — um tenant (que
-- seta app.niche_id na leitura) poderia APAGAR/ALTERAR conhecimento do próprio
-- nicho. Separa: SELECT por nicho; INSERT/UPDATE/DELETE só na curadoria.

-- niche_knowledge
DROP POLICY IF EXISTS niche_read ON niche_knowledge;
CREATE POLICY niche_select ON niche_knowledge
  FOR SELECT
  USING (niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid);
CREATE POLICY niche_write ON niche_knowledge
  FOR ALL
  USING (
    niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
    AND current_setting('app.curation', true) = 'on'
  )
  WITH CHECK (
    niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
    AND current_setting('app.curation', true) = 'on'
  );

-- niche_configs
DROP POLICY IF EXISTS niche_read ON niche_configs;
CREATE POLICY niche_select ON niche_configs
  FOR SELECT
  USING (niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid);
CREATE POLICY niche_write ON niche_configs
  FOR ALL
  USING (
    niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
    AND current_setting('app.curation', true) = 'on'
  )
  WITH CHECK (
    niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
    AND current_setting('app.curation', true) = 'on'
  );
