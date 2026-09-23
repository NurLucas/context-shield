import { describe, it, expect } from 'vitest';
import { SecretScanner } from '../src/security/scanner.js';
import { calculateShannonEntropy, isHighEntropySecret } from '../src/security/entropy.js';
import { ChatCompletionRequest } from '../src/types/index.js';

describe('Shannon Entropy', () => {
  it('calculates 0 entropy for empty string', () => {
    expect(calculateShannonEntropy('')).toBe(0);
  });

  it('calculates expected entropy for varied characters', () => {
    const regular = 'hello world';
    const highEntropy = '4a8f9c2d1e0b7f8e3c2a1b9d0e';
    expect(calculateShannonEntropy(highEntropy)).toBeGreaterThan(calculateShannonEntropy(regular));
  });

  it('identifies high entropy tokens correctly', () => {
    const apiSecret = 'sk-proj-4f8A9bC1dE2fG3hI4jK5lM6nO7pQ8rS9tU0vW';
    expect(isHighEntropySecret(apiSecret, 20, 3.5)).toBe(true);
    expect(isHighEntropySecret('this is just standard english text with no secret', 20, 4.5)).toBe(false);
  });
});

describe('SecretScanner', () => {
  const scanner = new SecretScanner();

  it('detects and redacts AWS access keys', () => {
    const prompt = 'Deploying with AKIAIOSFODNN7EXAMPLE to bucket';
    const result = scanner.scanText(prompt);
    expect(result.hasSecrets).toBe(true);
    expect(result.findings[0]?.type).toBe('aws-access-key');
    expect(result.sanitizedText).toBe('Deploying with [REDACTED:AWS-ACCESS-KEY] to bucket');
  });

  it('detects and redacts GitHub Personal Access Tokens', () => {
    const prompt = 'Use ghp_0123456789abcdefghijklmnopqrstuvwxyz for auth';
    const result = scanner.scanText(prompt);
    expect(result.hasSecrets).toBe(true);
    expect(result.findings[0]?.type).toBe('github-pat');
    expect(result.sanitizedText).toContain('[REDACTED:GITHUB-PAT]');
  });

  it('detects and redacts OpenAI API keys', () => {
    const prompt = 'sk-proj-1234567890abcdef1234567890abcdef12345678';
    const result = scanner.scanText(prompt);
    expect(result.hasSecrets).toBe(true);
    expect(result.findings[0]?.type).toBe('openai-api-key');
    expect(result.sanitizedText).toBe('[REDACTED:OPENAI-API-KEY]');
  });

  it('deep scans ChatCompletionRequest messages array', () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Here is my AWS key: AKIAIOSFODNN7EXAMPLE please help configure S3' },
      ],
    };

    const { sanitizedRequest, totalFindings } = scanner.sanitizeRequest(req);
    expect(totalFindings).toHaveLength(1);
    expect(sanitizedRequest.messages[1]?.content).toContain('[REDACTED:AWS-ACCESS-KEY]');
    expect(sanitizedRequest.messages[1]?.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
