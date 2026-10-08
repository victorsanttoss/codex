-- M9: camada de NICHO (conhecimento compartilhado entre tenants do mesmo nicho)
-- + loop de curadoria. Storage de PLATAFORMA com isolamento PRÓPRIO por nicho
-- (app.niche_id) e por curadoria (app.curation) — NÃO é tenant-scoped.
-- pgvector já instalado; dimensão 1024 (bge-m3, igual ao M5) p/ scores comparáveis.

-- niches: dado de referência da plataforma (sem RLS de tenant).
CREATE TABLE niches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  vertical   text NOT NULL,
  motion     text NOT NULL,
  guidance   text,
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- tenant_niche: vínculo TENANT-SCOPED (o servidor resolve o nicho daqui).
CREATE TABLE tenant_niche (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  niche_id   uuid NOT NULL REFERENCES niches(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_niche ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_niche FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_niche
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- niche_knowledge: leitura por app.niche_id; ESCRITA exige app.curation='on'.
CREATE TABLE niche_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niche_id    uuid NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  content     text NOT NULL,
  embedding   vector(1024) NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'active',
  source_kind text NOT NULL DEFAULT 'manual',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX niche_knowledge_niche_idx ON niche_knowledge (niche_id);
CREATE INDEX niche_knowledge_embedding_hnsw
  ON niche_knowledge USING hnsw (embedding vector_cosine_ops);
ALTER TABLE niche_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_knowledge FORCE ROW LEVEL SECURITY;
CREATE POLICY niche_read ON niche_knowledge
  USING (niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid)
  WITH CHECK (
    niche_id = NULLIF(current_setting('app.niche_id', true), '')::uuid
    AND current_setting('app.curation', true) = 'on'   -- escrita só na curadoria
  );

-- curation_candidates: SÓ acessíveis na curadoria (app.curation='on'). Tenants nunca leem.
CREATE TABLE curation_candidates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niche_id          uuid NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  candidate_type    text NOT NULL,
  content           text NOT NULL,
  evidence_count    integer NOT NULL DEFAULT 1,
  source_tenant_id  uuid,
  source_refs       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'pending',
  redaction_checked boolean NOT NULL DEFAULT false,
  curator_id        text,
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX curation_candidates_niche_status_idx ON curation_candidates (niche_id, status);
ALTER TABLE curation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE curation_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY curation_only ON curation_candidates
  USING (current_setting('app.curation', true) = 'on')
  WITH CHECK (current_setting('app.curation', true) = 'on');
