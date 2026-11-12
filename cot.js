/**
 * The cot fence: one spec, two forms, and the pair a toolcall form needs.
 *
 * A cot is written into a request as either of two things, and the slot says which:
 *
 *     text:<tag>        the reasoning, fenced in a tag, at the head of the assistant's first text
 *                       block: `<tag>\n...cot...\n</tag>\n\n<reply>`
 *     toolcall:<name>   the reasoning as the argument of a real tool call, answered by its result,
 *                       ahead of the assistant message it belongs to
 *
 * The text form changes one block's bytes. The toolcall form inserts two messages, because a
 * `toolCall` without a `toolResult` is not a shape a transcript may hold: pi's own
 * `transformMessages` answers such a call with `isError: true, "No result provided"`, so a half pair
 * would put a fabricated error into the history. `cotPair` therefore always returns both.
 *
 * Both forms are pure: the id comes from the cot's own bytes and the stamp it is written under, so
 * two calls with the same arguments produce identical messages and a grown conversation keeps every
 * already-sent position byte-identical.
 *
 * `fenced` answers "is this turn already carrying a cot". It matches by **name**, not by form: a turn
 * fenced under `text:think` counts as fenced once the model asks for `toolcall:think`, because two
 * fences on one turn read as two reasoning traces. It also requires the call to carry the id prefix
 * this module writes, because the cot tool is a real tool the model can call: a genuine `think` call
 * is the model's own reasoning, and reading it as a fence would leave that turn's thinking out of the
 * request forever.
 *
 * `beat` is the per-turn counter: `[turn <index>]`, carried inside a text block of the turn it
 * counts. It is a position anchor the model can count, not an instruction, and it never becomes a
 * message of its own: a system message per turn is what several providers fold into the head, which
 * would invalidate the whole prefix.
 */

/** The reply a fabricated cot call gets. One short token, so the pair costs a few bytes and says
 * nothing a model could mistake for an answer. */
export const COT_ACK = "OK";

/** The zero usage record every fabricated message carries: the request pays for none of it. */
export function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** A deterministic call id: the same cot under the same stamp always yields the same id, and the
 * result after it answers nothing else. */
export function pairId(cot, stamp = {}) {
	const text = `${stamp.provider ?? ""}/${stamp.api ?? ""}/${stamp.model ?? ""}\u0000${cot}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${PAIR_PREFIX}${hash.toString(36)}`;
}

/**
 * One fabricated cot call and its result, in that order. `stamp` is passed in rather than read: a
 * turn file speaks as the live model, and a refilled turn keeps the stamp of the model that wrote
 * it. Nothing else about the pair depends on the caller.
 */
export function cotPair(cot, name, id, stamp) {
	const usage = zeroUsage();
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: { thought: cot } }],
			api: stamp.api,
			provider: stamp.provider,
			model: stamp.model,
			usage,
			// `transformMessages` drops an assistant marked error or aborted, so this is load-bearing.
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: COT_ACK }],
			isError: false,
			usage,
			timestamp: 0,
		},
	];
}

/** The fence the text form writes. */
export function cotText(cot, name) {
	return `<${name}>\n${cot}\n</${name}>`;
}

