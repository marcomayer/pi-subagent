import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Claim {
	id: string;
	pid: number;
	/** Zero means the process is still choosing its ticket. */
	ticket: number;
}

function readClaims(directory: string): Claim[] {
	const claims: Claim[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json")) continue;
		const path = join(directory, name);
		let claim: Claim;
		try {
			claim = JSON.parse(readFileSync(path, "utf8")) as Claim;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!Number.isInteger(claim.pid) || claim.pid <= 0 || !Number.isSafeInteger(claim.ticket) || claim.ticket < 0) {
			throw new Error(`Invalid pane lock claim: ${path}`);
		}
		try {
			process.kill(claim.pid, 0);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") {
				// Each claim has a unique filename: deleting a dead owner's claim cannot delete a new owner's lock.
				rmSync(path, { force: true });
				continue;
			}
			if (code !== "EPERM") throw error;
		}
		claims.push({ ...claim, id: name });
	}
	return claims;
}

/**
 * Cross-process Lamport bakery lock. Publish "choosing" before selecting a ticket, then wait for all
 * choosing or earlier-ticket claims. Atomic publication and unique claim files let us recover dead
 * owners without racing to delete a shared lock file underneath a new owner. Also works within one process.
 *
 * Assumes directory enumeration retains active claim names while rename replaces their contents; POSIX
 * rename alone does not guarantee that property. Intended for local filesystems, not a portable or distributed
 * filesystem lock. Dead-owner detection uses PID existence, so PID reuse can delay stale-claim recovery.
 */
export async function withPaneLayoutLock<T>(
	directory: string,
	operation: () => Promise<T>,
	timeoutMs = 60_000,
): Promise<T> {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${randomUUID()}.json`;
	const path = join(directory, id);
	const temporary = `${path}.tmp`;
	const deadline = performance.now() + timeoutMs;
	const publish = (ticket: number): void => {
		writeFileSync(temporary, JSON.stringify({ pid: process.pid, ticket }), { mode: 0o600 });
		renameSync(temporary, path);
	};

	try {
		publish(0);
		const ticket = readClaims(directory).reduce((max, claim) => Math.max(max, claim.ticket), 0) + 1;
		publish(ticket);
		while (true) {
			const blocked = readClaims(directory).some(
				(claim) => claim.id !== id &&
					(claim.ticket === 0 || claim.ticket < ticket || (claim.ticket === ticket && claim.id < id)),
			);
			if (!blocked) return await operation();
			if (performance.now() >= deadline) throw new Error(`Timed out waiting for subagent pane layout lock: ${directory}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
	} finally {
		rmSync(path, { force: true });
		rmSync(temporary, { force: true });
	}
}
