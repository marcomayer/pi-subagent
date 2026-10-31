import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeMetadata } from "../shared.ts";

const cliPath = fileURLToPath(new URL("../subagent.ts", import.meta.url));
const sharedPath = new URL("../shared.ts", import.meta.url).href;
const parentFixturePath = fileURLToPath(new URL("./fixtures/parent-extension.ts", import.meta.url));

type Rect = { x: number; y: number; width: number; height: number };
type Pane = { id: string };
type Split = { direction: "right" | "down"; ratio: number; children: [Tree, Tree] };
type Tree = Pane | Split;

/** A socket-level Herdr double: real CLI processes, no Pi processes or terminal panes. */
async function fixture(pidDelayMs: number | null = 0) {
	const root = mkdtempSync(join(tmpdir(), "subagent-layout-"));
	const socketPath = join(root, "herdr.sock");
	const env = {
		...process.env,
		PI_SUBAGENT_RUN_DIR: "",
		PI_CODING_AGENT_DIR: root,
		PI_SESSION_ID: "layout-test",
		HERDR_SOCKET_PATH: socketPath,
		HERDR_PANE_ID: "parent",
		PI_PROVIDER: "test-provider",
		PI_MODEL: "test-model",
	};
	let tree: Tree = { id: "parent" };
	let failNextOpen = false;
	let failLayoutReads = false;
	let layoutReads = 0;
	let pendingLaunches = 0;
	let splitRatioSets = 0;
	let onOpen: (() => void) | undefined;
	const opens: { id: string; target: string; direction: string }[] = [];
	const renames: { pane_id: string; label: string }[] = [];
	const prematureLayoutReads: string[] = [];
	const sockets = new Set<Socket>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const children = new Set<ReturnType<typeof spawn>>();
	const heldLaunches: (() => void)[] = [];
	let existingRuns = 0;

	function layout() {
		const panes: { pane_id: string; rect: Rect }[] = [];
		const splits: { direction: string; ratio: number; rect: Rect }[] = [];
		function visit(node: Tree, rect: Rect) {
			if ("id" in node) {
				panes.push({ pane_id: node.id, rect });
				return;
			}
			splits.push({ direction: node.direction, ratio: node.ratio, rect });
			if (node.direction === "right") {
				const width = rect.width * node.ratio;
				visit(node.children[0], { ...rect, width });
				visit(node.children[1], { ...rect, x: rect.x + width, width: rect.width - width });
			} else {
				const height = rect.height * node.ratio;
				visit(node.children[0], { ...rect, height });
				visit(node.children[1], { ...rect, y: rect.y + height, height: rect.height - height });
			}
		}
		visit(tree, { x: 0, y: 0, width: 200, height: 120 });
		return { panes, splits };
	}

	function splitPane(node: Tree, target: string, id: string, direction: Split["direction"]): Tree {
		if ("id" in node) return node.id === target ? { direction, ratio: 0.5, children: [node, { id }] } : node;
		node.children = node.children.map((child) => splitPane(child, target, id, direction)) as [Tree, Tree];
		return node;
	}

	/** Herdr's portable layout tree, as returned by layout.export. */
	function exportTree(node: Tree): unknown {
		if ("id" in node) return { type: "pane", pane_id: node.id };
		return {
			type: "split",
			direction: node.direction,
			ratio: node.ratio,
			first: exportTree(node.children[0]),
			second: exportTree(node.children[1]),
		};
	}

	/** Herdr split paths step from the tab root: true is the second child, false the first. */
	function splitAt(path: boolean[]): Split | undefined {
		let node = tree;
		for (const second of path) {
			if ("id" in node) return undefined;
			node = node.children[second ? 1 : 0];
		}
		return "id" in node ? undefined : node;
	}

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
			const reply = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			if (request.method === "pane.layout") {
				layoutReads++;
				if (pendingLaunches) prematureLayoutReads.push(request.method);
				if (failLayoutReads) {
					socket.end(`${JSON.stringify({ id: request.id, error: { message: "persistent layout failure" } })}\n`);
				} else reply({ layout: layout() });
			} else if (request.method === "plugin.pane.open") {
				if (failNextOpen) {
					failNextOpen = false;
					socket.end(`${JSON.stringify({ id: request.id, error: { message: "injected open failure" } })}\n`);
					return;
				}
				const id = `child-${opens.length + 1}`;
				opens.push({ id, target: request.params.target_pane_id, direction: request.params.direction });
				tree = splitPane(tree, request.params.target_pane_id, id, request.params.direction);
				pendingLaunches++;
				const publishPid = () => {
					// A live PID is enough for sibling discovery. No child process needs to run.
					const runDir = request.params.env.PI_SUBAGENT_RUN_DIR;
					// A failing CLI can remove its run before test cleanup releases the gate.
					if (existsSync(runDir)) writeFileSync(join(runDir, "pid"), String(process.pid));
					pendingLaunches--;
				};
				if (pidDelayMs === null) heldLaunches.push(publishPid);
				else {
					const timer = setTimeout(() => {
						publishPid();
						timers.delete(timer);
					}, pidDelayMs);
					timers.add(timer);
				}
				reply({ plugin_pane: { pane: { pane_id: id } } });
				onOpen?.();
			} else if (request.method === "pane.rename") {
				renames.push(request.params);
				reply({});
			} else if (request.method === "layout.export") {
				layoutReads++;
				if (failLayoutReads) {
					socket.end(`${JSON.stringify({ id: request.id, error: { message: "persistent layout failure" } })}\n`);
				} else reply({ type: "layout_export", layout: { tab_id: "tab-1", root: exportTree(tree) } });
			} else if (request.method === "layout.set_split_ratio") {
				const split = request.params.tab_id === "tab-1" ? splitAt(request.params.path) : undefined;
				if (!split) {
					socket.end(`${JSON.stringify({ id: request.id, error: { code: "split_not_found", message: "split path not found" } })}\n`);
					return;
				}
				split.ratio = request.params.ratio;
				splitRatioSets++;
				reply({ type: "layout_split_ratio_set" });
			} else {
				throw new Error(`Unexpected Herdr request: ${request.method}`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	function run(args: string[], onMessage?: (message: "waiting" | "completed") => void): Promise<{ code: number | null; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
			if (onMessage) child.on("message", onMessage);
			children.add(child);
			child.on("close", () => children.delete(child));
			let stderr = "";
			child.stderr!.on("data", (chunk) => { stderr += chunk; });
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stderr }));
		});
	}

	async function parentExtension() {
		const child = spawn(process.execPath, [parentFixturePath], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
		children.add(child);
		child.on("close", () => children.delete(child));
		let stderr = "";
		child.stderr!.on("data", (chunk) => { stderr += chunk; });
		let ready!: () => void;
		let failed!: (error: Error) => void;
		const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
		const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
		let sequence = 0;
		child.on("message", (message: { type?: string; id?: number; error?: string }) => {
			if (message.type === "ready") ready();
			if (message.id !== undefined) {
				const callback = pending.get(message.id)!;
				pending.delete(message.id);
				if (message.error) callback.reject(new Error(message.error));
				else callback.resolve();
			}
		});
		child.on("error", failed);
		child.on("close", (code) => {
			const error = new Error(`Parent fixture exited (${code}): ${stderr}`);
			failed(error);
			for (const callback of pending.values()) callback.reject(error);
			pending.clear();
		});
		await started;
		function command(type: string, milliseconds?: number) {
			return new Promise<void>((resolve, reject) => {
				const id = ++sequence;
				pending.set(id, { resolve, reject });
				child.send({ id, type, milliseconds });
			});
		}
		return {
			advance: (milliseconds: number) => command("advance", milliseconds),
			restart: () => command("restart"),
		};
	}

	return {
		opens,
		renames,
		labelPane: (label: string) => run(["--input-type=module", "-e", `
			import { labelOwnPane } from ${JSON.stringify(sharedPath)};
			process.env.HERDR_PANE_ID = "child-1";
			await labelOwnPane(${JSON.stringify(label)});
		`]),
		prematureLayoutReads,
		layout,
		spawn: () => run([cliPath, "spawn", "--name", "test", "--prompt", "hello"]),
		equalize: (onState: (state: "waiting" | "completed") => void) => run(["--input-type=module", "-e", `
			import { readdirSync } from "node:fs";
			import { join } from "node:path";
			import { setImmediate } from "node:timers/promises";
			import { equalizeRunPanes, getAgentDir } from ${JSON.stringify(sharedPath)};
			let completed = false;
			const operation = equalizeRunPanes("layout-test").finally(() => { completed = true; });
			const root = join(getAgentDir(), "subagent-pane-locks");
			// Synchronize on actual contention, not on an assumed subprocess startup time.
			while (!completed) {
				const claims = readdirSync(root).filter(name => name.endsWith(".json"));
				const own = claims.find(name => name.split(".")[1]?.startsWith(process.pid + "-"));
				const key = own?.split(".")[0];
				const waiting = own !== undefined && claims.filter(name => name.startsWith(key + ".")).length > 1;
				if (waiting) { process.send("waiting"); break; }
				await setImmediate();
			}
			if (completed) process.send("completed");
			await operation;
		`], onState),
		releaseLaunches: () => { for (const publishPid of heldLaunches.splice(0)) publishPid(); },
		addRun: () => {
			const handle = `existing-${++existingRuns}`;
			const runDir = join(root, "subagents", handle);
			writeMetadata({
				version: 2, handle, runDir, parentSessionId: "layout-test",
				sessionFile: join(runDir, "session.jsonl"), paneId: handle,
				cwd: root, provider: "test-provider", model: "test-model", thinking: "medium",
				state: "idle", hasStarted: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			});
			writeFileSync(join(runDir, "pid"), String(process.pid));
			tree = splitPane(tree, "parent", handle, "right");
		},
		failOpen: () => { failNextOpen = true; },
		failLayouts: (fail = true) => { failLayoutReads = fail; },
		layoutReadCount: () => layoutReads,
		splitRatioSetCount: () => splitRatioSets,
		/** Skew every down-split, as a user dragging dividers would. */
		skewColumn: () => {
			const skew = (node: Tree) => {
				if ("id" in node) return;
				if (node.direction === "down") node.ratio = 0.8;
				node.children.forEach(skew);
			};
			skew(tree);
		},
		parentExtension,
		onOpen: (callback: () => void) => { onOpen = callback; },
		async close() {
			await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
				child.once("close", () => resolve());
				child.kill("SIGKILL");
			})));
			for (const timer of timers) clearTimeout(timer);
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function assertColumn(f: Awaited<ReturnType<typeof fixture>>, count: number) {
	assert.deepEqual(f.opens.map(({ target, direction }) => ({ target, direction })),
		Array.from({ length: count }, (_, i) => ({ target: i ? `child-${i}` : "parent", direction: i ? "down" : "right" })));
	const panes = f.layout().panes;
	const parent = panes.find((pane) => pane.pane_id === "parent")!;
	assert.equal(parent.rect.height, 120);
	for (const pane of panes.filter((pane) => pane.pane_id !== "parent")) {
		assert.equal(pane.rect.x, 100);
		assert.ok(Math.abs(pane.rect.height - 120 / count) < 0.001, JSON.stringify(panes));
	}
}

