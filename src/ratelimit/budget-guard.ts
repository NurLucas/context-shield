import { ChatCompletionRequest } from '../types/index.js';

export class BudgetExceededError extends Error {
  public currentUsage: number;
  public budgetLimit: number;
  public budgetType: 'session' | 'daily';

  constructor(message: string, currentUsage: number, budgetLimit: number, budgetType: 'session' | 'daily') {
    super(message);
    this.name = 'BudgetExceededError';
    this.currentUsage = currentUsage;
    this.budgetLimit = budgetLimit;
    this.budgetType = budgetType;
  }
}

export class BudgetGuard {
  private sessionTokensUsed = 0;
  private dailyTokensUsed = 0;
  private dailyResetDate: string;

  private readonly sessionBudget: number;
  private readonly dailyBudget: number;

  constructor(sessionBudget: number = 0, dailyBudget: number = 0) {
    this.sessionBudget = sessionBudget;
    this.dailyBudget = dailyBudget;
    this.dailyResetDate = new Date().toISOString().slice(0, 10);
  }

  private checkDailyRollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailyResetDate = today;
      this.dailyTokensUsed = 0;
    }
  }

  /**
   * Approximates token count (~4 characters per token).
   */
  public estimateRequestTokens(request: ChatCompletionRequest): number {
    let totalChars = 0;
    if (Array.isArray(request.messages)) {
      for (const m of request.messages) {
        if (typeof m.content === 'string') {
          totalChars += m.content.length;
        } else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part && typeof part.text === 'string') {
              totalChars += part.text.length;
            }
          }
        }
      }
    }
    return Math.max(1, Math.ceil(totalChars / 4));
  }

  /**
   * Pre-flight budget check before forwarding upstream.
   */
  public verifyBudget(estimatedTokens: number): void {
    this.checkDailyRollover();

    if (this.sessionBudget > 0 && this.sessionTokensUsed + estimatedTokens > this.sessionBudget) {
      throw new BudgetExceededError(
        `Session token budget exceeded: current=${this.sessionTokensUsed}, requested=${estimatedTokens}, limit=${this.sessionBudget}`,
        this.sessionTokensUsed,
        this.sessionBudget,
        'session'
      );
    }

    if (this.dailyBudget > 0 && this.dailyTokensUsed + estimatedTokens > this.dailyBudget) {
      throw new BudgetExceededError(
        `Daily token budget exceeded: current=${this.dailyTokensUsed}, requested=${estimatedTokens}, limit=${this.dailyBudget}`,
        this.dailyTokensUsed,
        this.dailyBudget,
        'daily'
      );
    }
  }

  /**
   * Record actual token expenditure after request completion.
   */
  public recordUsage(actualTokens: number): void {
    this.checkDailyRollover();
    this.sessionTokensUsed += actualTokens;
    this.dailyTokensUsed += actualTokens;
  }

  public getUsage() {
    this.checkDailyRollover();
    return {
      sessionTokensUsed: this.sessionTokensUsed,
      sessionBudget: this.sessionBudget,
      sessionRemaining: this.sessionBudget > 0 ? Math.max(0, this.sessionBudget - this.sessionTokensUsed) : null,
      dailyTokensUsed: this.dailyTokensUsed,
      dailyBudget: this.dailyBudget,
      dailyRemaining: this.dailyBudget > 0 ? Math.max(0, this.dailyBudget - this.dailyTokensUsed) : null,
    };
  }

  public resetSession(): void {
    this.sessionTokensUsed = 0;
  }
}
