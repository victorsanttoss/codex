-- M9: metering de PLATAFORMA (curadoria). NÃO tenant-scoped, NÃO faturado ao
-- tenant — mesmo quando a mineração lê dados do tenant sob withTenant, o custo de
-- LLM/embeddings da curadoria é investimento da plataforma.
CREATE TABLE platform_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,
  tokens_in   bigint,
  tokens_out  bigint,
  cost_micros bigint,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
