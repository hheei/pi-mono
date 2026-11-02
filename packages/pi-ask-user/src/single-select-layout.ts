import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { FREEFORM_HINT, FREEFORM_LABEL } from "./constants";
import { type RowBlock, visibleBlockWindow } from "./option-rows";

export interface QuestionOption {
	title: string;
	description?: string;
}

/** What a rendered row is, so the list styles it without sniffing its text. */
export type OptionRowKind = "option" | "description" | "helper" | "indicator";

export interface AnnotatedRow {
	line: string;
	selected: boolean;
	kind: OptionRowKind;
}

export interface RenderSingleSelectRowsParams {
	options: QuestionOption[];
	selectedIndex: number;
	width: number;
	allowFreeform: boolean;
	maxRows?: number;
}

type RowLine = { text: string; kind: OptionRowKind };

/** Wraps `text` under `prefix`, indenting continuation lines to the same column. */
function wrappedRow(text: string, prefix: string, width: number, kind: OptionRowKind): RowLine[] {
	const indent = " ".repeat(prefix.length);
	return wrapTextWithAnsi(text, Math.max(8, width - prefix.length)).map((line, index) => ({
		text: `${index === 0 ? prefix : indent}${line}`.trimEnd(),
		kind,
	}));
}

type ListItem = { type: "option"; option: QuestionOption; index: number } | { type: "freeform" };

function buildItemBlocks(
	options: QuestionOption[],
	width: number,
	allowFreeform: boolean,
	selectedIndex: number,
): RowBlock<RowLine>[] {
	const normalizedWidth = Math.max(12, width);
	const allItems: ListItem[] = options.map((option, index) => ({
		type: "option",
		option,
		index,
	}));
	if (allowFreeform) allItems.push({ type: "freeform" });

	return allItems.map((item, itemIndex) => {
		const pointer = itemIndex === selectedIndex ? "→" : " ";
		const helperPrefix = `${pointer}   `;

		if (item.type === "freeform") {
			const label = `${FREEFORM_LABEL} — ${FREEFORM_HINT}`;
			return { itemIndex, lines: wrappedRow(label, helperPrefix, normalizedWidth, "helper") };
		}

		const numberPrefix = `${pointer} ${item.index + 1}. `;
		const lines = wrappedRow(item.option.title, numberPrefix, normalizedWidth, "option");
		if (item.option.description) {
			lines.push(...wrappedRow(item.option.description, "      ", normalizedWidth, "description"));
		}
		return { itemIndex, lines };
	});
}

function flatten(blocks: RowBlock<RowLine>[], selectedIndex: number): AnnotatedRow[] {
	return blocks.flatMap((block) =>
		block.lines.map((line) => ({
			line: line.text,
			kind: line.kind,
			selected: block.itemIndex === selectedIndex,
		})),
	);
}

export function renderSingleSelectRows({
	options,
	selectedIndex,
	width,
	allowFreeform,
	maxRows,
}: RenderSingleSelectRowsParams): AnnotatedRow[] {
	const itemCount = options.length + (allowFreeform ? 1 : 0);
	const blocks = buildItemBlocks(options, width, allowFreeform, selectedIndex);
	const allRows = flatten(blocks, selectedIndex);

	if (!Number.isFinite(maxRows) || !maxRows || maxRows <= 0 || allRows.length <= maxRows) {
		return allRows;
	}

	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const window = visibleBlockWindow(blocks, selectedIndex, safeMaxRows);
	const visible = flatten(window, selectedIndex);
	if (window !== blocks && safeMaxRows > 1) {
		visible.push({
			line: `  (${selectedIndex + 1}/${itemCount})`,
			kind: "indicator",
			selected: false,
		});
	}
	return visible.slice(0, safeMaxRows);
}
