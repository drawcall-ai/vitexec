export function formatError(error: unknown): string {
  const ancestors = new Set<Error>();
  function format(value: unknown, depth: number): string {
    const indent = "  ".repeat(depth);
    if (!(value instanceof Error)) return `${indent}${String(value)}`;
    if (ancestors.has(value)) return `${indent}[circular error]`;
    ancestors.add(value);
    const lines = [value.message.split("\n").map(line => `${indent}${line}`).join("\n")];
    if (value instanceof AggregateError) {
      for (const child of value.errors) lines.push(format(child, depth + 1));
    }
    if (value.cause !== undefined) lines.push(format(value.cause, depth + 1));
    ancestors.delete(value);
    return lines.join("\n");
  }
  return format(error, 0);
}

export async function withCleanup<T>(action: () => Promise<T>, cleanup: () => Promise<unknown>, message: string): Promise<T> {
  const errors: unknown[] = [];
  try {
    return await action();
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    try { await cleanup(); } catch (error) {
      if (errors.length) throw new AggregateError([...errors, error], message);
      throw error;
    }
  }
}
