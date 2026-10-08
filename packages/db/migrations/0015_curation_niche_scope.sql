-- M9 (revisão Codex #1): curation_candidates isolava só por app.curation. Adiciona
-- o escopo POR NICHO (app.niche_id) — uma sessão de curadoria de um nicho não pode
-- ler/escrever candidatos de outro nicho (defesa além do filtro por SQL).
DROP POLICY IF EXISTS curation_only ON curation_candidates;
CREATE POLICY curation_only ON curation_candidates
  USING (
    current_setting('app.curation', true) = 'on'
    AND niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.curation', true) = 'on'
    AND niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
  );
