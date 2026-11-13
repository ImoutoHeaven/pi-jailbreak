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

/** A newline, named so the templates below read as one line each. */
const NL = "\n";

/** The separator `pairId` puts between the position and the cot. */
const NUL = "\u0000";

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

/**
 * Whether a text block opens with a fence in `name`.
 *
 * The tag alone, in either case, with no newline required: a model that learned the fence writes
 * `<think>` and then its reasoning on the same line, and demanding a newline after the tag made
 * `fenced` disagree with the repair about what a fence is. The disagreement was costly in one
 * direction — a turn whose fence has no newline read as unfenced, so the promotion prepended a second
 * opening tag and the request changed again on the next pass. The `>` is part of the pattern, so
 * `<thinkable>` is not a fence.
 */
export function opensWith(text, name) {
	return new RegExp(`^<${escapeTag(name)}>`, "i").test(String(text ?? ""));
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

/** A text block that carries nothing but a turn marker, which `beat` writes. */
export const MARKER_ONLY = /^\[turn \d+\]$/;

/**
 * Whether a message is the cot call this extension writes: one block that is a `cot_`-prefixed call to
 * a configured name, carrying a `thought` argument, and nothing else that counts as content.
 *
 * A block holding nothing but a turn marker does not count: `beat` writes one into every assistant
 * turn, including this one, and reading the marker as content would make the pair unrecognisable and
 * put a second pair in front of the same turn on the next request.
 *
 * The pair lives outside the message it serves, so only a list can see it — which is why every writer
 * that walks a list uses this, and none of them decides idempotence message by message.
 */
export function isCotPairMessage(message, names) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
	const blocks = message.content.filter((block) => !(block?.type === "text" && MARKER_ONLY.test(String(block.text ?? ""))));
	if (blocks.length !== 1) return false;
	const block = blocks[0];
	return isCotCall(block, names) && typeof block.arguments?.thought === "string";
}

/** Whether the message at `index` is preceded by a cot pair that answers it. */
export function afterCotPair(messages, index, names) {
	return index >= 2 && messages[index - 1]?.role === "toolResult" && isCotPairMessage(messages[index - 2], names);
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

/** `text` with every trailing `[turn <digits>]` suffix and preceding whitespace removed in one backward scan. */
function stripTrailingMarkers(text) {
	let end = text.length;
	while (end >= 8 && text[end - 1] === "]") {
		let p = end - 2;
		while (p >= 0 && text[p] >= "0" && text[p] <= "9") p--;
		if (p === end - 2 || p < 5 || text.slice(p - 5, p + 1) !== "[turn ") break;
		end = p - 5;
		while (end > 0 && /\s/.test(text[end - 1])) end--;
	}
	return end === text.length ? text : text.slice(0, end);
}

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

/** The note a cut trace carries, so a model knows its reasoning is not all there. */
const TRUNCATED = "\n[... reasoning truncated]";

/**
 * `cot` cut to `maxChars`, or `cot` itself when it is already short enough or carries no bound.
 *
 * A trace that already ends with the note is returned as it is. The note is longer than some bounds, so
 * reading the writer's own output back would cut inside the note and append a second one — the same
 * bytes differing on every pass, which is exactly what a byte-stable request cannot have. A cut trace
 * is a cut trace; there is nothing left to decide about it.
 *
 * The cut never splits a surrogate pair, and it never reaches the end: a note on a trace that is
 * entirely present would tell the model its reasoning was cut when none of it was.
 */
export function clampCot(cot, maxChars) {
	if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || cot.length <= maxChars) return cot;
	const source = cot.endsWith(TRUNCATED) ? cot.slice(0, -TRUNCATED.length) : cot;
	if (source !== cot && (source.length <= maxChars || (maxChars === 1 && source.length === 2 && /[\uD800-\uDBFF]/.test(source[0])))) {
		return cot;
	}
	let cut = maxChars;
	if (/[\uD800-\uDBFF]/.test(source[cut - 1])) cut = cut > 1 ? cut - 1 : 2;
	return cut < source.length || source !== cot ? `${source.slice(0, cut)}${TRUNCATED}` : source.slice(0, cut);
}

