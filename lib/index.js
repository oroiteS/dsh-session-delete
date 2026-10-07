// dsh-session-delete — node half.
//
// A small JSON bridge over DSH's own workspace registry + session
// persistence, giving the browser half exactly the one capability the
// shipped UI lacks: DELETING a stored session from disk. Everything else the
// management page does (archive / unarchive / list projections) already has
// first-class client services, so the browser half uses those directly and
// only calls into this bridge for the destructive part.
//
// Routes (all JSON, same-origin only, loopback-guarded):
//   GET  /api/dsh-session-delete/list    → registry projection + per-session disk sizes
//   POST /api/dsh-session-delete/delete  → { sessionIds: [...] } batch delete
//
// Delete pipeline, per session id (each step idempotent, ordered so a
// failure leaves a consistent world):
//   1. refuse LIVE sessions (ctx.sessions.get) — close the view first;
//   2. stat via sessionPersistence — unknown ids report `not-found` (already gone);
//   3. resolve the session directory (persistence.locate when available,
//      else the backend's own projectKey/sessionDir rules) and guard it:
//      under the configured root, basename === encoded id, `session-` prefix;
//   4. rm -rf that directory (the single source of truth — the sqlite search
//      index reconciles against persistence and self-heals);
//   5. registry cleanup: unarchive → unpin → detach from its workspace, so
//      workspace.json keeps no ghosts. Every write goes through the
//      registry's own domain write chain, so the sidebar live-refreshes.
//
// The projectKey/encodeSegment rules below mirror
// @deepseek-ai/dsh-session-persistence-jsonl exactly; they are only the
// FALLBACK path resolution — locate() is preferred when the backend exposes
// it. Guards make a wrong guess refuse instead of deleting something else.
import { dirname, resolve, sep, basename } from "node:path";
import { rm } from "node:fs/promises";

const API_PREFIX = "/api/dsh-session-delete";
const MAX_JSON_BODY_BYTES = 256 * 1024;

