-- M5 (revisão Codex #6): integridade cross-tenant defensiva. RLS já evita LEITURA
-- cruzada, mas sem FK composta um bug com source_id conhecido poderia inserir um
-- chunk referenciando fonte de OUTRO tenant. A FK (tenant_id, source_id) garante
-- que a fonte pertence ao MESMO tenant do chunk.
ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_tenant_id_uniq UNIQUE (tenant_id, id);

ALTER TABLE knowledge_chunks
  ADD CONSTRAINT knowledge_chunks_source_same_tenant_fk
  FOREIGN KEY (tenant_id, source_id)
  REFERENCES knowledge_sources (tenant_id, id) ON DELETE CASCADE;
