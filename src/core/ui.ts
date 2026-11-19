import * as clack from "@clack/prompts";

export interface InteractiveEnv {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  ci: string | undefined;
}

function currentEnv(): InteractiveEnv {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    ci: process.env["CI"],
  };
}

/** Prompts are allowed only when stdin and stdout are TTYs and `CI` is unset. */
export function isInteractive(env: InteractiveEnv = currentEnv()): boolean {
  return env.stdinIsTTY && env.stdoutIsTTY && (env.ci === undefined || env.ci === "");
}

export function info(message: string): void {
  if (isInteractive()) clack.log.info(message);
  else process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
  if (isInteractive()) clack.log.success(message);
  else process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  if (isInteractive()) clack.log.warn(message);
  else process.stderr.write(`warning: ${message}\n`);
}

export function error(message: string, hint?: string): void {
  if (isInteractive()) {
    clack.log.error(hint ? `${message}\n${hint}` : message);
  } else {
    process.stderr.write(`error: ${message}\n`);
    if (hint) process.stderr.write(`hint: ${hint}\n`);
  }
}

export interface MultiselectOptions<T> {
  message: string;
  options: { value: T; label: string }[];
  initialValues: T[];
  /** Returned when not interactive. Callers must decide this explicitly. */
  fallback: T[];
}

/**
 * Multiselect prompt with a mandatory non-interactive fallback.
 * Returns `null` if the user cancels the prompt.
 */
export async function multiselect<T>(opts: MultiselectOptions<T>): Promise<T[] | null> {
  if (!isInteractive()) return opts.fallback;
  const result = await clack.multiselect<T>({
    message: opts.message,
    options: opts.options.map((o) => ({ value: o.value, label: o.label })) as clack.Option<T>[],
    initialValues: opts.initialValues,
    required: true,
  });
  return clack.isCancel(result) ? null : result;
}
