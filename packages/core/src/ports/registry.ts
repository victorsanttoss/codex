import type { ChannelProvider } from "./channel-provider";
import type { LLMProvider } from "./llm-provider";
import type { EmbeddingProvider } from "./embedding-provider";
import type { CrmProvider } from "./crm-provider";
import type { SchedulingProvider } from "./scheduling-provider";
import type { NotificationProvider } from "./notification-provider";
import type { TranscriptionProvider } from "./transcription-provider";

/**
 * Registry/factory que seleciona o adaptador conforme a config do tenant.
 * Adaptadores se registram por chave (ex.: "meta_cloud", "selfhosted_llama").
 * Aqui NÃO há adaptador concreto — só o mecanismo de seleção, exercitado
 * em teste com fakes. M2/M4 registram implementações reais.
 */

export interface TenantProviderSelection {
  channelAdapter: string;
  channelConfig: Record<string, unknown>;
  llmAdapter: string;
  llmConfig: Record<string, unknown>;
}

/** Seleção do adaptador de embeddings do tenant (M5). */
export interface EmbeddingSelection {
  embeddingAdapter: string;
  embeddingConfig: Record<string, unknown>;
}

/** Seleção do adaptador de CRM do tenant (M7). */
export interface CrmSelection {
  crmAdapter: string;
  crmConfig: Record<string, unknown>;
}

/** Seleção do adaptador de transcrição do tenant (M12). */
export interface TranscriptionSelection {
  transcriptionAdapter: string;
  transcriptionConfig: Record<string, unknown>;
}

export type ChannelFactory = (config: Record<string, unknown>) => ChannelProvider;
export type LLMFactory = (config: Record<string, unknown>) => LLMProvider;
export type EmbeddingFactory = (config: Record<string, unknown>) => EmbeddingProvider;
export type CrmFactory = (config: Record<string, unknown>) => CrmProvider;
export type SchedulingFactory = (config: Record<string, unknown>) => SchedulingProvider;
export type NotificationFactory = (config: Record<string, unknown>) => NotificationProvider;
export type TranscriptionFactory = (config: Record<string, unknown>) => TranscriptionProvider;

export class ProviderRegistry {
  private readonly channels = new Map<string, ChannelFactory>();
  private readonly llms = new Map<string, LLMFactory>();
  private readonly embeddings = new Map<string, EmbeddingFactory>();
  private readonly crms = new Map<string, CrmFactory>();
  private readonly schedulers = new Map<string, SchedulingFactory>();
  private readonly notifiers = new Map<string, NotificationFactory>();
  private readonly transcribers = new Map<string, TranscriptionFactory>();

  registerChannel(key: string, factory: ChannelFactory): this {
    if (this.channels.has(key)) {
      throw new Error(`Adaptador de canal já registrado: ${key}`);
    }
    this.channels.set(key, factory);
    return this;
  }

  registerLLM(key: string, factory: LLMFactory): this {
    if (this.llms.has(key)) {
      throw new Error(`Adaptador de LLM já registrado: ${key}`);
    }
    this.llms.set(key, factory);
    return this;
  }

  registerEmbedding(key: string, factory: EmbeddingFactory): this {
    if (this.embeddings.has(key)) {
      throw new Error(`Adaptador de embeddings já registrado: ${key}`);
    }
    this.embeddings.set(key, factory);
    return this;
  }

  channelFor(selection: TenantProviderSelection): ChannelProvider {
    const factory = this.channels.get(selection.channelAdapter);
    if (!factory) {
      throw new UnknownAdapterError("channel", selection.channelAdapter);
    }
    return factory(selection.channelConfig);
  }

  llmFor(selection: TenantProviderSelection): LLMProvider {
    const factory = this.llms.get(selection.llmAdapter);
    if (!factory) {
      throw new UnknownAdapterError("llm", selection.llmAdapter);
    }
    return factory(selection.llmConfig);
  }

  embeddingFor(selection: EmbeddingSelection): EmbeddingProvider {
    const factory = this.embeddings.get(selection.embeddingAdapter);
    if (!factory) {
      throw new UnknownAdapterError("embedding", selection.embeddingAdapter);
    }
    return factory(selection.embeddingConfig);
  }

  registerCrm(key: string, factory: CrmFactory): this {
    if (this.crms.has(key)) throw new Error(`Adaptador de CRM já registrado: ${key}`);
    this.crms.set(key, factory);
    return this;
  }

  registerScheduling(key: string, factory: SchedulingFactory): this {
    if (this.schedulers.has(key)) throw new Error(`Adaptador de agendamento já registrado: ${key}`);
    this.schedulers.set(key, factory);
    return this;
  }

  registerNotification(key: string, factory: NotificationFactory): this {
    if (this.notifiers.has(key)) throw new Error(`Adaptador de notificação já registrado: ${key}`);
    this.notifiers.set(key, factory);
    return this;
  }

  crmFor(selection: CrmSelection): CrmProvider {
    const factory = this.crms.get(selection.crmAdapter);
    if (!factory) throw new UnknownAdapterError("crm", selection.crmAdapter);
    return factory(selection.crmConfig);
  }

  schedulingFor(adapter: string, config: Record<string, unknown>): SchedulingProvider {
    const factory = this.schedulers.get(adapter);
    if (!factory) throw new UnknownAdapterError("scheduling", adapter);
    return factory(config);
  }

  notificationFor(adapter: string, config: Record<string, unknown>): NotificationProvider {
    const factory = this.notifiers.get(adapter);
    if (!factory) throw new UnknownAdapterError("notification", adapter);
    return factory(config);
  }

  registerTranscription(key: string, factory: TranscriptionFactory): this {
    if (this.transcribers.has(key)) throw new Error(`Adaptador de transcrição já registrado: ${key}`);
    this.transcribers.set(key, factory);
    return this;
  }

  transcriptionFor(selection: TranscriptionSelection): TranscriptionProvider {
    const factory = this.transcribers.get(selection.transcriptionAdapter);
    if (!factory) throw new UnknownAdapterError("transcription", selection.transcriptionAdapter);
    return factory(selection.transcriptionConfig);
  }
}

export class UnknownAdapterError extends Error {
  constructor(
    readonly portKind: "channel" | "llm" | "embedding" | "crm" | "scheduling" | "notification" | "transcription",
    readonly adapterKey: string,
  ) {
    super(`Nenhum adaptador de ${portKind} registrado para "${adapterKey}".`);
    this.name = "UnknownAdapterError";
  }
}
