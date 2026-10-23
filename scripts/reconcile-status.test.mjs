import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Reconcile guards live in the compiled build (src/ is CommonJS).
const require = createRequire(import.meta.url);
if (!existsSync(new URL("../dist/start-opencode.js", import.meta.url))) {
  throw new Error("dist/start-opencode.js is missing — run npm run build:cli first");
}
const { shouldReconcileTurn } = require("../dist/start-opencode.js");

// Minimal stand-in: shouldReconcileTurn only reads these fields.
function store(overrides = {}) {
  return {
    agent: "opencode",
    status: "running",
    sdkSessionId: "ses_1",
    turnStartedAt: Date.now() - 10_000,
    pendingPermissions: new Map(),
    ...overrides,
  };
}

test("a stale running opencode turn is reconcilable", () => {
  assert.equal(shouldReconcileTurn(store()), true);
});

test("a turn younger than 5s is left alone", () => {
  assert.equal(shouldReconcileTurn(store({ turnStartedAt: Date.now() - 1_000 })), false);
  assert.equal(shouldReconcileTurn(store({ turnStartedAt: undefined })), false);
});

test("a turn waiting on an approval is left alone", () => {
  const waiting = store();
  waiting.pendingPermissions.set("perm1", { toolUseID: "perm1" });
  assert.equal(shouldReconcileTurn(waiting), false);
});

test("only running opencode sessions with an sdk id reconcile", () => {
  assert.equal(shouldReconcileTurn(store({ status: "done" })), false);
  assert.equal(shouldReconcileTurn(store({ agent: "claude-code" })), false);
  assert.equal(shouldReconcileTurn(store({ sdkSessionId: null })), false);
});
