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
 */

const NUL = "\u0000";

/** The reply a fabricated cot call gets. One short token, so the pair costs a few bytes and says
 * nothing a model could mistake for an answer. */
export const COT_ACK = "OK";

/** The id prefix `pairId` always writes. */
export const PAIR_PREFIX = "cot_";

/** A text block that carries nothing but a turn marker, which `beat` writes. */
export const MARKER_ONLY = /^\[turn \d+\]$/;

/** The marker `beat` writes. One per block, at the very end, so stripping it is unambiguous. */
export const BEAT_MARK = /\n?\[turn \d+\]$/;

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
 * turn file speaks as the live model, a refilled foreign turn keeps the foreign stamp, and a
 * transcribed turn carries a cleared model stamp so downstream serializers treat it as unsigned.
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

/** Whether a text block opens with a fence in `name` (allowing leading whitespace). */
export function opensWith(text, name) {
	return new RegExp(`^\\s*<${escapeTag(name)}>`, "i").test(String(text ?? ""));
}

/** Whether a call block is a fabricated cot call under one of `names`. */
export function isCotCall(block, names) {
	return block?.type === "toolCall" && names.includes(block.name) && String(block.id ?? "").startsWith(PAIR_PREFIX);
}

/**
 * Index of a live (model-issued, non-`cot_`) tool call to one of `names` carrying a string `thought`
 * argument, or -1. When the model calls the cot tool itself, merging into that call avoids placing a
 * second fabricated pair ahead of the turn.
 */
export function findLiveCotCall(content, names) {
	if (!Array.isArray(content)) return -1;
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (
			block?.type === "toolCall" &&
			names.includes(block.name) &&
			!String(block.id ?? "").startsWith(PAIR_PREFIX) &&
			typeof block.arguments?.thought === "string"
		) {
			return i;
		}
	}
	return -1;
}

/** Whether a turn already carries a cot fence or fabricated cot call under any configured name. */
export function fenced(blocks, names) {
	for (const block of blocks ?? []) {
		if (isCotCall(block, names)) return true;
		if (block?.type === "text" && names.some((name) => opensWith(block.text, name))) return true;
	}
	return false;
}

/** Whether a message is the fabricated cot call message this extension writes. */
export function isCotPairMessage(message, names) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
	const blocks = message.content.filter((block) => !(block?.type === "text" && MARKER_ONLY.test(String(block.text ?? ""))));
	if (blocks.length !== 1) return false;
	const block = blocks[0];
	return isCotCall(block, names) && typeof block.arguments?.thought === "string";
}

/** Whether the message at `index` is preceded by a fabricated cot pair that answers it. */
export function afterCotPair(messages, index, names) {
	return index >= 2 && messages[index - 1]?.role === "toolResult" && isCotPairMessage(messages[index - 2], names);
}

/** Readable thinking text carried in `thinking` blocks, skipping redacted or empty entries. */
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

/** `text` with every trailing `[turn <digits>]` suffix and preceding whitespace removed in one backward scan. */
export function stripTrailingMarkers(text) {
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

/** A block's text with its turn marker, replacing any previous trailing marker idempotently. */
export function beatText(text, turn) {
	const rest = String(text ?? "").replace(BEAT_MARK, "");
	return rest ? `${rest}\n[turn ${turn}]` : `[turn ${turn}]`;
}

/**
 * Stamp `[turn <turn>]` onto the last existing text block of an assistant message.
 *
 * Tool-only steps and fabricated `cotPair` call messages carry no text blocks and are left untouched:
 * inserting a synthetic text block ahead of `toolCall` breaks signed carrier adjacency when
 * `transcribe` is off, double-numbers `toolcall:` turns, and teaches models to speak bare markers
 * before silent tool calls.
 */
export function beatOne(message, turn) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	let last = -1;
	for (let i = 0; i < message.content.length; i++) {
		if (
			message.content[i]?.type === "text" &&
			String(message.content[i].text ?? "").replace(BEAT_MARK, "").trim() !== ""
		) {
			last = i;
		}
	}
	if (last < 0) return message;
	const next = message.content.slice();
	const text = beatText(next[last].text, turn);
	if (text === next[last].text) return message;
	next[last] = { ...next[last], text };
	return { ...message, content: next };
}

/** The whole message list with turn markers on assistant replies that carry visible text. */
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
 * `text` with every fence tag in `names` removed, opening and closing alike, in either case, in a
 * single linear pass that catches tags assembled by deleting inner ones (`<<think>think>`).
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
	const limit = maxLen + 2;
	const out = [];
	const opens = [];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "<") {
			opens.push(out.length);
			out.push(ch);
			continue;
		}
		if (ch === ">" && opens.length > 0) {
			const start = opens[opens.length - 1];
			const span = out.length - start;
			if (span >= 2 && span <= limit) {
				const slash = out[start + 1] === "/";
				const from = start + (slash ? 2 : 1);
				if (out.length > from) {
					let candidate = "";
					for (let k = from; k < out.length; k++) candidate += out[k];
					if (tags.has(candidate.toLowerCase())) {
						out.length = start;
						opens.pop();
						continue;
					}
				}
			}
			opens.length = 0;
			out.push(ch);
			continue;
		}
		out.push(ch);
	}
	return out.join("");
}

