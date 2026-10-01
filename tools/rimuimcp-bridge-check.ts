/**
 * Smoke test for the pi <-> rimUIMCP MCP bridge.
 *
 * Reuses the exact stdio client the pi extension uses (`.pi/extensions/rimuimcp/mcp-client.ts`)
 * to spawn `apps/mcp/src/main.ts`, list its tools, and make a couple of real calls.
 *
 * Requires the game + local runtime to be running:
 *   ./scripts/launch.ps1 start -Visible
 *   node tools/rimuimcp-bridge-check.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../.pi/extensions/rimuimcp/mcp-client.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = process.env.PI_RIMUIMCP_MCP_ENTRY ?? path.join(ROOT, "apps", "mcp", "src", "main.ts");
const CONFIG = process.env.PI_RIMUIMCP_CONFIG ?? path.join(ROOT, "work", "runtime.json");

function preview(result: { content?: Array<{ text?: string }> }): string {
	const text = result.content?.[0]?.text ?? "";
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

const client = new StdioMcpClient({
	command: process.execPath,
	args: [ENTRY],
	env: { ...process.env, RIMUIMCP_CONFIG: CONFIG },
	startTimeoutMs: 60_000,
	callTimeoutMs: 60_000,
	onStderr: (line) => console.error(`[server] ${line}`),
});

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
}

try {
	const tools = await client.listTools();
	check("tools/list returns rimuimcp_call", tools.some((t) => t.name === "rimuimcp_call"), tools.map((t) => t.name).join(", "));

	const status = await client.callTool("rimuimcp_call", { method: "session.status", args: {} });
	check("session.status succeeds", !status.isError, preview(status));

	const parsed = JSON.parse(status.content?.[0]?.text ?? "{}");
	check("session.status gameLoaded", parsed.data?.gameLoaded === true, `gameLoaded=${parsed.data?.gameLoaded} mapLoaded=${parsed.data?.mapLoaded}`);

	const pawns = await client.callTool("rimuimcp_call", { method: "state.pawns", args: { budgetMs: 300 } });
	const pawnData = JSON.parse(pawns.content?.[0]?.text ?? "{}").data ?? {};
	check("state.pawns returns items", Array.isArray(pawnData.items), `total=${pawnData.total} count=${pawnData.items?.length}`);
} catch (error) {
	failures += 1;
	console.error("bridge check crashed:", error instanceof Error ? error.message : String(error));
} finally {
	await client.stop();
}

console.log(failures === 0 ? "\nbridge check: PASS" : `\nbridge check: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
