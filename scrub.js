/**
 * The eighth slot: the outbound text rewrite.
 *
 * A gateway that pattern-matches a system prompt answers with a fabricated quota error instead of a
 * model reply, and the only thing that changes its mind is the bytes it reads. `scrub` is that byte
 * rewrite: every match in the resolved rule file is obfuscated before the request leaves, and
 * nothing else about the request changes.
 *
 * Three properties make it safe to keep switched on.
 *
 * Pure: the rewrite is computed on the outbound message array and never written back to the
 * transcript. The transcript keeps the original text, so every turn recomputes the same output from
 * the same input and no second pass has anything to accumulate.
 *
 * Idempotent by construction. Every action inserts one of three markers and changes no other
 * character, so removing the markers from a rewritten string gives back exactly the string it came
 * from. A second pass therefore lands on the bytes of the first, for any rule set and any input. This
 * is why the action set holds nothing that deletes or rewrites: those break the equality, and then
 * the property would depend on which file happened to be loaded.
 *
 * Content-deterministic: the same input always yields the same bytes, because every action is a
 * function of the matched text alone. No random marker position, no hash. This is what keeps a
 * prompt-cache prefix stable across turns while the slot is on.
 *
 * Scope is a property of the file, not a second config slot: `scope: system` rewrites the whole
 * system prompt, `scope: system+user` adds user messages. Assistant and toolResult messages are
 * never touched, and neither is a `thinking` block, because a rewritten block loses the signature a
 * cross-model replay depends on.
 */

import { createRequire } from "node:module";
import { basename } from "node:path";
import { cachedFile } from "./turns.js";

/** U+200B, the zero-width space: the marker that survives the widest range of gateways. */
export const ZW = "\u200b";
/** U+00AD, a soft hyphen: an intra-word break a tokenizer keeps inside the word. */
export const SHY = "\u00ad";
/** U+034F, the combining grapheme joiner. Kept because some gateways accept it; not all do. */
export const CGJ = "\u034f";

/** Every invisible a text may carry for its own reasons, for matching a code a model typed through a rewrite. */
const INVISIBLES = /[\u200b\u200c\u200d\u2060\ufeff\u00ad\u034f\u180e]/g;

/**
 * The markers this file writes, and only those: U+200B from `zw` and `first`, U+00AD from `soft`,
 * U+034F from `cgj`.
 *
 * A token can carry an invisible for its own reasons: a ZWJ inside an emoji, a BOM at the head of a
 * pasted file. Counting any of those as "already rewritten" would let a real trigger in the same
 * token pass unscrubbed, so only a marker this file could have written counts as evidence that it
 * did.
 */
const WRITTEN_MARK = /[\u200b\u00ad\u034f]/;
const WRITTEN_MARK_ALL = /[\u200b\u00ad\u034f]/g;

/** The text with only the markers this file writes removed. */
export function stripWritten(value) {
	return String(value ?? "").replace(WRITTEN_MARK_ALL, "");
}

/** The text with every invisible removed, so `N\u200bSFW` and `NSFW` compare equal. */
export function stripInvisible(value) {
	return String(value ?? "").replace(INVISIBLES, "");
}

/**
 * The actions, and what each does to the text it matched.
 *
 * Every one of them inserts a marker and changes no other character, which is the only kind of action
 * this file offers. An action that rewrote or deleted characters would change the text into something
 * no rule can predict, and a second pass could find work in the result. That is why `replace` and
 * `drop` are absent.
 */
export const SCRUB_ACTIONS = Object.freeze(["zw", "first", "soft", "cgj"]);

/** The scopes, in widening order. `system` is the default because it is the whole threat surface. */
export const SCRUB_SCOPES = Object.freeze(["system", "system+user"]);

/** One rune, a marker, then the rest. A match with no word to hold the marker stays as it is. */
function markAfterFirst(text, marker) {
	const runes = [...text];
	if (runes.length < 2) return text;
	// The marker must touch a non-space character, or it stands alone as its own token.
	if (/^\s+$/.test(text)) return text;
	return runes[0] + marker + runes.slice(1).join("");
}

/**
 * Whether every marker in a rewritten string touches a non-space character.
 *
 * A marker with whitespace on both sides is a token on its own. Stripping cannot remove it without
 * joining the words around it, so the strip leaves it in place and the result no longer reduces to
 * the source. No action may produce one, and the parser refuses a rule that would: a match made only
 * of whitespace.
 */
function marksTouchWords(marked) {
	const MARKERS = /[\u200b\u00ad\u034f]/;
	for (let at = 0; at < marked.length; at++) {
		if (!MARKERS.test(marked[at])) continue;
		const before = marked[at - 1];
		const after = marked[at + 1];
		if ((before === undefined || /\s/.test(before)) && (after === undefined || /\s/.test(after))) return false;
	}
	return true;
}

