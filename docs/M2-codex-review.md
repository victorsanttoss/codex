# M2 — Revisão do Codex (canal WhatsApp) + triagem

Revisor: OpenAI Codex (read-only) sobre `packages/whatsapp-cloud`, `apps/api/src/whatsapp`,
`redis-mutex`, migration 0002 e repos do canal. Sem achados CRÍTICOS.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | Webhook processava síncrono antes do 200 (timeout/DoS) | fila BullMQ durável: controller valida assinatura na borda, enfileira e responde 200 (~17ms); worker processa com retry. FIFO por conversa segue no SerializedRunner. |
| 2 | ALTO | Normalizador só lia `entry[0].changes[0]` (perdia batch) | itera todos os entries × changes (+teste de batch) |
| 3 | ALTO | Janela 24h usava horário de processamento | pipeline passa `receivedAt` do timestamp da mensagem; adaptador valida ts inválido |
| 4 | ALTO | Fencing token existia mas pipeline ignorava | `handle.isValid()` checado antes do envio outbound (aborta worker zumbi) |
| 6 | MÉDIO | Mídia sem limite de tamanho | teto de 16 MB (descarta acima); streaming/storage real fica p/ M6 |
| 7 | MÉDIO | Status aceitava regressão (delivered sobre read) | atualização MONOTÔNICA por rank (+teste) |
| 8 | BAIXO | Assinatura inválida = 200 silencioso | log/warn na borda e na pipeline |
| 9 | BAIXO | `resolve` não filtrava `status='active'` | filtra conexão ativa |

## Documentado (dívida consciente)

- **#5 (MÉDIO)** Outbound pode duplicar em retry após erro de rede (a Meta pode ter
  aceitado mas a resposta caiu). Idempotência real de envio (registrar intenção
  antes + chave idempotente + reconciliação) fica para o **M6**, quando houver
  reenvio real do agente. No M2 (echo stub) o risco é baixo.
- **Mídia**: storage real/streaming e validação de MIME esperado — M6.

## Confirmado pelo Codex (sem ação)

Sem vazamento no lookup system (`set_config('app.resolve_phone')` + policy);
`tenantSender`/mídia leem segredo dentro de `runWithTenant`; HMAC é timing-safe;
header ausente falha. Risco maior é operacional/futuro (lifecycle de conexão no M3).
