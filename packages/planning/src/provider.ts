export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  finishReason: string | null;
  refusal: string | null;
  /** Model identifier echoed by the provider (may differ from the requested alias). */
  responseModel: string | null;
  systemFingerprint: string | null;
  usage: TokenUsage | null;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal: AbortSignal;
}

/** Non-secret, loggable call configuration. */
export interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  responseFormat: "json_object";
  temperature: number;
  maxTokens: number;
  thinking: "enabled" | "disabled";
  timeoutMs: number;
}

export interface ChatProvider {
  readonly config: ProviderConfig;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export type ProviderErrorKind = "TIMEOUT" | "HTTP" | "NETWORK" | "BAD_RESPONSE";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    if (this.kind === "TIMEOUT" || this.kind === "NETWORK") return true;
    if (this.kind === "HTTP") return this.status === 429 || (this.status !== undefined && this.status >= 500);
    return false;
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: "enabled" | "disabled";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek Chat Completions (OpenAI-compatible) with JSON Output:
 * `response_format: {type: "json_object"}` and the word "json" in the prompt
 * (https://api-docs.deepseek.com/guides/json_mode). Thinking mode is on by
 * default upstream; we disable it for bounded latency and so `temperature`
 * takes effect (https://api-docs.deepseek.com/guides/thinking_mode).
 */
export function createDeepSeekProvider(options: DeepSeekOptions): ChatProvider {
  const config: ProviderConfig = {
    provider: "deepseek",
    model: options.model,
    baseUrl: options.baseUrl ?? DEEPSEEK_BASE_URL,
    responseFormat: "json_object",
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 1500,
    thinking: options.thinking ?? "disabled",
    timeoutMs: options.timeoutMs ?? 20_000,
  };
  const doFetch = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey;

  return {
    config,
    async complete({ messages, signal }) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        response_format: { type: "json_object" },
        max_tokens: config.maxTokens,
        thinking: { type: config.thinking },
        stream: false,
      };
      if (config.thinking === "disabled") body.temperature = config.temperature;

      let res: Response;
      try {
        res = await doFetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw new ProviderError("TIMEOUT", "provider call aborted by timeout");
        throw new ProviderError("NETWORK", `network error: ${(err as Error).name}`);
      }
      if (!res.ok) {
        // Body may echo request details; keep only the status in errors/logs.
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("HTTP", `provider HTTP ${res.status}`, res.status);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        if (signal.aborted) throw new ProviderError("TIMEOUT", "provider call aborted by timeout");
        throw new ProviderError("BAD_RESPONSE", "provider response was not JSON");
      }
      return parseChatCompletion(json);
    },
  };
}

interface RawCompletion {
  model?: unknown;
  system_fingerprint?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseChatCompletion(json: unknown): ChatResponse {
  const raw = (json ?? {}) as RawCompletion;
  const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  if (!choice) throw new ProviderError("BAD_RESPONSE", "provider response had no choices");
  const usage: TokenUsage | null = raw.usage
    ? {
        promptTokens: num(raw.usage.prompt_tokens),
        completionTokens: num(raw.usage.completion_tokens),
        totalTokens: num(raw.usage.total_tokens),
        ...(typeof raw.usage.prompt_cache_hit_tokens === "number"
          ? { cacheHitTokens: raw.usage.prompt_cache_hit_tokens }
          : {}),
      }
    : null;
  return {
    content: str(choice.message?.content),
    finishReason: str(choice.finish_reason),
    refusal: str(choice.message?.refusal),
    responseModel: str(raw.model),
    systemFingerprint: str(raw.system_fingerprint),
    usage,
  };
}