/**
 * `text` with every fence tag in `names` removed, opening and closing alike, in either case, until
 * nothing changes.
 *
 * Removal is a rewrite, and a rewrite can create the sequence it removes: `<<think>think>` loses the
 * inner tag and leaves one behind when the two halves join, `</think</think>>` is left as `</think>`.
 * So a tag is checked against the buffer as it is now, not against the input: after every `>` the text
 * between the innermost unclosed `<` and that `>` is compared, and dropped when it names a tag. That
 * catches an assembled tag on the same pass and costs one scan, where deleting a match at a time and
 * starting over cost one scan per nesting level.
 *
 * Removal rather than escaping, on purpose. An escape would be a spelling the model has never seen,
 * and a model that learns it starts emitting it; a removal is invisible, so it teaches nothing. The
 * union of names is what matters: a turn fenced as `think` can carry `</note>` from an earlier model,
 * and the next reader is configured for `note`.
 */
export function stripTags(text, names) {
	const tags = new Set();
	let maxLen = 0;
	for (const raw of names ?? []) {
		const name = String(raw).toLowerCase();
		if (!name || name.includes("<") || name.includes(">")) continue;
		tags.add(name);
		if (name.length > maxLen) maxLen = name.length;
	}
	const body = String(text ?? "");
	if (tags.size === 0 || !body.includes("<")) return body;
	// Include the leading `/` of a closing tag. No character shrinks when lowercased, so a span wider
	// than `maxLen + 1` code units cannot lowercase to a configured tag.
	const limit = maxLen + 1;
	const out = [];
	// Where every `<` in `out` sits. Once a `>` stays in `out` without matching, every `<` ahead of it
	// has a `>` after it and can never form a tag name, so the whole stack clears in one step.
	const opens = [];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		out.push(ch);
		if (ch === "<") {
			opens.push(out.length - 1);
			continue;
		}
		if (ch !== ">" || opens.length === 0) continue;
		const at = opens[opens.length - 1];
		const span = out.length - 2 - at;
		if (span <= 0 || span > limit) {
			opens.length = 0;
			continue;
		}
		let raw = "";
		for (let k = at + 1; k < out.length - 1; k++) raw += out[k];
		const name = raw.toLowerCase();
		if (!tags.has(name.startsWith("/") ? name.slice(1) : name)) {
			opens.length = 0;
			continue;
		}
		out.length = at;
		opens.pop();
	}
	return out.join("");
}

/**
 * The opening tag of the fence for `name`, and the closing tag, as `{ open, close }`.
 */
function fenceTags(name) {
	return { open: `<${name}>`, close: `</${name}>` };
}

/**
 * Where the fence for `name` opens in `text`, or -1.
 *
 * The scan runs over `text` itself and never over a lowered copy. Lowercasing can change length — U+0130
 * is one code unit that becomes two — so an index taken from a lowered string cuts the block at the wrong
 * place, and the tag it was aiming at ends up spliced into the reasoning instead of delimiting it.
 */
function fenceOpenAt(text, open) {
	const hit = new RegExp(escapeTag(open), "i").exec(String(text ?? ""));
	return hit ? hit.index : -1;
}

/** The index of the **last** closing tag in `text`, or -1. The same rule: every index comes from `text`. */
function fenceCloseAt(text, close) {
	const pattern = new RegExp(escapeTag(close), "gi");
	let last = -1;
	for (let hit = pattern.exec(text); hit; hit = pattern.exec(text)) last = hit.index;
	return last;
}

