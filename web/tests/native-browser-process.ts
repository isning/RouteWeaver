import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

// Own one spawned browser and its fresh profile. Never target process names or
// process groups: startup cleanup is restricted to this ChildProcess handle.
export function ownNativeBrowserProcess(
  child: ChildProcess,
  directory: string,
) {
  // Register at spawn time, including the error-without-exit startup case.
  // `exit` alone is insufficient: descendant processes can share stderr and
  // still be flushing profile data. `close` follows their inherited stdio close.
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return async (requestClose?: () => Promise<unknown>) => {
    const errors: unknown[] = [];
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (requestClose) await requestClose();
        else child.kill("SIGTERM");
      } catch (error) {
        errors.push(error);
        // A broken CDP connection must not leak the process owned by this test.
        // This is emergency cleanup, not a retry of the browser or test body.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGTERM");
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
      }
    }
    const result = await closed;
    // Once CDP ownership exists, successful cleanup requires an orderly browser
    // exit, including a crash after the last assertion but before teardown.
    // Keep a primary protocol error first; its emergency SIGTERM is not a
    // separate unexpected crash. Startup failures stay owned by the caller.
    if (
      requestClose &&
      errors.length === 0 &&
      (result.code !== 0 || result.signal !== null)
    )
      errors.push(
        new Error(
          `Owned browser exited abnormally (code=${result.code}, signal=${result.signal})`,
        ),
      );
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Native browser shutdown failed");
    return result;
  };
}
