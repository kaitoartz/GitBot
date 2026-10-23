import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// src/ is CommonJS (root package), so the API under test is read from the
// build output. Run `npm run build:cli` first.
const require = createRequire(import.meta.url);
if (!existsSync(new URL("../dist/attachments.js", import.meta.url))) {
  throw new Error("dist/attachments.js is missing — run npm run build:cli first");
}
const {
  ATTACHMENT_MAX_BYTES,
  filePartFor,
  mentionText,
  parseDataUrl,
  publicAttachment,
  resolveAttachments,
} = require("../dist/attachments.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gitbot-att-"));
  writeFileSync(join(root, "notes.md"), "# hola\n");
  writeFileSync(join(root, "pixel.png"), PNG);
  writeFileSync(join(root, "tool.exe"), "MZ");
  return root;
}

test("parseDataUrl reads mime and decoded size", () => {
  const parsed = parseDataUrl(`data:image/png;base64,${PNG.toString("base64")}`);
  assert.deepEqual(parsed, { mime: "image/png", size: PNG.length });
  assert.equal(parseDataUrl("https://example.com/a.png"), null);
});

test("repo paths become mentions; outside paths are rejected", async () => {
  const root = fixture();
  try {
    const [mention] = await resolveAttachments([{ kind: "path", path: "notes.md" }], root);
    assert.equal(mention.kind, "mention");
    assert.equal(mention.relPath, "notes.md");
    assert.equal(mentionText([mention]), "@notes.md");
    assert.deepEqual(publicAttachment(mention), {
      kind: "mention",
      name: "notes.md",
      mime: "text/markdown",
      size: 7,
      path: "notes.md",
    });

    await assert.rejects(
      () => resolveAttachments([{ kind: "path", path: "../outside.txt" }], root),
      /outside the selected repository/,
    );
    await assert.rejects(
      () => resolveAttachments([{ kind: "path", path: join(root, "missing.md") }], root),
      /file not found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("images accept a data URL or a repo path, and build a FilePart", async () => {
  const root = fixture();
  try {
    const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
    const [fromData, fromPath] = await resolveAttachments(
      [
        { kind: "image", name: "pixel.png", mime: "image/png", dataUrl },
        { kind: "image", path: "pixel.png", mime: "image/png" },
      ],
      root,
    );
    assert.equal(fromData.kind, "image");
    assert.equal(fromData.size, PNG.length);
    assert.equal(fromPath.relPath, "pixel.png");

    const part = await filePartFor(fromPath);
    assert.equal(part.type, "file");
    assert.equal(part.mime, "image/png");
    assert.equal(part.filename, "pixel.png");
    assert.match(part.url, /^data:image\/png;base64,/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported and oversized binaries are refused", async () => {
  const root = fixture();
  try {
    await assert.rejects(
      () => resolveAttachments([{ kind: "image", path: "tool.exe" }], root),
      /cannot be attached/,
    );
    const huge = `data:application/pdf;base64,${Buffer.alloc(ATTACHMENT_MAX_BYTES + 3).toString("base64")}`;
    await assert.rejects(
      () => resolveAttachments([{ kind: "image", mime: "application/pdf", dataUrl: huge }], root),
      /too large/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
