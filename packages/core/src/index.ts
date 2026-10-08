// Contexto de execução (tenant / system)
export * from "./context/tenant-context";

// Normalização de telefone (E.164) — chave de dedup agnóstica a canal
export * from "./phone";

// Classificador anti-SSRF (faixas privadas/reservadas + hostnames numéricos)
export * from "./net/ssrf";

// Criptografia de credenciais (envelope encryption) + seams pluggable
export * from "./crypto/envelope";
export * from "./crypto/secrets-store";

// Ports (interfaces) — sem adaptadores concretos
export * from "./ports/channel-provider";
export * from "./ports/llm-provider";
export * from "./ports/embedding-provider";
export * from "./ports/crm-provider";
export * from "./ports/scheduling-provider";
export * from "./ports/notification-provider";
export * from "./ports/transcription-provider";
export * from "./ports/registry";

// Observação: as suítes de contrato e os fakes vivem em
// `./ports/testing/*` e são importadas diretamente pelos testes dos
// adaptadores — propositalmente fora do barrel público/produção.
