-- M5: novo kind de segredo para a chave do provedor de embeddings (quando for
-- um provedor SEPARADO do LLM; se for o mesmo, reusa-se 'llm_api_key').
-- Migration ISOLADA (padrão do M4 #12): ALTER TYPE ADD VALUE não pode ser usado
-- na MESMA transação em que o valor é referenciado. Mantê-la sozinha evita isso.
ALTER TYPE tenant_secret_kind ADD VALUE IF NOT EXISTS 'embedding_api_key';
