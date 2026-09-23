import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { ProxyServer } from '../src/proxy/server.js';
import { ProxyConfig } from '../src/types/index.js';

describe('ContextShield End-to-End Integration Tests', () => {
  let mockUpstreamServer: http.Server;
  let upstreamPort: number;
  let proxyServer: ProxyServer;
  let proxyPort: number;
  let upstreamReceivedRequests: any[] = [];

  beforeAll(async () => {
    // 1. Setup Mock Upstream Server
    mockUpstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString();
        let parsedBody: any = null;
        try {
          parsedBody = JSON.parse(bodyStr);
        } catch {
          // ignore
        }

        upstreamReceivedRequests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: parsedBody,
        });

        if (req.url?.includes('/v1/chat/completions')) {
          if (parsedBody?.stream) {
            // Mock streaming SSE response
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            res.write(
              `data: ${JSON.stringify({
                id: 'cmpl-stream-1',
                model: parsedBody.model,
                choices: [{ index: 0, delta: { content: 'Mocked ' } }],
              })}\n\n`
            );
            res.write(
              `data: ${JSON.stringify({
                id: 'cmpl-stream-1',
                model: parsedBody.model,
                choices: [{ index: 0, delta: { content: 'Streaming Response' } }],
              })}\n\n`
            );
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            // Mock non-streaming JSON response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'cmpl-json-1',
                object: 'chat.completion',
                created: 1700000000,
                model: parsedBody.model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'Mocked upstream response' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
              })
            );
          }
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        upstreamPort = (mockUpstreamServer.address() as any).port;
        resolve();
      });
    });

    // 2. Setup ContextShield Proxy
    proxyPort = upstreamPort + 100;
    const config: ProxyConfig = {
      port: proxyPort,
      host: '127.0.0.1',
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      redactionMode: 'redact',
      enableL1Cache: true,
      l1MaxEntries: 100,
      l1TtlMs: 60000,
      enableL2Cache: true,
      l2DbPath: ':memory:',
      rateLimitPerMinute: 600,
      sessionTokenBudget: 100000,
      dailyTokenBudget: 100000,
      costPer1kPromptTokens: 0.005,
      costPer1kCompletionTokens: 0.015,
      logLevel: 'debug',
      auditLog: true,
    };

    proxyServer = new ProxyServer(config);
    await proxyServer.listen();
  });

  afterAll(async () => {
    await proxyServer.close();
    await new Promise<void>((resolve) => mockUpstreamServer.close(() => resolve()));
  });

  it('serves /health check', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
    expect(data.version).toBe('1.0.0');
  });

  it('proxies request, redacts secrets before forwarding, and caches response', async () => {
    upstreamReceivedRequests = [];

    const payload = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: 'Here is my secret AWS key AKIAIOSFODNN7EXAMPLE please help me configure S3',
        },
      ],
      stream: false,
    };

    // First request: Cache Miss
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-contextshield-cache')).toBe('MISS');
    const json1 = (await res1.json()) as any;
    expect(json1.choices[0].message.content).toBe('Mocked upstream response');

    // Verify upstream received sanitized request
    expect(upstreamReceivedRequests.length).toBe(1);
    const forwardedBody = upstreamReceivedRequests[0].body;
    expect(forwardedBody.messages[0].content).toContain('[REDACTED:AWS-ACCESS-KEY]');
    expect(forwardedBody.messages[0].content).not.toContain('AKIAIOSFODNN7EXAMPLE');

    // Second request with same content: Cache Hit (L1)
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-contextshield-cache')).toBe('HIT-L1');
    const json2 = (await res2.json()) as any;
    expect(json2.choices[0].message.content).toBe('Mocked upstream response');

    // Verify upstream was NOT called for second request
    expect(upstreamReceivedRequests.length).toBe(1);
  });

  it('correctly handles streaming SSE requests and caches stream output', async () => {
    upstreamReceivedRequests = [];

    const streamPayload = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Stream test message' }],
      stream: true,
    };

    // 1st request: streaming miss
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(streamPayload),
    });

    expect(res1.status).toBe(200);
    expect(res1.headers.get('content-type')).toContain('text/event-stream');
    const text1 = await res1.text();
    expect(text1).toContain('Mocked ');
    expect(text1).toContain('Streaming Response');
    expect(text1).toContain('data: [DONE]');

    // Wait a brief moment for background stream tap to finish caching
    await new Promise((r) => setTimeout(r, 100));

    // 2nd request: streaming cache hit
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(streamPayload),
    });

    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-contextshield-cache')).toBe('HIT-L1');
    expect(res2.headers.get('content-type')).toContain('text/event-stream');
    const text2 = await res2.text();
    expect(text2).toContain('Mocked Streaming Response');
    expect(text2).toContain('data: [DONE]');
  });

  it('exposes /metrics in Prometheus format and /stats in JSON', async () => {
    const metricsRes = await fetch(`http://127.0.0.1:${proxyPort}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('contextshield_requests_total');
    expect(metricsText).toContain('contextshield_tokens_saved_total');
    expect(metricsText).toContain('contextshield_secrets_redacted_total');

    const statsRes = await fetch(`http://127.0.0.1:${proxyPort}/stats`);
    expect(statsRes.status).toBe(200);
    const statsJson = (await statsRes.json()) as any;
    expect(statsJson.sessionMetrics.totalRequests).toBeGreaterThan(0);
    expect(statsJson.sessionMetrics.cacheHitsL1).toBeGreaterThan(0);
    expect(statsJson.sessionMetrics.redactedSecrets).toBeGreaterThan(0);
  });
});
