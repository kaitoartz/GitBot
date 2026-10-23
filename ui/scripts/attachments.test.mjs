import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMention,
  attachmentKindFor,
  formatBytes,
  mentionQueryAt,
  mimeForFilename,
} from "../app/lib/attachments.ts";

test("mentionQueryAt finds the token under the caret", () => {
  assert.deepEqual(mentionQueryAt("look at @chat", 14), { start: 8, end: 14, query: "chat" });
  assert.deepEqual(mentionQueryAt("@src/app.tsx", 12), { start: 0, end: 12, query: "src/app.tsx" });
  assert.equal(mentionQueryAt("mail me @ a", 11), null);
  assert.equal(mentionQueryAt("@a", 2), null, "needs two letters");
  assert.equal(mentionQueryAt("no mention here", 15), null);
  assert.equal(mentionQueryAt("word@notamention", 17), null, "must start a token");
});

test("applyMention replaces the token and leaves the caret after it", () => {
  const r = applyMention("please read @cha now", 12, 16, "src/chat.tsx");
  assert.equal(r.text, "please read @src/chat.tsx now");
  assert.equal(r.caret, "please read @src/chat.tsx ".length);
});

test("only images and PDFs are attachable", () => {
  assert.equal(attachmentKindFor({ name: "a.png", type: "image/png" }), "image");
  assert.equal(attachmentKindFor({ name: "a.PNG", type: "" }), "image");
  assert.equal(attachmentKindFor({ name: "a.pdf", type: "application/pdf" }), "pdf");
  assert.equal(attachmentKindFor({ name: "a.cs", type: "text/plain" }), null);
  assert.equal(attachmentKindFor({ name: "a.exe", type: "" }), null);
});

test("mimeForFilename and formatBytes", () => {
  assert.equal(mimeForFilename("shot.webp"), "image/webp");
  assert.equal(mimeForFilename("doc.pdf"), "application/pdf");
  assert.equal(mimeForFilename("main.cs"), "application/octet-stream");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
