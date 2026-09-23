import { Transform, TransformCallback } from 'node:stream';
import { ChatCompletionChunk, ChatCompletionResponse } from '../types/index.js';

export interface SseStreamResult {
  fullContent: string;
  model: string;
  responseId: string;
  promptTokens: number;
  completionTokens: number;
  completeResponse: ChatCompletionResponse;
}

/**
 * Streaming SSE Tap
 * Passes chunks downstream with zero added latency while extracting
 * full response text and token counts in flight for caching.
 */
export class SseStreamTap extends Transform {
  private buffer = '';
  private fullContent = '';
  private model = '';
  private responseId = '';
  private finishReason: string | null = null;
  private promptTokens = 0;
  private completionTokens = 0;
  private onCompleteCallback?: (result: SseStreamResult) => void;

  constructor(estimatedPromptTokens: number = 0, onComplete?: (result: SseStreamResult) => void) {
    super();
    this.promptTokens = estimatedPromptTokens;
    this.onCompleteCallback = onComplete;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.push(chunk);

    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') {
        this.emitComplete();
        continue;
      }

      try {
        const parsed = JSON.parse(dataStr) as ChatCompletionChunk;
        if (parsed.id) this.responseId = parsed.id;
        if (parsed.model) this.model = parsed.model;

        if (parsed.choices && parsed.choices.length > 0) {
          const choice = parsed.choices[0];
          if (choice?.delta?.content) {
            this.fullContent += choice.delta.content;
          }
          if (choice?.finish_reason) {
            this.finishReason = choice.finish_reason;
          }
        }

        // Upstream might provide usage in stream
        if ((parsed as any).usage) {
          const u = (parsed as any).usage;
          if (u.prompt_tokens) this.promptTokens = u.prompt_tokens;
          if (u.completion_tokens) this.completionTokens = u.completion_tokens;
        }
      } catch {
        // Ignore partial/unparseable json chunks
      }
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      // Process remaining buffer if any
      const trimmed = this.buffer.trim();
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          this.emitComplete();
        }
      }
    }
    callback();
  }

  private emitComplete(): void {
    // If completion tokens weren't provided upstream, estimate from character length (~4 chars/token)
    if (this.completionTokens === 0) {
      this.completionTokens = Math.max(1, Math.ceil(this.fullContent.length / 4));
    }

    const completeResponse: ChatCompletionResponse = {
      id: this.responseId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model || 'unknown',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.fullContent,
          },
          finish_reason: this.finishReason || 'stop',
        },
      ],
      usage: {
        prompt_tokens: this.promptTokens,
        completion_tokens: this.completionTokens,
        total_tokens: this.promptTokens + this.completionTokens,
      },
    };

    if (this.onCompleteCallback) {
      this.onCompleteCallback({
        fullContent: this.fullContent,
        model: this.model,
        responseId: this.responseId,
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        completeResponse,
      });
    }
  }
}

/**
 * Replays a cached response as an SSE stream for clients that requested stream: true
 */
export function replayAsSseStream(response: ChatCompletionResponse): string[] {
  const chunks: string[] = [];
  const content =
    typeof response.choices[0]?.message?.content === 'string'
      ? response.choices[0].message.content
      : '';

  // Initial role chunk
  chunks.push(
    `data: ${JSON.stringify({
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`
  );

  // Content chunk
  chunks.push(
    `data: ${JSON.stringify({
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`
  );

  // Finish chunk
  chunks.push(
    `data: ${JSON.stringify({
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`
  );

  // Stream terminator
  chunks.push('data: [DONE]\n\n');

  return chunks;
}
