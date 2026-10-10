/**
 * Desktop (PiDesk) view path for ask_user_question.
 *
 * Uses the extension View protocol via @pidesk/view-sdk. When PiDesk injects
 * PIDESK_VIEW_* / PI_VIEW_* into the pi process, this module presents a
 * floating widget above the task composer (same family as the @-mention menu)
 * instead of the terminal TUI overlay or a modal.
 *
 * Multi-question dialogs render one `tabs` node: one tab per question plus a
 * final review tab (per-question answer summary + jump-back buttons). A single
 * question keeps the flat card column (no tab bar). Host owns local tab
 * switching (click / ←→); the extension takes over only via `activeTab` in the
 * echoed spec — auto-advance fires on a single-select question's
 * unanswered→answered transition, targeting the next unanswered question (or
 * the review tab). Tab switching is view state and never enters form values.
 *
 * Footer actions: 取消（两段式——已有作答/备注时先布防确认）/ 提交（允许部分
 * 作答，未答题在复核页以 ⚠ 标记并可一键跳回，对齐 TUI 的 Submit 页）。
 */

import {
	connectDesktopView,
	type DesktopViewClient,
	type LiveViewSession,
	type ViewAction,
	type ViewEvent,
	type ViewNode,
	type ViewResult,
	type ViewSpec,
	type ViewTab,
} from "@pidesk/view-sdk";
import { LABELS_BY_KIND } from "./state/row-intent.ts";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./tool/types.ts";

/** Longest preview slice shown in the desktop pane before truncation. */
const MAX_PREVIEW_CHARS = 4000;

const TABS_NODE_ID = "questionnaire-tabs";
const REVIEW_TAB_ID = "review";
const GOTO_ACTION_RE = /^goto:(review|[0-9]+)$/;

export interface DesktopViewDeps {
	connect?: typeof connectDesktopView;
}

function optionValue(questionIndex: number, optionIndex: number): string {
	return `opt:${questionIndex}:${optionIndex}`;
}

function customId(questionIndex: number): string {
	return `q${questionIndex}-custom`;
}

function notesId(questionIndex: number): string {
	return `q${questionIndex}-notes`;
}

function listId(questionIndex: number): string {
	return `q${questionIndex}`;
}

function questionTabId(questionIndex: number): string {
	return `q${questionIndex}`;
}

function gotoQuestionAction(questionIndex: number): string {
	return `goto:${questionIndex}`;
}

function gotoReviewAction(): string {
	return `goto:${REVIEW_TAB_ID}`;
}

/** "goto:<i>" / "goto:review" → 跳转目标；其它 actionId 返回 null。 */
function parseGotoAction(actionId: string): { review: boolean; questionIndex: number } | null {
	const m = GOTO_ACTION_RE.exec(actionId);
	if (!m) return null;
	if (m[1] === REVIEW_TAB_ID) return { review: true, questionIndex: -1 };
	return { review: false, questionIndex: Number(m[1]) };
}

function hasAnyPreview(question: QuestionData): boolean {
	return question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
}

interface UiState {
	/** list values per question (option value keys or [] for multi) */
	selections: (string | string[])[];
	customTexts: string[];
	notes: string[];
	/** focused option index for preview, per question */
	focused: number[];
	/** 激活页签：`q<i>` 或 "review"（仅多题 tabs 布局使用） */
	activeTab: string;
	/** 两段式取消：已布防时，下一次「取消」动作才真正关闭 */
	cancelArmed: boolean;
}

function initialState(params: QuestionParams): UiState {
	return {
		selections: params.questions.map((q) => (q.multiSelect ? [] : "")),
		customTexts: params.questions.map(() => ""),
		notes: params.questions.map(() => ""),
		focused: params.questions.map(() => 0),
		activeTab: questionTabId(0),
		cancelArmed: false,
	};
}

