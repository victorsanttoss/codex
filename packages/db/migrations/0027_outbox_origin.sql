-- Revisão Codex (núcleo de entrega compartilhado): com as respostas REATIVAS do
-- agente entrando no livro-razão do outbox, as contagens que assumiam "só
-- proativo" (teto de frequência da cadência, alerta de outbox failed) passariam a
-- incluir linhas reativas — bloqueando cadência após respostas normais e
-- misturando falha de dispatcher com falha de entrega. Coluna explícita de origem
-- resolve na raiz: 'proactive' (cadência/outbox clássico) | 'reactive' (resposta
-- do agente, linha nasce 'sent').
ALTER TABLE outbox_messages ADD COLUMN origin text NOT NULL DEFAULT 'proactive';
CREATE INDEX outbox_messages_origin_idx ON outbox_messages (tenant_id, origin, status);
