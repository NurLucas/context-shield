import { SessionMetrics, ProxyConfig } from '../types/index.js';
import pc from 'picocolors';

export class MetricsCollector {
  private metrics: SessionMetrics;
  private config: ProxyConfig;
  private latencySamples: number[] = [];
  private cachedLatencySamples: number[] = [];

  constructor(config: ProxyConfig) {
    this.config = config;
    this.metrics = {
      totalRequests: 0,
      cacheHitsL1: 0,
      cacheHitsL2: 0,
      cacheMisses: 0,
      upstreamErrors: 0,
      blockedRequests: 0,
      redactedSecrets: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      tokensSaved: 0,
      estimatedCostSavedUsd: 0,
      averageLatencyMs: 0,
      cachedLatencyMs: 0,
      startedAt: Date.now(),
    };
  }

  public recordRequest(): void {
    this.metrics.totalRequests += 1;
  }

  public recordCacheHit(tier: 'L1' | 'L2', promptTokens: number, completionTokens: number, latencyMs: number): void {
    if (tier === 'L1') this.metrics.cacheHitsL1 += 1;
    else this.metrics.cacheHitsL2 += 1;

    const tokens = promptTokens + completionTokens;
    this.metrics.tokensSaved += tokens;

    // Calculate dollar savings
    const promptCost = (promptTokens / 1000) * this.config.costPer1kPromptTokens;
    const completionCost = (completionTokens / 1000) * this.config.costPer1kCompletionTokens;
    this.metrics.estimatedCostSavedUsd += promptCost + completionCost;

    this.cachedLatencySamples.push(latencyMs);
    if (this.cachedLatencySamples.length > 100) this.cachedLatencySamples.shift();
    this.metrics.cachedLatencyMs = Math.round(
      this.cachedLatencySamples.reduce((a, b) => a + b, 0) / this.cachedLatencySamples.length
    );
  }

  public recordCacheMiss(promptTokens: number, completionTokens: number, latencyMs: number): void {
    this.metrics.cacheMisses += 1;
    this.metrics.totalPromptTokens += promptTokens;
    this.metrics.totalCompletionTokens += completionTokens;

    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > 100) this.latencySamples.shift();
    this.metrics.averageLatencyMs = Math.round(
      this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length
    );
  }

  public recordBlocked(): void {
    this.metrics.blockedRequests += 1;
  }

  public recordRedactedSecrets(count: number): void {
    this.metrics.redactedSecrets += count;
  }

  public recordUpstreamError(): void {
    this.metrics.upstreamErrors += 1;
  }

  public getMetrics(): SessionMetrics {
    return { ...this.metrics };
  }

  /**
   * Generates Prometheus / OpenTelemetry compliant text format
   */
  public toPrometheus(): string {
    const m = this.metrics;
    return [
      '# HELP contextshield_requests_total Total number of HTTP requests processed',
      '# TYPE contextshield_requests_total counter',
      `contextshield_requests_total ${m.totalRequests}`,
      '# HELP contextshield_cache_hits_total Total number of cache hits by tier',
      '# TYPE contextshield_cache_hits_total counter',
      `contextshield_cache_hits_total{tier="L1"} ${m.cacheHitsL1}`,
      `contextshield_cache_hits_total{tier="L2"} ${m.cacheHitsL2}`,
      '# HELP contextshield_cache_misses_total Total number of cache misses',
      '# TYPE contextshield_cache_misses_total counter',
      `contextshield_cache_misses_total ${m.cacheMisses}`,
      '# HELP contextshield_tokens_saved_total Total tokens saved by caching',
      '# TYPE contextshield_tokens_saved_total counter',
      `contextshield_tokens_saved_total ${m.tokensSaved}`,
      '# HELP contextshield_cost_saved_usd Total estimated USD saved',
      '# TYPE contextshield_cost_saved_usd gauge',
      `contextshield_cost_saved_usd ${m.estimatedCostSavedUsd.toFixed(4)}`,
      '# HELP contextshield_secrets_redacted_total Total secrets intercepted and sanitized',
      '# TYPE contextshield_secrets_redacted_total counter',
      `contextshield_secrets_redacted_total ${m.redactedSecrets}`,
    ].join('\n');
  }

  /**
   * Formats a clean terminal dashboard display
   */
  public renderDashboard(): string {
    const m = this.metrics;
    const uptimeSec = Math.floor((Date.now() - m.startedAt) / 1000);
    const hitTotal = m.cacheHitsL1 + m.cacheHitsL2;
    const hitRate = m.totalRequests > 0 ? ((hitTotal / m.totalRequests) * 100).toFixed(1) : '0.0';

    return [
      pc.cyan('╔═════════════════════════════════════════════════════════════════╗'),
      pc.cyan('║               🛡️  CONTEXT-SHIELD TELEMETRY                     ║'),
      pc.cyan('╠═════════════════════════════════════════════════════════════════╣'),
      `║ ${pc.bold('Uptime:')} ${uptimeSec}s   ${pc.bold('Requests:')} ${m.totalRequests}   ${pc.bold('Hit Rate:')} ${pc.green(hitRate + '%')}                   ║`,
      `║ ${pc.bold('Cache Hits:')} L1: ${pc.yellow(m.cacheHitsL1)} | L2: ${pc.yellow(m.cacheHitsL2)} | Misses: ${pc.dim(m.cacheMisses)}                      ║`,
      `║ ${pc.bold('Tokens Saved:')} ${pc.green(m.tokensSaved.toLocaleString())} tokens                                   ║`,
      `║ ${pc.bold('Est. Savings:')} ${pc.bold(pc.green('$' + m.estimatedCostSavedUsd.toFixed(4)))} USD                                    ║`,
      `║ ${pc.bold('Secrets Intercepted:')} ${m.redactedSecrets > 0 ? pc.red(m.redactedSecrets) : pc.dim('0')}                                     ║`,
      `║ ${pc.bold('Latency:')} Upstream avg: ${m.averageLatencyMs}ms | Cached: ${pc.green(m.cachedLatencyMs + 'ms')}              ║`,
      pc.cyan('╚═════════════════════════════════════════════════════════════════╝'),
    ].join('\n');
  }
}
