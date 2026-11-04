import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

export async function editWithExternalEditor(tui: TUI, currentText: string): Promise<string> {
	const editorCmd =
		process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
	const tempDir = mkdtempSync(join(tmpdir(), "pi-ask-user-"));
	const tempFile = join(tempDir, "response.md");
	try {
		writeFileSync(tempFile, currentText, "utf8");
		tui.stop();
		process.stdout.write(`\nLaunching external editor: ${editorCmd}\n`);
		const [cmd, ...args] = editorCmd.split(" ");
		await new Promise<void>((resolve, reject) => {
			const child = spawn(cmd ?? "vi", [...args, tempFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Editor exited with ${code ?? "unknown"}`));
			});
			child.on("error", reject);
		});
		return readFileSync(tempFile, "utf8").replace(/\r?\n$/, "");
	} finally {
		tui.start();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
}
