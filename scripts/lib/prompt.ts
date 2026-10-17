import { createInterface } from "node:readline";

/**
 * Terminal prompts for the setup and support scripts. In a terminal, hidden answers are
 * read in raw mode and never echoed (P1-03). When stdin is piped (automation, tests),
 * each answer is the next line of input; nothing is echoed either way.
 */

let pipedLines: AsyncIterator<string> | undefined;

async function nextPipedLine(): Promise<string> {
  pipedLines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const { value, done } = await pipedLines.next();
  if (done) throw new Error("Input ended before all answers were given.");
  return value;
}

function readHiddenFromTerminal(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return (await nextPipedLine()).trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise<string>((resolve) => rl.question(question, resolve))).trim();
  } finally {
    rl.close();
  }
}

/** Never echoed, never trimmed (spaces are valid password characters). */
export async function askHidden(question: string): Promise<string> {
  return process.stdin.isTTY ? readHiddenFromTerminal(question) : nextPipedLine();
}

/** Asks twice and insists the answers match. */
export async function askNewPassword(label: string): Promise<string> {
  const first = await askHidden(`${label}: `);
  const second = await askHidden(`${label} (again): `);
  if (first !== second) throw new Error("The two passwords do not match. Nothing was changed.");
  return first;
}

/** Requires typing "yes", unless --yes was passed. */
export async function confirm(question: string, preApproved: boolean): Promise<void> {
  if (preApproved) return;
  const answer = await ask(`${question} Type "yes" to continue: `);
  if (answer.toLowerCase() !== "yes") throw new Error("Cancelled. Nothing was changed.");
}
