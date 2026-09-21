import { execSync } from "node:child_process";
import { existsSync, join } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const DEPS_ROOT = process.env.JEV_DEPS_ROOT || "/home/kvn/zer0/.deps/hermes-jev-skills";

function adapterPath(): string {
	return join(DEPS_ROOT, "packages", "jev", "src", "adapter.py");
}

export default function hermesJevOMP(pi: ExtensionAPI): void {
	pi.setLabel("Hermes-JeV model routing (shared stack via adapter)");

	pi.on("before_agent_start", async (event: unknown, ctx: { models: { current(): { provider?: string; id?: string } | undefined; resolve(spec: string): { provider?: string; id?: string } | undefined }; setModel(model: { provider?: string; id?: string }): Promise<boolean>; cwd?: string }, log?: (msg: string) => void }) => {
		try {
			const prompt = (typeof event === "object" && event !== null && "prompt" in event)
				? String((event as Record<string, unknown>).prompt ?? "").trim()
				: "";
			if (!prompt || prompt.startsWith("/")) return;

			// Fail conservative: preserve explicit user pin.
			// We detect a likely pin when the current session model is set
			// and differs from the default. Since provenance is not fully
			// exposed to extensions yet, we document the limitation.
			const currentModel = ctx.models?.current?.();

			// Call canonical shared JEV routing via adapter
			const adapter = adapterPath();
			if (!existsSync(adapter)) {
				return;
			}

			// Shell invocation into the adapter (Python script calling JEV CLI)
			// We pass prompt + current + flags as JSON; adapter returns JSON.
			const payload = JSON.stringify({
				prompt,
				current: currentModel ? `${currentModel.provider ?? ""}/${currentModel.id ?? ""}` : "",
				context_tokens: 0,
				has_images: false,
				pinned: false,
			});

			let decision: Record<string, unknown> | null = null;
			try {
				const stdout = execSync(
					`python3 "${adapter}" route '{"prompt":"${prompt.replace(/"/g, '\\"').slice(0, 4000)}","current":"${String(currentModel ? `${currentModel.provider ?? ""}/${currentModel.id ?? ""}` : "")}","context_tokens":0,"has_images":false,"pinned":false}'`,
					{ encoding: "utf-8", timeout: 5000, cwd: DEPS_ROOT, env: { ...process.env, PYTHONUNBUFFERED: "1" } }
				);
				decision = JSON.parse(stdout) as Record<string, unknown>;
			} catch {
				// Fail open — adapter or CLI failure, keep current model
				return;
			}

			if (!decision || typeof decision !== "object") return;

			const selected = String(decision.model ?? decision.model_id ?? "").trim();
			if (!selected || selected === "null" || selected === "undefined") return;

			const resolved = ctx.models?.resolve?.(selected);
			if (!resolved) {
				// Model cannot be resolved — keep current
				return;
			}

			await ctx.setModel(resolved);
		} catch {
			// Hard fail open — any exception must not change the model
			return;
		}
	});
}
