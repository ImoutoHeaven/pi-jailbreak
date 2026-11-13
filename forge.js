/**
 * The cross-model CoT refill.
 *
 * Pi drops a thinking block whenever the request targets a different model than the one that
 * produced the message (`pi-ai/dist/api/transform-messages.js`):
 *
 *     const isSameModel = assistantMsg.provider === model.provider &&
 *                         assistantMsg.api      === model.api      &&
 *                         assistantMsg.model    === model.id;
 *     if (block.type === "thinking") { if (!isSameModel) return []; ... }
 *
 * `forge` copies that exact predicate and promotes readable reasoning on foreign turns into the
 * configured `cot` fence while preserving the turn's original `(provider, api, model)` stamp and
 * `thinking` blocks so Pi strips foreign blocks and signatures downstream. When a foreign turn
 * carries both a native `thinking` summary and an inline fence or live cot tool call, `forge` merges
 * them into a single trace so neither the provider summary nor the model's notes are lost.
 */

import {
	afterCotPair,
	cotPair,
	cotText,
	findLiveCotCall,
	isCotCall,
	mergeCotPieces,
	ownCot,
	pairId,
	splitTurn,
	stripTags,
} from "./cot.js";

export { ownCot };

/** Pi's own predicate, copied field for field so the two never drift. */
export function isSameModel(message, live) {
	return message?.provider === live?.provider && message?.api === live?.api && message?.model === live?.id;
}

/**
 * One foreign assistant message's forged form as the replacement message list, or null when left as
 * it is.
 */
export function forgeOne(message, live, spec, index = 0, names = [spec?.name]) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
	if (isSameModel(message, live)) return null;
	if (message.content.some((b) => isCotCall(b, names))) return null;

	const { summary, interior, reply, hadFence } = splitTurn(message, names);
	// Without readable thinking blocks that Pi would drop on a model switch, forge has nothing to refill.
	if (!summary) return null;
	const thinkingBlocks = message.content.filter((b) => b?.type === "thinking");
	const otherBlocks = message.content.filter((b) => b?.type !== "thinking" && b?.type !== "text");

	if (spec.form === "toolcall") {
		const liveIdx = findLiveCotCall(message.content, names);
		if (liveIdx >= 0) {
			const liveCall = message.content[liveIdx];
			const liveThought = stripTags(liveCall.arguments.thought, names).trim();
			if (summary && mergeCotPieces([summary, liveThought]) === liveThought) return null;
			const merged = mergeCotPieces([summary, interior, liveThought]);
			if (!hadFence && merged === liveCall.arguments.thought) return null;
			const updatedOthers = otherBlocks.map((b) =>
				b === liveCall ? { ...liveCall, arguments: { ...liveCall.arguments, thought: merged } } : b,
			);
			const nextContent = [
				...thinkingBlocks,
				...(hadFence ? (reply ? [{ type: "text", text: reply }] : []) : message.content.filter((b) => b?.type === "text")),
				...updatedOthers,
			];
			return [{ ...message, content: nextContent }];
		}
		const cot = mergeCotPieces([summary, interior]);
		if (!cot || (hadFence && cot === interior)) return null;
		const pair = cotPair(cot, spec.name, pairId(`${index}\u0000${cot}`, message), message);
		const visibleTexts = hadFence
			? reply
				? [{ type: "text", text: reply }]
				: []
			: message.content.filter((b) => b?.type === "text" && String(b.text ?? "").trim() !== "");
		if (visibleTexts.length === 0 && otherBlocks.length === 0) return pair;
		if (!hadFence) return [...pair, message];
		return [...pair, { ...message, content: [...thinkingBlocks, ...visibleTexts, ...otherBlocks] }];
	}

	const cot = mergeCotPieces([summary, interior]);
	if (!cot || (hadFence && cot === interior)) return null;
	const fencedText = reply ? `${cotText(cot, spec.name)}\n\n${reply}` : cotText(cot, spec.name);

	const firstText = message.content.find((b) => b?.type === "text");
	const textBlock = firstText ? { ...firstText, text: fencedText } : { type: "text", text: fencedText };
	return [{ ...message, content: [...thinkingBlocks, textBlock, ...otherBlocks] }];
}

/**
 * Refill readable reasoning across all foreign turns in `messages`. Returns `messages` itself when
 * nothing changed.
 */
export function forgeHistory(messages, live, spec, names = [spec?.name]) {
	if (!Array.isArray(messages) || !live?.provider || !live?.id || !spec) return messages;
	let changed = false;
	const out = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (afterCotPair(messages, index, names)) {
			out.push(message);
			continue;
		}
		const forged = forgeOne(message, live, spec, index, names);
		if (!forged) {
			out.push(message);
			continue;
		}
		changed = true;
		out.push(...forged);
	}
	return changed ? out : messages;
}

/** The first index at which two message lists differ, or null when one is a prefix of the other. */
export function prefixStable(previous, next) {
	const shared = Math.min(previous.length, next.length);
	for (let i = 0; i < shared; i++) {
		if (JSON.stringify(previous[i]) !== JSON.stringify(next[i])) return i;
	}
	return null;
}
