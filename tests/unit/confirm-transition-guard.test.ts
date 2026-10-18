import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * G-01 (D-97): in phase 5 the transition to `confirmed` is reachable from tests only — no
 * Server Action, screen or service may use it. Two independent guards: no file under src/
 * other than the transition itself mentions it, and ESLint refuses an import of it.
 */

const ROOT = process.cwd();
const TRANSITION = join("src", "modules", "bookings", "confirm-transition.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("G-01: markConfirmed is not reachable from the app in phase 5 (D-97)", () => {
  it("no file under src/ other than the transition mentions it", () => {
    const offenders = sourceFiles(join(ROOT, "src"))
      .map((path) => relative(ROOT, path))
      .filter((path) => path !== TRANSITION)
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
  }, 60_000);
});
