import { readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi supplies these runtime imports. No selector UI is exercised by the lifecycle tests.
registerHooks({
	resolve(specifier, context, nextResolve) {
		const source = specifier === "@earendil-works/pi-coding-agent"
			? "export const DynamicBorder = undefined; export const keyHint = undefined;"
			: specifier === "@earendil-works/pi-tui"
				? "export const Container = undefined; export const SelectList = undefined; export const Text = undefined;"
				: undefined;
		if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

const { default: extension } = await import("../../index.ts");
type Handler = (event: { reason?: string }, context: ExtensionContext) => unknown;
const handlers = new Map<string, Handler>();
extension({
	on: (name: string, handler: Handler) => { handlers.set(name, handler); },
	registerCommand: () => {},
} as unknown as ExtensionAPI);

let clock = 0;
mock.method(performance, "now", () => clock);
mock.timers.enable({ apis: ["setInterval"] });
let context: ExtensionContext;

async function start() {
	context = {
		hasUI: true,
		sessionManager: { getSessionId: () => process.env.PI_SESSION_ID },
		ui: {
			setWidget: () => {},
			notify: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, context);
}

async function settle() {
	// Synchronization only: allow the real socket operation and its promise handlers to finish
	// before advancing the fake clock. Assertions remain at the Herdr request boundary.
	const root = join(process.env.PI_CODING_AGENT_DIR!, "subagent-pane-locks");
	function hasOwnClaim() {
		return readdirSync(root).some((directory) =>
			readdirSync(join(root, directory)).some((name) => name.startsWith(`${process.pid}-`) && name.endsWith(".json")),
		);
	}
	await setImmediate();
	while (hasOwnClaim()) await setImmediate();
	await setImmediate();
}

await start();
await settle();
process.send!({ type: "ready" });
process.on("message", async (message: { id: number; type: string; milliseconds?: number }) => {
	try {
		if (message.type === "advance") {
			clock += message.milliseconds!;
			mock.timers.tick(message.milliseconds!);
		} else if (message.type === "restart") {
			await handlers.get("session_shutdown")!({ reason: "reload" }, context);
			await start();
		} else {
			throw new Error(`Unknown lifecycle command: ${message.type}`);
		}
		await settle();
		process.send!({ id: message.id, clock });
	} catch (error) {
		process.send!({ id: message.id, error: String(error) });
	}
});
