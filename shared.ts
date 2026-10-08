import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { equalizeSubagentPanes, focusSubagentPane, openSubagentPane, renameSubagentPane } from "./herdr.ts";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 2;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** Herdr pane hosting the child, as of its last launch; herdr assigns a new id if the user moves the pane. */
	paneId?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

function launchScriptPath(runDir: string): string {
	return join(runDir, "launch.sh");
}

function pidPath(runDir: string): string {
	return join(runDir, "pid");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 2 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 2,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function readRunPid(runDir: string): number | undefined {
	try {
		const pid = Number(readFileSync(pidPath(runDir), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** True while the child's process, whose pid launch.sh records before exec'ing pi, is running. */
export function isRunAlive(metadata: RunMetadata): boolean {
	const pid = readRunPid(metadata.runDir);
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Hang up the child's process group like a closing terminal would; herdr closes the pane once it exits. */
export function stopRunProcess(metadata: RunMetadata): void {
	const pid = readRunPid(metadata.runDir);
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGHUP");
	} catch {
		try {
			process.kill(pid, "SIGHUP");
		} catch {
			// Already exited.
		}
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The caller's environment, minus herdr's per-pane variables which herdr sets for the new pane itself. */
function childEnvironment(runDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("HERDR_")) continue;
		env[key] = value;
	}
	env.PI_SUBAGENT_RUN_DIR = runDir;
	return env;
}

/** Pane ids of the other live runs spawned by the same parent session. */
function siblingPaneIds(metadata: RunMetadata): string[] {
	return listRuns()
		.filter((run) => run.handle !== metadata.handle && run.parentSessionId === metadata.parentSessionId)
		.filter((run) => run.paneId !== undefined && isRunAlive(run))
		.map((run) => run.paneId!);
}

async function waitForRunPid(runDir: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readRunPid(runDir) !== undefined) return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Subagent process did not start within ${timeoutMs}ms`);
}

/**
 * Start the child pi process for a run in a herdr pane beside the caller's pane (`HERDR_PANE_ID`), with the
 * caller's environment. `initialArgs` are only passed on first spawn. Returns the new pane id.
 */
export async function launchRun(metadata: RunMetadata, initialArgs: string[] = []): Promise<string> {
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (!parentPaneId) throw new Error("Subagents require running inside herdr: HERDR_PANE_ID is unset");

	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const argv = [
		launcher,
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];
	// exec keeps the recorded pid for the launcher, which leads the pane's process group.
	// Ctrl+Z is ignored because the pane has no shell to resume a stopped pi from.
	const script = [
		"trap '' TSTP",
		`echo $$ > ${shellQuote(pidPath(metadata.runDir))}`,
		`exec ${argv.map(shellQuote).join(" ")}`,
		"",
	].join("\n");
	writeFileSync(launchScriptPath(metadata.runDir), script, { encoding: "utf8", mode: 0o600 });
	rmSync(pidPath(metadata.runDir), { force: true });

	const paneId = await openSubagentPane({
		parentPaneId,
		siblingPaneIds: siblingPaneIds(metadata),
		cwd: metadata.cwd,
		env: childEnvironment(metadata.runDir),
	});
	updateMetadata(metadata.runDir, { paneId });
	await waitForRunPid(metadata.runDir);
	return paneId;
}

/** Give the live runs' panes beside the caller's pane equal heights, e.g. after one exited. */
export async function equalizeRunPanes(runs: RunMetadata[]): Promise<void> {
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (!parentPaneId) return;
	const paneIds = runs.filter((run) => run.paneId !== undefined && isRunAlive(run)).map((run) => run.paneId!);
	await equalizeSubagentPanes(parentPaneId, paneIds);
}

/** Focus the herdr pane of a run. */
export async function focusRunPane(metadata: RunMetadata): Promise<void> {
	if (!metadata.paneId) throw new Error(`${metadata.handle} has no pane`);
	await focusSubagentPane(metadata.paneId);
}

/** Label the herdr pane the current process runs in; no-op outside herdr. */
export async function labelOwnPane(label: string): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return;
	await renameSubagentPane(paneId, label);
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!isRunAlive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
