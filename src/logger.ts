import pino from 'pino';

// pino-pretty cannot be bundled inside a compiled Bun binary (it is loaded
// via worker_threads at runtime and the path cannot be resolved inside the
// single-file executable).  Use plain JSON output always.
// For a readable local output pipe through pino-pretty CLI:
//   bun run dev | bunx pino-pretty
export const logger = pino({ level: 'info' });