test("subagent pane labels retain their prefix for names, handles, and renames", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		for (const label of ["review", "a1b2c3", "renamed review"]) {
			assert.deepEqual(await f.labelPane(label), { code: 0, stderr: "" });
		}
		assert.deepEqual(f.renames, [
			{ pane_id: "child-1", label: "subagent: review" },
			{ pane_id: "child-1", label: "subagent: a1b2c3" },
			{ pane_id: "child-1", label: "subagent: renamed review" },
		]);
	} finally { await f.close(); }
});

test("sequential spawns build an equal-height column beside the parent", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < 3; i++) assert.deepEqual(await f.spawn(), { code: 0, stderr: "" });
		assertColumn(f, 3);
	} finally { await f.close(); }
});

test("concurrent spawns discover each newly opened sibling, including delayed launcher PIDs", { timeout: 15000 }, async () => {
	const f = await fixture(200);
	try {
		const results = await Promise.all(Array.from({ length: 3 }, () => f.spawn()));
		for (const result of results) assert.deepEqual(result, { code: 0, stderr: "" });
		assertColumn(f, 3);
		assert.deepEqual(f.prematureLayoutReads, []);
	} finally { await f.close(); }
});

test("concurrent spawns extend an existing subagent column", { timeout: 15000 }, async () => {
	const f = await fixture(100);
	try {
		assert.deepEqual(await f.spawn(), { code: 0, stderr: "" });
		const results = await Promise.all(Array.from({ length: 3 }, () => f.spawn()));
		for (const result of results) assert.deepEqual(result, { code: 0, stderr: "" });
		assertColumn(f, 4);
		assert.deepEqual(f.prematureLayoutReads, []);
	} finally { await f.close(); }
});

