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
	return isCotCall(block, names) && Boolean(block.arguments && "thought" in block.arguments);
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
	const tags = new Set((names ?? []).map((name) => String(name).toLowerCase()));
	const body = String(text ?? "");
	if (tags.size === 0 || !body.includes("<")) return body;
	let out = "";
	// Where every `<` in `out` sits, so the text between the innermost one and the current `>` is the
	// only candidate to check.
	const opens = [];
	for (const ch of body) {
		out += ch;
		if (ch === "<") {
			opens.push(out.length - 1);
			continue;
		}
		if (ch !== ">" || opens.length === 0) continue;
		const at = opens[opens.length - 1];
		const raw = out.slice(at + 1, out.length - 1).toLowerCase();
		if (!tags.has(raw.startsWith("/") ? raw.slice(1) : raw)) continue;
		out = out.slice(0, at);
		opens.pop();
	}
	return out;
}

/** The tag pair a fence for `name` is written with. */
function fenceTags(name) {
	return { open: `<${name}>`, close: `</${name}>` };
}

/**
 * What is between the fence's opening tag and its **last** closing tag, or null when the block carries
 * no fence for `name`.
 *
 * The last closing tag, not the first: a model that learned the syntax leaves its own closing tag in
 * its reasoning, and reading to the first one would take the model's tag as the end of the fence.
 *
 * A fence with no closing tag at all is a half-written fence, and its interior is everything after the
 * opening one. That shape is common — the model writes `<think>` and then its reasoning, never closing
 * it — and treating it as "no fence" would make this module prepend a second opening tag in front of
 * the first.
 *
 * The comparison is case-insensitive in both directions. `opensWith` accepts `<THINK>` as a fence, so a
 * case-sensitive anchor here would leave an uppercase fence unfenced to the repair while the turn still
 * counts as fenced: the repair never runs and the signature stays beside it forever.
 */
