-- Dívida M5: busca HÍBRIDA vetor+keyword. A perna keyword usa o full-text search
-- nativo do Postgres (config 'portuguese' — produto PT-BR) como RESGATE de recall:
-- acha o que o ANN perde (nomes próprios, códigos, termos raros); os hits entram
-- pontuados pelo cosseno real (scores seguem comparáveis entre fontes — ADR 0021).
CREATE INDEX knowledge_chunks_fts_idx
  ON knowledge_chunks USING GIN (to_tsvector('portuguese', content));
CREATE INDEX niche_knowledge_fts_idx
  ON niche_knowledge USING GIN (to_tsvector('portuguese', content));
