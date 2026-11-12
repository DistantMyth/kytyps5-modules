import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

describe("Module Validation CLI Tests", () => {
  test("scripts/validate-modules.mjs runs cleanly on valid repository", async () => {
    const { stdout, stderr } = await execFileAsync("node", ["scripts/validate-modules.mjs"], { cwd: root });
    assert.equal(stderr, "");
    assert.match(stdout, /Validation passed: \d+ file\(s\) verified cleanly\./);
  });
});