function containsParagraphSlice(haystack, needle) {
	return (
		haystack === needle ||
		haystack.startsWith(`${needle}\n\n`) ||
		haystack.endsWith(`\n\n${needle}`) ||
		haystack.includes(`\n\n${needle}\n\n`)
	);
}

/**
 * Join non-empty trimmed segments. Deduplicates exact matches and `\n\n`-delimited paragraph
 * supersets without ever dropping arbitrary substrings inside sentences.
 */
export function mergeCotPieces(pieces) {
	const out = [];
	for (const raw of pieces) {
		const piece = String(raw ?? "").trim();
		if (!piece) continue;
		if (out.some((seen) => containsParagraphSlice(seen, piece))) continue;
		for (let i = out.length - 1; i >= 0; i--) {
			if (containsParagraphSlice(piece, out[i])) out.splice(i, 1);
		}
		out.push(piece);
	}
	return out.join("\n\n");
}

/** Match a configured opening fence tag at the very start of `text` (ignoring leading whitespace). */
function matchLeadingOpenTag(text, names) {
	const match = /^\s*<([A-Za-z][A-Za-z0-9_-]*)>/.exec(text);
	if (!match) return null;
	const lowered = match[1].toLowerCase();
	const known = (names ?? []).some((name) => String(name).toLowerCase() === lowered);
	return known ? { tag: lowered, afterOpen: match[0].length } : null;
}

/** Strip the separator between a closing fence tag and the visible reply that follows it. */
function trimAfterFence(text) {
	if (/^[ \t]*\r?\n/.test(text)) return text.replace(/^(?:[ \t]*\r?\n)+/, "");
	return text.replace(/^[ \t]+/, "");
}

/**
 * Parse an assistant message into `{ summary, interior, reply, hadFence }`.
 *
 * A text CoT fence is recognized only when the first non-whitespace text block opens with `<tag>`
 * for some tag in `names`. Balanced `<tag>` / `</tag>` pairs are tracked so code examples inside
 * reasoning or inside the visible reply never swallow visible prose. An unclosed leading `<tag>`
 * counts as reasoning only when `stopReason === "length"` cut the turn off mid-thought; otherwise
 * the text stays visible prose. `reply` is never passed through `stripTags`, keeping literal tag
 * examples in user-facing answers and code blocks intact.
 */
function thinkingSummary(message, names) {
	const thinking = [];
	for (const block of message?.content ?? []) {
		if (block?.type !== "thinking" || block.redacted) continue;
		const text = String(block.thinking ?? "").trim();
		if (!text || text === "[Reasoning redacted]") continue;
		const cleaned = stripTags(text, names).trim();
		if (cleaned) thinking.push(cleaned);
	}
	return mergeCotPieces(thinking);
}

export function splitTurn(message, names) {
	const summary = thinkingSummary(message, names);
	const texts = [];
	for (const block of message?.content ?? []) {
		if (block?.type === "text") texts.push(String(block.text ?? ""));
	}
	for (let i = texts.length - 1; i >= 0; i--) {
		if (texts[i].replace(BEAT_MARK, "").trim() !== "") {
			texts[i] = texts[i].replace(BEAT_MARK, "");
			break;
		}
		texts[i] = "";
	}
	const b0 = texts.findIndex((t) => t.trim() !== "");
	if (b0 < 0) return { summary, interior: "", reply: "", hadFence: false };

	const lead = matchLeadingOpenTag(texts[b0], names);
	if (!lead) {
		const rawReply = texts.slice(b0).join("\n\n").replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
		return { summary, interior: "", reply: stripTrailingMarkers(rawReply), hadFence: false };
	}

	const tail = [texts[b0].slice(lead.afterOpen), ...texts.slice(b0 + 1)];
	const tagPattern = new RegExp(`<(\\/)?${escapeTag(lead.tag)}>`, "gi");
	let depth = 1;
	let closeBlock = -1;
	let closeStart = -1;
	let closeEnd = -1;
	for (let i = 0; i < tail.length; i++) {
		tagPattern.lastIndex = 0;
		for (let hit = tagPattern.exec(tail[i]); hit; hit = tagPattern.exec(tail[i])) {
			depth += hit[1] ? -1 : 1;
			if (depth === 0) {
				closeBlock = i;
				closeStart = hit.index;
				closeEnd = hit.index + hit[0].length;
				break;
			}
		}
		if (depth === 0) break;
	}

	if (closeBlock < 0) {
		if (message.stopReason === "length") {
			const interior = mergeCotPieces(tail.map((part) => stripTags(part, names)));
			return { summary, interior, reply: "", hadFence: true };
		}
		const rawReply = texts.slice(b0).join("\n\n").replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
		return { summary, interior: "", reply: stripTrailingMarkers(rawReply), hadFence: false };
	}

	const insideParts = [...tail.slice(0, closeBlock), tail[closeBlock].slice(0, closeStart)];
	const interior = mergeCotPieces(insideParts.map((part) => stripTags(part, names)));
	const closeTail = tail[closeBlock].slice(closeEnd);
	const restAfter = tail.slice(closeBlock + 1);
	const rawAfter = (closeTail ? [closeTail, ...restAfter] : restAfter).join("\n\n");
	const reply = stripTrailingMarkers(trimAfterFence(rawAfter).trimEnd());
	return { summary, interior, reply, hadFence: true };
}