/** One message's readable reasoning, in the order it was written, and the reply that followed it. */
function splitTurn(message, spec, names) {
	const thinking = [];
	const texts = [];
	for (const block of message.content) {
		if (block?.type === "thinking") {
			if (block.redacted) continue;
			const text = String(block.thinking ?? "").trim();
			if (!text || text === "[Reasoning redacted]") continue;
			thinking.push(text);
		} else if (block?.type === "text") {
			texts.push(String(block.text ?? ""));
		}
	}
	// `beat` appends `BEAT_MARK` to the last text block. Strip that exact suffix first so `splitTurn` and
	// `beatText` agree on what is a marker, and `thinking` blocks whose own text looks like one stay intact.
	if (texts.length > 0) texts[texts.length - 1] = texts[texts.length - 1].replace(BEAT_MARK, "");
	const { open, close } = fenceTags(spec.name);
	// A fence spans from the first opening tag across the turn's text blocks to the last closing tag
	// after it, or to the end of the turn when the model never closed it. With no opening tag anywhere,
	// every text block is the reply and the reasoning is the thinking blocks alone.
	let openBlock = -1;
	let openAt = -1;
	for (let i = 0; i < texts.length; i++) {
		const at = fenceOpenAt(texts[i], open);
		if (at >= 0) {
			openBlock = i;
			openAt = at;
			break;
		}
	}
	const pre = [];
	const inside = [];
	const prose = [];
	if (openBlock < 0) {
		prose.push(...texts);
	} else {
		for (let i = 0; i < openBlock; i++) pre.push(texts[i]);
		pre.push(texts[openBlock].slice(0, openAt));
		const tail = [texts[openBlock].slice(openAt + open.length), ...texts.slice(openBlock + 1)];
		let closeBlock = -1;
		let closeAt = -1;
		for (let j = tail.length - 1; j >= 0; j--) {
			const end = fenceCloseAt(tail[j], close);
			if (end >= 0) {
				closeBlock = j;
				closeAt = end;
				break;
			}
		}
		const afterClose = closeBlock < 0 ? [] : [tail[closeBlock].slice(closeAt + close.length), ...tail.slice(closeBlock + 1)];
		// An opening tag after the last closing tag starts a fence the model never closed, so the reasoning
		// runs to the end of the turn's text.
		if (closeBlock < 0 || afterClose.some((part) => fenceOpenAt(part, open) >= 0)) {
			inside.push(...tail);
		} else {
			for (let j = 0; j < closeBlock; j++) inside.push(tail[j]);
			inside.push(tail[closeBlock].slice(0, closeAt));
			prose.push(...afterClose);
		}
	}
	const clean = (list) => list.map((text) => stripTags(text, names).trim()).filter(Boolean);
	const summary = clean(thinking).join("\n\n");
	const lead = clean(pre).join("\n\n");
	const interior = clean(inside).join("\n\n");
	// A piece that an earlier piece already contains is dropped, ignoring any truncation note `forge`
	// appended when cutting the same thinking bytes to `maxChars`, and replacing an earlier piece when a
	// later one already opens with it as a full line.
	const pieces = [];
	for (const piece of [summary, lead, interior]) {
		if (!piece) continue;
		const core = piece.endsWith(TRUNCATED) ? piece.slice(0, -TRUNCATED.length) : piece;
		if (pieces.some((seen) => seen.includes(core))) continue;
		for (let i = pieces.length - 1; i >= 0; i--) {
			const prev = pieces[i];
			if ((prev.endsWith(TRUNCATED) && piece.includes(prev.slice(0, -TRUNCATED.length))) || piece.startsWith(`${prev}\n`)) {
				pieces.splice(i, 1);
			}
		}
		pieces.push(piece);
	}
	// Tag removal, trimming, or dropped blank blocks can expose trailing `[turn N]` suffixes at the end of
	// `reply`; strip them in one backward scan so Pass 1 settles in linear time.
	const reply = stripTrailingMarkers(clean(prose).join("\n\n"));
	return { reasoning: pieces.join("\n\n"), reply };
}

