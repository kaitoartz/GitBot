// Composer attachments: validation that runs before a file ever reaches the
// server, plus the small text helpers behind the `@` mention picker.
//
// Code and text travel as `@repo/relative/path` mentions (OpenCode resolves
// them). Only images and PDFs become binary attachments, because that is what
// the server's FilePartInput path accepts.

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

export type AttachmentKind = "image" | "pdf";

export type PendingAttachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  /** base64 data URL; sent to the server, never displayed in the DOM. */
  dataUrl: string;
};

const IMAGE_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

export function mimeForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "application/pdf";
  return IMAGE_EXT[ext] ?? "application/octet-stream";
}

/** Images and PDFs are attachable; anything else is a mention, not a file. */
export function attachmentKindFor(file: { name: string; type?: string }): AttachmentKind | null {
  const mime = file.type || mimeForFilename(file.name);
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  return null;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The `@token` under the caret, if any. Requires at least `min` letters. */
export function mentionQueryAt(
  text: string,
  caret: number,
  min = 2,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2];
  if (query.length < min) return null;
  const start = before.length - query.length - 1;
  return { start, end: caret, query };
}

/** Replace the active `@token` with a full mention and place the caret after it. */
export function applyMention(
  text: string,
  start: number,
  end: number,
  path: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const inserted = `@${path} `;
  // Keep a leading space when the mention starts mid-sentence.
  const needsSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const next = `${before}${needsSpace}${inserted}${after.replace(/^\s+/, "")}`;
  return { text: next, caret: before.length + needsSpace.length + inserted.length };
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

let attachmentSeq = 0;
export function attachmentId(): string {
  attachmentSeq += 1;
  return `att-${Date.now()}-${attachmentSeq}`;
}