function escapeTag(name) {
	return String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a text block opens with a fence in `name`. */
export function opensWith(text, name) {
	return new RegExp(`^<${escapeTag(name)}>\\n`).test(String(text ?? ""));
}

/** The id prefix `pairId` always writes. A call carrying it is one this extension fabricated; a call
 * without it is somebody else's, including a real call to the cot tool, which must not read as a cot
 * already written. */
export const PAIR_PREFIX = "cot_";

/** Whether a call block is a fabricated cot call under one of `names`. */
export function isCotCall(block, names) {
	return block?.type === "toolCall" && names.includes(block.name) && String(block.id ?? "").startsWith(PAIR_PREFIX);
}

/**
 * Whether a turn already carries a cot, under any name the config names and in either form.
 *
 * The name alone is not enough for the call form: the cot tool is a real tool the model can call, so
 * a genuine `think` call would read as a cot this extension wrote and the turn's own reasoning would
 * never come back. Only a call carrying this extension's id prefix counts.
 */
export function fenced(blocks, names) {
	for (const block of blocks ?? []) {
		if (isCotCall(block, names)) return true;
		if (block?.type === "text" && names.some((name) => opensWith(block.text, name))) return true;
	}
	return false;
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
 * without a second reader. That a summary is a summary and not the trace itself is deliberately not
 * tested: the readable bytes are what the request can carry, and `transcribe` treats them as the cot.
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

/** The marker `beat` writes. One per block, at the very end, so stripping it is unambiguous. */
const BEAT_MARK = /\n?\[turn \d+\]$/;

/**
 * A block's text with its turn marker: the previous one, if any, is removed first, so a second pass
 * writes the same bytes instead of stacking a second marker. A block that held nothing but a marker
 * keeps nothing but the new one.
 */
export function beatText(text, turn) {
	const rest = String(text ?? "").replace(BEAT_MARK, "");
	return rest ? `${rest}\n[turn ${turn}]` : `[turn ${turn}]`;
}

/**
 * One assistant message with its turn marker, or the message itself when it cannot take one.
 *
 * The marker rides inside a text block of the message it counts: no message is added, and no system
 * message is touched. Both matter. A system message written for each turn is the one shape providers
 * disagree about — several fold a mid-conversation system message into the head, which invalidates
 * the whole prefix. A message of its own changes the transcript length, which moves every position
 * after it.
 *
 * A turn that says nothing gets a text block of its own, placed after any leading reasoning blocks and
 * ahead of its calls: an assistant message reads reasoning first, then what it said, then what it
 * called, and a text block ahead of the reasoning would reorder a block that a provider may sign.
 * A turn with visible text gets the marker at the end of that text, so a fenced turn reads as
 * `<tag>cot</tag>`, then the reply, then the marker.
 *
 * `turn` is the message's position in the list, never a running counter: appending a message then
 * renumbers nothing that was already sent.
 */
export function beatOne(message, turn) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	let last = -1;
	for (let i = 0; i < message.content.length; i++) if (message.content[i]?.type === "text") last = i;
	const next = message.content.slice();
	if (last >= 0) {
		const text = beatText(next[last].text, turn);
		if (text === next[last].text) return message;
		next[last] = { ...next[last], text };
	} else {
		let at = 0;
		while (at < next.length && next[at]?.type === "thinking") at++;
		next.splice(at, 0, { type: "text", text: `[turn ${turn}]` });
	}
	return { ...message, content: next };
}

/**
 * The whole list with turn markers. Returns the input array itself when nothing changed, so a request
 * with no assistant turn allocates nothing.
 */
export function beatHistory(messages) {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const out = messages.map((message, index) => {
		const beaten = beatOne(message, index);
		if (beaten === message) return message;
		changed = true;
		return beaten;
	});
	return changed ? out : messages;
}

/**
 * The cot as it is sent, bounded by `maxChars` when the slot carries a bound. A cut inside a
 * surrogate pair would leave a lone code unit in the request bytes, and the whole design leans on
 * those bytes being reproducible, so the pair is kept whole.
 */
export function clampCot(cot, maxChars) {
	if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || cot.length <= maxChars) return cot;
	let cut = maxChars;
	if (/[\uD800-\uDBFF]/.test(cot[cut - 1])) cut = cut > 1 ? cut - 1 : 2;
	// Keeping a leading pair whole can reach the end of a short trace, and a marker on a trace that is
	// entirely present would tell the model its reasoning was cut when none of it was.
	return cut < cot.length ? `${cot.slice(0, cut)}\n[... reasoning truncated]` : cot.slice(0, cut);
}

/**
 * One message with its reasoning written as text, or the message itself when it is left alone.
 *
 * This is the opposite trade from `forge`: forge adds a fence beside a thinking block it keeps, so
 * pi's wire format stays native. Transcribe replaces the block with the fence, because the point is
 * to make the model's own reasoning arrive as text on the next request, where it is neither encrypted
 * nor summarized. Keeping both would show one turn two reasoning traces, which is the state forge's
 * second invariant exists to prevent.
 *
 * Two turns are left alone, for two different reasons:
 *
 *  - a turn already carrying a cot, whoever wrote it. That is the loop closing by itself: once the
 *    model writes its own fence, this function has nothing to do, and no state has to record that.
 *  - a turn with nothing readable, a redacted or empty block. There is nothing to promote.
 *
 * The decision reads the message and nothing else, in particular not the live model. That is what
 * keeps a model switch free: the same history yields the same bytes whichever model asks for it.
 *
 * `index` salts the call id. Two turns carrying identical reasoning under one stamp would otherwise
 * produce one id twice, and a transcript may not hold two calls with one id.
 */
export function transcribeOne(message, spec, names, maxChars = null, index = 0) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	if (fenced(message.content, names)) return message;
	const own = ownCot(message);
	if (!own) return message;
	const cot = clampCot(own, maxChars);
	const kept = message.content.filter((block) => block?.type !== "thinking");
	if (spec.form === "toolcall") {
		// The block is replaced by a pair ahead of the message, and the message's own stamp is what the
		// pair carries: it is the same turn, rewritten, not a second one.
		return [...cotPair(cot, spec.name, pairId(`${index}\u0000${cot}`, message), message), ...(kept.length ? [{ ...message, content: kept }] : [])];
	}
	const lead = kept.findIndex((block) => block?.type === "text");
	const next = kept.slice();
	if (lead >= 0) next[lead] = { ...kept[lead], text: `${cotText(cot, spec.name)}\n\n${kept[lead].text ?? ""}` };
	// No visible text: the fence leads the message, ahead of any call. A text block after a tool call is
	// the one order a provider rejects, and it is also the shape the loop turns take.
	else next.unshift({ type: "text", text: cotText(cot, spec.name) });
	return [{ ...message, content: next }];
}

/**
 * The whole list transcribed. Returns the input array itself when nothing changed, so a request with
 * nothing to promote allocates nothing.
 */
export function transcribeHistory(messages, spec, names, maxChars = null) {
	if (!Array.isArray(messages) || !spec) return messages;
	let changed = false;
	const out = [];
	for (let index = 0; index < messages.length; index++) {
		const done = transcribeOne(messages[index], spec, names, maxChars, index);
		if (done === messages[index]) {
			out.push(messages[index]);
			continue;
		}
		changed = true;
		out.push(...(Array.isArray(done) ? done : [done]));
	}
	return changed ? out : messages;
}
