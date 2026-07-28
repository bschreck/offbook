export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

/**
 * Invariants that must hold for the app to be correct at all (the tokenizer's
 * reconstruction property, plan/document length agreement). These throw in every build:
 * a silently wrong mask is worse than a visible crash, because the user cannot tell.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