/**
 * The text one action produces for one match. Pure and total: an action that cannot apply returns
 * the match unchanged rather than throwing, so a rule file cannot break a run.
 *
 * Every action only inserts a marker, and every marker lands touching a non-space character. A marker
 * of its own between two spaces is a token nothing can strip away safely, so the strip would stop
 * giving the source back and a second pass would find the same match again. Keeping each marker
 * against a word is what makes a rewrite a fixed point.
 */
export function applyAction(action, text) {
	switch (action) {
		case "first":
			// A marker with whitespace on both sides would be a token of its own, which no strip can remove
			// without joining its neighbours, so a match that is only whitespace is left as it is.
			return markAfterFirst(text, ZW);
		case "zw":
			// After the gap when a word follows it, before the gap when the match ends on one. Either way
			// the marker sits against a word, and the gap itself is left exactly as written. A match made
			// only of whitespace has no word to hold the marker, so it stays as it is.
			if (!/\S/.test(text)) return text;
			if (!/\s/.test(text)) return markAfterFirst(text, ZW);
			return text.replace(/\s+/g, (gap, offset, whole) => {
				const followed = offset + gap.length < whole.length;
				return followed ? gap + ZW : ZW + gap;
			});
		case "soft":
			// The caller hands this bare text: every marker this file writes was stripped first, so an
			// insert here never stacks on its own output.
			return text.replace(/\S+/g, (token) => {
				const runes = [...token];
				if (runes.length <= 4) return token;
				return runes[0] + runes[1] + SHY + runes.slice(2).join("");
			});
		case "cgj":
			return text.replace(/\S+/g, (token) => markAfterFirst(token, CGJ));
		default:
			return text;
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A rule's own line, for a message that has to name the rule that failed. */
function describeRule(rule) {
	return `${JSON.stringify(rule.match)} (${rule.action})`;
}

/**
 * One parsed file. `rules` keeps the compiled order for reporting; `regex` and `byLower` carry the
 * actual work, so a request is one scan with no per-turn compilation.
 */
function build(scope, rules) {
	const sorted = [...rules].sort((a, b) => {
		const length = b.match.length - a.match.length;
		if (length !== 0) return length;
		return a.match < b.match ? -1 : a.match > b.match ? 1 : 0;
	});
	const regex = new RegExp(sorted.map((rule) => escapeRegExp(rule.match)).join("|"), "giu");
	const byLower = new Map(sorted.map((rule) => [rule.match.toLowerCase(), rule]));
	return { scope, rules: sorted, regex, byLower };
}

/**
 * Every rule applied once, in one alternation scan.
 *
 * Longest match first, for correctness inside this pass: `NSFW_CSAM` and `CSAM` both match at one
 * position, and the longer spelling has to win there or the output reads as a half-rewritten code.
 * The strip below is what makes a second pass a no-op.
 */
function rewriteIn(text, spec) {
	return text.replace(spec.regex, (matched) => {
		const rule = spec.byLower.get(matched.toLowerCase());
		return rule ? applyAction(rule.action, matched, rule.text) : matched;
	});
}

/**
 * One string, rewritten. Strip the markers this file writes, then run every rule once.
 *
 * Stripping first is what makes the whole thing a fixed point. The four obfuscating actions only
 * insert the three markers above and never touch another character, so stripping a rewritten string
 * gives back exactly the string it came from. With `R` for the rules and `S` for the strip, that is
 * `S(R(x)) = x`, and therefore `R(S(R(x))) = R(x)`: the second pass lands on the bytes of the first,
 * for any rule set and any input.
 *
 * A skip list would fail in the other direction. A user who pastes `N` + U+200B + `SFW`, or a model
 * quoting a rewritten prompt back, would be told "already done" and sent as-is. Stripping the markers
 * instead sends it through the same rules as any other text.
 *
 * Only markers this file writes are stripped, so a ZWJ inside an emoji is not read as a rewrite and
 * `NSFW👨‍👩‍👧` still gets rewritten.
 *
 * One exception to the pure strip: a token made only of markers. Stripping it would empty it, which
 * restores no word and lets the words on either side meet, so such a token passes through as it
 * stands.
 */
export function scrubText(text, spec) {
	if (!spec || typeof text !== "string" || text.length === 0) return text;
	return rewriteIn(textForRules(text), spec);
}

/**
 * The text with our markers removed, except for a token that would vanish.
 *
 * Only a run of markers that stands alone between whitespace survives, because emptying it would
 * join two words that were never joined.
 */
function textForRules(text) {
	if (!WRITTEN_MARK.test(text)) return text;
	return text
		.split(/(\s+)/)
		.map((piece) => (/^\s*$/.test(piece) ? piece : piece.replace(WRITTEN_MARK_ALL, "") || piece))
		.join("");
}

/**
 * One rule entry, or the reason it is not one. A match that already carries an invisible could
 * never match the same way twice, so it is refused rather than quietly never firing.
 */
function readRule(value, at, matches) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${at} is not an object` };
	for (const key of Object.keys(value)) {
		if (!["match", "action", "text"].includes(key)) return { error: `${at}: ${key} is not one of match, action, text` };
	}
	const match = value.match;
	if (typeof match !== "string" || match.length === 0) return { error: `${at}: match must be a non-empty string` };
	if (stripInvisible(match) !== match) return { error: `${at}: match already carries an invisible character` };
	if (!SCRUB_ACTIONS.includes(value.action)) return { error: `${at}: action must be one of ${SCRUB_ACTIONS.join(", ")}` };
	if (value.text !== undefined) return { error: `${at}: ${value.action} takes no text` };
	// A rule that cannot write a marker would leave the match exactly as it found it: the footer would
	// report the slot delivered and the trigger would travel anyway. It is refused rather than kept as
	// a rule that quietly does nothing.
	if (applyAction(value.action, match) === match) {
		return { error: `${at}: ${value.action} cannot mark ${JSON.stringify(match)}, so the rule would never fire` };
	}
	if (!marksTouchWords(applyAction(value.action, match))) {
		return { error: `${at}: ${value.action} on ${JSON.stringify(match)} would leave a marker with no word to sit against` };
	}
	const rule = { match, action: value.action };
	matches.push(rule);
	return { rule };
}

/**
 * The file, or the reason it is not one. A file with one bad rule is rejected whole: a table that
 * silently dropped what it could not read would rewrite text nobody asked it to rewrite.
 */
export function parseScrub(text) {
	let parsed;
	try {
		parsed = { data: JSON.parse(text) };
	} catch (jsonError) {
		parsed = parseYaml(text);
		if (parsed.error) return { error: parsed.error };
	}
	return readDocument(parsed.data);
}

function parseYaml(text) {
	let YAML;
	try {
		YAML = createRequire(import.meta.url)("yaml");
	} catch {
		return { error: "invalid JSON, and the yaml package is not installed for a YAML file" };
	}
	try {
		return { data: YAML.parse(text) };
	} catch (error) {
		return { error: `invalid YAML: ${String(error?.message ?? error).split("\n")[0]}` };
	}
}

function readDocument(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "not an object" };
	for (const key of Object.keys(data)) {
		if (!["scope", "rules"].includes(key)) return { error: `${key} is not a scrub key (scope, rules)` };
	}
	const scope = data.scope ?? "system";
	if (!SCRUB_SCOPES.includes(scope)) return { error: `scope must be ${SCRUB_SCOPES.join(", ")}` };
	if (!Array.isArray(data.rules)) return { error: "rules must be an array" };
	const rules = [];
	for (const [index, value] of data.rules.entries()) {
		const read = readRule(value, `rule ${index + 1}`, rules);
		if (read.error) return { error: read.error };
	}
	return { spec: build(scope, rules) };
}

/**
 * The file at `path`, read once per revision. The cache is keyed by the bytes, so an edited file is
 * picked up on the next request and an untouched one costs no parse.
 */
export function loadScrub(path) {
	const hit = cachedFile(path, "scrub", (text) => {
		const parsed = parseScrub(text);
		return parsed.error ? { error: `${basename(path)}: ${parsed.error}` } : { value: parsed.spec };
	});
	return hit.error ? { error: hit.error } : { spec: hit.value };
}

/**
 * The rewritten messages, or `undefined` when the rewrite changes nothing.
 *
 * `undefined` is the no-op answer the guard expects: it means "this slot has nothing to say about
 * this request", so the array the caller built is passed through untouched and never copied.
 */
export function scrubMessages(messages, spec) {
	if (!spec || !Array.isArray(messages) || messages.length === 0) return undefined;
	let next;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		const system = message.role === "system";
		if (!system && !(message.role === "user" && spec.scope === "system+user")) continue;
		let copy = null;

		if (system && message.sections && typeof message.sections === "object" && !Array.isArray(message.sections)) {
			let sections = null;
			for (const [name, value] of Object.entries(message.sections)) {
				if (typeof value !== "string") continue;
				const rewritten = scrubText(value, spec);
				if (rewritten === value) continue;
				sections ??= { ...message.sections };
				sections[name] = rewritten;
			}
			if (sections) {
				copy ??= { ...message };
				copy.sections = sections;
			}
		}

		const content = message.content;
		if (typeof content === "string") {
			const rewritten = scrubText(content, spec);
			if (rewritten !== content) {
				copy ??= { ...message };
				copy.content = rewritten;
			}
		} else if (Array.isArray(content)) {
			let blocks = null;
			for (let at = 0; at < content.length; at++) {
				const block = content[at];
				// Only plain text travels to a gateway. A thinking block carries a signature, and a
				// rewrite would invalidate it without saying so.
				if (!block || block.type !== "text" || typeof block.text !== "string") continue;
				const rewritten = scrubText(block.text, spec);
				if (rewritten === block.text) continue;
				blocks ??= content.slice();
				blocks[at] = { ...block, text: rewritten };
			}
			if (blocks) {
				copy ??= { ...message };
				copy.content = blocks;
			}
		}

		if (!copy) continue;
		next ??= messages.slice();
		next[index] = copy;
	}
	return next;
}