test("equalizing sets absolute split ratios, so a repeat run changes nothing", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < 3; i++) assert.deepEqual(await f.spawn(), { code: 0, stderr: "" });
		f.skewColumn();
		const before = f.splitRatioSetCount();
		assert.deepEqual(await f.equalize(() => {}), { code: 0, stderr: "" });
		assertColumn(f, 3);
		assert.equal(f.splitRatioSetCount() - before, 2, "one request per skewed divider");
		assert.deepEqual(await f.equalize(() => {}), { code: 0, stderr: "" });
		assert.equal(f.splitRatioSetCount() - before, 2, "an equal column needs no requests");
	} finally { await f.close(); }
});

test("a failed pane open releases placement coordination for the next spawn", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		f.failOpen();
		const failure = await f.spawn();
		assert.equal(failure.code, 1);
		assert.match(failure.stderr, /injected open failure/);
		assert.deepEqual(await f.spawn(), { code: 0, stderr: "" });
		assertColumn(f, 1);
	} finally { await f.close(); }
});

test("persistent background layout failures back off to at most one retry every 30 seconds", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		f.addRun();
		f.failLayouts();
		const parent = await f.parentExtension();
		const attemptedAt = [0];
		let previous = f.layoutReadCount();
		for (let seconds = 1; seconds <= 90; seconds++) {
			await parent.advance(1000);
			const count = f.layoutReadCount();
			if (count !== previous) attemptedAt.push(seconds);
			previous = count;
		}
		assert.deepEqual(attemptedAt, [0, 2, 6, 14, 30, 60, 90]);
	} finally { await f.close(); }
});

