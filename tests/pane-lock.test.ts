import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withPaneLayoutLock } from "../pane-lock.ts";

const lockModule = new URL("../pane-lock.ts", import.meta.url).href;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-lock-"));
	return { directory: join(root, "pane"), close: () => rmSync(root, { recursive: true, force: true }) };
}

test("same-process callers cannot overlap critical sections", async () => {
	const f = fixture();
	try {
		let active = 0;
		let completed = 0;
		await Promise.all(Array.from({ length: 8 }, () => withPaneLayoutLock(f.directory, async () => {
			assert.equal(active++, 0);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(--active, 0);
			completed++;
		})));
		assert.equal(completed, 8);
		assert.deepEqual(readdirSync(f.directory), []);
	} finally { f.close(); }
});

test("operation failures release the lock", async () => {
	const f = fixture();
	try {
		await assert.rejects(withPaneLayoutLock(f.directory, async () => { throw new Error("failed operation"); }), /failed operation/);
		assert.equal(await withPaneLayoutLock(f.directory, async () => "next"), "next");
		assert.deepEqual(readdirSync(f.directory), []);
	} finally { f.close(); }
});

test("waiting is bounded and a timed-out contender cleans up its claim", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const holder = withPaneLayoutLock(f.directory, async () => { entered(); await gate; });
	try {
		await ready;
		await assert.rejects(withPaneLayoutLock(f.directory, async () => assert.fail("must not acquire"), 75), /Timed out waiting/);
		assert.equal(readdirSync(f.directory).length, 1);
	} finally {
		release();
		await holder;
		f.close();
	}
});

test("different parent-pane lock directories do not block each other", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const holder = withPaneLayoutLock(f.directory, () => gate);
	try {
		assert.equal(await withPaneLayoutLock(`${f.directory}-other`, async () => "independent", 75), "independent");
	} finally {
		release();
		await holder;
		f.close();
	}
});

test("independent processes cannot overlap critical sections under repeated contention", { timeout: 15000 }, async () => {
	const f = fixture();
	const children: ReturnType<typeof spawn>[] = [];
	try {
		const marker = join(f.directory, "critical-section");
		const script = `
			import { openSync, closeSync, rmSync } from "node:fs";
			import { withPaneLayoutLock } from ${JSON.stringify(lockModule)};
			for (let i = 0; i < 6; i++) {
				await withPaneLayoutLock(${JSON.stringify(f.directory)}, async () => {
					const fd = openSync(${JSON.stringify(marker)}, "wx");
					try { await new Promise(resolve => setTimeout(resolve, 5)); }
					finally { closeSync(fd); rmSync(${JSON.stringify(marker)}); }
				});
			}
		`;
		await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
			children.push(child);
			let stderr = "";
			child.stderr!.on("data", (chunk) => { stderr += chunk; });
			child.on("error", reject);
			child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
		})));
		assert.deepEqual(readdirSync(f.directory), []);
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		f.close();
	}
});

test("multiple contenders recover a crashed owner without overlapping", { timeout: 15000 }, async () => {
	const f = fixture();
	const script = `
		import { withPaneLayoutLock } from ${JSON.stringify(lockModule)};
		await withPaneLayoutLock(${JSON.stringify(f.directory)}, async () => {
			process.stdout.write("acquired\\n");
			await new Promise(() => { setInterval(() => {}, 1000); });
		});
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exited = once(child, "exit");
	try {
		// Fail promptly if the helper crashes before publishing its readiness marker.
		const ready = await Promise.race([
			once(child.stdout, "data").then(([chunk]) => String(chunk)),
			exited.then(() => { throw new Error(`Lock owner exited early: ${stderr}`); }),
		]);
		assert.match(ready, /acquired/);
		child.kill("SIGKILL");
		await exited;
		assert.equal(readdirSync(f.directory).length, 1, "crashed owner leaves its claim behind");
		let active = 0;
		await Promise.all(Array.from({ length: 4 }, () => withPaneLayoutLock(f.directory, async () => {
			assert.equal(active++, 0);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(--active, 0);
		})));
		assert.deepEqual(readdirSync(f.directory), []);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		f.close();
	}
});