function sameBlocks(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function scrubTextBlock(block, text) {
	if (block?.type === "text" && block.textSignature === undefined && block.text === text) return block;
	return { type: "text", text };
}

function scrubOtherBlock(block) {
	if (block?.type !== "toolCall") return block;
	if (block.thoughtSignature === undefined && block.namespace === undefined) return block;
	const next = { ...block };
	delete next.thoughtSignature;
	delete next.namespace;
	return next;
}

/**
 * Clear model-affinity fields and signatures on a transcribed assistant message so Pi's own
 * `transformMessages` treats it as unsigned cross-model history: `toolCall.id` pairing suffixes are
 * stripped or normalized per target adapter without any adapter-specific code here.
 */
function scrubEnvelope(message, content) {
	const cleanEnvelope =
		message.model === "" &&
		message.responseId === undefined &&
		message.providerThinkingLevel === undefined;
	if (cleanEnvelope && sameBlocks(content, message.content)) return message;
	const next = { ...message, model: "", content };
	delete next.responseId;
	delete next.providerThinkingLevel;
	return next;
}

function scrubbedNonThinkingNonText(message, replaceIdx = -1, mergedThought = "") {
	const out = [];
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block?.type === "thinking" || block?.type === "text") continue;
		const clean = scrubOtherBlock(block);
		if (i === replaceIdx && clean.arguments?.thought !== mergedThought) {
			out.push({ ...clean, arguments: { ...clean.arguments, thought: mergedThought } });
		} else {
			out.push(clean);
		}
	}
	return out;
}

function scrubbedUnfencedContent(message, replaceIdx = -1, mergedThought = "") {
	const out = [];
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block?.type === "thinking") continue;
		if (block?.type === "text") {
			if (!String(block.text ?? "").trim()) continue;
			out.push(scrubTextBlock(block, block.text));
			continue;
		}
		const clean = scrubOtherBlock(block);
		if (i === replaceIdx && clean.arguments?.thought !== mergedThought) {
			out.push({ ...clean, arguments: { ...clean.arguments, thought: mergedThought } });
		} else {
			out.push(clean);
		}
	}
	return out;
}

function resolveReasoning(summary, interior, mode) {
	return mode === "strict" ? interior : mergeCotPieces([summary, interior]);
}

/**
 * Transcribe one assistant message in `"merge"` (`transcribe: true`) or `"strict"`
 * (`transcribe: "strict"`) mode.
 *
 * Returns either a single message, an array of replacement messages (`[]` when an empty/opaque-only
 * thinking turn had nothing left after stripping, or `[...pair, turn]` for `toolcall:`), or the
 * original `message` reference when already in canonical transcribed form.
 */