test("pane-set changes bypass retry backoff and successful equalization stops retries", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		f.addRun();
		f.failLayouts();
		const parent = await f.parentExtension();
		await parent.advance(1000);
		await parent.advance(1000); // Second failure: next retry would be at six seconds.
		await parent.advance(1000);
		f.addRun();
		await parent.advance(1000);
		assert.equal(f.layoutReadCount(), 3, "changed panes retry before the old backoff expires");
		f.failLayouts(false);
		await parent.advance(1000);
		assert.equal(f.layoutReadCount(), 3);
		await parent.advance(1000);
		assert.equal(f.layoutReadCount(), 4);
		await parent.advance(30_000);
		assert.equal(f.layoutReadCount(), 4, "successful, unchanged panes need no further retries");
	} finally { await f.close(); }
});

test("a fresh session resets background layout retry backoff", { timeout: 15000 }, async () => {
	const f = await fixture();
	try {
		f.addRun();
		f.failLayouts();
		const parent = await f.parentExtension();
		await parent.advance(1000);
		await parent.advance(1000);
		await parent.advance(1000);
		await parent.restart();
		assert.equal(f.layoutReadCount(), 3, "a new session attempts equalization immediately");
		await parent.advance(1000);
		assert.equal(f.layoutReadCount(), 3);
		await parent.advance(1000);
		assert.equal(f.layoutReadCount(), 4, "a new session uses the initial retry delay");
	} finally { await f.close(); }
});

test("background equalization shares the placement lock", { timeout: 15000 }, async () => {
	const f = await fixture(null);
	let spawning: Promise<{ code: number | null; stderr: string }> | undefined;
	let equalizing: Promise<{ code: number | null; stderr: string }> | undefined;
	try {
		const opened = new Promise<void>((resolve) => f.onOpen(resolve));
		spawning = f.spawn();
		await opened;
		const waiting = new Promise<void>((resolve, reject) => {
			equalizing = f.equalize((state) => {
				if (state === "waiting") resolve();
				else reject(new Error("Equalization completed before contending for the placement lock"));
			});
			equalizing.then((result) => {
				if (result.code !== 0) reject(new Error(result.stderr));
			}, reject);
		});
		await waiting;
		assert.deepEqual(f.prematureLayoutReads, []);
		f.releaseLaunches();
		assert.deepEqual(await spawning, { code: 0, stderr: "" });
		assert.deepEqual(await equalizing, { code: 0, stderr: "" });
		assert.deepEqual(f.prematureLayoutReads, []);
	} finally {
		f.releaseLaunches();
		await f.close();
		await Promise.allSettled([spawning, equalizing]);
	}
});
