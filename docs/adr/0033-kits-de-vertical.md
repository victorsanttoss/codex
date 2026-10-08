# ADR 0033 — Kits de vertical declarativos + `platform_authored`

## Contexto
A máquina de nicho (M9) está pronta mas vazia. Popular verticais reais (solar,
odonto, imobiliário) precisa ser **declarativo, idempotente e versionado**, sem
burlar o gate de curadoria do M9 — mas também sem fingir "revisão humana" de
conteúdo que a própria plataforma escreveu.

## Decisão
- **`VerticalKit`**: um objeto declarativo por vertical (`version` semver, `niche`
  {name, vertical, motion}, `guidance`, `knowledge[]`, `qualificationSchema`,
  `templates[]`, `compliance?`). Um arquivo por vertical; 3 kits piloto embutidos.
- **`platform_authored`**: o conhecimento do kit entra em `niche_knowledge` com
  `source_kind='platform_authored'` — conteúdo de plataforma **explicitamente
  curado**, distinto de `curation` (minerado de tenant, que EXIGE gate humano). É
  honesto: não há "aprovação humana" de cada item que a plataforma mesma autorou,
  mas é versionado e auditável, e passa por **guard de PII** (genérico por
  construção).
- **Idempotência por versão** (em `niche_configs.kit_version`): reaplicar a MESMA
  versão é no-op; versão maior **aposenta** o `platform_authored` ativo anterior e
  insere o novo (não duplica). Rollback por `retire`.
- **Templates**: o kit define SPECS (HSM); o catálogo do tenant é materializado
  por tenant com `status='pending'` (a aprovação na Meta é externa).
- Aplicação só por **staff de plataforma** (`/platform/kits`, `PlatformGuard`).

## Consequências
Subir/atualizar uma vertical é aplicar um kit (versionado, reversível). O conteúdo
inicial é **semente** — exige revisão de especialista de domínio (e de conformidade
em verticais reguladas, ver `compliance.notes`); o loop de curadoria do M9 o refina
com dados reais. A distinção `platform_authored` × `curation` mantém a regra do M9
(dados de tenant nunca auto-promovem) sem teatro de revisão.
