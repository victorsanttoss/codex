# ADR 0002 — Envelope encryption de credenciais

## Contexto
Guardamos credenciais por tenant (token do WhatsApp, API key de CRM). Não podem
ficar em texto puro no banco nem em log, e a chave mestra precisa poder rotacionar.

## Decisão
- **Envelope encryption** com AES-256-GCM:
  - DEK (Data Encryption Key) aleatória **por registro** cifra o segredo;
  - a DEK é "embrulhada" por uma **KEK** de ambiente, **versionada** (`key_version`).
- **AAD obrigatório e derivado** (`tenantId:kind`) vincula o ciphertext ao
  registro — impede transplantar blob entre tenants/kinds sem detecção.
- Blob auto-descritivo com **byte de versão de formato** + validação determinística
  de tamanho antes de qualquer operação GCM.
- **Rotação** (`rewrap`) troca só o envelope da DEK (unwrap com KEK antiga, wrap
  com a ativa) — **não decifra o segredo**, preservando dataNonce/Tag/ciphertext.
- `SecretsCrypto` é uma **interface pluggable**: hoje KEK em ambiente
  (`EnvelopeCipher`); amanhã KMS, sem tocar nos call sites.

## Consequências
Segredo ilegível no banco; rotação de KEK sem expor plaintext; troca para KMS
isolada. Custo: gestão de versões de KEK no ambiente (`SECRETS_KEK_V*`).