/**
 * The one message this turn becomes, or the message itself when there is nothing to write.
 *
 * A turn carries reasoning in three places at once, and any two of them can be present together:
 * the thinking blocks, the interior of a fence the model wrote itself, and the words ahead of that
 * fence. Each writer that handled one of them alone left the other two where they were, which is how a
 * turn ended up showing a fence and an encrypted trace beside it, or two fences nested in each other.
 * This reads all three into one piece of text and writes exactly one fence, so the shape a model meets
 * on the next request is the same shape every time: one opening tag, the reasoning, one closing tag,
 * then the reply.
 *
 * The choice this makes is the one the earlier writers weighed and split on. The summary behind a
 * signature is not a copy of the fence: measured over the turns that carry both, the fence carries
 * almost none of it. Dropping the signature therefore discarded reasoning the model had already paid
 * for, and keeping it beside the fence showed two traces. Writing it into the fence keeps every
 * readable byte and leaves one trace, which is why the summary goes first — it is the provider's
 * compression of the whole turn, and the model's own words read as the detail that follows it.
 *
 * The result is a fixed point. Every piece is stripped of the configured tags and trimmed before it is
 * joined with one separator, and the reply is dropped when it is blank, so a second pass finds one
 * fence, no tags inside it, and nothing outside it, and rebuilds the same bytes. A turn the extension
 * already wrote is therefore byte-identical on every later request, which is what keeps the prompt
 * cache hitting; the first request that carries a turn written by a model changes it once.
 *
 * An empty fence no longer means the signed block is the only trace. The two are one piece of text
 * here, so the only question left is whether the turn has any readable reasoning at all.
 *
 * `maxChars` bounds the reasoning, never the reply: a cut reply is a turn that stopped talking.
 *
 * The decision reads the message and the spec and nothing else, in particular not the live model, so
 * the same history yields the same bytes whichever model asks for it.
 */
function canonical(message, spec, names, maxChars = null) {
	const { reasoning, reply } = splitTurn(message, spec, names);
	if (!reasoning) return null;
	const cot = clampCot(reasoning, maxChars);
	if (!cot.trim()) return null;
	const { open, close } = fenceTags(spec.name);
	const text = reply ? `${open}${NL}${cot}${NL}${close}${NL}${NL}${reply}` : `${open}${NL}${cot}${NL}${close}`;
	// The calls travel after the fence, in their original order. Reasoning and text are replaced by the
	// one block above; a turn that carried nothing but reasoning keeps nothing else.
	const kept = message.content.filter((block) => block?.type !== "thinking" && block?.type !== "text");
	// A turn this writer already wrote rebuilds the same bytes. It is returned as it is rather than as a
	// copy, so a list with nothing to promote keeps its identity and a request allocates nothing. The
	// comparison is exact, down to the order of the blocks that follow the fence.
	if (message.content.length === kept.length + 1 && message.content[0]?.type === "text" && message.content[0].text === text) {
		let same = true;
		for (let i = 0; i < kept.length; i++) if (message.content[i + 1] !== kept[i]) { same = false; break; }
		if (same) return null;
	}
	return { ...message, content: [{ type: "text", text }, ...kept] };
}

/**
 * Whether two block lists hold the same blocks, by identity and in the same order. Length alone is not
 * enough: a turn whose fence was replaced by its reply keeps the same number of blocks, and reading that
 * as "nothing changed" would leave the fence on a turn the pair already answers.
 */
function sameBlocks(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * `message` with its reasoning gone: the reply, when it has one, then every block that was neither
 * reasoning nor text. An empty list means the reasoning was all the turn said, and the pair that now
 * carries it is the whole turn.
 */
function turnWithoutReasoning(message, reply) {
	const rest = message.content.filter((block) => block?.type !== "thinking" && block?.type !== "text");
	if (!reply) return rest.length ? [{ ...message, content: rest }] : [];
	return [{ ...message, content: [{ type: "text", text: reply }, ...rest] }];
}

/**
 * One message with its reasoning written as text, or the message itself when it is left alone.
 *
 * The two forms differ only in where the cot ends up: the text form rebuilds the turn's own text block,
 * the toolcall form puts the reasoning in the argument of a call and leaves the turn with its reply and
 * its calls, so the fence travels ahead of the message as a pair of its own.
 *
 * `index` salts the call id. Two turns carrying identical reasoning under one stamp would otherwise
 * produce one id twice, and a transcript may not hold two calls with one id.
 */
export function transcribeOne(message, spec, names, maxChars = null, index = 0) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	// The text form rewrites the turn's own blocks; the toolcall form keeps the same reasoning and puts it
	// in the argument of a call instead, so the two forms differ only in where the cot lands.
	if (spec.form !== "toolcall") return canonical(message, spec, names, maxChars) ?? message;
	const { reasoning, reply } = splitTurn(message, spec, names);
	if (!reasoning) return message;
	const cot = clampCot(reasoning, maxChars);
	if (!cot.trim()) return message;
	// The pair carries the reasoning; the turn keeps what it did besides reasoning, which is its reply and
	// its calls. The two forms differ in where the cot lands and in nothing else, so a visible reply is
	// never lost to the form that writes a call.
	const pair = cotPair(cot, spec.name, pairId(`${index}${NUL}${cot}`, message), message);
	return [...pair, ...turnWithoutReasoning(message, reply)];
}