function fenceInterior(text, name) {
	const body = String(text ?? "");
	const { open, close } = fenceTags(name);
	if (!body.toLowerCase().startsWith(open.toLowerCase())) return null;
	// The open tag is ASCII (the config validates the name), so its length is the same whatever case the
	// block wrote it in.
	const rest = body.slice(open.length);
	const end = fenceEnd(rest, close);
	return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Where the fence ends: the index of our closing tag in `rest`, or -1.
 *
 * `cotText` writes the closing tag on a line of its own, so the fence ends at the **last closing tag
 * that starts a line**. A reply that merely mentions the tag writes it mid-sentence — `never write
 * </think>` — which is the common case and the one this separates.
 *
 * It separates the two shapes the previous rule could not: a cot that closes an idea, breaks a
 * paragraph and keeps reasoning, and a reply that quotes the tag and continues. Under the blank-line
 * rule those were the same bytes, so either reading had to lose one — the first-tag reading left 16 of
 * 16 real cots with their reasoning in the reply slot, and the last-tag reading swallowed the reply.
 *
 * Two readings, because the text cannot say more than this:
 *
 *  1. the last line-initial tag with nothing after it, or with a blank line and the reply after it.
 *     A cot that breaks a paragraph and keeps reasoning ends this way, and such a turn often has no
 *     reply at all. The same disjunction is also what keeps a reply that quoted the tag on its own
 *     line out of the cot: prose follows that tag rather than a blank line, so it fails here and the
 *     scan falls through to the fence's real close.
 *  2. nothing qualified: the last line-initial tag, then the plain blank-line reading, then the last
 *     tag at all. That is the shape of a fence someone else wrote, whose close is not line-initial.
 *
 * One shape still misreads, and it is a real one: a reply that quotes the bare close on a line of its
 * own **and** leaves a blank line after it is drawn into the cot, because that is byte-for-byte the
 * shape in rule 1. Every positional anchor has a counterexample of this kind — first tag, last tag,
 * last blank-line tag, line-initial tag — so a choice has to be made, and the corpus decides which is
 * worth losing: the line-initial rule heals the reasoning in all 16 cases that produced this module.
 * The shape is pinned in the check so a future change makes the trade again on purpose.
 *
 * The blank-line rule stays as a fallback for a fence whose close is not line-initial, followed by the
 * last tag when nothing else applies. A half-written fence — no closing tag at all — runs to the end.
 *
 * The scan runs over `rest` itself with a case-insensitive pattern, never over a lowered copy. A
 * lowercase expansion can change length — U+0130 is one code unit that lowercases to two — so every
 * index taken from a lowered string would be off by the difference, and slicing `rest` with it cuts
 * the tag in half and swallows the blank line the reply follows.
 *
 * The break is `\r?\n[ \t]*\r?\n`, not `\n\s*\n`: a block with CRLF line endings would never match, and
 * `\s` would eat the `\r` itself.
 */
function fenceEnd(rest, close) {
	const pattern = new RegExp(escapeTag(close), "gi");
	const hits = [];
	for (let hit = pattern.exec(rest); hit; hit = pattern.exec(rest)) hits.push({ at: hit.index, end: hit.index + hit[0].length });
	if (hits.length === 0) return -1;
	const last = hits[hits.length - 1];
	const lineStart = (hit) => hit.at === 0 || rest[hit.at - 1] === "\n";
	const blankAfter = (hit) => /^\r?\n[ \t]*\r?\n/.test(rest.slice(hit.end));
	// A closing tag that starts a line, with either nothing or a blank line and the reply behind it,
	// closes the fence. The LAST such tag: a cot that breaks a paragraph and keeps reasoning ends with
	// one, and such a turn often has no reply at all.
	for (let i = hits.length - 1; i >= 0; i--) {
		if (lineStart(hits[i]) && (rest.slice(hits[i].end).trim() === "" || blankAfter(hits[i]))) return hits[i].at;
	}
	// Nothing qualified: either every line-initial tag has prose behind it (a reply that began a line
	// by quoting the tag, which the loop above already passed over), or no tag starts a line at all.
	// A close that is not line-initial (a fence someone else wrote), then the last line-initial tag,
	// then the plain blank-line reading.
	for (let i = hits.length - 1; i >= 0; i--) if (lineStart(hits[i])) return hits[i].at;
	const blanked = hits.filter(blankAfter);
	return blanked.length ? blanked[0].at : last.at;
}
/**
 * A block's text with its fence rebuilt: the opening tag, the interior with every configured tag
 * removed, one closing tag, then whatever the block said after the fence. An unterminated fence is
 * closed here. A block whose fence is already whole and clean is returned unchanged, so a clean fence
 * stays byte-identical.
 *
 * Two shapes are left exactly as they are. A block whose interior still contains an opening tag has
 * more than one fence in it, so there is no single interior to rebuild, and choosing the last closing
 * tag would pull the second fence into the reasoning. A block whose fence is already whole and clean
 * is returned unchanged so a clean fence stays byte-identical.
 *
 * The tail is emitted raw, always. A reply that quotes the tag keeps its quotation either way, so a
 * tag in the tail is not a reason to skip the repair — skipping it would leave a stray closing tag
 * inside the fence, which is the defect this exists to heal.
 */
function repairFence(text, name, names) {
	const body = String(text ?? "");
	const interior = fenceInterior(body, name);
	if (interior === null) return body;
	const { open, close } = fenceTags(name);
	if (interior.toLowerCase().includes(open.toLowerCase())) return body;
	const rest = body.slice(open.length);
	const end = fenceEnd(rest, close);
	const terminated = end >= 0;
	const tail = terminated ? rest.slice(end + close.length) : "";
	const clean = stripTags(interior, names);
	if (terminated && clean === interior) return body;
	return `${open}${clean}${close}${tail}`;
}

/** The message with every fenced text block repaired, or the message itself when none needed it. */
function repaired(message, names) {
	let changed = false;
	const next = message.content.map((block) => {
		if (block?.type !== "text") return block;
		for (const name of names) {
			const text = repairFence(block.text, name, names);
			if (text === block.text) continue;
			changed = true;
			return { ...block, text };
		}
		return block;
	});
	return changed ? { ...message, content: next } : message;
}

/**
 * What a fenced turn says in its cot, stripped of tags, and only that.
 *
 * It reads the fence interior, never the whole turn: a reply after the fence, or a turn marker `beat`
 * appended, is not reasoning, and counting it would let a turn with an empty cot lose the reasoning
 * block that is its only trace.
 */
function fenceContent(message, spec, names) {
	if (spec.form === "toolcall") {
		const pair = message.content.find((block) => isCotCall(block, names));
		return pair && typeof pair.arguments?.thought === "string" ? stripTags(pair.arguments.thought, names).trim() : "";
	}
	for (const block of message.content) {
		if (block?.type !== "text") continue;
		for (const name of names) {
			const interior = fenceInterior(block.text, name);
			if (interior !== null) return stripTags(interior, names).trim();
		}
	}
	return "";
}

/** Whether a block is a reasoning trace a fence already vouches for. */
function signed(block) {
	return block?.type === "thinking" && Boolean(block.thinkingSignature);
}

/**
 * The message without its signed reasoning, or the message itself when it has none. A signature beside
 * a fence is the second trace the invariant forbids; an unsigned block is the model's own reasoning in
 * the native shape, and is left where it is.
 */
function dropSigned(message) {
	if (!Array.isArray(message?.content) || !message.content.some(signed)) return message;
	return { ...message, content: message.content.filter((block) => !signed(block)) };
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
 * A turn already carrying a fence is the case this slot exists for, not an exception. When the block
 * behind that fence is signed, the turn shows a fence and an encrypted trace at once — the state the
 * second invariant forbids. The signature is the piece that goes, and only the signature: a credential
 * vouches for reasoning it carried, and the fence in front of it is a different, readable trace.
 *
 * The two traces are not copies of each other. Measured over every such turn in a real session, the
 * summary behind the signature is absent from the fence, sometimes shorter and sometimes longer, so
 * promoting the block over the fence would overwrite what the model actually wrote with the
 * provider's summary of a trace it had already decided to write down. Dropping the signature keeps
 * both readable traces and removes the encrypted third, which is the one that carries nothing a
 * reader can use.
 *
 * One turn is left alone: a fenced turn with no signature, which is the loop closed by itself. There
 * is no state that records that the model learned; the absence of a signature is the whole test.
 *
 * The decision reads the message and nothing else, in particular not the live model. That is what
 * keeps a model switch free: the same history yields the same bytes whichever model asks for it.
 *
 * `index` salts the call id. Two turns carrying identical reasoning under one stamp would otherwise
 * produce one id twice, and a transcript may not hold two calls with one id.
 */
export function transcribeOne(message, spec, names, maxChars = null, index = 0) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	if (fenced(message.content, names)) {
		// Only a signed block is a second trace. A turn the model fenced itself and left unsigned is the
		// loop closed by itself, and rewriting it would change what the model said for nothing.
		if (!message.content.some(signed)) return message;
		// The fence this turn carries is the one place a stray tag survives: it was written by the model
		// or by an earlier request, and the unfenced path below never sees it again. Rebuilding it from
		// its interior is what keeps it closing where it should.
		const fixed = repaired(message, names);
		if (!fenceContent(fixed, spec, names)) return fixed;
		return [dropSigned(fixed)];
	}
	const own = ownCot(message);
	if (!own) return message;
	// The tags go before the fence is built, never after: ours is written by `cotText` below, so it can
	// not be a candidate.
	const cot = clampCot(stripTags(own, names), maxChars);
	if (!cot.trim()) return message;
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
 *
 * A turn already preceded by a cot pair is left alone. Promotion writes a pair ahead of the turn, so a
 * second pass over its own output would write a second pair in front of the same turn — which is the
 * one shape a transcript may not hold twice, and the reason this walks the list instead of deciding
 * each message on its own.
 */
export function transcribeHistory(messages, spec, names, maxChars = null) {
	if (!Array.isArray(messages) || !spec) return messages;
	let changed = false;
	const out = [];
	for (let index = 0; index < messages.length; index++) {
		if (afterCotPair(messages, index, names)) {
			// The reasoning is already in a pair ahead of this turn, so a fence would be a second trace. The
			// signature is not: it is the encrypted third, and it goes.
			const bare = dropSigned(messages[index]);
			if (bare !== messages[index]) changed = true;
			out.push(bare);
			continue;
		}		const done = transcribeOne(messages[index], spec, names, maxChars, index);
		if (done === messages[index]) {
			out.push(messages[index]);
			continue;
		}
		changed = true;
		out.push(...(Array.isArray(done) ? done : [done]));
	}
	return changed ? out : messages;
}
