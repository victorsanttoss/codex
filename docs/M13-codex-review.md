# Revisão de arquitetura M13 (Codex, read-only)

Módulo 13 — Canal não-oficial (Baileys). Revisão `codex exec --sandbox read-only`.
**Nenhum achado CRÍTICO.** Tratamento dos achados:

## ALTO — corrigidos

1. **Envio Baileys do outbox descartava `clientMessageId`** → após crash entre
   `sendText` e `markOutboxSent`, o reclaim de órfãs poderia **duplicar entrega**.
   **Correção:** `clientMessageId` agora é propagado até o socket como **`messageId`
   do WhatsApp** (`BaileysConnection.sendText(opts.messageId)` → `sock.sendMessage(...,
   { messageId })`). O WhatsApp **deduplica por id**, então o reenvio do mesmo id é
   idempotente (dedup real, melhor que a correlação best-effort do Cloud). Cobertura:
   teste do adaptador (id ecoado) + outbox-routing (propaga `c1`).

2. **Núcleo compartilhado injetava `MediaService` do Cloud e o caminho Baileys
   fabricava `secretRef`.** **Correção:** o download de mídia (Graph + `secretRef`) no
   `InboundCoreService` agora roda **só para `provider === 'cloud_api'`**. Mídia do
   Baileys (download via socket) é **follow-up explícito**: hoje cai na política
   não-texto do M6 sem tocar o Graph — o `secretRef` do caminho Baileys deixou de ter
   efeito.

## MÉDIO — corrigidos

3. **`workerIndex < workerTotal` não era garantido** (shard inválido). **Correção:**
   `.refine` no bloco `baileys` da config rejeita `index >= total` (fail-fast).

4. **`reconcile()` não fechava sessões órfãs** (número que saiu de ativo ou mudou de
   dono após rebalance ficaria com socket vivo fora do roteamento). **Correção:** ao
   fim do reconcile, fecha+remove os sockets cujo número não está no conjunto
   ativo+possuído.

5. **`BaileysSendError` não estendia `ChannelSendError`** → um erro permanente
   poderia ser tratado como transitório no outbox. **Correção:** `isSendErrorTransient`
   reconhece **ambos** os tipos de erro de canal (`.transient`); desconhecido =
   transiente.

## BAIXO — corrigidos

6. **Onboarding registrava `baileys` mesmo com `BAILEYS_ENABLED=false`** (conexão
   pendente órfã). **Correção:** o controller injeta `APP_CONFIG` e **recusa** (400)
   quando o pool está desligado.

7. **Log incluía `reason` cru do driver.** **Correção:** allowlist — loga só um código
   curto/numérico sanitizado.

## Verificações positivas (Codex)
Store de sessão com **RLS forçado** e AAD `tenantId:baileys_session:phone`; **QR no
Redis com TTL**, nunca logado; testes usam **`FakeBaileysDriver`/mocks** (o
`RealBaileysDriver` não é exercitado); scheduler e session-worker **particionam antes
do `claimDueOutbox`**, evitando dupla entrega entre processos; núcleo permanece
agnóstico (estrutural verde).