/**
 * The whole list transcribed. Returns the input array itself when nothing changed, so a request with
 * nothing to promote allocates nothing.
 *
 * A turn already preceded by a cot pair is the case the pair exists for, not an exception. The pair is
 * that turn's fence: the reasoning goes into the pair's `thought`, and the turn keeps only what it did
 * besides reasoning. Writing a second fence onto the turn instead would show one turn two traces, which
 * is the one shape a transcript may not hold.
 *
 * The pair keeps its id. It is derived from the cot and the turn, and the index that salts it moves
 * when messages are inserted, so recomputing it here would rewrite an id the transcript already holds.
 */
export function transcribeHistory(messages, spec, names, maxChars = null) {
	if (!Array.isArray(messages) || !spec) return messages;
	let changed = false;
	const out = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const pair = afterCotPair(messages, index, names) ? messages[index - 2] : null;
		// A pair answers an assistant turn with blocks. Anything else behind one is not the pair's turn, and
		// dropping blocks from it would be losing a message the pair never spoke for. The content guard is the
		// same one `transcribeOne` makes: reading a turn the writer cannot read must not throw.
		if (pair && message?.role === "assistant" && Array.isArray(message.content)) {
			const { reasoning, reply } = splitTurn(message, spec, names);
			// Nothing readable: the pair is already the whole trace (or belongs to a reasoning-only turn
			// ahead of this one), and this message stays as it is.
			if (!reasoning) {
				out.push(message);
				continue;
			}
			// The same bound the fence would get: merge into the pair's existing thought without discarding it.
			const merged = mergedPair(pair, reasoning, names, maxChars);
			if (merged) {
				out[out.length - 2] = merged;
				changed = true;
			}
			const turn = turnWithoutReasoning(message, reply);
			if (turn.length === 1 && sameBlocks(turn[0].content, message.content)) {
				out.push(message);
				continue;
			}
			changed = true;
			out.push(...turn);
			continue;
		}
		const done = transcribeOne(message, spec, names, maxChars, index);
		if (done === message) {
			out.push(message);
			continue;
		}
		changed = true;
		out.push(...(Array.isArray(done) ? done : [done]));
	}
	return changed ? out : messages;
}

/**
 * The pair `pair` with `cot` written into its argument, or null when it already says exactly that.
 *
 * The argument is read through the same strip the writers apply, so a cot that carries a tag cannot
 * close the fence early. Nothing else about the pair changes: not its id, not its stamp, not its
 * result message.
 */
function mergedPair(pair, reasoning, names, maxChars) {
	const call = pair.content.find((block) => isCotCall(block, names));
	if (!call || typeof call.arguments?.thought !== "string") return null;
	const existing = stripTags(call.arguments.thought, names).trim();
	const incoming = stripTags(reasoning, names).trim();
	const pieces = [];
	for (const piece of [existing, incoming]) {
		if (!piece) continue;
		const core = piece.endsWith(TRUNCATED) ? piece.slice(0, -TRUNCATED.length) : piece;
		if (pieces.some((seen) => seen.includes(core))) continue;
		for (let i = pieces.length - 1; i >= 0; i--) {
			if (pieces[i].endsWith(TRUNCATED) && piece.includes(pieces[i].slice(0, -TRUNCATED.length))) pieces.splice(i, 1);
		}
		pieces.push(piece);
	}
	const cot = clampCot(pieces.join("\n\n"), maxChars);
	if (!cot || cot === call.arguments.thought) return null;
	return {
		...pair,
		content: pair.content.map((block) => (block === call ? { ...call, arguments: { ...call.arguments, thought: cot } } : block)),
	};
}
