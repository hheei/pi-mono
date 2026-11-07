/**
 * Transforms plain agent and background task identifiers (e.g. `agent-3f9a1c`, `bash-3f9a1c`)
 * in Markdown prose by wrapping them in inline code backticks, making them visually
 * distinct in terminal TUI rendering.
 *
 * Preserves text inside code blocks, inline code, and URLs intact.
 */
const IDENTIFIER = /(?:agent-[0-9a-f]{6}|bash-[0-9a-f]{6})/;
/** Word boundary: the id is not part of a longer word or a markdown link URL. */
const PROSE_IDENTIFIER = /(?<![`/\w])((?:agent-[0-9a-f]{6}|bash-[0-9a-f]{6}))(?![`\w])/gu;

export function transformSubagentsMarkdown(markdown: string): string {
	if (!IDENTIFIER.test(markdown)) return markdown;
	// The split captures code blocks and inline code, so odd indexes are the parts to leave alone.
	return markdown
		.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
		.map((part, index) => (index % 2 === 1 ? part : part.replace(PROSE_IDENTIFIER, "`$1`")))
		.join("");
}
