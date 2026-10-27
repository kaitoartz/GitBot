// Frontend-only contract mirroring the live GitBot server.
// No fetches here — UI components take these types as props,
// so a future adapter can plug into:
//   GET / (bots), /history, /sessions, /status
//   POST /chat, /abort, /permission
// without touching components.

export type Agent = "claude" | "codex" | "opencode";

export type Bot = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  instructions: string;
  permissionMode: string;
  // Server values: "claude-code" | "codex" | "opencode" (older records
  // may predate the field and default to Claude Code server-side).
  agent: string;
  model: string;
  setupInstructions?: string;
  repoPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  setupStatus?: string;
  setupThreadId?: string;
};

export type Thread = {
  id: string;
  botId: string;
  title: string;
};

export type ThreadFull = Thread & {
  // Omitted when the thread inherits the bot's configured coding agent.
  agent?: string;
  kind: string;
  sdkSessionId: string | null;
  titleIsAuto: boolean;
  repoPath: string;
  preview: string;
  messageCount: number;
  /** Active entry of a routing group; omitted for single-model bots. */
  routing?: { groupId: string; index: number };
  createdAt: string;
  updatedAt: string;
};

export type HistorySubagent = {
  childSessionId: string;
  agent?: string | null;
  title?: string | null;
  status?: string | null;
};

export type HistoryBlock = {
  type: string;
  text?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  /** Present on a `task` tool block: the subagent it spawned. */
  subagent?: HistorySubagent;
  url?: string;
  name?: string;
  mime?: string;
};

export type HistoryMsg = {
  /** OpenCode message id, used to rewind to this user message. */
  id?: string;
  role: string;
  content: HistoryBlock[];
};

/** Tools the "Allow all edits" shortcut on an approval card covers
 *  (the server's allow-all-edits mode auto-approves exactly these). */
export const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

export type PermRequest = {
  toolUseID: string;
  toolName: string;
  input: unknown;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
