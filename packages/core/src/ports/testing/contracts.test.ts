import { runChannelProviderContract } from "./channel-provider.contract";
import { runLLMProviderContract } from "./llm-provider.contract";
import { runEmbeddingProviderContract } from "./embedding-provider.contract";
import { runCrmProviderContract } from "./crm-provider.contract";
import { runTranscriptionProviderContract } from "./transcription-provider.contract";
import {
  FakeChannelProvider,
  FakeEmbeddingProvider,
  FakeLLMProvider,
  FakeTranscriptionProvider,
} from "./fakes";
import { FakeCrmProvider } from "./crm-fakes";

// Prova os contratos das ports usando adaptadores fake — sem implementação real.
runChannelProviderContract("fake", () => new FakeChannelProvider());
runLLMProviderContract("fake", () => new FakeLLMProvider());
runEmbeddingProviderContract("fake", () => new FakeEmbeddingProvider());
runCrmProviderContract("fake", () => new FakeCrmProvider());
runTranscriptionProviderContract("fake", () => new FakeTranscriptionProvider());
