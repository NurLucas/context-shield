import { describe, it, expect } from 'vitest';
import { SseStreamTap, replayAsSseStream, SseStreamResult } from '../src/proxy/sse-parser.js';
import { ChatCompletionResponse } from '../src/types/index.js';
import { Readable } from 'node:stream';

describe('SseStreamTap', () => {
  it('intercepts and reconstructs completed response from SSE stream chunks', async () => {
    let capturedResult: SseStreamResult | undefined;

    const tap = new SseStreamTap(15, (res) => {
      capturedResult = res;
    });

    const chunks = [
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const sourceStream = Readable.from(chunks);
    const sink: string[] = [];

    await new Promise<void>((resolve, reject) => {
      sourceStream
        .pipe(tap)
        .on('data', (c) => sink.push(c.toString()))
        .on('end', resolve)
        .on('error', reject);
    });

    // Zero-copy downstream passthrough verified
    expect(sink.join('')).toBe(chunks.join(''));

    // Reconstructed response verified
    expect(capturedResult).toBeDefined();
    expect(capturedResult?.fullContent).toBe('Hello world!');
    expect(capturedResult?.model).toBe('gpt-4o');
    expect(capturedResult?.completeResponse.choices[0]?.message?.content).toBe('Hello world!');
    expect(capturedResult?.promptTokens).toBe(15);
  });

  it('replays a cached response as an SSE stream', () => {
    const mockResponse: ChatCompletionResponse = {
      id: 'chatcmpl-cached',
      object: 'chat.completion',
      created: 123456789,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Cached answer' },
          finish_reason: 'stop',
        },
      ],
    };

    const sseChunks = replayAsSseStream(mockResponse);
    expect(sseChunks.length).toBe(4);
    expect(sseChunks[1]).toContain('Cached answer');
    expect(sseChunks[3]).toBe('data: [DONE]\n\n');
  });
});
