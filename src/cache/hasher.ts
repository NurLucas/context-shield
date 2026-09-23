import { createHash } from 'node:crypto';
import { ChatCompletionRequest } from '../types/index.js';

/**
 * Request Canonicalizer and Fingerprinter
 * Creates a deterministic SHA-256 hash for LLM requests.
 */
export function canonicalizeRequest(request: ChatCompletionRequest): string {
  // Normalize the payload to remove variance in object key order
  const normalized = {
    model: request.model || '',
    messages: (request.messages || []).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.trim() : JSON.stringify(m.content),
      name: m.name || null,
      tool_call_id: m.tool_call_id || null,
    })),
    temperature: request.temperature !== undefined ? Math.round(request.temperature * 100) / 100 : 0.7,
    max_tokens: request.max_tokens || null,
    top_p: request.top_p || null,
    tools: request.tools ? JSON.stringify(request.tools) : null,
    tool_choice: request.tool_choice ? JSON.stringify(request.tool_choice) : null,
  };

  return JSON.stringify(normalized);
}

export function hashRequest(request: ChatCompletionRequest): string {
  const canonical = canonicalizeRequest(request);
  return createHash('sha256').update(canonical).digest('hex');
}
