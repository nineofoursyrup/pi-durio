import type { RunResult } from './runtime.js';

/** Flush the machine-readable receipt before a bounded, unconfirmed host exit. */
export function writeHeadlessResult(result: RunResult) {
  process.exitCode = result.status === 'completed' ? 0 : result.status === 'aborted' ? 130 : result.status === 'unknown' ? 75 : 1;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => {
    // Active handles may ignore cancellation. This ends this host only; its owner
    // markers and unknown receipt remain, with no claim about residual/remote work.
    if (result.cleanup === 'unknown') process.exit(75);
  });
}
