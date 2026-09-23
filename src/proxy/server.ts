import * as http from 'node:http';
import { Readable } from 'node:stream';
import { ProxyConfig, ChatCompletionRequest, ChatCompletionResponse } from '../types/index.js';
import { SecretScanner } from '../security/scanner.js';
import { TokenBucketLimiter } from '../ratelimit/token-bucket.js';
import { BudgetGuard, BudgetExceededError } from '../ratelimit/budget-guard.js';
import { hashRequest } from '../cache/hasher.js';
import { L1LruCache } from '../cache/l1-lru.js';
import { L2SqliteCache } from '../cache/l2-sqlite.js';
import { SseStreamTap, replayAsSseStream } from './sse-parser.js';
import { UpstreamClient } from './upstream.js';
import { MetricsCollector } from '../telemetry/metrics.js';

export class ProxyServer {
  private server: http.Server;
  private config: ProxyConfig;
  private scanner: SecretScanner;
  private rateLimiter: TokenBucketLimiter;
  private budgetGuard: BudgetGuard;
  private l1Cache: L1LruCache;
  private l2Cache: L2SqliteCache;
  private upstreamClient: UpstreamClient;
  private metrics: MetricsCollector;

  constructor(config: ProxyConfig) {
    this.config = config;
    this.scanner = new SecretScanner(config.customRedactNotice);
    this.rateLimiter = new TokenBucketLimiter(config.rateLimitPerMinute);
    this.budgetGuard = new BudgetGuard(config.sessionTokenBudget, config.dailyTokenBudget);
    this.l1Cache = new L1LruCache(config.l1MaxEntries, config.l1TtlMs);
    this.l2Cache = new L2SqliteCache(config.l2DbPath);
    this.upstreamClient = new UpstreamClient(config.upstreamUrl, config.apiKey);
    this.metrics = new MetricsCollector(config);

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  public getMetricsCollector(): MetricsCollector {
    return this.metrics;
  }

  public getBudgetGuard(): BudgetGuard {
    return this.budgetGuard;
  }

  public getL1Cache(): L1LruCache {
    return this.l1Cache;
  }

  public getL2Cache(): L2SqliteCache {
    return this.l2Cache;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startTime = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

    // CORS pre-flight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }

    // Diagnostic & Telemetry Endpoints
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), version: '1.0.0' }));
      return;
    }

    if (pathname === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(this.metrics.toPrometheus());
      return;
    }

    if (pathname === '/stats' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sessionMetrics: this.metrics.getMetrics(),
          budget: this.budgetGuard.getUsage(),
          l1Size: this.l1Cache.size(),
          l2Stats: this.l2Cache.getStats(),
        })
      );
      return;
    }

    if (pathname === '/cache/clear' && req.method === 'POST') {
      this.l1Cache.clear();
      this.l2Cache.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'L1 and L2 caches cleared successfully' }));
      return;
    }

    // Only proxy POST requests for completion endpoints
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Cannot ${req.method} ${pathname}` } }));
      return;
    }

    this.metrics.recordRequest();

    const rateCheck = this.rateLimiter.tryConsume(clientIp);
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(rateCheck.resetMs / 1000)),
      });
      res.end(
        JSON.stringify({
          error: {
            message: 'Rate limit exceeded. Too many requests to ContextShield proxy.',
            type: 'rate_limit_error',
            code: 429,
          },
        })
      );
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    req.on('end', async () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let requestBody: ChatCompletionRequest;

        try {
          requestBody = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request payload' } }));
          return;
        }

        let sanitizedRequest = requestBody;
        if (this.config.redactionMode !== 'off') {
          const scanResult = this.scanner.sanitizeRequest(requestBody);

          if (scanResult.totalFindings.length > 0) {
            this.metrics.recordRedactedSecrets(scanResult.totalFindings.length);

            if (this.config.redactionMode === 'block') {
              this.metrics.recordBlocked();
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: {
                    message: 'ContextShield Security Firewall blocked request containing sensitive credentials.',
                    type: 'security_violation',
                    code: 403,
                    findings: scanResult.totalFindings.map((f) => ({
                      type: f.type,
                      description: f.description,
                      matched: f.matchedValue.slice(0, 4) + '****',
                    })),
                  },
                })
              );
              return;
            }

            sanitizedRequest = scanResult.sanitizedRequest;
          }
        }

        const estimatedTokens = this.budgetGuard.estimateRequestTokens(sanitizedRequest);
        try {
          this.budgetGuard.verifyBudget(estimatedTokens);
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            this.metrics.recordBlocked();
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: err.message,
                  type: 'budget_exceeded',
                  code: 429,
                  usage: this.budgetGuard.getUsage(),
                },
              })
            );
            return;
          }
          throw err;
        }

        const requestHash = hashRequest(sanitizedRequest);
        const isClientStreaming = Boolean(sanitizedRequest.stream);

        let cachedEntry = this.config.enableL1Cache ? this.l1Cache.get(requestHash) : null;
        let cacheTier: 'L1' | 'L2' | undefined;

        if (cachedEntry) {
          cacheTier = 'L1';
        } else if (this.config.enableL2Cache) {
          cachedEntry = this.l2Cache.get(requestHash);
          if (cachedEntry) {
            cacheTier = 'L2';
            if (this.config.enableL1Cache) {
              this.l1Cache.set(requestHash, cachedEntry);
            }
          }
        }

        // Cache Hit Handling
        if (cachedEntry && cacheTier) {
          const latencyMs = Date.now() - startTime;
          this.metrics.recordCacheHit(cacheTier, cachedEntry.promptTokens, cachedEntry.completionTokens, latencyMs);

          const parsedResponse = JSON.parse(cachedEntry.responseBody) as ChatCompletionResponse;

          if (isClientStreaming) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-ContextShield-Cache': `HIT-${cacheTier}`,
              'X-ContextShield-Latency': `${latencyMs}ms`,
            });

            const streamChunks = replayAsSseStream(parsedResponse);
            for (const chunk of streamChunks) {
              res.write(chunk);
            }
            res.end();
          } else {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-ContextShield-Cache': `HIT-${cacheTier}`,
              'X-ContextShield-Latency': `${latencyMs}ms`,
            });
            res.end(cachedEntry.responseBody);
          }
          return;
        }

        if (sanitizedRequest.model?.toLowerCase().includes('mock') || this.config.upstreamUrl === 'mock') {
          const latencyMs = Date.now() - startTime;
          const promptTokens = estimatedTokens;
          const completionTokens = 25;
          const lastMsg = sanitizedRequest.messages?.[sanitizedRequest.messages.length - 1];
          const promptContent = typeof lastMsg?.content === 'string' ? lastMsg.content : 'test prompt';

          const mockResponse: ChatCompletionResponse = {
            id: `chatcmpl-mock-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: sanitizedRequest.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `[ContextShield Mock Engine] Received sanitized prompt: "${promptContent}". Secret protection and caching are active!`,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          };

          this.metrics.recordCacheMiss(promptTokens, completionTokens, latencyMs);
          this.budgetGuard.recordUsage(promptTokens + completionTokens);

          const responseText = JSON.stringify(mockResponse);

          if (this.config.enableL1Cache) {
            this.l1Cache.set(requestHash, {
              hash: requestHash,
              requestFingerprint: sanitizedRequest.model,
              model: sanitizedRequest.model,
              responseBody: responseText,
              isStream: isClientStreaming,
              promptTokens,
              completionTokens,
              ttlMs: this.config.l1TtlMs,
            });
          }
          if (this.config.enableL2Cache) {
            this.l2Cache.set(requestHash, {
              hash: requestHash,
              requestFingerprint: sanitizedRequest.model,
              model: sanitizedRequest.model,
              responseBody: responseText,
              isStream: isClientStreaming,
              promptTokens,
              completionTokens,
              ttlMs: this.config.l1TtlMs,
            });
          }

          if (isClientStreaming) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-ContextShield-Cache': 'MISS',
            });
            const streamChunks = replayAsSseStream(mockResponse);
            for (const chunk of streamChunks) res.write(chunk);
            res.end();
          } else {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-ContextShield-Cache': 'MISS',
            });
            res.end(responseText);
          }
          return;
        }

        const upstreamRes = await this.upstreamClient.forwardRequest(
          pathname,
          req.method || 'POST',
          req.headers,
          sanitizedRequest
        );

        const contentType = upstreamRes.headers.get('content-type') || '';
        const isSseStream = isClientStreaming || contentType.includes('text/event-stream');

        // Copy upstream response headers
        const downstreamHeaders: Record<string, string> = {
          'X-ContextShield-Cache': 'MISS',
        };
        for (const [k, v] of upstreamRes.headers.entries()) {
          if (!['content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
            downstreamHeaders[k] = v;
          }
        }

        if (!upstreamRes.ok || !upstreamRes.body) {
          this.metrics.recordUpstreamError();
          const errorText = await upstreamRes.text();
          res.writeHead(upstreamRes.status, downstreamHeaders);
          res.end(errorText);
          return;
        }

        if (isSseStream) {
          // Stream handling with SSE Tap
          res.writeHead(upstreamRes.status, {
            ...downstreamHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const nodeReadableStream = Readable.fromWeb(upstreamRes.body as any);
          const tap = new SseStreamTap(estimatedTokens, (streamResult) => {
            const latencyMs = Date.now() - startTime;
            this.metrics.recordCacheMiss(streamResult.promptTokens, streamResult.completionTokens, latencyMs);
            this.budgetGuard.recordUsage(streamResult.promptTokens + streamResult.completionTokens);

            const responseJsonStr = JSON.stringify(streamResult.completeResponse);

            // Commit to L1 & L2 cache
            if (this.config.enableL1Cache) {
              this.l1Cache.set(requestHash, {
                hash: requestHash,
                requestFingerprint: sanitizedRequest.model,
                model: sanitizedRequest.model,
                responseBody: responseJsonStr,
                isStream: true,
                promptTokens: streamResult.promptTokens,
                completionTokens: streamResult.completionTokens,
                ttlMs: this.config.l1TtlMs,
              });
            }
            if (this.config.enableL2Cache) {
              this.l2Cache.set(requestHash, {
                hash: requestHash,
                requestFingerprint: sanitizedRequest.model,
                model: sanitizedRequest.model,
                responseBody: responseJsonStr,
                isStream: true,
                promptTokens: streamResult.promptTokens,
                completionTokens: streamResult.completionTokens,
                ttlMs: this.config.l1TtlMs,
              });
            }
          });

          nodeReadableStream.pipe(tap).pipe(res);
        } else {
          // Non-streaming JSON handling
          const responseText = await upstreamRes.text();
          const latencyMs = Date.now() - startTime;

          res.writeHead(upstreamRes.status, {
            ...downstreamHeaders,
            'Content-Type': 'application/json',
          });
          res.end(responseText);

          try {
            const parsed = JSON.parse(responseText) as ChatCompletionResponse;
            const promptTokens = parsed.usage?.prompt_tokens || estimatedTokens;
            const completionTokens = parsed.usage?.completion_tokens || Math.ceil(responseText.length / 4);

            this.metrics.recordCacheMiss(promptTokens, completionTokens, latencyMs);
            this.budgetGuard.recordUsage(promptTokens + completionTokens);

            if (this.config.enableL1Cache) {
              this.l1Cache.set(requestHash, {
                hash: requestHash,
                requestFingerprint: sanitizedRequest.model,
                model: sanitizedRequest.model,
                responseBody: responseText,
                isStream: false,
                promptTokens,
                completionTokens,
                ttlMs: this.config.l1TtlMs,
              });
            }
            if (this.config.enableL2Cache) {
              this.l2Cache.set(requestHash, {
                hash: requestHash,
                requestFingerprint: sanitizedRequest.model,
                model: sanitizedRequest.model,
                responseBody: responseText,
                isStream: false,
                promptTokens,
                completionTokens,
                ttlMs: this.config.l1TtlMs,
              });
            }
          } catch {
            // Unparseable JSON upstream response, skip caching
          }
        }
      } catch (err: any) {
        this.metrics.recordUpstreamError();
        if (!res.headersSent) {
          const isUpstreamNetwork = err?.name === 'TypeError' || err?.message?.includes('fetch failed');
          const statusCode = isUpstreamNetwork ? 502 : 500;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: isUpstreamNetwork
                  ? `Failed to connect to upstream LLM provider (${this.config.upstreamUrl}): ${err?.message}. Note: To test locally without an API key or external network, use model: "mock".`
                  : err?.message || 'Internal Proxy Error',
                type: isUpstreamNetwork ? 'upstream_gateway_error' : 'internal_proxy_error',
                code: statusCode,
              },
            })
          );
        }
      }
    });
  }

  public listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        resolve();
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.l2Cache.close();
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
