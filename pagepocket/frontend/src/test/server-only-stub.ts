// Vitest stand-in for the `server-only` package (aliased in vitest.config.ts).
// Next.js aliases the real package inside its own build pipeline; the guard's
// build-time behavior is exercised by `pnpm build`, not by unit tests.
export {};