function buildPreviewMarkdown(question: QuestionData, focusIndex: number): string {
	const focused = question.options[focusIndex];
	if (!focused) {
		const withPreview = question.options.find((o) => o.preview);
		if (!withPreview) return "";
		return withPreview.preview?.slice(0, MAX_PREVIEW_CHARS) ?? "";
	}
	const body = focused.preview?.slice(0, MAX_PREVIEW_CHARS);
	if (!body) {
		return `**${focused.label}**\n\n${focused.description}`;
	}
	return `**${focused.label}**\n\n${body}`;
}

/** 该题是否已有答案：选项（含多选）或自定义文本任一非空。 */
function isQuestionAnswered(state: UiState, index: number): boolean {
	const selection = state.selections[index];
	if (Array.isArray(selection)) {
		if (selection.length > 0) return true;
	} else if (typeof selection === "string" && selection.length > 0) {
		return true;
	}
	return (state.customTexts[index] ?? "").trim().length > 0;
}

function nextUnansweredAfter(params: QuestionParams, state: UiState, index: number): number | null {
	for (let j = index + 1; j < params.questions.length; j++) {
		if (!isQuestionAnswered(state, j)) return j;
	}
	return null;
}

function hasAnyWork(params: QuestionParams, state: UiState): boolean {
	return params.questions.some((_, i) => isQuestionAnswered(state, i) || (state.notes[i] ?? "").trim().length > 0);
}

/** 单题卡片的内容节点（不含 card 外壳；tabs 布局与单题布局共用）。 */
function buildQuestionChildren(
	question: QuestionData,
	index: number,
	state: UiState,
	tabsMode: boolean,
	total: number,
): ViewNode[] {
	const items = question.options.map((o, oi) => ({
		value: optionValue(index, oi),
		label: o.label,
		description: o.description,
	}));
	const showPreview = hasAnyPreview(question);
	const selection = state.selections[index];
	const preview = showPreview
		? {
				type: "markdown" as const,
				content: buildPreviewMarkdown(question, state.focused[index] ?? 0),
			}
		: null;

	const listNode: ViewNode = {
		type: "list",
		id: listId(index),
		items,
		multiple: question.multiSelect === true,
		value: selection,
	};

	const customNode: ViewNode = {
		type: "input",
		id: customId(index),
		label: LABELS_BY_KIND.other,
		placeholder: "没有合适选项时在此输入…",
		value: state.customTexts[index] ?? "",
	};

	const notesNode: ViewNode = {
		type: "input",
		id: notesId(index),
		label: "备注（可选）",
		placeholder: "补充说明，会随答案返回",
		value: state.notes[index] ?? "",
	};

	const children: ViewNode[] = [
		{
			type: "text",
			content: question.question,
			// card 内用 body 而非 heading：heading 在紧凑浮层里层级过重
			variant: "body",
		},
		...(question.multiSelect ? [{ type: "text" as const, content: "可多选", variant: "caption" as const }] : []),
	];

	if (showPreview) {
		children.push(
			{
				type: "row",
				gap: 16,
				children: [
					{ type: "column", gap: 8, children: [listNode, customNode] },
					{
						type: "column",
						gap: 8,
						children: [preview ?? { type: "text", content: "", variant: "caption" }],
					},
				],
			},
			notesNode,
		);
	} else {
		children.push(listNode, customNode, notesNode);
	}

	// 多选题不自动前进（勾选≠确认）：tabs 布局下提供显式「下一题」，
	// 对齐 TUI 的 Next 哨兵行。单题布局无「下一题」可言（footer 提交）。
	if (tabsMode && question.multiSelect === true) {
		children.push(
			index + 1 < total
				? { type: "button", id: gotoQuestionAction(index + 1), label: "下一题 →", variant: "ghost" }
				: { type: "button", id: gotoReviewAction(), label: "完成，去复核 →", variant: "ghost" },
		);
	}

	return children;
}

