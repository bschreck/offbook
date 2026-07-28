# ADR-0006 — `reps` is an append-only log, and it ships before anything reads it

**Status:** accepted.

## Context

The progress model — confidence numbers, spaced repetition, deadline planning — is deferred out
of v1 (PLAN.md §0.0 A3). The tempting conclusion is to not record anything until it is needed.

## Decision

Record a `Rep` for every completed practice run from day one, in an append-only store, and
display none of it. No numbers, no streaks, no badges anywhere in the v1 UI.

A `Rep` captures what actually happened: which document, which chunk (by content-hash key),
which role set, which method and rung, how many tokens were masked out of how many candidates,
how many peeks and reveals it cost, and how long it took.

## Why

Writing a rep is about twenty lines and one index. Not writing it means that when the progress
model arrives, every existing user starts from zero and the feature is a rewrite rather than a
`recomputeAll()` over data we already have. The asymmetry is enormous and one-directional.

The corollary rule: `reps` is **the** truth, and anything derived from it (mastery, confidence,
scheduling) is a materialized view that must be reproducible by folding the log from scratch.
This is what makes changing the algorithm later a recompute instead of a migration.

## Consequences

- Never mutate or trim a rep. No ring buffer, no cap — a cap would make `recomputeAll()` a lie.
- A rep write and any view update happen in **one** transaction, or the view drifts from the log.
- Reps round-trip through the JSON backup even though nothing displays them.
