/**
 * rimUIMCP bridge for pi.
 *
 * pi has no built-in MCP client, so this extension spawns the project's own MCP
 * server (`apps/mcp/src/main.ts`) as a child process, speaks JSON-RPC over stdio,
 * and re-registers its tools as native pi tools.
 *
 * On top of the generic `rimuimcp_call` passthrough it registers a small set of
 * curated `rimworld_*` tools for the common read/control methods, so the model
 * does not have to remember raw method names.
 *
 * Preconditions: the game and the local runtime must already be running
 * (`./scripts/launch.ps1 start -Visible`). The MCP server itself connects lazily,
 * so a missing runtime surfaces as a tool error rather than a startup failure.
 *
 * Env knobs:
 *   PI_RIMUIMCP_MCP_ENTRY            MCP server entry (default: apps/mcp/src/main.ts)
 *   PI_RIMUIMCP_CONFIG               runtime config file (default: work/runtime.json)
 *   PI_RIMUIMCP_MCP_START_TIMEOUT_MS default 60000
 *   PI_RIMUIMCP_MCP_CALL_TIMEOUT_MS  default 120000
 *   PI_RIMUIMCP_MCP_DEBUG=1          log the MCP server's stderr
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StdioMcpClient, type McpCallResult, type McpContent, type McpTool } from "./mcp-client.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .pi/extensions/rimuimcp -> .pi/extensions -> .pi -> repository root
const PROJECT_ROOT = path.resolve(HERE, "..", "..", "..");

const ENTRY = process.env.PI_RIMUIMCP_MCP_ENTRY ?? path.join(PROJECT_ROOT, "apps", "mcp", "src", "main.ts");
const CONFIG = process.env.PI_RIMUIMCP_CONFIG ?? path.join(PROJECT_ROOT, "work", "runtime.json");
const DEBUG = process.env.PI_RIMUIMCP_MCP_DEBUG === "1";
const START_TIMEOUT_MS = Number(process.env.PI_RIMUIMCP_MCP_START_TIMEOUT_MS ?? 60_000);
const CALL_TIMEOUT_MS = Number(process.env.PI_RIMUIMCP_MCP_CALL_TIMEOUT_MS ?? 120_000);

const GUIDELINES = [
	"Start with rimworld_status (or rimworld_roots) to confirm the game is loaded before reading or acting.",
	"Read pawn/thing ids from rimworld_pawns and coordinates from rimworld_map / rimworld_pawns; references are session- and world-version-bound and must be re-queried after loading a save.",
	"Collection reads may paginate: check total/nextCursor instead of assuming one page is the whole map.",
	"Prefer the curated rimworld_* tools; fall back to rimuimcp_call for any method without a wrapper.",
];

interface CuratedTool {
	name: string;
	label: string;
	snippet: string;
	description: string;
	method: string;
	parameters: unknown;
	defaults?: Record<string, unknown>;
}

function opt<T>(schema: T): T {
	return Type.Optional(schema as any) as T;
}

function curated(
	name: string,
	label: string,
	method: string,
	snippet: string,
	description: string,
	parameters: unknown,
	defaults?: Record<string, unknown>,
): CuratedTool {
	return { name, label: `RimWorld: ${label}`, method, snippet, description, parameters, defaults };
}

const CURATED: CuratedTool[] = [
	curated("rimworld_status", "status", "session.status", "RimWorld connection/session status (gameLoaded, mapLoaded, tick)", "Report the session status: connection health, gameLoaded, mapLoaded, programState, gameTick and current map.", Type.Object({})),
	curated("rimworld_roots", "roots", "state.roots", "List RimWorld state roots and available collections", "List the state roots (game, currentMap, world, research, ui, selection, designator) and the collection/def type names that can be queried.", Type.Object({})),
	curated("rimworld_pawns", "pawns", "state.pawns", "Read pawns/colonists on the current map", "Read pawns on the current map (paginated). Inspect total and nextCursor; results are under data.items.", Type.Object({ budgetMs: opt(Type.Number()), limit: opt(Type.Number()), cursor: opt(Type.String()) })),
	curated("rimworld_map", "map", "state.map", "Read current map summary (size, biome, counts)", "Read the current map summary: id, width, height, biome, thing/building counts.", Type.Object({})),
	curated("rimworld_ui_snapshot", "ui snapshot", "ui.snapshot", "Snapshot currently visible UI controls", "Snapshot the currently visible UI controls so they can be located and activated by later actions.", Type.Object({ surface: opt(Type.String()) })),
	curated("rimworld_screenshot", "screenshot", "ui.screenshot", "Screenshot the game screen (returns an image)", "Capture the game screen and return it as an image you can look at.", Type.Object({ name: opt(Type.String()) })),
	curated("rimworld_pause", "pause/resume", "runtime.pause", "Pause or resume the simulation", "Pause (default) or resume the simulation.", Type.Object({ paused: opt(Type.Boolean()) }), { paused: true }),
	curated("rimworld_advance", "advance ticks", "runtime.advance", "Advance the simulation by N ticks", "Advance the simulation by a number of ticks.", Type.Object({ ticks: Type.Number() })),
	curated("rimworld_select_pawn", "select pawn", "ui.select", "Select a pawn by id", "Select a pawn by id (from rimworld_pawns).", Type.Object({ pawnId: Type.String() })),
	curated("rimworld_map_click", "map click", "map.click", "Click a map cell by tile coordinates", "Click a map cell at tile coordinates x/z (from rimworld_pawns or rimworld_map).", Type.Object({ x: Type.Number(), z: Type.Number() })),
];

const GENERIC_SNIPPET = "Call any rimUIMCP method directly (method + args); escape hatch for methods without a curated wrapper";

function toPiContent(result: McpCallResult) {
	const content: Array<Record<string, unknown>> = [];
	for (const item of result.content ?? []) {
		const typed = item as McpContent;
		if (typed.type === "text" && typeof typed.text === "string") {
			content.push({ type: "text", text: typed.text });
		} else if (typed.type === "image" && typed.data) {
			content.push({ type: "image", source: { type: "base64", mediaType: typed.mimeType || "image/png", data: typed.data } });
		} else if (typed.type === "resource" && typed.text) {
			content.push({ type: "text", text: typed.text });
		} else {
			content.push({ type: "text", text: `[unsupported content: ${typed.type}]` });
		}
	}
	if (content.length === 0) {
		content.push({
			type: "text",
			text: result.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : "(no content)",
		});
	}
	return content as any;
}

export default function rimuimcpExtension(pi: ExtensionAPI) {
	const client = new StdioMcpClient({
		command: process.execPath,
		args: [ENTRY],
		env: { ...process.env, RIMUIMCP_CONFIG: CONFIG },
		startTimeoutMs: START_TIMEOUT_MS,
		callTimeoutMs: CALL_TIMEOUT_MS,
		onStderr: DEBUG ? (line) => console.error("[rimuimcp-mcp]", line) : undefined,
	});
	const registered = new Set<string>();
	let status: "idle" | "connecting" | "ready" | "error" = "idle";
	let lastError: string | undefined;

	async function callMethod(method: string, args: Record<string, unknown>, signal?: AbortSignal) {
		return client.callTool("rimuimcp_call", { method, args, timeoutMs: CALL_TIMEOUT_MS }, signal);
	}

	async function runTool(tool: CuratedTool, params: Record<string, unknown>, signal?: AbortSignal) {
		const args = { ...(tool.defaults ?? {}), ...params };
		try {
			const result = await callMethod(tool.method, args, signal);
			return { content: toPiContent(result), details: { tool: tool.name, method: tool.method }, ...(result.isError ? { isError: true } : {}) } as any;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "cancelled") return { content: [{ type: "text", text: "Cancelled." }], details: { tool: tool.name } } as any;
			return { content: [{ type: "text", text: `${tool.name} failed: ${message}` }], details: { tool: tool.name }, isError: true } as any;
		}
	}

	function registerCurated() {
		for (const tool of CURATED) {
			if (registered.has(tool.name)) continue;
			registered.add(tool.name);
			pi.registerTool({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				promptSnippet: tool.snippet,
				promptGuidelines: GUIDELINES,
				parameters: tool.parameters as any,
				async execute(_toolCallId, params, signal) {
					return runTool(tool, (params ?? {}) as Record<string, unknown>, signal);
				},
			});
		}
	}

	async function registerMcpTools(): Promise<McpTool[]> {
		const tools = await client.listTools();
		const existing = new Set(pi.getAllTools().map((t) => t.name));
		const usable = tools.filter((tool) => tool.name && /^[a-z0-9_]+$/.test(tool.name));
		for (const tool of usable) {
			if (existing.has(tool.name) || registered.has(tool.name)) continue; // never clobber a built-in or curated tool
			registered.add(tool.name);
			pi.registerTool({
				name: tool.name,
				label: "RimWorld: call",
				description: tool.description ?? `rimUIMCP MCP tool ${tool.name}`,
				promptSnippet: GENERIC_SNIPPET,
				promptGuidelines: GUIDELINES,
				parameters: Type.Unsafe<Record<string, unknown>>((tool.inputSchema as any) ?? { type: "object", properties: {} }),
				async execute(_toolCallId, params, signal) {
					try {
						const result = await client.callTool(tool.name, params ?? {}, signal);
						return { content: toPiContent(result), details: { tool: tool.name }, ...(result.isError ? { isError: true } : {}) } as any;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (message === "cancelled") return { content: [{ type: "text", text: "Cancelled." }], details: { tool: tool.name } } as any;
						return { content: [{ type: "text", text: `${tool.name} failed: ${message}` }], details: { tool: tool.name }, isError: true } as any;
					}
				},
			});
		}
		return usable;
	}

	function setStatus(ctx: ExtensionContext, value: string | undefined) {
		try {
			ctx.ui.setStatus("rimuimcp", value);
		} catch {}
	}

	async function bringUp(ctx: ExtensionContext, notify: boolean) {
		status = "connecting";
		setStatus(ctx, "rimuimcp: starting…");
		try {
			registerCurated();
			const tools = await registerMcpTools();
			status = "ready";
			setStatus(ctx, "rimuimcp: ready");
			if (notify) ctx.ui.notify(`rimUIMCP MCP ready (${tools.length} server tool(s) + ${CURATED.length} curated).`, "info");
		} catch (error) {
			status = "error";
			lastError = error instanceof Error ? error.message : String(error);
			setStatus(ctx, "rimuimcp: error");
			if (notify) ctx.ui.notify(`rimUIMCP MCP failed to start: ${lastError}`, "error");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await bringUp(ctx, true);
	});

	pi.on("session_shutdown", async () => {
		await client.stop();
	});

	pi.registerCommand("rimuimcp", {
		description: "rimUIMCP MCP status / reconnect / stop",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "stop" || action === "restart" || action === "reconnect") {
				await client.stop();
				registered.clear();
				status = "idle";
				setStatus(ctx, undefined);
				if (action === "stop") {
					ctx.ui.notify("rimUIMCP MCP stopped.", "info");
					return;
				}
			}
			if (action === "restart" || action === "reconnect" || status !== "ready") {
				await bringUp(ctx, false);
				ctx.ui.notify(
					status === "ready"
						? `rimUIMCP MCP running (${registered.size} tools registered).`
						: `rimUIMCP MCP error: ${lastError ?? "unknown"}`,
					status === "ready" ? "info" : "error",
				);
				return;
			}
			ctx.ui.notify(
				`rimUIMCP MCP: ${status}${client.running ? " (process alive)" : ""}, ${registered.size} tools.\nEntry: ${ENTRY}\nConfig: ${CONFIG}${lastError ? `\nLast error: ${lastError}` : ""}`,
				"info",
			);
		},
	});
}