/** 单题布局（1 个问题）：卡片纵向堆叠，无 tab 条、无复核页。 */
function buildQuestionNode(question: QuestionData, index: number, state: UiState): ViewNode {
	return {
		type: "card",
		title: question.header || `问题 ${index + 1}`,
		children: buildQuestionChildren(question, index, state, false, 1),
	};
}

function answerSummary(question: QuestionData, state: UiState, index: number): string {
	const custom = (state.customTexts[index] ?? "").trim();
	if (custom.length > 0) return custom;
	const selection = state.selections[index];
	if (Array.isArray(selection)) {
		const labels: string[] = [];
		for (const value of selection) {
			const parsed = parseOptionValue(value);
			const label = parsed ? question.options[parsed.optionIndex]?.label : undefined;
			if (typeof label === "string") labels.push(label);
		}
		return labels.join("、");
	}
	if (typeof selection === "string" && selection.length > 0) {
		const parsed = parseOptionValue(selection);
		const label = parsed ? question.options[parsed.optionIndex]?.label : undefined;
		return typeof label === "string" ? label : "";
	}
	return "";
}

/** 复核页：每题一行「题头：答案」+ 跳回按钮；未作答标 ⚠。允许部分作答。 */
function buildReviewChildren(params: QuestionParams, state: UiState): ViewNode[] {
	const rows: ViewNode[] = params.questions.map((q, i) => {
		const header = q.header || `问题 ${i + 1}`;
		const summary = answerSummary(q, state, i);
		return {
			type: "row",
			gap: 8,
			children: [
				{
					type: "text",
					content: summary ? `${header}：${summary}` : `⚠ ${header}：未作答`,
					variant: "body",
				},
				{ type: "button", id: gotoQuestionAction(i), label: "修改", variant: "ghost" },
			],
		};
	});
	return [
		{
			type: "text",
			content: "提交后以下答案将返回给模型；标 ⚠ 的题目可点「修改」返回补答。",
			variant: "caption",
		},
		...rows,
	];
}

function buildTree(params: QuestionParams, state: UiState): ViewNode {
	if (params.questions.length <= 1) {
		return {
			type: "column",
			gap: 16,
			children: params.questions.map((q, i) => buildQuestionNode(q, i, state)),
		};
	}

	// 多题：一题一页签 + 复核页；chip 状态 = 已答 ✓ / 未答空心点，复核页
	// 全答完 ✓、有缺 ⚠。所有页签的 children 始终在树里（值不因切页丢失）。
	const tabs: ViewTab[] = params.questions.map((q, i) => ({
		id: questionTabId(i),
		label: q.header || `问题 ${i + 1}`,
		...(isQuestionAnswered(state, i) ? { status: "answered" as const } : {}),
		children: buildQuestionChildren(q, i, state, true, params.questions.length),
	}));
	tabs.push({
		id: REVIEW_TAB_ID,
		label: "复核",
		...(params.questions.every((_, i) => isQuestionAnswered(state, i))
			? { status: "answered" as const }
			: { status: "attention" as const }),
		children: buildReviewChildren(params, state),
	});
	return { type: "tabs", id: TABS_NODE_ID, tabs, activeTab: state.activeTab };
}

function buildActions(state: UiState): ViewAction[] {
	return [
		{
			id: "cancel",
			label: state.cancelArmed ? "再按一次确认取消" : "取消",
			kind: "submit",
			variant: state.cancelArmed ? "danger" : "ghost",
		},
		{ id: "submit", label: "提交", kind: "submit", variant: "primary" },
	];
}

function buildSpec(params: QuestionParams, state: UiState): ViewSpec {
	return {
		title: "回答问题",
		// 贴输入栏上方的浮层（对齐 @ 菜单）；Host 不支持 widget 时直接 error 而不是 modal，
		// 避免问卷被塞进居中模态、与「输入栏上方」的产品意图偏离。
		placement: "widget",
		placementRequired: true,
		placementHint: { side: "aboveEditor", floating: true },
		root: buildTree(params, state),
		actions: buildActions(state),
	};
}

