/**
 * Minimal newline-delimited JSON-RPC client for a stdio MCP server.
 *
 * Kept dependency-free on purpose: pi loads extensions through jiti and this
 * client must not rely on the project's node_modules being resolvable.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface McpCallResult {
	content?: McpContent[];
	isError?: boolean;
	structuredContent?: unknown;
}

export interface StdioMcpClientOptions {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	startTimeoutMs?: number;
	callTimeoutMs?: number;
	/** Optional sink for the server's stderr (defaults to debug-gated console.error). */
	onStderr?: (line: string) => void;
}

export class StdioMcpClient {
	private child: ChildProcess | undefined;
	private stdout = "";
	private stderr: string[] = [];
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private starting: Promise<void> | undefined;

	private readonly options: StdioMcpClientOptions;

	constructor(options: StdioMcpClientOptions) {
		this.options = options;
	}

	private get startTimeoutMs(): number {
		return this.options.startTimeoutMs ?? 60_000;
	}

	private get callTimeoutMs(): number {
		return this.options.callTimeoutMs ?? 120_000;
	}

	private log(line: string): void {
		this.stderr.push(line);
		if (this.stderr.length > 60) this.stderr.shift();
		this.options.onStderr?.(line);
	}

	private lastStderr(): string {
		return this.stderr.slice(-8).join("\n");
	}

	async start(): Promise<void> {
		if (this.starting) return this.starting;
		this.starting = this.doStart().catch((error) => {
			this.starting = undefined; // allow a retry on the next call
			void this.stop();
			throw error;
		});
		return this.starting;
	}

	private async doStart(): Promise<void> {
		const child = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.log(line);
		});
		child.on("error", (error) => this.log(`[spawn error] ${error.message}`));
		child.on("exit", (code, signal) => {
			this.starting = undefined;
			this.child = undefined;
			const reason = new Error(`MCP server exited (code=${code ?? "null"} signal=${signal ?? "null"})\n${this.lastStderr()}`);
			for (const [, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(reason);
			}
			this.pending.clear();
		});

		await this.request(
			"initialize",
			{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-rimuimcp-bridge", version: "1.0.0" } },
			this.startTimeoutMs,
		);
		this.notify("notifications/initialized", {});
	}

	private onStdout(chunk: string): void {
		this.stdout += chunk;
		let index: number;
		while ((index = this.stdout.indexOf("\n")) >= 0) {
			const line = this.stdout.slice(0, index).trim();
			this.stdout = this.stdout.slice(index + 1);
			if (!line) continue;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				this.log(`[non-json stdout] ${line.slice(0, 400)}`);
				continue;
			}
			if (message.id !== undefined && this.pending.has(message.id)) {
				const pending = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error(`${message.error.message ?? "MCP error"} (code ${message.error.code ?? "?"})`));
				else pending.resolve(message.result);
			} else if (message.method) {
				this.log(`[notification] ${message.method}`);
			}
		}
	}

	private write(payload: unknown): void {
		if (!this.child?.stdin?.writable) throw new Error("MCP server is not running");
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private request(method: string, params: unknown, timeoutMs = this.callTimeoutMs): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error as Error);
			}
		});
	}

	async listTools(): Promise<McpTool[]> {
		await this.start();
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.request("tools/list", cursor ? { cursor } : {}, this.startTimeoutMs);
			tools.push(...(result?.tools ?? []));
			cursor = result?.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
		await this.start();
		const id = this.nextId;
		const onAbort = () => {
			try {
				this.notify("notifications/cancelled", { requestId: id, reason: "aborted by user" });
			} catch {}
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(new Error("cancelled"));
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return (await this.request("tools/call", { name, arguments: args ?? {} })) as McpCallResult;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	get running(): boolean {
		return Boolean(this.child);
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.starting = undefined;
		if (!child?.pid) return;
		this.child = undefined;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error("MCP server stopped"));
		}
		this.pending.clear();
		try {
			child.stdin?.end();
		} catch {}
		if (process.platform === "win32") {
			// node -> (possible) grandchildren: kill the whole tree by pid.
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
		} else {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
		}
	}
}
