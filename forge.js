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
 *    `provider`/`api`/`id` triple, and the cot spec. No clock, no model call, no mutable state. A
 *    pure answer is what keeps a grown conversation byte-identical at every position it already
 *    sent, so the provider's prompt cache keeps hitting, and it is what makes a refill idempotent:
 *    the same history asked twice produces the same messages.
 * 2. No re-stamp. The forged turn keeps its original `provider`, `api` and `model`. Re-stamping
 *    would make pi treat the message as the live model's own and carry its thinking block as well,
 *    giving one turn two reasoning traces.
 * 3. No floor and no run boundary. Skipping the messages at or after the last user message looks
 *    like it protects the live run, but the boundary slides: a message past the floor in one request
 *    enters the forge region in the next, and bytes already sent change under it. Purity covers the
 *    whole history, and `isSameModel` alone keeps the live run's own turns out, because those are
 *    stamped with the live model. The extension never needs to know where a run started.
 * 4. Add only. Nothing the message already said changes, and no message is dropped.
 *
 * The two forms write the cot differently, and `cot.js` owns both:
 *
 *  - `text:<tag>` rewrites the first text block in place: `<tag>\n...cot...\n</tag>\n\n<reply>`. One
 *    block, because an assistant's text blocks are joined with no separator between them.
 *  - `toolcall:<name>` inserts a call and its result ahead of the message. Insertion rather than a
 *    rewrite: the message may already carry a call of its own, and a second `toolCall` in the same
 *    content would leave two calls waiting for results pi will then invent errors for.
 *
 * The name is per model, so the set of names the config names travels with it: a turn already
 * fenced under one model's name counts as fenced for every other, or a model switch would stack a
 * second fence on it.
 *
 * Nothing here reads or writes the session, and nothing here knows about any other extension.
 */

import { afterCotPair, clampCot, cotPair, cotText, fenced, pairId, stripTags } from "./cot.js";

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
 * A provider that reports a reasoning field instead of a block has already been read into a thinking
 * block before this module runs, and a summarized trace arrives the same way, so both are covered
 * without a second reader.
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

/**
 * One assistant message's forged form as the messages that replace it, or null when it is left
 * exactly as it is. The result is a list because the toolcall form inserts a call and its result
 * ahead of the message while the text form replaces the message with one copy of itself.
 *
 * `maxChars` bounds the refilled CoT, and `null` means no bound, which is the default: a truncated
 * trace is not the reasoning the turn wrote, and a model that reads a cut-off version of its own
 * thinking has reason to distrust the turn it is being shown. The bound is applied before the cot
 * is built, so it is part of the pure answer rather than a second pass.
 *
 * `index` is the message's position, and it salts the call id. Two foreign turns carrying the same
 * reasoning under the same stamp would otherwise produce one id twice, and a transcript may not hold
 * two calls with one id.
 */
export function forgeOne(message, live, spec, index = 0, maxChars = null, names = [spec?.name]) {
	if (message?.role !== "assistant") return null;
	// Pi carries this message's CoT already, so the turn is left exactly as it is.
	if (isSameModel(message, live)) return null;
	const content = Array.isArray(message.content) ? message.content : [];
	// Already carrying a cot, by us on an earlier request or by a pasted message: idempotent. Any name
	// the config names counts, whatever form it was written in, so a turn this extension already
	// fenced under another model's name is not fenced a second time.
	if (fenced(content, names)) return null;
	const own = ownCot(message);
	if (!own) return null;
	// Strip configured tags and trim per block before joining, matching `transcribe` byte for byte when a
	// thinking block carries fence tags around newlines.
	const cleaned = (message.content ?? [])
		.filter((block) => block?.type === "thinking" && !block.redacted)
		.map((block) => String(block.thinking ?? "").trim())
		.filter((text) => text && text !== "[Reasoning redacted]")
		.map((text) => stripTags(text, names).trim())
		.filter(Boolean)
		.join("\n\n");
	const cot = clampCot(cleaned, maxChars);
	if (!cot) return null;
	if (spec.form === "toolcall") {
		// Insertion, not a rewrite: the message may already carry a call of its own, and a second
		// `toolCall` in one content would leave two calls waiting for results pi then answers with a
		// fabricated error. The pair is stamped with the turn's own stamp, so it stays part of the same
		// foreign turn rather than becoming the live model's second reasoning trace.
		const pair = cotPair(cot, spec.name, pairId(`${index}\u0000${cot}`, message), message);
		return [...pair, message];
	}
	const lead = content.findIndex((block) => block?.type === "text");
	const fence = cotText(cot, spec.name);
	const next = content.slice();
	if (lead >= 0) {
		// One block: an assistant's text blocks are joined with no separator.
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
	return [{ ...message, content: next }];
}

/**
 * The whole message list, forged. Returns the input array itself when nothing changed, so a request
 * with nothing to refill allocates nothing and stays byte-identical.
 *
 * A turn already preceded by a cot pair is left alone, through the same predicate `transcribe` uses:
 * the pair sits ahead of it as a result answering a cot call, and writing another would give one turn
 * two reasoning traces.
 */
export function forgeHistory(messages, live, spec, maxChars = null, names = [spec?.name]) {
	if (!Array.isArray(messages) || !live?.provider || !live?.id || !spec) return messages;
	let changed = false;
	const out = [];
	for (let index = 0; index < messages.length; index++) {
		if (afterCotPair(messages, index, names)) {
			out.push(messages[index]);
			continue;
		}
		const forged = forgeOne(messages[index], live, spec, index, maxChars, names);
		if (!forged) {
			out.push(messages[index]);
			continue;
		}
		changed = true;
		out.push(...forged);
	}
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
