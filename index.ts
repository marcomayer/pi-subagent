import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	effectiveRunState,
	equalizeRunPanes,
	focusRunPane,
	inboxDir,
	isRunAlive,
	labelOwnPane,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	stopRunProcess,
	type InboxMessage,
	type RunMetadata,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and focus the herdr pane of a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Focus subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "focus")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			try {
				await focusRunPane(run);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not focus ${run.handle}: ${message}`, "error");
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		let arrangedPaneIds: string | undefined;

		// Re-equalize the subagent column whenever its set of panes changes, e.g. after a child exited.
		const arrangePanes = (): void => {
			if (!widgetContext) return;
			const runs = listRuns(widgetContext.sessionManager.getSessionId());
			const paneIds = runs
				.filter(isRunAlive)
				.map((run) => run.paneId)
				.join(",");
			if (paneIds === arrangedPaneIds) return;
			arrangedPaneIds = paneIds;
			equalizeRunPanes(runs).catch(() => {});
		};

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", async (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || isRunAlive(run)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					await launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			arrangedPaneIds = undefined;
			refreshWidget();
			arrangePanes();
			widgetTimer = setInterval(() => {
				refreshWidget();
				arrangePanes();
			}, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!isRunAlive(run)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				stopRunProcess(run);
				await waitForRunShutdown(run.runDir);
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		labelOwnPane(metadata.name ?? metadata.handle).catch(() => {});
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
