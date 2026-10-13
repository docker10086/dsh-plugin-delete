import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-plugin-delete";
export const inject = ["webServer"];

const SESSION_ID_RE = /^session-[a-z0-9-]{8,}$/i;
const MAX_BODY_BYTES = 16 * 1024;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function isLoopbackAddress(address) {
  const value = address.toLowerCase();
  return value === "::1" || value.startsWith("127.") || value.startsWith("::ffff:127.");
}

function isLoopbackHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function requestRejection(ctx, req) {
  try {
    const connection = ctx.get("connection");
    if (connection !== undefined && typeof connection.requestRejection === "function") {
      const code = connection.requestRejection(req);
      if (code !== undefined) return code;
      return undefined;
    }
  } catch {
    // Fall back to the local loopback check when the connection service is absent.
  }

  const headers = req.headers ?? {};
  const host = headers.host;
  if (typeof host !== "string" || host === "") return 403;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return 403;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return 403;
  if (headers["sec-fetch-site"] === "cross-site") return 403;
  const origin = headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403;
    } catch {
      return 403;
    }
  }
  const remote = req.socket?.remoteAddress;
  if (typeof remote === "string" && remote !== "" && !isLoopbackAddress(remote)) return 403;
  return undefined;
}

function contentTypeAllowed(req) {
  const type = req.headers?.["content-type"];
  return typeof type === "string" && type.toLowerCase().includes("application/json");
}

async function findSessionDirectories(root, sessionId) {
  const matches = [];

  async function visit(directory, depth) {
    if (depth > 2) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.name === sessionId) {
        matches.push(candidate);
        return;
      }
      await visit(candidate, depth + 1);
    }));
  }

  await visit(root, 0);
  return matches;
}

async function removeIfPresent(target) {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    error.path = target;
    throw error;
  }
}

async function removeWorkspaceReferences(home, sessionId) {
  const file = path.join(home, "storages", "workspace.json");
  let document;
  try {
    document = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  let changed = false;
  const removeFrom = (value) => {
    if (!Array.isArray(value)) return value;
    const next = value.filter((id) => id !== sessionId);
    if (next.length !== value.length) changed = true;
    return next;
  };
  if (document.global) {
    document.global.archivedSessionIds = removeFrom(document.global.archivedSessionIds);
    document.global.pinnedSessionIds = removeFrom(document.global.pinnedSessionIds);
  }
  for (const workspace of Object.values(document.tables?.workspaces ?? {})) {
    if (workspace && typeof workspace === "object") {
      workspace.sessionIds = removeFrom(workspace.sessionIds);
    }
  }
  if (!changed) return false;

  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return true;
}

async function deleteSession(ctx, sessionId) {
  const home = dshHome();
  const sessionsRoot = path.join(home, "sessions");
  const sessionDirectories = await findSessionDirectories(sessionsRoot, sessionId);
  const projection = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);

  if (sessionDirectories.length === 0) {
    const projectionExists = await fs.access(projection).then(() => true, () => false);
    if (!projectionExists) {
      const error = new Error("session not found");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
  }

  // Stop the agent before removing its durable files. This also removes the row
  // from the active workspace view; the JSON cleanup below makes the deletion
  // survive the next process start.
  const registry = ctx.get("workspaceRegistry");
  if (registry && typeof registry.archiveSession === "function") {
    await registry.archiveSession(sessionId, { stopActivity: true });
  }

  for (const directory of sessionDirectories) await removeIfPresent(directory);
  await removeIfPresent(projection);
  const workspaceChanged = await removeWorkspaceReferences(home, sessionId);
  return {
    ok: true,
    sessionId,
    removedDirectories: sessionDirectories.length,
    removedProjection: true,
    workspaceChanged,
  };
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-plugin-delete/delete",
    handler: async (req, res) => {
      const rejection = requestRejection(ctx, req);
      if (rejection !== undefined) {
        json(res, rejection, { ok: false, error: rejection === 401 ? "unauthorized" : "forbidden" });
        return;
      }
      if (req.method === "POST" && !contentTypeAllowed(req)) {
        json(res, 415, { ok: false, error: "expected application/json" });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }

      const raw = await readBody(req);
      if (raw === null) {
        json(res, 413, { ok: false, error: "request too large" });
        return;
      }

      let input;
      try {
        input = JSON.parse(raw || "{}");
      } catch {
        json(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
      if (!SESSION_ID_RE.test(sessionId) || input?.confirm !== true) {
        json(res, 400, { ok: false, error: "sessionId and confirm=true are required" });
        return;
      }

      try {
        json(res, 200, await deleteSession(ctx, sessionId));
      } catch (error) {
        if (error?.code === "SESSION_NOT_FOUND") {
          json(res, 404, { ok: false, error: "session not found" });
          return;
        }
        ctx.logger?.error?.("dsh-plugin-delete: deletion failed", error);
        json(res, 500, { ok: false, error: "deletion failed" });
      }
    },
  }), "dsh-plugin-delete: delete route");
}