function parseOptionValue(value: string): { questionIndex: number; optionIndex: number } | null {
	const m = /^opt:(\d+):(\d+)$/.exec(value);
	if (!m) return null;
	return { questionIndex: Number(m[1]), optionIndex: Number(m[2]) };
}

/** change 涉及的题号；不属于任何题控件时返回 null。 */
function questionIndexForNode(params: QuestionParams, nodeId: string): number | null {
	for (let i = 0; i < params.questions.length; i++) {
		if (nodeId === listId(i) || nodeId === customId(i) || nodeId === notesId(i)) return i;
	}
	return null;
}

function applyChange(state: UiState, params: QuestionParams, event: Extract<ViewEvent, { type: "change" }>): void {
	const { nodeId, value } = event;
	for (let i = 0; i < params.questions.length; i++) {
		if (nodeId === listId(i)) {
			if (params.questions[i].multiSelect) {
				const arr = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
				state.selections[i] = arr;
				const first = arr[0];
				const parsed = first ? parseOptionValue(first) : null;
				if (parsed) state.focused[i] = parsed.optionIndex;
			} else {
				const str = typeof value === "string" ? value : "";
				state.selections[i] = str;
				const parsed = parseOptionValue(str);
				if (parsed) state.focused[i] = parsed.optionIndex;
			}
			return;
		}
		if (nodeId === customId(i)) {
			state.customTexts[i] = typeof value === "string" ? value : "";
			return;
		}
		if (nodeId === notesId(i)) {
			state.notes[i] = typeof value === "string" ? value : "";
			return;
		}
	}
}

function buildAnswers(params: QuestionParams, values: Record<string, unknown>): QuestionAnswer[] {
	const answers: QuestionAnswer[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const q = params.questions[i];
		const customRaw = values[customId(i)];
		const custom = typeof customRaw === "string" ? customRaw.trim() : "";
		const notesRaw = values[notesId(i)];
		const notes = typeof notesRaw === "string" && notesRaw.trim().length > 0 ? notesRaw.trim() : undefined;

		if (custom.length > 0) {
			answers.push({
				questionIndex: i,
				question: q.question,
				kind: "custom",
				answer: custom,
				notes,
			});
			continue;
		}

		if (q.multiSelect) {
			const raw = values[listId(i)];
			const selectedValues = Array.isArray(raw)
				? raw.filter((v): v is string => typeof v === "string")
				: typeof raw === "string" && raw
					? [raw]
					: [];
			const selected: string[] = [];
			for (const v of selectedValues) {
				const parsed = parseOptionValue(v);
				if (parsed && q.options[parsed.optionIndex]) {
					selected.push(q.options[parsed.optionIndex].label);
				}
			}
			if (selected.length === 0) continue;
			answers.push({
				questionIndex: i,
				question: q.question,
				kind: "multi",
				answer: null,
				selected,
				notes,
			});
			continue;
		}

		const raw = values[listId(i)];
		const selectedValue = typeof raw === "string" ? raw : "";
		const parsed = parseOptionValue(selectedValue);
		if (!parsed || !q.options[parsed.optionIndex]) continue;
		const option = q.options[parsed.optionIndex];
		answers.push({
			questionIndex: i,
			question: q.question,
			kind: "option",
			answer: option.label,
			preview: option.preview && option.preview.length > 0 ? option.preview : undefined,
			notes,
		});
	}
	return answers;
}

function resultFromValues(params: QuestionParams, result: ViewResult): QuestionnaireResult {
	if (result.action === "cancel") {
		return { answers: [], cancelled: true };
	}
	const answers = buildAnswers(params, result.values);
	if (answers.length === 0) {
		return { answers: [], cancelled: true };
	}
	return { answers, cancelled: false };
}

/**
 * Present the questionnaire on the desktop host.
 * Returns `null` when no desktop host is available (caller falls back to TUI).
 */
