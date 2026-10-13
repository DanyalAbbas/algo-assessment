import { Injectable, Logger } from '@nestjs/common';
import { Groq } from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { CATEGORIES, FALLBACK_CATEGORY } from './categories';

// How many of a user's own corrections are fed back into their prompt. Applied
// per user so one user's feedback cannot exhaust another's budget.
const CORRECTION_EXAMPLES_PER_USER = 40;

// A correction the user made on a past transaction. Injected into prompts as
// few-shot examples so the model learns the user's preferences.
interface CorrectionExample {
  description: string;
  originalCategory: string;
  correctedCategory: string;
}

@Injectable()
export class CategorizationService {
  private readonly logger = new Logger(CategorizationService.name);
  private groq: Groq | null = null;
  private model: string;

  // Background work queue. Categorization is derived data, so it is kept off
  // the money-movement path: a transfer commits and returns without waiting
  // on a third-party LLM. The queue is drained by a small concurrency-limited
  // worker, so a slow or failing provider cannot exhaust the event loop or
  // slow down transfers.
  private readonly queue: string[] = [];
  private inFlight = 0;
  private readonly maxConcurrent: number;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.GROQ_API_KEY;
    this.model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    this.maxConcurrent = Number(process.env.LLM_CONCURRENCY || 3);
    if (apiKey && !apiKey.startsWith('your-')) {
      this.groq = new Groq({ apiKey });
    } else {
      this.logger.warn(
        'GROQ_API_KEY not set — transactions will be left as Uncategorized',
      );
    }
  }

  /**
   * Queue transactions for background categorization. Returns immediately —
   * the caller (the transfer path) must never block on this.
   */
  enqueue(transactionIds: string[]) {
    if (transactionIds.length === 0) return;
    this.queue.push(...transactionIds);
    // Defer so the current request finishes its response first.
    setImmediate(() => this.pump());
  }

  private pump() {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.inFlight += 1;
      void this.processWithRetry(id)
        .catch((err) =>
          this.logger.warn(`Background categorization failed: ${err}`),
        )
        .finally(() => {
          this.inFlight -= 1;
          this.pump();
        });
    }
  }

  // One retry: a transient provider error (429/5xx/timeout) usually clears,
  // and without a retry a blip would permanently leave the row Uncategorized.
  private async processWithRetry(id: string, attempt = 0) {
    try {
      await this.categorizeTransactions([id]);
    } catch (err) {
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.processWithRetry(id, attempt + 1);
      }
      throw err;
    }
  }

  /** Queue depth, exposed for diagnostics/tests. */
  get pendingCount(): number {
    return this.queue.length + this.inFlight;
  }

  // Categorize a set of transactions (both ledger entries of a transfer).
  // Returns a map of transactionId -> category so callers can reflect the
  // result in an in-flight response without re-reading the database.
  async categorizeTransactions(
    transactionIds: string[],
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    if (transactionIds.length === 0) return results;
    const transactions = await this.prisma.transaction.findMany({
      where: { id: { in: transactionIds } },
      include: {
        account: { select: { userId: true } },
      },
    });
    if (transactions.length === 0) return results;

    // Gather per-user corrections for the few-shot feedback loop. The limit is
    // applied PER USER (one query each) rather than to the combined result, so
    // a user with many corrections cannot crowd another user's feedback out of
    // their prompt. Grouping by user also keeps one user's corrections out of
    // another's prompt entirely.
    const userIds = [...new Set(transactions.map((t) => t.account.userId))];
    const correctionsByUser = new Map<string, CorrectionExample[]>();
    for (const uid of userIds) {
      const corrections = await this.prisma.categoryCorrection.findMany({
        where: { userId: uid },
        orderBy: { createdAt: 'desc' },
        take: CORRECTION_EXAMPLES_PER_USER,
      });
      correctionsByUser.set(
        uid,
        corrections.map((c) => ({
          description: c.description,
          originalCategory: c.originalCategory,
          correctedCategory: c.correctedCategory,
        })),
      );
    }

    // The two ledger rows of a transfer usually carry the SAME description (and
    // the same owner), so classify each distinct (owner, description) pair once
    // and reuse the answer. Without this a single transfer burns two LLM calls
    // on a near-identical prompt, which is pure waste against a metered quota.
    const cache = new Map<string, string | null>();
    const updates: Array<{ id: string; category: string }> = [];
    for (const tx of transactions) {
      const examples = correctionsByUser.get(tx.account.userId) ?? [];
      const cacheKey = `${JSON.stringify([tx.account.userId, tx.description])}`;
      let category = cache.get(cacheKey);
      if (category === undefined) {
        category = await this.categorizeOne(tx.description, examples);
        cache.set(cacheKey, category);
      }
      if (category) {
        updates.push({ id: tx.id, category });
        results.set(tx.id, category);
      }
    }

    // Batch the writes.
    for (const u of updates) {
      await this.prisma.transaction.update({
        where: { id: u.id },
        data: { category: u.category },
      });
    }
    return results;
  }

  private async categorizeOne(
    description: string,
    examples: CorrectionExample[],
  ): Promise<string | null> {
    if (!this.groq) return null; // leave as Uncategorized
    if (!description || description.trim().length === 0) {
      return FALLBACK_CATEGORY;
    }

    const categoryList = CATEGORIES.join(', ');
    let prompt = `You are a transaction categorization engine for a personal-finance app.
Categorize the transaction description into exactly ONE of these categories:
${categoryList}

Rules:
- Respond with ONLY the category name, nothing else.
- If the description is a generic money transfer between people/accounts, use "Transfers".
- If a salary/payroll deposit is described, use "Salary".
- If you cannot tell, use "Other".`;

    if (examples.length > 0) {
      prompt += `\n\nThe user has corrected categories before. When a new description resembles a corrected one, prefer the user's corrected category:\n`;
      // De-duplicate by correctedCategory+description to keep the prompt tight.
      const seen = new Set<string>();
      let count = 0;
      for (const ex of examples) {
        const key = `${ex.description}|${ex.correctedCategory}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prompt += `- Description: "${ex.description}" was corrected from "${ex.originalCategory}" to "${ex.correctedCategory}".\n`;
        if (++count >= 15) break;
      }
    }

    prompt += `\nTransaction description: "${description}"\nCategory:`;

    try {
      // Hard timeout: categorization runs on the request path after commit,
      // so a slow or wedged provider must never be able to hold a transfer
      // response open indefinitely. On timeout the entry simply stays
      // "Uncategorized" — the money movement has already committed.
      const response = await Promise.race([
        this.groq.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          // Reasoning models (e.g. gpt-oss) spend tokens on a hidden reasoning
          // trace before the visible answer, so the budget must exceed the
          // answer length alone or the content comes back empty.
          max_tokens: 400,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('LLM request timed out')),
            Number(process.env.LLM_TIMEOUT_MS || 5000),
          ).unref?.(),
        ),
      ]);
      const raw = (response.choices[0]?.message?.content ?? '').trim();
      return this.normalizeCategory(raw);
    } catch (err) {
      this.logger.warn(`Groq categorization failed: ${err}`);
      return null; // leave as Uncategorized; transfer is unaffected
    }
  }

  // The model sometimes wraps the answer in quotes, punctuation, or
  // apologizes. Map its answer onto our canonical list; otherwise Other.
  //
  // Empty / whitespace / punctuation-only output must take the explicit
  // fallback. It cannot reach the fuzzy match below: String.prototype.includes
  // returns true for the empty needle against every candidate, which would
  // silently assign whatever category happens to be first in the list.
  normalizeCategory(raw: string): string {
    const cleaned = raw
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/[.!?,]+$/g, '')
      .trim();
    if (cleaned.length === 0) {
      return 'Other';
    }
    const lower = cleaned.toLowerCase();
    const match = CATEGORIES.find((c) => c.toLowerCase() === lower);
    if (match) return match;
    // Fuzzy contains-match for minor variations. Requires a needle long enough
    // to be meaningful, so stray single characters cannot select a category by
    // accident (e.g. "&" matching "Food & Dining").
    if (lower.length >= 3) {
      const fuzzy = CATEGORIES.find(
        (c) =>
          lower.includes(c.toLowerCase()) || c.toLowerCase().includes(lower),
      );
      if (fuzzy) return fuzzy;
    }
    return 'Other';
  }
}
