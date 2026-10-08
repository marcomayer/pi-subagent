import { createConnection } from "node:net";

/** Plugin and pane entrypoint ids from herdr-plugin/herdr-plugin.toml. */
const HERDR_PLUGIN_ID = "pi-subagent";
const HERDR_PANE_ENTRYPOINT = "subagent";

interface PaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PaneLayout {
	panes: { pane_id: string; rect: PaneRect }[];
	splits: { direction: "right" | "down"; ratio: number; rect: PaneRect }[];
}

/** Send one request over the herdr socket API (`HERDR_SOCKET_PATH`) and resolve with its result. */
function herdrRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (!socketPath) return Promise.reject(new Error("Not running inside herdr: HERDR_SOCKET_PATH is unset"));

	return new Promise((resolveResult, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		// A stalled Herdr request must not hold the cross-process layout lock indefinitely.
		socket.setTimeout(10_000, () => socket.destroy(new Error(`herdr ${method}: request timed out`)));
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: "1", method, params })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end === -1) return;
			socket.end();
			try {
				const response = JSON.parse(buffer.slice(0, end)) as { result?: T; error?: { message?: string } };
				if (response.error) reject(new Error(`herdr ${method}: ${response.error.message ?? "request failed"}`));
				else resolveResult(response.result as T);
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", reject);
		socket.on("close", () => reject(new Error(`herdr ${method}: connection closed without a response`)));
	});
}

async function readPaneLayout(paneId: string): Promise<PaneLayout> {
	const result = await herdrRequest<{ layout: PaneLayout }>("pane.layout", { pane_id: paneId });
	return result.layout;
}

/** Subagent panes in the layout that form the column beside the parent, top to bottom. */
function subagentColumn(layout: PaneLayout, subagentPaneIds: string[]): PaneLayout["panes"] {
	const panes = layout.panes
		.filter((pane) => subagentPaneIds.includes(pane.pane_id))
		.sort((a, b) => a.rect.y - b.rect.y);
	const top = panes[0];
	if (!top) return [];
	return panes.filter((pane) => pane.rect.x === top.rect.x);
}

/**
 * Resize a parent's subagent column so every pane gets the same height. Herdr splits are binary, so
 * the column is a chain of down-splits; the split above pane i+1 must give pane i 1/(n-i) of the rest.
 */
export async function equalizeSubagentPanes(parentPaneId: string, subagentPaneIds: string[]): Promise<void> {
	let layout = await readPaneLayout(parentPaneId);
	const column = subagentColumn(layout, subagentPaneIds).map((pane) => pane.pane_id);

	for (let i = 0; i < column.length - 1; i++) {
		const upper = layout.panes.find((pane) => pane.pane_id === column[i])?.rect;
		const lower = layout.panes.find((pane) => pane.pane_id === column[i + 1])?.rect;
		if (!upper || !lower) return;

		// The innermost down-split spanning both panes is the one whose divider sits between them.
		const split = layout.splits
			.filter(
				({ direction, rect }) =>
					direction === "down" &&
					rect.x <= upper.x &&
					rect.x + rect.width >= upper.x + upper.width &&
					rect.y <= upper.y &&
					rect.y + rect.height >= lower.y + lower.height,
			)
			.sort((a, b) => a.rect.height - b.rect.height)[0];
		if (!split) return;

		const delta = 1 / (column.length - i) - split.ratio;
		if (Math.abs(delta) < 0.01) continue;

		// Resizing a pane moves its nearest divider in the given direction: down grows the upper pane, up shrinks it.
		if (delta > 0) await herdrRequest("pane.resize", { pane_id: column[i], direction: "down", amount: delta });
		else await herdrRequest("pane.resize", { pane_id: column[i + 1], direction: "up", amount: -delta });
		layout = await readPaneLayout(parentPaneId);
	}
}

/**
 * Open a subagent pane running the run directory's launch.sh. The first subagent splits right of the
 * parent pane; later ones split below the lowest sibling. The caller holds the layout lock and registers
 * the new pane before equalizing the column. Returns the pane id.
 */
export async function openSubagentPane(options: {
	parentPaneId: string;
	siblingPaneIds: string[];
	cwd: string;
	env: Record<string, string>;
}): Promise<string> {
	const layout = await readPaneLayout(options.parentPaneId);
	const lowestSibling = subagentColumn(layout, options.siblingPaneIds).at(-1);

	const result = await herdrRequest<{ plugin_pane: { pane: { pane_id: string } } }>("plugin.pane.open", {
		plugin_id: HERDR_PLUGIN_ID,
		entrypoint: HERDR_PANE_ENTRYPOINT,
		placement: "split",
		target_pane_id: lowestSibling?.pane_id ?? options.parentPaneId,
		direction: lowestSibling ? "down" : "right",
		cwd: options.cwd,
		env: options.env,
		focus: false,
	});
	return result.plugin_pane.pane.pane_id;
}

/** Focus a subagent's herdr pane, switching tab or workspace if needed. */
export async function focusSubagentPane(paneId: string): Promise<void> {
	await herdrRequest("plugin.pane.focus", { pane_id: paneId });
}

/** Set the label herdr shows for a pane. */
export async function renameSubagentPane(paneId: string, label: string): Promise<void> {
	await herdrRequest("pane.rename", { pane_id: paneId, label });
}