export function transcribeOne(message, spec, names, index = 0, mode = "merge") {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	if (isCotPairMessage(message, names)) {
		const cleaned = message.content.map((b) => scrubOtherBlock(b));
		return scrubEnvelope(message, cleaned);
	}
	// Already transcribed on an earlier pass: preserve visible text (including any literal <tag> examples) as-is.
	if (message.model === "" && !message.content.some((b) => b?.type === "thinking")) {
		const content = scrubbedUnfencedContent(message);
		return content.length === 0 ? [] : scrubEnvelope(message, content);
	}

	const { summary, interior, reply, hadFence } = splitTurn(message, names);

	if (spec.form === "toolcall") {
		const liveIdx = findLiveCotCall(message.content, names);
		if (liveIdx >= 0) {
			const liveCall = message.content[liveIdx];
			const liveThought = stripTags(liveCall.arguments.thought, names).trim();
			// Already merged by forge on an earlier step: strip thinking/signatures without re-parsing visible reply text.
			if (summary && mergeCotPieces([summary, liveThought]) === liveThought) {
				const content = scrubbedUnfencedContent(message);
				return content.length === 0 ? [] : scrubEnvelope(message, content);
			}
			const merged = mergeCotPieces(mode === "strict" ? [interior, liveThought] : [summary, interior, liveThought]);
			const content = hadFence
				? [...(reply ? [scrubTextBlock(message.content[0], reply)] : []), ...scrubbedNonThinkingNonText(message, liveIdx, merged)]
				: scrubbedUnfencedContent(message, liveIdx, merged);
			return content.length === 0 ? [] : scrubEnvelope(message, content);
		}
		const cot = resolveReasoning(summary, interior, mode);
		const rest = hadFence
			? [...(reply ? [scrubTextBlock(message.content[0], reply)] : []), ...scrubbedNonThinkingNonText(message)]
			: scrubbedUnfencedContent(message);
		if (!cot) {
			return rest.length === 0 ? [] : scrubEnvelope(message, rest);
		}
		const id = pairId(`${index}${NUL}${cot}`, message);
		const pair = cotPair(cot, spec.name, id, { provider: message.provider, api: message.api, model: "" });
		return rest.length === 0 ? pair : [...pair, scrubEnvelope(message, rest)];
	}

	const cot = resolveReasoning(summary, interior, mode);
	if (!cot) {
		const content = hadFence
			? [...(reply ? [scrubTextBlock(message.content[0], reply)] : []), ...scrubbedNonThinkingNonText(message)]
			: scrubbedUnfencedContent(message);
		return content.length === 0 ? [] : scrubEnvelope(message, content);
	}

	const fencedText = reply ? `${cotText(cot, spec.name)}\n\n${reply}` : cotText(cot, spec.name);
	const content = [scrubTextBlock(message.content[0], fencedText), ...scrubbedNonThinkingNonText(message)];
	return scrubEnvelope(message, content);
}

/** Merge reasoning into an existing preceding `cotPair` call message, scrubbing its stamp as needed. */
export function mergedPair(pair, reasoning, names, scrub = false) {
	const call = pair.content.find((block) => isCotCall(block, names));
	if (!call || typeof call.arguments?.thought !== "string") return null;
	const existing = stripTags(call.arguments.thought, names).trim();
	const incoming = stripTags(reasoning, names).trim();
	const cot = mergeCotPieces([existing, incoming]);
	const nextCall = cot && cot !== call.arguments.thought
		? { ...scrubOtherBlock(call), arguments: { ...call.arguments, thought: cot } }
		: scrub ? scrubOtherBlock(call) : call;
	const nextContent = nextCall === call ? pair.content : pair.content.map((b) => (b === call ? nextCall : b));
	if (scrub) {
		const done = scrubEnvelope(pair, nextContent);
		return done === pair ? null : done;
	}
	return nextContent === pair.content ? null : { ...pair, content: nextContent };
}

/**
 * Transcribe an entire message list under `mode` (`"merge"` or `"strict"`). Returns the input array
 * itself when nothing changed.
 */
export function transcribeHistory(messages, spec, names, mode = "merge") {
	if (!Array.isArray(messages) || !spec) return messages;
	let changed = false;
	const out = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const pair = afterCotPair(messages, index, names) ? out[out.length - 2] : null;
		if (pair && message?.role === "assistant" && Array.isArray(message.content)) {
			// When already transcribed (model === "") or preceded by a forged pair (messages[index - 2].model !== ""),
			// any leading <tag> left on message is literal user-facing prose rather than an unextracted fence.
			const alreadyExtracted = message.model === "" || messages[index - 2]?.model !== "";
			const { summary, interior, reply, hadFence } = alreadyExtracted
				? { summary: thinkingSummary(message, names), interior: "", reply: "", hadFence: false }
				: splitTurn(message, names);
			const cot = resolveReasoning(summary, interior, mode);
			if (cot) {
				const updatedPair = mergedPair(pair, cot, names, true);
				if (updatedPair) {
					out[out.length - 2] = updatedPair;
					changed = true;
				}
			}
			const rest = hadFence
				? [...(reply ? [scrubTextBlock(message.content[0], reply)] : []), ...scrubbedNonThinkingNonText(message)]
				: scrubbedUnfencedContent(message);
			if (rest.length === 0) {
				changed = true;
				continue;
			}
			const doneTurn = scrubEnvelope(message, rest);
			if (doneTurn !== message) changed = true;
			out.push(doneTurn);
			continue;
		}
		const done = transcribeOne(message, spec, names, index, mode);
		if (done === message) {
			out.push(message);
			continue;
		}
		changed = true;
		out.push(...(Array.isArray(done) ? done : [done]));
	}
	return changed ? out : messages;
}
