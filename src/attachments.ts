/**
 * Chat attachments for OpenCode threads.
 *
 * Two paths, because attaching code and attaching a picture are not the same
 * problem:
 * - Text/code travels as an `@repo/relative/path` mention in the message text.
 *   OpenCode resolves it natively; no bytes are added to the prompt.
 * - Images and PDFs travel as a real `FilePartInput` (`{ type, mime, url }`).
 *   The spike S1 proved v1.19.3 accepts a base64 data URL for both, rejects
 *   `source` without `url`, and silently hangs on a bare Windows path — so the
 *   server always builds the data URL itself.
 *
 * Inputs are validated here, once, before the turn starts: every path must
 * live inside the thread's repo and every binary must be a supported type
 * under the size limit.
 */

import { readFile as readFileFs, stat } from "fs/promises";
import { basename, extname, isAbsolute, join } from "path";
import { repoRelative, resolveInsideRepo } from "./workspace";

/** Mirrors the Codex attachment ceiling; big enough for screenshots and PDFs. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** What the client may post in `POST /chat` → `attachments`. */
export type ChatAttachmentInput =
  | { kind: "path"; path: string }
  | { kind: "image"; path?: string; name?: string; mime?: string; dataUrl?: string }
  // Legacy shape: image data URLs only.
  | { url: string };

/** A validated attachment; only the turn driver reads bytes/dataUrl. */
export interface PendingAttachment {
  kind: "mention" | "image";
  name: string;
  mime: string;
  size: number;
  /** Set for mentions and path-based images. */
  relPath?: string;
  /** Absolute path on disk, when the file came from the repo. */
  path?: string;
  /** Set when the client sent the bytes (browser picker / drag-drop / paste). */
  dataUrl?: string;
}

const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

const TEXT_MIMES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

/** MIME by extension; PDFs and images are the only attachable binaries. */
export function mimeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  return IMAGE_MIMES[ext] ?? TEXT_MIMES[ext] ?? "application/octet-stream";
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isAttachableMime(mime: string): boolean {
  return isImageMime(mime) || mime === "application/pdf";
}

/** `data:<mime>;base64,<payload>` → mime + byte length (null when malformed). */
export function parseDataUrl(url: string): { mime: string; size: number } | null {
  const match = /^data:([^;,]+);base64,/i.exec(url);
  if (!match) return null;
  const payload = url.slice(match[0].length);
  if (!payload) return null;
  // Cheap size check first: base64 is ~4/3 of the decoded bytes.
  const size = Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  return { mime: match[1].toLowerCase(), size };
}

function resolveFromRepo(path: string, repoPath: string): string {
  return resolveInsideRepo(isAbsolute(path) ? path : join(repoPath, path), repoPath);
}

/**
 * Validate every attachment against the repo and the binary allow-list.
 * Throws with a user-facing message; the /chat handler turns it into a 400.
 */
export async function resolveAttachments(
  inputs: unknown,
  repoPath: string,
): Promise<PendingAttachment[]> {
  if (inputs == null) return [];
  if (!Array.isArray(inputs)) throw new Error("attachments must be an array");

  const out: PendingAttachment[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i] as ChatAttachmentInput | undefined;
    if (!input || typeof input !== "object") throw new Error(`attachment ${i + 1} is not an object`);

    // Mentions: code/text the agent reads with its own tools.
    const pathInput = (input as any).path;
    const kind = (input as any).kind;
    const dataUrlInput = (input as any).dataUrl ?? (input as any).url;

    if (kind === "path" || (kind == null && pathInput && !dataUrlInput)) {
      if (typeof pathInput !== "string" || !pathInput.trim()) {
        throw new Error(`attachment ${i + 1}: path is required`);
      }
      const absolute = resolveFromRepo(pathInput, repoPath);
      const s = await stat(absolute).catch(() => null);
      if (!s?.isFile()) throw new Error(`attachment ${i + 1}: file not found inside the repository`);
      out.push({
        kind: "mention",
        name: basename(absolute),
        mime: mimeForPath(absolute),
        size: s.size,
        relPath: repoRelative(absolute, repoPath),
        path: absolute,
      });
      continue;
    }

    // Binary: image / PDF.
    if (typeof dataUrlInput === "string" && dataUrlInput) {
      const parsed = parseDataUrl(dataUrlInput);
      if (!parsed) throw new Error(`attachment ${i + 1}: expected a base64 data URL`);
      const mime = typeof (input as any).mime === "string" ? (input as any).mime.toLowerCase() : parsed.mime;
      if (!isAttachableMime(mime)) {
        throw new Error(`attachment ${i + 1}: ${mime} cannot be attached (images and PDF only)`);
      }
      if (parsed.size > ATTACHMENT_MAX_BYTES) {
        throw new Error(`attachment ${i + 1} is too large (${parsed.size} bytes > ${ATTACHMENT_MAX_BYTES})`);
      }
      out.push({
        kind: "image",
        name:
          typeof (input as any).name === "string" && (input as any).name
            ? (input as any).name
            : `attachment-${i + 1}${extForMime(mime)}`,
        mime,
        size: parsed.size,
        dataUrl: dataUrlInput,
      });
      continue;
    }

    if (typeof pathInput === "string" && pathInput) {
      const absolute = resolveFromRepo(pathInput, repoPath);
      const s = await stat(absolute).catch(() => null);
      if (!s?.isFile()) throw new Error(`attachment ${i + 1}: file not found inside the repository`);
      if (s.size > ATTACHMENT_MAX_BYTES) {
        throw new Error(`attachment ${i + 1} is too large (${s.size} bytes > ${ATTACHMENT_MAX_BYTES})`);
      }
      const mime =
        typeof (input as any).mime === "string" && (input as any).mime
          ? String((input as any).mime).toLowerCase()
          : mimeForPath(absolute);
      if (!isAttachableMime(mime)) {
        throw new Error(`attachment ${i + 1}: ${mime} cannot be attached (images and PDF only)`);
      }
      out.push({
        kind: "image",
        name: (input as any).name ?? basename(absolute),
        mime,
        size: s.size,
        path: absolute,
        relPath: repoRelative(absolute, repoPath),
      });
      continue;
    }

    throw new Error(`attachment ${i + 1}: send { kind: "path", path } or { kind: "image", dataUrl | path }`);
  }
  return out;
}

/** The event-safe view: no bytes, no absolute paths. */
export function publicAttachment(a: PendingAttachment): Record<string, unknown> {
  return {
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    size: a.size,
    ...(a.relPath ? { path: a.relPath } : {}),
  };
}

/** Mention lines appended to the message text. */
export function mentionText(attachments: PendingAttachment[]): string {
  return attachments
    .filter((a) => a.kind === "mention" && a.relPath)
    .map((a) => `@${a.relPath}`)
    .join("\n");
}

/** An OpenCode `FilePartInput` for one attachment, bytes included. */
export async function filePartFor(a: PendingAttachment): Promise<{
  type: "file";
  mime: string;
  filename: string;
  url: string;
}> {
  let dataUrl = a.dataUrl;
  if (!dataUrl && a.path) {
    const bytes = await readFileFs(a.path);
    dataUrl = `data:${a.mime};base64,${bytes.toString("base64")}`;
  }
  if (!dataUrl) throw new Error(`attachment ${a.name} has no bytes`);
  return { type: "file", mime: a.mime, filename: a.name, url: dataUrl };
}

function extForMime(mime: string): string {
  const found = Object.entries(IMAGE_MIMES).find(([, value]) => value === mime);
  if (found) return found[0];
  if (mime === "application/pdf") return ".pdf";
  return "";
}
