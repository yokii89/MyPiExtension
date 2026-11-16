import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import bashJobsExtension from "../index.ts";
import { type ShellExit, spawnShellCommand } from "../infra/shell.ts";

vi.mock("../infra/shell.ts", () => ({ spawnShellCommand: vi.fn(), isProcessAlive: () => false }));

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Actual AgentSession + extension runtime + agent loop. The model is scripted locally and the
// child is controlled, so this needs no credentials/network and makes no external changes.
describe.each(["followUp", "steer"] as const)("AgentSession %s completion delivery", (wakeOnExit) => {
	it.each([true, false])("does not repeat a consumed result (inspect=%s)", async (inspect) => {
		const dir = mkdtempSync(join(tmpdir(), "bash-jobs-sdk-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "bash-jobs.json"),
			JSON.stringify({ wakeOnExit, longGraceSec: 0, wakeCoalesceMs: 0, output: { tee: false } }),
		);
		let finish!: (exit: ShellExit) => void;
		let output: ((chunk: Buffer) => void) | undefined;
		vi.mocked(spawnShellCommand).mockReturnValue({
			pid: undefined,
			exited: new Promise((resolve) => {
				finish = resolve;
			}),
			onData: (listener) => {
				output = listener;
			},
			kill: () => finish({ exitCode: null }),
		});
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const runtime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(dir, "catalog.json"),
			refreshOnCreate: false,
		});
		let calls = 0;
		runtime.registerProvider("wake-test", {
			api: "openai-completions",
			apiKey: "local-test-only",
			baseUrl: "http://localhost.invalid",
			models: [
				{
					id: "scripted",
					name: "Scripted",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 1000,
				},
			],
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const step = ++calls;
				void (async () => {
					if (step === 2) {
						output?.(Buffer.from("validation failed\n"));
						finish({ exitCode: 1 });
						// Let the wake timer expire while a model response is still being produced.
						await wait(30);
					}
					const tool = step === 1 ? "bash" : step === 2 && inspect ? "tool_execution_inspect_output" : undefined;
					const message: AssistantMessage = {
						role: "assistant",
						api: "openai-completions",
						provider: "wake-test",
						model: "scripted",
						content: tool
							? [
									{
										type: "toolCall",
										id: `call-${step}`,
										name: tool,
										arguments: step === 1 ? { command: "probe", mode: "long" } : { job: "J-1" },
									},
								]
							: [{ type: "text", text: "Handled result." }],
						stopReason: tool ? "toolUse" : "stop",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
					stream.end();
				})();
				return stream;
			},
		});
		let api!: ExtensionAPI;
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					api = pi;
					bashJobsExtension(pi);
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			resourceLoader,
			settingsManager,
			modelRuntime: runtime,
			model: runtime.getModel("wake-test", "scripted"),
			thinkingLevel: "off",
			sessionManager: SessionManager.inMemory(dir),
			tools: ["bash", "tool_execution_inspect_output", "bash_job_stop"],
		});
		const errors: unknown[] = [];
		try {
			await session.bindExtensions({ onError: (error) => errors.push(error) });
			expect(api.getAllTools().map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["bash", "tool_execution_inspect_output", "bash_job_stop"]),
			);
			expect(api.getCommands().map((command) => command.name)).toContain("bash-jobs");
			await session.prompt("Run validation and handle its result.");
			await wait(30);
			await session.waitForIdle();
			const notices = session.messages.filter(
				(message) => message.role === "custom" && message.customType === "bash-job",
			);
			expect(errors).toEqual([]);
			expect(notices).toHaveLength(inspect ? 0 : 1);
			expect(calls).toBe(3);
			if (inspect) {
				const result = session.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "tool_execution_inspect_output",
				);
				expect(JSON.stringify(result)).toContain("validation failed");
				expect(JSON.stringify(result)).toContain("exit 1");
			}
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			rmSync(dir, { recursive: true, force: true });
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
		}
	});
});
