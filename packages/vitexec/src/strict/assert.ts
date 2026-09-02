import type { VerifyStrictSourceOptions } from "./types.js";
import { verifyStrictSource } from "./verify.js";

export function assertStrictSource(
  source: string,
  options: VerifyStrictSourceOptions = {}
): void {
  const verification = verifyStrictSource(source, options);
  if (verification.ok) return;
  const details = verification.issues.map((issue) =>
    `${issue.code} at ${issue.start.line}:${issue.start.column}: ${issue.message}`
  );
  throw new Error(`Strict source verification failed: ${details.join("; ")}`);
}
