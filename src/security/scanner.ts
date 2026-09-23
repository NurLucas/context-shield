import { SecretFinding, ScanResult, ChatCompletionRequest } from '../types/index.js';
import { SECRET_PATTERNS } from './patterns.js';
import { calculateShannonEntropy } from './entropy.js';

export class SecretScanner {
  private customReplacementNotice?: string;

  constructor(customNotice?: string) {
    this.customReplacementNotice = customNotice;
  }

  /**
   * Scans a single string and returns all matched secrets with redaction options.
   */
  public scanText(text: string): ScanResult {
    if (!text || typeof text !== 'string') {
      return { hasSecrets: false, findings: [], sanitizedText: text || '' };
    }

    const findings: SecretFinding[] = [];
    let sanitized = text;

    for (const pattern of SECRET_PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(text)) !== null) {
        const fullMatch = match[0];
        let targetSecret = fullMatch;

        if (pattern.extractGroup !== undefined && match[pattern.extractGroup]) {
          targetSecret = match[pattern.extractGroup] as string;
        }

        // Validate entropy if required
        if (pattern.minEntropy !== undefined) {
          const entropy = calculateShannonEntropy(targetSecret);
          if (entropy < pattern.minEntropy) {
            continue; // Skip false positive
          }
        }

        const redacted = this.customReplacementNotice || `[REDACTED:${pattern.id.toUpperCase()}]`;

        findings.push({
          type: pattern.id,
          description: pattern.name,
          matchedValue: targetSecret,
          redactedValue: redacted,
          entropy: calculateShannonEntropy(targetSecret),
          index: match.index,
        });

        // Replace all occurrences in sanitized output
        sanitized = sanitized.split(targetSecret).join(redacted);
      }
    }

    return {
      hasSecrets: findings.length > 0,
      findings,
      sanitizedText: sanitized,
    };
  }

  /**
   * Deep scans and sanitizes a ChatCompletionRequest payload in place.
   */
  public sanitizeRequest(request: ChatCompletionRequest): {
    sanitizedRequest: ChatCompletionRequest;
    totalFindings: SecretFinding[];
  } {
    const totalFindings: SecretFinding[] = [];
    const cloned: ChatCompletionRequest = JSON.parse(JSON.stringify(request));

    if (Array.isArray(cloned.messages)) {
      for (const msg of cloned.messages) {
        if (typeof msg.content === 'string') {
          const res = this.scanText(msg.content);
          if (res.hasSecrets) {
            msg.content = res.sanitizedText;
            totalFindings.push(...res.findings);
          }
        } else if (Array.isArray(msg.content)) {
          // Multimodal / multipart content
          for (const part of msg.content) {
            if (part && typeof part.text === 'string') {
              const res = this.scanText(part.text);
              if (res.hasSecrets) {
                part.text = res.sanitizedText;
                totalFindings.push(...res.findings);
              }
            }
          }
        }
      }
    }

    return {
      sanitizedRequest: cloned,
      totalFindings,
    };
  }
}
