/**
 * Shannon Entropy Calculator
 * High entropy (> 4.3 for base64/hex strings) indicates randomized credentials/keys.
 */

export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }

  let entropy = 0;
  const len = str.length;

  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Checks if a candidate token exhibits characteristics of a machine-generated high-entropy secret.
 */
export function isHighEntropySecret(candidate: string, minLength = 20, minEntropy = 4.2): boolean {
  if (!candidate || candidate.length < minLength) return false;
  // Ignore normal long words or repeated strings
  if (/^[a-zA-Z\s]+$/.test(candidate) && !/[0-9]/.test(candidate)) {
    return false;
  }
  const entropy = calculateShannonEntropy(candidate);
  return entropy >= minEntropy;
}
