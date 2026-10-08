-- M4: novo kind de segredo por tenant para a chave de API do LLM.
-- ALTER TYPE ADD VALUE roda em transação no PG12+ desde que o novo valor não
-- seja USADO na mesma transação (só o adicionamos aqui).
ALTER TYPE tenant_secret_kind ADD VALUE IF NOT EXISTS 'llm_api_key';
