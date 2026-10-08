# ADR 0029 — Opt-out e compliance (LGPD / anti-ban)

## Contexto
Continuar mandando mensagem para quem pediu para parar é a forma mais rápida de
violar LGPD e ser **denunciado/banido**. Detecção precisa ser confiável e a saída,
honrada para sempre.

## Decisão
- **Detecção pura e conservadora** (`isOptOutText`): casa comandos curtos
  ("pare", "stop", "sair") e frases de saída ("para de me mandar", "descadastrar",
  "não quero receber"). Mensagens longas (>160 chars) não são tratadas como
  opt-out (evita falso-positivo em conversa normal — ex.: "vou *parar* no
  mercado"). **Falso-positivo (parar cadência à toa) é preferível a falso-negativo.**
- **Persistência**: `contacts.opted_out` (flag + timestamp). O opt-out é **por
  contato** (wa_id), permanente.
- **Aplicação em todo lugar**: no inbound, o handler detecta → marca o contato,
  **para a cadência** e confirma **uma vez** (sem chamar o LLM). No envio proativo,
  o motor de cadência re-checa `isContactOptedOut` e **nunca** dispara para opt-out.
- **Stop-on-engagement**: além do opt-out, QUALQUER inbound para a cadência ativa
  (o lead voltou — não precisa de follow-up automático).

## Consequências
Quem pede para sair, sai — e não recebe mais disparo proativo. A detecção roda na
borda (inbound) e é re-verificada no envio (defesa em profundidade). Combinado com
horário comercial + teto de frequência (ADR 0028), reduz drasticamente o risco de
ban e mantém conformidade com LGPD.
