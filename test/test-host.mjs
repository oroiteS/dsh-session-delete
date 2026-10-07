// dsh-session-delete Host 半部冒烟测试：
//   1. 模拟 cordis ctx（inject/effect/get/logger）
//   2. 模拟 workspaceRegistry / sessionPersistence / sessions / webServer
//   3. 真实创建临时会话目录，走一遍 list + delete 路由
// 运行：node .tmp/test-host.mjs
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { apply } from "../lib/index.js";

const assert = (condition, message) => {
	if (!condition) {
		console.error("❌ " + message);
		process.exitCode = 1;
	} else {
		console.log("✅ " + message);
	}
};

//#region fake host world
const root = await mkdtemp(join(tmpdir(), "dshsd-test-"));
const sessionsRoot = join(root, "sessions");
const workspaceCwd = join(root, "my-project");
await mkdir(join(sessionsRoot, "--" + workspaceCwd.replaceAll("/", "-") + "--"), { recursive: true });
await mkdir(workspaceCwd, { recursive: true });

// 真实 projectKey 规则（与后端一致）算出来的目录名：
function projectKey(cwd) {
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
const projectDir = join(sessionsRoot, projectKey(workspaceCwd));
await mkdir(projectDir, { recursive: true });

const LIVE_ID = "session-11111111-1111-4111-8111-111111111111";
const DEAD_ID = "session-22222222-2222-4222-8222-222222222222"; // 磁盘上不存在
const TARGET_ID = "session-33333333-3333-4333-8333-333333333333";
const TARGET2_ID = "session-44444444-4444-4444-8444-444444444444";

for (const id of [LIVE_ID, TARGET_ID, TARGET2_ID]) {
	await mkdir(join(projectDir, id), { recursive: true });
	await writeFile(join(projectDir, id, "session.v4.jsonl.zstd"), "fake-log-" + id);
}

const workspaceRecord = {
	path: workspaceCwd,
	title: "my-project",
	sessionIds: [TARGET_ID, LIVE_ID, TARGET2_ID],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

const registry = {
	archivedSessionIds: [TARGET2_ID, DEAD_ID],
	pinnedSessionIds: [TARGET_ID],
	async unarchiveSession(id) {
		this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id);
	},
	async unpinSession(id) {
		this.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id);
	},
	list() {
		return [{
			id: "ws-1",
			title: workspaceRecord.title,
			path: workspaceRecord.path,
			sessionIds: [...workspaceRecord.sessionIds],
			async detachSession(sessionId) {
				workspaceRecord.sessionIds = workspaceRecord.sessionIds.filter((value) => value !== sessionId);
			},
		}];
	},
};

const persistence = {
	root: sessionsRoot,
	stat: undefined, // below
	locate(meta) {
		return { kind: "jsonl", path: join(projectDir, meta.id, "session.v4.jsonl.zstd") };
	},
};
persistence.stat = async (id) => {
	if (id === DEAD_ID) return undefined;
	return { header: { id, cwd: workspaceCwd, createdAt: Date.now() }, revision: "r1", sizeBytes: 1234 };
};

const services = new Map(Object.entries({
	workspaceRegistry: registry,
	sessionPersistence: persistence,
	// TOUCHED_ID：内存 store 里存在（进程生命周期内被打开过）但并无活动 ——
	// 旧实现误报"正在运行"的场景；LIVE_ID：真正有 agent 在跑。
	sessions: { get: (id) => (id === LIVE_ID || id === "session-55555555-5555-4555-8555-555555555555" ? { id } : undefined) },
}));

const emittedEvents = [];
const routes = [];
const fakeCtx = {
	get: (name) => services.get(name),
	sessionPersistence: persistence,
	waterfall: async (event, payload, fallback) => {
		if (event === "workspace/session-activity" && payload.sessionId === LIVE_ID) return [{ kind: "agent" }];
		return await fallback();
	},
	emit: (event, ...args) => { emittedEvents.push([event, ...args]); },
	logger: { info: (line) => console.log("  [host log]", line), warn: (line) => console.log("  [host warn]", line) },
	effect(setup) {
		const dispose = setup();
		void dispose;
	},
	inject(deps, callback) {
		if (!deps.every((name) => name === "webServer" ? true : services.has(name))) {
			console.error("❌ inject 缺服务: " + deps.join(","));
			process.exitCode = 1;
			return;
		}
		callback({
			...fakeCtx,
			webServer: { register: (route) => { routes.push(route); return () => {}; } },
		});
	},
};

function fakeRequest(body) {
	return {
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1" },
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(JSON.stringify(body));
		},
	};
}
function fakeResponse() {
	return {
		status: 0,
		body: undefined,
		writeHead(status) { this.status = status; },
		end(payload) { this.body = JSON.parse(payload); },
	};
}
//#endregion