//#region path rules (mirror of dsh-session-persistence-jsonl)
/** Encode one id or path segment, keeping `:` literal for drive letters. */
function encodeSegment(segment) {
	return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

/**
 * The readable directory key for a project path — byte-for-byte the same
 * rule as the jsonl persistence backend: separators collapse to `-`, unsafe
 * code units escape as `~XXXX`, bounded to 251 readable chars.
 */
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** The session directory beneath the configured root, backend rules. */
function sessionDir(root, cwd, id) {
	const project = cwd === undefined ? "_no-cwd" : projectKey(cwd);
	return resolve(root, project, encodeSegment(id));
}
//#endregion

//#region http helpers
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
	res.end(payload);
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return undefined;
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Same-origin + loopback guard: the desktop shell forwards non-static paths
 * to the owned Host, and a malicious page must not be able to erase session
 * logs cross-origin. Mirrors the free-search settings bridge guard.
 */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion

//#region delete core
/**
 * Resolve the on-disk directory of one stored session. Prefers the
 * backend's own refusal-diagnostics locator; falls back to the exact
 * projectKey/sessionDir rules the backend uses.
 */
function resolveSessionDir(persistence, snapshot) {
	const root = resolve(String(persistence.root));
	let dir;
	if (typeof persistence.locate === "function" && snapshot.header) {
		try {
			const located = persistence.locate(snapshot.header);
			if (located && typeof located.path === "string") dir = dirname(resolve(located.path));
		} catch {
			dir = undefined;
		}
	}
	if (dir === undefined) dir = sessionDir(root, snapshot.header?.cwd, snapshot.header?.id ?? "");
	return { root, dir };
}

/**
 * Delete ONE stored session: disk directory first (the risky step — if it
 * fails nothing else has changed), then registry cleanup. Every registry
 * write goes through the service's own operation queue / domain chain.
 */
async function deleteOneSession(ctx, sessionId) {
	const persistence = ctx.sessionPersistence;
	if (!persistence || typeof persistence.stat !== "function") {
		return { id: sessionId, ok: false, code: "persistence-unavailable", message: "sessionPersistence 服务不可用" };
	}
	// 1. Refuse only sessions with work actually in flight, via the SAME
	//    activity waterfall the built-in archive flow uses. Mere in-memory
	//    presence (ctx.sessions.get) is NOT "running": the desktop retains
	//    recently touched sessions for the whole process lifetime, so that
	//    check produced false "正在运行" refusals for idle archived sessions.
	let activity = [];
	if (typeof ctx.waterfall === "function") {
		try {
			activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
		} catch (error) {
			return { id: sessionId, ok: false, code: "activity-check-failed", message: `活动检查失败：${error instanceof Error ? error.message : String(error)}` };
		}
	}
	if (activity.length > 0) {
		return { id: sessionId, ok: false, code: "session-active", message: `会话有正在进行的工作（${activity.map((entry) => entry.kind).join("、")}），请先停止后再删除` };
	}
	// 2. Unknown to persistence → nothing on disk to erase, but the registry
	//    may still hold the id (archive set / workspace accounting). Fall
	//    through to the cleanup below instead of returning early, otherwise
	//    stale ghost entries could never be purged.
	const snapshot = await persistence.stat(sessionId);
	const missingOnDisk = snapshot === undefined;
	// 3. Resolve + guard the directory before any destructive call.
	const expectedName = encodeSegment(sessionId);
	if (!sessionId.startsWith("session-")) {
		return { id: sessionId, ok: false, code: "unexpected-id", message: `异常的会话 id：${sessionId}` };
	}
	if (!missingOnDisk) {
		const { root, dir } = resolveSessionDir(persistence, snapshot);
		if (basename(dir) !== expectedName) {
			return { id: sessionId, ok: false, code: "dir-mismatch", message: `目录名与会话 id 不匹配：${basename(dir)}` };
		}
		if (dir !== root && !dir.startsWith(root + sep)) {
			return { id: sessionId, ok: false, code: "outside-root", message: `目录不在会话根目录内：${dir}` };
		}
		// 4. Erase the directory.
		try {
			await rm(dir, { recursive: true, force: true });
		} catch (error) {
			return { id: sessionId, ok: false, code: "rm-failed", message: `删除目录失败：${error instanceof Error ? error.message : String(error)}` };
		}
	}
	// 5. Registry cleanup — order matters only in that each step is
	//    idempotent; a failure here leaves a harmless ghost that the next
	//    delete/restart cycle reports but never blocks.
	const warnings = [];
	const registry = ctx.get("workspaceRegistry");
	if (registry !== undefined) {
		try {
			await registry.unarchiveSession(sessionId);
		} catch (error) {
			warnings.push(`取消归档失败：${String(error)}`);
		}
		try {
			await registry.unpinSession(sessionId);
		} catch (error) {
			warnings.push(`取消置顶失败：${String(error)}`);
		}
		try {
			for (const workspace of registry.list()) {
				if (workspace.sessionIds.includes(sessionId) && typeof workspace.detachSession === "function") {
					await workspace.detachSession(sessionId);
				}
			}
		} catch (error) {
			warnings.push(`从工作区移除失败：${String(error)}`);
		}
	} else {
		warnings.push("workspaceRegistry 服务不可用，注册表未清理");
	}
	// 6. Tell every connected client to drop its stale summary: the jsonl
	//    persistence layer has no deletion event, so without this relay the
	//    client list (and the sidebar's ungrouped tail) kept showing deleted
	//    sessions until the next full restart. `api-session/removed` is the
	//    exact event the session controller itself emits on session/disposed,
	//    and the api-remotes forwarded-event allowlist relays it to clients.
	try {
		ctx.emit("api-session/removed", sessionId);
	} catch (error) {
		warnings.push(`通知客户端移除失败：${String(error)}`);
	}
	return {
		id: sessionId,
		ok: true,
		code: missingOnDisk ? "purged" : warnings.length > 0 ? "deleted-with-warnings" : "deleted",
		warnings: warnings.length > 0 ? warnings : undefined,
		message: missingOnDisk
			? warnings.length > 0 ? "会话本已不在磁盘，注册表残留清理未完成" : "会话本已不在磁盘，已清理注册表残留"
			: warnings.length > 0 ? "会话已删除，但注册表清理未完成" : "会话已删除",
	};
}
//#endregion

//#region bridge
function makeRoutes(ctx) {
	const list = async () => {
		const registry = ctx.get("workspaceRegistry");
		const persistence = ctx.sessionPersistence;
		if (registry === undefined || persistence === undefined) {
			return { ok: false, code: "services-unavailable", message: "workspaceRegistry / sessionPersistence 服务不可用" };
		}
		const workspaces = registry.list().map((workspace) => ({
			id: String(workspace.id),
			title: workspace.title,
			path: workspace.path,
			sessionIds: [...workspace.sessionIds].map(String),
		}));
		const archivedSessionIds = registry.archivedSessionIds.map(String);
		const pinnedSessionIds = registry.pinnedSessionIds.map(String);
		const ids = new Set(archivedSessionIds);
		for (const workspace of workspaces) for (const id of workspace.sessionIds) ids.add(id);
		const sizes = {};
		for (const id of ids) {
			try {
				const snapshot = await persistence.stat(id);
				if (snapshot !== undefined && typeof snapshot.sizeBytes === "number") sizes[id] = snapshot.sizeBytes;
			} catch {
				// one unreadable session must not break the listing
			}
		}
		return { ok: true, workspaces, archivedSessionIds, pinnedSessionIds, sizes };
	};

	const deleter = async (body) => {
		if (body === null || typeof body !== "object" || !Array.isArray(body.sessionIds) || body.sessionIds.some((id) => typeof id !== "string" || id.length === 0)) {
			return { ok: false, code: "request-rejected", message: "malformed delete request (sessionIds: string[] is required)" };
		}
		const sessionIds = [...new Set(body.sessionIds)];
		const results = [];
		for (const id of sessionIds) {
			try {
				results.push(await deleteOneSession(ctx, id));
			} catch (error) {
				results.push({ id, ok: false, code: "internal-error", message: error instanceof Error ? error.message : String(error) });
			}
		}
		return { ok: true, results };
	};

	return [
		{
			kind: "exact",
			path: `${API_PREFIX}/list`,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) return;
				writeJson(res, 200, await list());
			},
		},
		{
			kind: "exact",
			path: `${API_PREFIX}/delete`,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) return;
				const body = await readJsonBody(req);
				if (body === undefined) {
					writeJson(res, 400, { ok: false, code: "request-rejected", message: "malformed JSON body" });
					return;
				}
				writeJson(res, 200, await deleter(body));
			},
		},
	];
}
//#endregion

/**
 * Plugin entry. The bridge depends on four services; when a peer is
 * missing the plugin stays down with a loud log instead of half-working.
 */
export function apply(ctx) {
	ctx.inject(["webServer", "workspaceRegistry", "sessionPersistence"], (sctx) => {
		sctx.effect(() => {
			const disposers = makeRoutes(sctx).map((route) => sctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "session-delete: api bridge");
	});
	ctx.effect(() => {
		ctx.logger?.info?.("dsh-session-delete: bridge ready at " + API_PREFIX);
	}, "session-delete: ready log");
}
