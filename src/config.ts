import { ProxyConfig } from './types/index.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

export const DEFAULT_CONFIG: ProxyConfig = {
  port: 8080,
  host: '127.0.0.1',
  upstreamUrl: process.env.UPSTREAM_URL || 'https://api.openai.com',
  apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || undefined,
  redactionMode: 'redact',
  enableL1Cache: true,
  l1MaxEntries: 1000,
  l1TtlMs: 24 * 60 * 60 * 1000, // 24 hours
  enableL2Cache: true,
  l2DbPath: path.join(os.homedir(), '.context-shield', 'cache.db'),
  rateLimitPerMinute: 120,
  sessionTokenBudget: 0, // unlimited by default
  dailyTokenBudget: 0, // unlimited by default
  costPer1kPromptTokens: 0.005, // $0.005 / 1k tokens
  costPer1kCompletionTokens: 0.015, // $0.015 / 1k tokens
  logLevel: 'info',
  auditLog: true,
};

export function loadConfigFile(customPath?: string): Partial<ProxyConfig> {
  const possiblePaths = [
    customPath,
    path.join(process.cwd(), '.contextshieldrc.json'),
    path.join(os.homedir(), '.contextshieldrc.json'),
  ].filter(Boolean) as string[];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Fallthrough if parsing fails
      }
    }
  }

  return {};
}

export function resolveConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  const fileConfig = loadConfigFile();
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...overrides,
  };
}