export async function presentQuestionnaireOnDesktop(
	params: QuestionParams,
	opts: { signal?: AbortSignal; deps?: DesktopViewDeps },
): Promise<QuestionnaireResult | null> {
	const connect = opts.deps?.connect ?? connectDesktopView;
	let client: DesktopViewClient | null = null;
	try {
		client = connect();
	} catch {
		return null;
	}
	if (!client) return null;

	try {
		const state = initialState(params);
		const result = await runDesktopSession(client, params, state, opts.signal);
		if (result === undefined) {
			// Host dismissed / force-closed — treat as cancel so the tool
			// envelope matches TUI Esc behaviour.
			return { answers: [], cancelled: true };
		}
		return result;
	} catch {
		// Socket / protocol / ViewHostError (placement rejected): fall through to TUI.
		return null;
	} finally {
		client.dispose();
	}
}

async function runDesktopSession(
	client: DesktopViewClient,
	params: QuestionParams,
	state: UiState,
	signal?: AbortSignal,
): Promise<QuestionnaireResult | undefined> {
	if (signal?.aborted) {
		return { answers: [], cancelled: true };
	}

	const spec = buildSpec(params, state);
	// Capture values from Host form store (authoritative at action time).
	const result = await client.open(spec, {
		signal,
		onEvent: (event, session: LiveViewSession) => {
			if (event.type === "change") {
				const index = questionIndexForNode(params, event.nodeId);
				const wasAnswered = index === null ? false : isQuestionAnswered(state, index);
				applyChange(state, params, event);
				// 任何交互都解除取消布防（对齐 TUI：其它动作 disarm）。
				state.cancelArmed = false;
				// 自动前进：仅多题布局下单选题选项列表的「未答→已答」确认动作
				// （点击/Enter）。多选勾选、自定义输入、备注不触发；回改已答题
				// 也不触发（只前进一次，避免改答案被拉走）。
				if (
					index !== null &&
					event.nodeId === listId(index) &&
					params.questions.length > 1 &&
					!params.questions[index].multiSelect &&
					!wasAnswered &&
					isQuestionAnswered(state, index)
				) {
					const next = nextUnansweredAfter(params, state, index);
					state.activeTab = next === null ? REVIEW_TAB_ID : questionTabId(next);
				}
				// Echo full tree so Client-side shadow state stays aligned with
				// Host form values (Host preserves live input on update).
				session.update(buildSpec(params, state));
				return;
			}
			if (event.type === "action") {
				if (event.actionId === "cancel") {
					if (hasAnyWork(params, state) && !state.cancelArmed) {
						// 第一段：仅布防，按钮换文案换色，不关闭
						state.cancelArmed = true;
						session.update(buildSpec(params, state));
						return;
					}
					session.close({ action: "cancel", values: {} });
					return;
				}
				if (event.actionId === "submit") {
					const values = { ...(event.values ?? {}) };
					// Prefer Host snapshot; fall back to last change events.
					for (let i = 0; i < params.questions.length; i++) {
						if (!(listId(i) in values)) values[listId(i)] = state.selections[i];
						if (!(customId(i) in values)) values[customId(i)] = state.customTexts[i];
						if (!(notesId(i) in values)) values[notesId(i)] = state.notes[i];
					}
					session.close({ action: "submit", values });
					return;
				}
				const goto = parseGotoAction(event.actionId);
				if (goto) {
					// 复核页「修改」/ 多选题「下一题」：显式接管激活页签
					state.cancelArmed = false;
					state.activeTab = goto.review
						? REVIEW_TAB_ID
						: questionTabId(Math.min(Math.max(goto.questionIndex, 0), params.questions.length - 1));
					session.update(buildSpec(params, state));
				}
			}
		},
	});

	if (!result) return undefined;
	return resultFromValues(params, result);
}

/** Test helper: expose tree builder without opening a socket. */
export function buildDesktopQuestionnaireSpec(params: QuestionParams): ViewSpec {
	return buildSpec(params, initialState(params));
}
