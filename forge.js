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
 * It also deletes `toolCall.thoughtSignature` and normalizes tool call ids for such a message. So
 * pi answers "does this message carry its CoT into this request?" per message, and this module
 * never invents a second answer: `isSameModel` is copied byte for byte, and the refill fires on
 * exactly the messages that predicate marks as foreign, minus the ones with nothing readable to put
 * back (a redacted-only block) and the ones already carrying the fence.
 *
 *     forge(M)  <=>  not isSameModel(M, live)  and  M carries a readable CoT  and  not already fenced
 *
 * Four invariants, all load-bearing:
 *
 * 1. Pure. The result depends only on the message's own persisted bytes, the live
 *    `provider`/`api`/`id` triple, and the tag. No clock, no model call, no mutable state. A pure
 *    answer is what keeps a grown conversation byte-identical at every position it already sent, so
 *    the provider's prompt cache keeps hitting.
 * 2. No re-stamp. The forged message keeps its original `provider`, `api` and `model`. Re-stamping
 *    would make pi treat the message as the live model's own, and the native thinking block would
 *    survive next to our fence, giving one turn two reasoning traces.
 * 3. No floor and no run boundary. Skipping the messages at or after the last user message looks
 *    like it protects the live run, but the boundary slides: a message past the floor in one request
 *    enters the forge region in the next, and bytes already sent change under it. Purity covers the
 *    whole history, and `isSameModel` alone keeps the live run's own turns out, because those are
 *    stamped with the live model. The extension never needs to know where a run started.
 * 4. Add only. The forged turn is the original with the fence written in front of its visible text.
 *    Nothing else about the message changes.
 *
 * The fence goes inside the first text block rather than in a block of its own. `openai-completions`
 * serializes an assistant's text blocks with `.join("")`, so two blocks would concatenate the fence
 * and the reply with no separator between them. One block, `\n\n` between the fence and the reply,
 * is the shape the turn file already writes.
 *
 * Nothing here reads or writes the session, and nothing here knows about any other extension.
 */

/** Pi's own predicate, copied so the two never drift. */
export function isSameModel(message, live) {
	return message?.provider === live?.provider && message?.api === live?.api && message?.model === live?.id;
}

/**
 * The CoT a message already carries, in its own bytes: the thinking blocks pi would drop. A
 * redacted or opaque block has no readable text, so it contributes nothing; its signature is only
 * valid to the model that produced it, which is exactly what a cross-model request cannot use. The
 * `redacted` flag is checked as well as the placeholder text, so a block that carries the flag
 * without the placeholder is still treated as unreadable rather than replayed.
 *
 * A provider that reports a reasoning field instead of a block (`reasoning_content`, `reasoning`,
 * `reasoning_text`) has already been read into a thinking block by `openai-completions`, and a
 * summarized trace arrives the same way, so both are covered without a second reader.
 */
export function ownCot(message) {
	const parts = [];
	for (const block of message?.content ?? []) {
		if (block?.type !== "thinking") continue;
		if (block.redacted) continue;
		const text = String(block.thinking ?? "").trim();
		if (!text || text === "[Reasoning redacted]") continue;
		parts.push(text);
	}
	return parts.join("\n\n");
}

/** Whether the visible text already opens with a fence this tag writes. */
function fencePattern(tag) {
	return new RegExp("^<" + String(tag ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ">\\n");
}

/**
 * Whether the visible text already opens with a fence this tag writes.
 *
 * The match is exact on purpose. Forge's own fence is always the tag then a newline, so a loose match
 * buys nothing inside one process, and it costs something: a hand-written fence with a stray space
 * that a loose match accepted would skip a refill the turn genuinely needs, losing the cot, while a
 * near-miss hand fence that is not matched only gets a second fence, which is visible and harmless.
 * The asymmetry favors strict.
 */
function fenced(text, tag) {
	return fencePattern(tag).test(String(text ?? ""));
}

/**
 * One assistant message's forged form, or null when it is left exactly as it is.
 *
 * `force` is `forge: "always"`: it refills a turn pi would carry as well, which shows the turn two
 * reasoning traces. It exists to diagnose a double fence and is never the right setting for a run.
 *
 * `maxChars` bounds the refilled CoT so a long trace cannot dominate a request. A negative value
 * means no bound. The bound is applied before the fence is built, so it is part of the pure answer
 * rather than a second pass.
 */
export function forgeOne(message, live, tag, maxChars = 4000, force = false) {
	if (message?.role !== "assistant") return null;
	// Pi carries this message's CoT already, so we touch nothing unless the caller forced it.
	if (!force && isSameModel(message, live)) return null;
	let cot = ownCot(message);
	if (!cot) return null;
	const limit = Number.isFinite(maxChars) ? maxChars : 4000;
	if (limit >= 0 && cot.length > limit) cot = `${cot.slice(0, limit)}\n[... reasoning truncated]`;
	const content = Array.isArray(message.content) ? message.content : [];
	const lead = content.findIndex((block) => block?.type === "text");
	// Already fenced, by us on an earlier request or by a pasted message: idempotent.
	if (lead >= 0 && fenced(content[lead].text, tag)) return null;
	const fence = `<${tag}>\n${cot}\n</${tag}>`;
	const next = content.slice();
	if (lead >= 0) {
		// One block: the provider joins an assistant's text blocks with no separator.
		next[lead] = { ...content[lead], text: `${fence}\n\n${content[lead].text ?? ""}` };
	} else {
		// A turn with no visible text at all still carries its reasoning, and the block goes after any
		// leading reasoning blocks rather than ahead of them: an assistant message reads reasoning
		// first, then what it said, and a provider that requires that order would reject the reverse.
		let at = 0;
		while (at < next.length && next[at]?.type === "thinking") at++;
		next.splice(at, 0, { type: "text", text: fence });
	}
	// The stamp travels unchanged: `provider`, `api`, `model`, `usage`, `stopReason`, everything.
	return { ...message, content: next };
}

/**
 * The whole message list, forged. Returns the input array itself when nothing changed, so a request
 * with nothing to refill allocates nothing and stays byte-identical.
 */
export function forgeHistory(messages, live, tag, maxChars = 4000, force = false) {
	if (!Array.isArray(messages) || !live?.provider || !live?.id) return messages;
	let changed = false;
	const out = messages.map((message) => {
		const forged = forgeOne(message, live, tag, maxChars, force);
		if (!forged) return message;
		changed = true;
		return forged;
	});
	return changed ? out : messages;
}

/**
 * The first index at which two message lists differ, or null when one is a prefix of the other.
 *
 * This is "does the provider's prompt cache survive" in executable form: appending a message keeps
 * every earlier position identical, so it costs nothing; a byte change at an already-sent position
 * costs one miss. The check runs this against a grown history to pin purity.
 */
export function prefixStable(previous, next) {
	const shared = Math.min(previous.length, next.length);
	for (let i = 0; i < shared; i++) {
		if (JSON.stringify(previous[i]) !== JSON.stringify(next[i])) return i;
	}
	return null;
}
