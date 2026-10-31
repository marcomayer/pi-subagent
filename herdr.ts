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

type LayoutNode =
	| { type: "pane"; pane_id?: string }
	| { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };

/** Split path as `layout.set_split_ratio` takes it: from the tab root, true steps into `second`. */
type SplitPath = boolean[];

function containsAny(node: LayoutNode, paneIds: Set<string>): boolean {
	if (node.type === "pane") return node.pane_id !== undefined && paneIds.has(node.pane_id);
	return containsAny(node.first, paneIds) || containsAny(node.second, paneIds);
}

/** The subtree that holds every given pane and nothing more specific, with its path. */
function smallestCommonNode(root: LayoutNode, paneIds: Set<string>): { node: LayoutNode; path: SplitPath } {
	let node = root;
	const path: SplitPath = [];
	while (node.type === "split") {
		const inFirst = containsAny(node.first, paneIds);
		const inSecond = containsAny(node.second, paneIds);
		if (inFirst === inSecond) break;
		path.push(inSecond);
		node = inSecond ? node.second : node.first;
	}
	return { node, path };
}

/**
 * Give a parent's subagent column equal heights. Herdr splits are binary, so the column is a chain of
 * down-splits, each one's `second` holding the panes below; split i must give its upper pane 1/(n-i).
 * Ratios are set absolutely, so re-running on an equal column sends no requests.
 */
export async function equalizeSubagentPanes(parentPaneId: string, subagentPaneIds: string[]): Promise<void> {
	const { layout } = await herdrRequest<{ layout: { tab_id: string; root: LayoutNode } }>("layout.export", {
		pane_id: parentPaneId,
	});
	const column = smallestCommonNode(layout.root, new Set(subagentPaneIds));
	// A rearranged tab can put the parent inside that subtree; never resize the parent's own pane.
	if (containsAny(column.node, new Set([parentPaneId]))) return;

	const chain: { path: SplitPath; ratio: number }[] = [];
	let node = column.node;
	const path = [...column.path];
	while (node.type === "split" && node.direction === "down") {
		chain.push({ path: [...path], ratio: node.ratio });
		path.push(true);
		node = node.second;
	}

	for (const [i, split] of chain.entries()) {
		const ratio = 1 / (chain.length + 1 - i);
		if (Math.abs(split.ratio - ratio) < 0.01) continue;
		await herdrRequest("layout.set_split_ratio", { tab_id: layout.tab_id, path: split.path, ratio });
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

/** Set the label herdr shows for a pane, keeping subagents visibly distinct. */
export async function renameSubagentPane(paneId: string, label: string): Promise<void> {
	await herdrRequest("pane.rename", { pane_id: paneId, label: `subagent: ${label}` });
}
