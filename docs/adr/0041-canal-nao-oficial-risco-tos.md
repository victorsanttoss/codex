# ADR 0041 — Canal não-oficial (Baileys): risco/ToS e default oficial

## Contexto
O Baileys automatiza o WhatsApp Web. É **mais barato** e **sem dependência da Meta**,
mas **viola os Termos do WhatsApp**: o número do cliente **pode ser banido a
qualquer momento**, quebra quando o WhatsApp muda, e **não tem suporte oficial**.
É uma decisão de **negócio/risco**, não técnica.

## Decisão
- **Default do produto continua a Cloud API oficial.** O Baileys é **opção
  consciente por tenant** (`provider='baileys'` na conexão; pool ligado por
  `BAILEYS_ENABLED`). Existe **atrás da mesma port `ChannelProvider`** justamente
  para ser plugável e descartável sem tocar no agente.
- **Sem HSM.** O não-oficial não tem template aprovado: `sendTemplate` é renderizado
  como **mensagem de texto normal** (documentado). Sem o selo do HSM, toda a
  responsabilidade de “não parecer spam” é do envio.
- **Guardrails do M8 com rigor MAIOR.** Opt-out/LGPD, teto de frequência, horário
  comercial (`America/Sao_Paulo`), stop-on-engagement e idempotência de envio
  **aplicam ao caminho Baileys** (revalidados no envio pelo `OutboxService`). O
  pacing conservador é ainda mais crítico aqui — é o caminho de maior risco de ban.
- **Transparência contratual.** O onboarding (painel) **divulga o risco** ao
  operador; o contrato com o cliente deve divulgá-lo também. Idealmente usar em
  segmentos de menor risco.

## Consequências
Oferecemos a opção barata sem acoplar o núcleo nem comprometer o caminho oficial.
O ban é um risco **assumido pelo tenant**, mitigado (não eliminado) pelos guardrails.
Se a Meta/WhatsApp quebrar o Baileys, desliga-se o pool (`BAILEYS_ENABLED=false`) e
os tenants migram para a Cloud API — sem mudança de arquitetura.
