-- M12: cache de TRANSCRIÇÃO direto na media_objects (uma mídia por message).
-- Idempotência: o passo de enriquecimento consulta por provider_media_id e só
-- transcreve/cobra se ainda não houver transcrição persistida (retry não re-cobra).
-- Herda a RLS por tenant_id já existente em media_objects (migration 0002).
ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS transcription         text,
  ADD COLUMN IF NOT EXISTS transcription_seconds integer,
  ADD COLUMN IF NOT EXISTS transcribed_at        timestamptz;

-- Lookup do cache por mídia (dentro do tenant). Não-único: a MESMA mídia pode
-- aparecer em mensagens diferentes (encaminhamento); o repo pega a 1ª com texto.
CREATE INDEX IF NOT EXISTS media_objects_provider_media_idx
  ON media_objects (tenant_id, provider_media_id);
