// Canonical category list for the Transaction Intelligence Agent.
// The LLM is instructed to pick from this set; "Uncategorized" is the
// fallback when the model fails or the key is missing.
export const CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Bills & Utilities',
  'Shopping',
  'Entertainment',
  'Health',
  'Sadqa & Zakaat',
  'Salary',
  'Transfers',
  'Other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const FALLBACK_CATEGORY = 'Uncategorized';
