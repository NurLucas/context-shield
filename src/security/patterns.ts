/**
 * Security Rule Definitions for Secret & Credential Detection
 */

export interface SecretPattern {
  id: string;
  name: string;
  regex: RegExp;
  extractGroup?: number;
  minEntropy?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'aws-access-key',
    name: 'AWS Access Key ID',
    regex: /\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'aws-secret-key',
    name: 'AWS Secret Access Key',
    regex: /(?:aws_secret_access_key|aws_sec_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    extractGroup: 1,
    minEntropy: 4.2,
  },
  {
    id: 'github-pat',
    name: 'GitHub Personal Access Token',
    regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59})\b/g,
  },
  {
    id: 'openai-api-key',
    name: 'OpenAI API Key',
    regex: /\b(sk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{32,100})\b/g,
  },
  {
    id: 'anthropic-api-key',
    name: 'Anthropic API Key',
    regex: /\b(sk-ant-[a-zA-Z0-9_-]{32,120})\b/g,
  },
  {
    id: 'google-api-key',
    name: 'Google API Key',
    regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g,
  },
  {
    id: 'stripe-secret-key',
    name: 'Stripe Secret Key',
    regex: /\b([sr]k_live_[0-9a-zA-Z]{24,99})\b/g,
  },
  {
    id: 'slack-token',
    name: 'Slack Token',
    regex: /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/g,
  },
  {
    id: 'jwt-token',
    name: 'JSON Web Token (JWT)',
    regex: /\b(eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g,
  },
  {
    id: 'private-key',
    name: 'Cryptographic Private Key',
    regex: /-----BEGIN\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----/g,
  },
  {
    id: 'database-uri',
    name: 'Database Connection String with Credentials',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s\/]+:([^@\s\/]+)@[^:\s\/]+/gi,
    extractGroup: 1,
  },
  {
    id: 'generic-api-key-assign',
    name: 'Generic API Key / Secret Assignment',
    regex: /(?:api[_-]?key|secret[_-]?token|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["']([a-zA-Z0-9_\-\.]{20,100})["']/gi,
    extractGroup: 1,
    minEntropy: 3.8,
  },
];
