-- M10: config por NICHO (schema de qualificação + versão do kit). Mesma RLS do
-- niche_knowledge: leitura por app.niche_id; escrita só na curadoria (app.curation).
CREATE TABLE niche_configs (
  niche_id      uuid PRIMARY KEY REFERENCES niches(id) ON DELETE CASCADE,
  qualification jsonb,
  kit_version   text,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE niche_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY niche_read ON niche_configs
  USING (niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid)
  WITH CHECK (
    niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
    AND current_setting('app.curation', true) = 'on'
  );
