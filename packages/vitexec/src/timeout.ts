export const CLEANUP_GRACE_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;
// Pinned Playwright force-kills a local browser after 30 seconds of graceful shutdown.
export const BROWSER_SHUTDOWN_TIMEOUT_MS = 40_000;

export async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
