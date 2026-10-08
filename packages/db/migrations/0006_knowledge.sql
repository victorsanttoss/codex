-- M5: camada de conhecimento (RAG). Tenant-scoped, RLS ENABLE+FORCE+policy.
-- pgvector já está instalado (init do container). Dimensão FIXA = 1024 (bge-m3,
-- ver ADR 0019); distância COSINE (assume embeddings normalizados); índice HNSW.

CREATE TYPE knowledge_source_kind AS ENUM ('faq', 'doc', 'text');

CREATE TABLE knowledge_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_ref    text NOT NULL,
  kind            knowledge_source_kind NOT NULL DEFAULT 'text',
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  content_hash    text NOT NULL,
  embedding_model text NOT NULL,
  dim             integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_sources_tenant_ref_uniq UNIQUE (tenant_id, external_ref)
);
CREATE INDEX knowledge_sources_tenant_idx ON knowledge_sources (tenant_id);

CREATE TABLE knowledge_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  content         text NOT NULL,
  embedding       vector(1024) NOT NULL,
  token_count     integer,
  embedding_model text NOT NULL,
  dim             integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_chunks_source_idx ON knowledge_chunks (source_id);
-- Índice vetorial HNSW com operador COSINE (vetores normalizados → cosine).
CREATE INDEX knowledge_chunks_embedding_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- ── RLS: isolamento puro por tenant_id (mesma policy NULLIF do resto) ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_sources', 'knowledge_chunks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END $$;
