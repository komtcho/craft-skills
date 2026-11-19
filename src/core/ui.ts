import * as clack from "@clack/prompts";

export interface InteractiveEnv {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  ci: string | undefined;
}

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const processOutput: Output = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

let output: Output = processOutput;

/** Redirects all plain output (tests). Returns a function that restores the previous sink. */
export function setOutput(next: Output): () => void {
  const previous = output;
  output = next;
  return () => {
    output = previous;
  };
}

export function getOutput(): Output {
  return output;
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

/** clack styling is used only for a real interactive terminal with the default sink. */
function fancy(): boolean {
  return output === processOutput && isInteractive();
}

/** Raw line to stdout, never styled (lists, JSON). */
export function print(text: string): void {
  output.out(`${text}\n`);
}

export function info(message: string): void {
  if (fancy()) clack.log.info(message);
  else output.out(`${message}\n`);
}

export function success(message: string): void {
  if (fancy()) clack.log.success(message);
  else output.out(`${message}\n`);
}

export function warn(message: string): void {
  if (fancy()) clack.log.warn(message);
  else output.err(`warning: ${message}\n`);
}

export function error(message: string, hint?: string): void {
  if (fancy()) {
    clack.log.error(hint ? `${message}\n${hint}` : message);
    return;
  }
  output.err(`error: ${message}\n`);
  if (hint) output.err(`hint: ${hint}\n`);
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
  if (!fancy()) return opts.fallback;
  const result = await clack.multiselect<T>({
    message: opts.message,
    options: opts.options.map((o) => ({ value: o.value, label: o.label })) as clack.Option<T>[],
    initialValues: opts.initialValues,
    required: true,
  });
  return clack.isCancel(result) ? null : result;
}
