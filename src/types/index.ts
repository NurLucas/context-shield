/**
 * ContextShield Type Definitions
 */

export type RedactionMode = 'redact' | 'block' | 'off';

export interface ProxyConfig {
  port: number;
  host: string;
  upstreamUrl: string;
  defaultModel?: string;
  apiKey?: string; // Optional master API key if injecting downstream
  redactionMode: RedactionMode;
  customRedactNotice?: string;
  enableL1Cache: boolean;
  l1MaxEntries: number;
  l1TtlMs: number;
  enableL2Cache: boolean;
  l2DbPath?: string;
  rateLimitPerMinute: number;
  sessionTokenBudget: number; // 0 = unlimited
  dailyTokenBudget: number; // 0 = unlimited
  costPer1kPromptTokens: number; // USD estimation
  costPer1kCompletionTokens: number; // USD estimation
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auditLog: boolean;
}

export interface SecretFinding {
  type: string;
  description: string;
  matchedValue: string;
  redactedValue: string;
  entropy?: number;
  index: number;
}

export interface ScanResult {
  hasSecrets: boolean;
  findings: SecretFinding[];
  sanitizedText: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  frequency_penalty?: number;
  presence_penalty?: number;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message?: ChatMessage;
  delta?: Partial<ChatMessage>;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: unknown[];
    };
    finish_reason: string | null;
  }>;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: TokenUsage;
  system_fingerprint?: string;
}

export interface CacheEntry {
  hash: string;
  requestFingerprint: string;
  model: string;
  responseBody: string;
  isStream: boolean;
  promptTokens: number;
  completionTokens: number;
  createdAt: number;
  lastAccessedAt: number;
  hitCount: number;
  ttlMs: number;
}

export interface CacheLookupResult {
  hit: boolean;
  tier?: 'L1' | 'L2';
  entry?: CacheEntry;
  latencyMs?: number;
}

export interface SessionMetrics {
  totalRequests: number;
  cacheHitsL1: number;
  cacheHitsL2: number;
  cacheMisses: number;
  upstreamErrors: number;
  blockedRequests: number;
  redactedSecrets: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  tokensSaved: number;
  estimatedCostSavedUsd: number;
  averageLatencyMs: number;
  cachedLatencyMs: number;
  startedAt: number;
}
