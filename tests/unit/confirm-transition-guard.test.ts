import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * G-01 (D-97, D-127): the transition to `confirmed` is reached through the confirmation
 * service only (`bookings.confirm`, `bookings.createConfirmed`). Two independent guards: no
 * file under src/ other than the transition and that service mentions it, and ESLint
 * refuses an import of it anywhere else.
 */

const ROOT = process.cwd();
const ALLOWED = [
  join("src", "modules", "bookings", "confirm-transition.ts"),
  join("src", "modules", "bookings", "confirm.ts"),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("G-01: markConfirmed is reached through the confirmation service only (D-97, D-127)", () => {
  it("no file under src/ other than the transition and the confirmation service mentions it", () => {
    const offenders = sourceFiles(join(ROOT, "src"))
      .map((path) => relative(ROOT, path))
      .filter((path) => !ALLOWED.includes(path))
      .filter((path) => /confirm-transition|markConfirmed/.test(readFileSync(join(ROOT, path), "utf8")));
    expect(offenders.map((p) => p.split(sep).join("/"))).toEqual([]);
  });

  it("ESLint refuses importing it from src/ (alias and relative paths)", async () => {
    const eslint = new ESLint({ cwd: ROOT });
    for (const source of [
      `import { markConfirmed } from "@/modules/bookings/confirm-transition";\nexport const x = markConfirmed;\n`,
      `import { markConfirmed } from "./confirm-transition";\nexport const x = markConfirmed;\n`,
    ]) {
      const [result] = await eslint.lintText(source, {
        filePath: join(ROOT, "src", "modules", "bookings", "probe.ts"),
      });
      expect(result.messages.map((m) => m.ruleId)).toContain("no-restricted-imports");
    }
    const [allowed] = await eslint.lintText(
      `import { markConfirmed } from "./confirm-transition";\nexport const x = markConfirmed;\n`,
      { filePath: join(ROOT, "src", "modules", "bookings", "confirm.ts") },
    );
    expect(allowed.messages.map((m) => m.ruleId)).not.toContain("no-restricted-imports");
  }, 60_000);
});
