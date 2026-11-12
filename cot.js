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
