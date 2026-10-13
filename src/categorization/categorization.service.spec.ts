/**
 * Unit tests for the Transaction Intelligence Agent's categorization logic.
 *  4. Empty / whitespace / punctuation-only model output must take the safe
 *     fallback, never an arbitrary category from the fuzzy match.
 *  5. Correction examples are limited PER USER, so one user's corrections
 *     cannot crowd another user's feedback out of their prompt.
 *
 * The Groq client is stubbed so these tests never touch the network.
 */
import { CategorizationService } from './categorization.service';
import { CATEGORIES } from './categories';

interface PromptRecord {
  userId: string;
  prompt: string;
}

describe('CategorizationService', () => {
  let service: CategorizationService;
  let prompts: PromptRecord[];
  let modelReply: (description: string) => string;

  // Fake Prisma with just the surface this service uses.
  const rows: Array<{ id: string; description: string; userId: string }> = [];
  const corrections: Array<{
    userId: string;
    description: string;
    originalCategory: string;
    correctedCategory: string;
    createdAt: Date;
  }> = [];
  let seq = 0;

  const prismaMock = {
    transaction: {
      findMany: jest.fn(({ where }: any) => {
        const ids = where.id?.in ?? [];
        return rows
          .filter((r) => ids.includes(r.id))
          .map((r) => ({ ...r, account: { userId: r.userId } }));
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    categoryCorrection: {
      // Deliberately records the `take` applied, so a per-user limit is
      // observable and a combined limit would be distinguishable.
      findMany: jest.fn(({ where, take }: any) => {
        return corrections
          .filter((c) => c.userId === where.userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take);
      }),
    },
  };

  const addRow = (userId: string, description: string) => {
    const id = `tx-${seq++}`;
    rows.push({ id, description, userId });
    return id;
  };

  const addCorrection = (
    userId: string,
    description: string,
    correctedCategory: string,
    ageMinutes = 0,
  ) => {
    corrections.push({
      userId,
      description,
      originalCategory: 'Other',
      correctedCategory,
      createdAt: new Date(Date.now() - ageMinutes * 60_000),
    });
  };

  beforeEach(() => {
    rows.length = 0;
    corrections.length = 0;
    prompts = [];
    modelReply = () => 'Other';
    seq = 0;
    jest.clearAllMocks();

    // Constructed directly so the mock Prisma and a stub Groq client can be
    // injected without booting the Nest DI container (no network, no DB).
    service = new CategorizationService(prismaMock as any);

    // Force a client to exist even without a real API key, then stub its call.
    (service as any).groq = {
      chat: {
        completions: {
          create: ({ messages }: any) => {
            const prompt = messages[0].content;
            const match = /Transaction description: "([^"]*)"/.exec(prompt);
            const description = match ? match[1] : '';
            // Attribute the prompt to the account whose row we are handling by
            // recording it with the userId of the most recent matching row.
            const row = rows.find((r) => r.description === description);
            prompts.push({ userId: row?.userId ?? 'unknown', prompt });
            return {
              choices: [{ message: { content: modelReply(description) } }],
            };
          },
        },
      },
    };
  });

  // -------------------------------------------------------------------
  // 4. normalizeCategory
  // -------------------------------------------------------------------
  describe('normalizeCategory', () => {
    it('returns the safe fallback for an empty string (never the first category)', () => {
      const result = service.normalizeCategory('');
      expect(result).toBe('Other');
      expect(result).not.toBe(CATEGORIES[0]);
    });

    it('returns the safe fallback for whitespace-only output', () => {
      for (const raw of ['   ', '\t', '\n', ' \t\n ']) {
        expect(service.normalizeCategory(raw)).toBe('Other');
      }
    });

    it('returns the safe fallback for punctuation-only output', () => {
      for (const raw of ['.', '!', '?', '...', '?!', '  .  ']) {
        expect(service.normalizeCategory(raw)).toBe('Other');
      }
    });

    it('maps a valid canonical answer to that exact category', () => {
      for (const c of CATEGORIES) {
        expect(service.normalizeCategory(c)).toBe(c);
      }
    });

    it('tolerates surrounding quotes and punctuation on a valid answer', () => {
      expect(service.normalizeCategory('"Transport"')).toBe('Transport');
      expect(service.normalizeCategory('  Food & Dining.  ')).toBe(
        'Food & Dining',
      );
      expect(service.normalizeCategory("'Groceries'")).toBe('Groceries');
    });

    it('returns the safe fallback for an invalid non-empty answer', () => {
      expect(service.normalizeCategory('Nonsense Category')).toBe('Other');
      expect(
        service.normalizeCategory('I am sorry, I cannot help with that'),
      ).toBe('Other');
    });

    it('does not let a stray single character select a category', () => {
      // "&" is a substring of "Food & Dining" but is not a meaningful answer.
      expect(service.normalizeCategory('&')).toBe('Other');
      expect(service.normalizeCategory('#')).toBe('Other');
    });
  });

  // -------------------------------------------------------------------
  // 4 (integration). End-to-end through categorizeTransactions with a stubbed model
  // -------------------------------------------------------------------
  it('stores the safe fallback when the model returns empty content', async () => {
    modelReply = () => '';
    const id = addRow('user-a', 'mystery purchase');

    const results = await service.categorizeTransactions([id]);

    expect(results.get(id)).toBe('Other');
    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { category: 'Other' } }),
    );
  });

  // -------------------------------------------------------------------
  // 5. Per-user correction budget + isolation
  // -------------------------------------------------------------------
  describe('per-user correction examples', () => {
    it('gives each user only their own corrections', async () => {
      addCorrection('user-a', 'blue bottle coffee', 'Food & Dining');
      addCorrection('user-b', 'uber trip', 'Transport');

      const a = addRow('user-a', 'blue bottle');
      const b = addRow('user-b', 'uber trip');

      await service.categorizeTransactions([a, b]);

      expect(prompts).toHaveLength(2);
      const promptA = prompts.find((p) => p.userId === 'user-a')!.prompt;
      const promptB = prompts.find((p) => p.userId === 'user-b')!.prompt;

      expect(promptA).toContain('blue bottle coffee');
      expect(promptA).not.toContain('uber trip');

      expect(promptB).toContain('uber trip');
      expect(promptB).not.toContain('blue bottle coffee');
    });

    it('does not let a skewed distribution starve another user of feedback', async () => {
      // user-noisy has 60 corrections (more than the per-user limit).
      for (let i = 0; i < 60; i++) {
        addCorrection('user-noisy', `noisy-${i}`, 'Shopping', i);
      }
      // user-quiet has a single, older correction.
      addCorrection('user-quiet', 'quiet-only-example', 'Health', 9999);

      const noisy = addRow('user-noisy', 'noisy transaction');
      const quiet = addRow('user-quiet', 'quiet transaction');

      await service.categorizeTransactions([noisy, quiet]);

      const promptQuiet = prompts.find(
        (p) => p.userId === 'user-quiet',
      )!.prompt;
      const promptNoisy = prompts.find(
        (p) => p.userId === 'user-noisy',
      )!.prompt;

      // The quiet user's single correction is present despite 60 newer ones.
      expect(promptQuiet).toContain('quiet-only-example');
      expect(promptNoisy).not.toContain('quiet-only-example');
      expect(promptNoisy).toContain('noisy-0');

      // The per-user limit is applied to each query independently.
      const takes = prismaMock.categoryCorrection.findMany.mock.calls.map(
        (c: any) => c[0].take,
      );
      expect(takes).toHaveLength(2);
      expect(new Set(takes).size).toBe(1);
      expect(takes[0]).toBeGreaterThanOrEqual(40);
    });

    it('omits the corrections block entirely when a user has none', async () => {
      addCorrection('user-other', 'someone else', 'Shopping');
      const a = addRow('user-none', 'nothing learned');

      await service.categorizeTransactions([a]);

      const prompt = prompts[0].prompt;
      expect(prompt).not.toContain('someone else');
      expect(prompt).not.toContain('was corrected from');
    });
  });
});

describe('Canonical category list', () => {
  it('includes Sadqa & Zakaat', () => {
    expect(CATEGORIES).toContain('Sadqa & Zakaat');
  });

  it('normalizes the new category correctly', () => {
    const svc = new CategorizationService({} as any);
    expect(svc.normalizeCategory('Sadqa & Zakaat')).toBe('Sadqa & Zakaat');
    expect(svc.normalizeCategory('"Sadqa & Zakaat".')).toBe('Sadqa & Zakaat');
  });

  it('keeps the list free of duplicates', () => {
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });
});