// 启动插件
apply(fakeCtx);
const listRoute = routes.find((route) => route.path.endsWith("/list"));
const deleteRoute = routes.find((route) => route.path.endsWith("/delete"));
assert(listRoute !== undefined && deleteRoute !== undefined, "两个路由都已注册");

// GET /list
{
	const res = fakeResponse();
	await listRoute.handler(fakeRequest(), res);
	assert(res.status === 200 && res.body.ok, "list 返回 ok");
	assert(res.body.workspaces[0].sessionIds.length === 3, "list 投影 3 个会话");
	assert(res.body.archivedSessionIds.length === 2, "list 投影归档集");
	assert(res.body.sizes[TARGET_ID] === 1234, "list 返回磁盘占用");
	assert(res.body.sizes[DEAD_ID] === undefined, "已消失的会话没有占用记录");
}

// POST /delete：有活动（agent 在跑）的会话拒绝 —— 与归档同款的活动瀑布判定
{
	const res = fakeResponse();
	await deleteRoute.handler(fakeRequest({ sessionIds: [LIVE_ID] }), res);
	const entry = res.body.results[0];
	assert(res.body.ok && entry.ok === false && entry.code === "session-active", "有活动的会话被拒绝（session-active）");
	assert(entry.message.includes("agent"), `拒绝原因列出活动类型（实际：${entry.message}）`);
	const dirExists = await stat(join(projectDir, LIVE_ID)).then(() => true, () => false);
	assert(dirExists, "活动会话目录未被触碰");
}

// POST /delete：内存 store 中存在但无活动 → 可删（旧实现误报"正在运行"的场景）
{
	const touchedId = "session-55555555-5555-4555-8555-555555555555";
	await mkdir(join(projectDir, touchedId), { recursive: true });
	await writeFile(join(projectDir, touchedId, "session.v4.jsonl.zstd"), "fake-log");
	const res = fakeResponse();
	await deleteRoute.handler(fakeRequest({ sessionIds: [touchedId] }), res);
	const entry = res.body.results[0];
	assert(entry.ok === true && entry.code === "deleted", "内存残留但空闲的会话可正常删除");
	const gone = await stat(join(projectDir, touchedId)).then(() => false, () => true);
	assert(gone, "空闲残留会话目录已移除");
	assert(emittedEvents.some(([event, id]) => event === "api-session/removed" && id === touchedId), "删除后向客户端发出 api-session/removed");
}

// POST /delete：磁盘已无会话但注册表仍有残留 → 清理残留（purged）
{
	const res = fakeResponse();
	await deleteRoute.handler(fakeRequest({ sessionIds: [DEAD_ID] }), res);
	const entry = res.body.results[0];
	assert(entry.ok === true && entry.code === "purged", "磁盘已无会话 → 清理注册表残留（purged）");
	assert(!registry.archivedSessionIds.includes(DEAD_ID), "陈旧归档条目已被清理");
	assert(emittedEvents.some(([event, id]) => event === "api-session/removed" && id === DEAD_ID), "purge 后同样发出 api-session/removed");
}

// POST /delete：正常删除（含归档+置顶清理 + detach）
{
	const res = fakeResponse();
	await deleteRoute.handler(fakeRequest({ sessionIds: [TARGET_ID, TARGET2_ID] }), res);
	const byId = Object.fromEntries(res.body.results.map((entry) => [entry.id, entry]));
	assert(byId[TARGET_ID]?.ok === true && byId[TARGET_ID]?.code === "deleted", "会话 1 删除成功");
	assert(byId[TARGET2_ID]?.ok === true && byId[TARGET2_ID]?.code === "deleted", "会话 2（归档态）删除成功");
	const gone1 = await stat(join(projectDir, TARGET_ID)).then(() => false, () => true);
	const gone2 = await stat(join(projectDir, TARGET2_ID)).then(() => false, () => true);
	assert(gone1 && gone2, "两个会话目录都已从磁盘移除");
	assert(!registry.pinnedSessionIds.includes(TARGET_ID), "置顶集已清理");
	assert(!registry.archivedSessionIds.includes(TARGET2_ID), "归档集已清理");
	assert(!workspaceRecord.sessionIds.includes(TARGET_ID) && !workspaceRecord.sessionIds.includes(TARGET2_ID), "工作区账目已 detach");
	assert(workspaceRecord.sessionIds.includes(LIVE_ID), "未涉及的会话账目保持不变");
	assert(emittedEvents.filter(([event]) => event === "api-session/removed").length >= 4, "每个成功删除都向客户端发了移除通知");
}

// POST /delete：非法请求体
{
	const res = fakeResponse();
	await deleteRoute.handler(fakeRequest({ sessionIds: "not-an-array" }), res);
	assert(res.status === 200 && res.body.ok === false && res.body.code === "request-rejected", "非法请求体被拒绝");
}

// 清理
await rm(root, { recursive: true, force: true });
console.log(process.exitCode ? "\n存在失败用例" : "\n全部通过");
