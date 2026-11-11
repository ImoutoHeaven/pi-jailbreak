/**
 * The fabricated conversation: the file format, its parse, its cache, and its mapping to messages.
 *
 * One YAML item is one message, and item order is conversation order. The block is spliced ahead of
 * the first real user message, so the model reads it as history rather than as a request, and it is
 * rebuilt from the file on every request: the transcript records nothing for it.
 *
 * Rejection is whole. A file with one bad item injects nothing, because a half-fabricated history
 * would leave the model an assistant turn nobody answered. The structural rules are the ones a
 * transcript needs: a `result` answers the `call` before it, the sequence begins with `user`,
 * and no assistant is left with empty content, which pi drops from a transcript.
 *
 * Pure functions and one cache. `toMessages` is the only one that runs per request.
 */

import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

// A missing package disables injection and leaves the system-prompt half working, so the import is
// guarded: failing here at load time would take the whole extension with it.
const require = createRequire(import.meta.url);
let YAML = null;
try {
	YAML = require("yaml");
} catch {
	YAML = null;
}

const MISSING = "the yaml package is not installed (run npm install in the pi-leviathan directory)";
const KEYS = ["user", "assistant", "result"];
/** The keys each role's mapping may carry. `result` takes a string and no mapping at all. */
const TAKES = { user: ["text"], assistant: ["text", "cot", "call", "native"] };
const CALL_KEYS = ["name", "arguments"];

/** One file, read and parsed once per revision, per kind of parse. */
const files = new Map();

/**
 * The first line of a parser message. The yaml package puts the line and the column in it, and the
 * lines after it are the source excerpt, which a report does not need.
 */
function firstLine(error) {
	const text = String(error?.message ?? error).split("\n")[0].trim().replace(/:$/, "");
	return text || "unreadable";
}

/**
 * Read one file once per revision, per kind of parse. The mtime and the size are what make a
 * revision, and the parse result is kept whether it succeeded or failed, so a bad file reports once
 * and a good one costs one stat per call.
 *
 * The kind is part of the key: a config may point `prompt` and `turns` at the same path, and each
 * side parses those bytes its own way.
 *
 * `parse` returns `{ value }` or `{ error }`. Both turns and the prompt text cache through here.
 */
export function cachedFile(path, kind, parse) {
	const key = `${kind}\u0000${path}`;
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return { error: `${basename(path)} unreadable` };
	}
	const hit = files.get(key);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
	let entry;
	try {
		entry = { mtimeMs: stat.mtimeMs, size: stat.size, ...parse(readFileSync(path, "utf8")) };
	} catch {
		entry = { mtimeMs: stat.mtimeMs, size: stat.size, error: `${basename(path)} unreadable` };
	}
	files.set(key, entry);
	return entry;
}

/**
 * The specs of one turn file, or the reason it was rejected. The error keeps the file name, so a
 * report says which file it read.
 */
export function loadTurns(path) {
	const hit = cachedFile(path, "turns", (text) => {
		const parsed = parseTurns(text);
		return parsed.error ? { error: `${basename(path)}: ${parsed.error}` } : { value: parsed.specs };
	});
	return hit.error ? { error: hit.error } : { specs: hit.value };
}

/**
 * A role value as the mapping it stands for. A string is the shorthand for `{text}`.
 */
function fieldsOf(role, value, at) {
	if (typeof value === "string") return { fields: { text: value } };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${at}: ${role} must be a string or a mapping` };
	for (const key of Object.keys(value)) {
		if (!TAKES[role].includes(key)) return { error: `${at}: ${role} carries ${key}, which it does not take` };
	}
	return { fields: value };
}

/** The `call` of an assistant, or null when it carries none. */
function callOf(value, at) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${at}: call must be a mapping` };
	for (const key of Object.keys(value)) {
		if (!CALL_KEYS.includes(key)) return { error: `${at}: call carries ${key}, which it does not take` };
	}
	if (typeof value.name !== "string" || !value.name.trim()) return { error: `${at}: call needs a name` };
	const args = value.arguments ?? {};
	if (!args || typeof args !== "object" || Array.isArray(args)) return { error: `${at}: call arguments must be a mapping` };
	return { call: { name: value.name, arguments: { ...args } } };
}

/**
 * The normalized sequence, or the reason the document is rejected.
 *
 * ```
 * { role: "user",       text }
 * { role: "assistant",  cot, text, call: {name, arguments} | null }
 * { role: "toolResult", name, text }
 * ```
 */
export function parseTurns(text) {
	if (!YAML) return { error: MISSING };
	let documents;
	try {
		documents = YAML.parseAllDocuments(text);
	} catch (error) {
		return { error: firstLine(error) };
	}
	if (documents.length === 0) return { error: "the file is empty" };
	if (documents.length > 1) return { error: "the file holds more than one document" };
	const [document] = documents;
	if (document.errors.length > 0) return { error: firstLine(document.errors[0]) };
	let items;
	try {
		items = document.toJS();
	} catch (error) {
		return { error: firstLine(error) };
	}
	if (!Array.isArray(items)) return { error: "the document is not a sequence" };
	if (items.length === 0) return { error: "the sequence is empty" };

	const specs = [];
	// The item whose `call` is still waiting for its `result`.
	let pending = -1;
	for (let index = 0; index < items.length; index++) {
		const at = `item ${index + 1}`;
		const item = items[index];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `${at} is not a mapping` };
		const keys = Object.keys(item);
		if (keys.length !== 1) return { error: `${at} needs exactly one of ${KEYS.join(", ")}` };
		const [key] = keys;
		if (!KEYS.includes(key)) return { error: `${at}: ${key} is not one of ${KEYS.join(", ")}` };
		// A `result` first has no call to answer, which the result branch below says precisely.
		if (index === 0 && key === "assistant") return { error: "the first item must be user" };
		// The result follows the call it answers, so anything else leaves that call unanswered.
		if (key !== "result" && pending >= 0) return { error: `${at}: the call in item ${pending + 1} has no result` };

		if (key === "user") {
			const read = fieldsOf("user", item.user, at);
			if (read.error) return { error: read.error };
			const { text } = read.fields;
			if (typeof text !== "string") return { error: `${at}: text must be a string` };
			if (!text.trim()) return { error: `${at}: empty text` };
			specs.push({ role: "user", text });
			continue;
		}

		if (key === "assistant") {
			const read = fieldsOf("assistant", item.assistant, at);
			if (read.error) return { error: read.error };
			const { text = "", cot = "", call, native } = read.fields;
			if (typeof text !== "string") return { error: `${at}: text must be a string` };
			if (typeof cot !== "string") return { error: `${at}: cot must be a string` };
			if (native !== undefined && (typeof native !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(native))) {
				return { error: `${at}: native must be a reasoning field name, such as reasoning_content` };
			}
			if (native !== undefined && !cot.trim()) return { error: `${at}: native needs a cot` };
			let normalized = null;
			if (call !== undefined) {
				const readCall = callOf(call, at);
				if (readCall.error) return { error: readCall.error };
				normalized = readCall.call;
			}
			if (!text.trim() && !normalized) return { error: `${at}: an assistant needs text or a call` };
			// `native` is present only when the file names it, so a spec for a file that does not is the
			// same object it was before this key existed.
			specs.push({ role: "assistant", cot, text, call: normalized, ...(native === undefined ? {} : { native }) });
			if (normalized) pending = index;
			continue;
		}

		if (typeof item.result !== "string") return { error: `${at}: result must be a string` };
		if (!item.result.trim()) return { error: `${at}: empty text` };
		if (pending < 0) {
			const second = specs.at(-1)?.role === "toolResult";
			return { error: second ? `${at}: a second result for one call` : `${at}: a result needs a preceding call` };
		}
		specs.push({ role: "toolResult", name: specs[pending].call.name, text: item.result });
		pending = -1;
	}
	if (pending >= 0) return { error: `item ${pending + 1}: the call has no result` };
	return { specs };
}

/** The zero usage record every fabricated message carries: the request pays for none of it. */
function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * The specs as pi messages. Pure object construction: nothing here reads the clock, the transcript
 * or the file, so two calls with the same specs, model and tag produce identical bytes.
 *
 * The fabricated cot is written at the head of the reply, fenced in the tag `cotTag` names, so the
 * turn reads as reasoning the assistant wrote down followed by what it said. The fence is text and
 * nothing else: a text block is the one block every message carries unchanged.
 *
 * `native` names a reasoning field instead, and it is used on exactly one adapter.
 * `openai-completions` replays a thinking block whose signature is a field name by writing that
 * field, so the cot reaches the wire as `reasoning_content` (or `reasoning`, or `reasoning_text`).
 * Every other adapter is handed the text fence: a non-empty signature is a real signature to
 * `anthropic-messages`, which sends it and has the request rejected, and
 * `openai-responses-shared` parses it as JSON and throws. The choice follows the live model's api,
 * which is part of the model's identity, so it costs a cache miss only when the same
 * provider and id are re-registered on another api — a change that misses anyway.
 *
 * A fabricated block is stamped with the live model, so it survives `transformMessages` and pi reads
 * it as this model's own earlier turn rather than as history carried over from somewhere else.
 */
export function toMessages(specs, { provider, api, model, cotTag }) {
	const messages = [];
	// The id of the last call, which the result after it answers.
	let lastCall = null;
	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index];
		if (spec.role === "user") {
			messages.push({ role: "user", content: [{ type: "text", text: spec.text }], timestamp: 0 });
			continue;
		}
		if (spec.role === "toolResult") {
			messages.push({
				role: "toolResult",
				toolCallId: lastCall,
				toolName: spec.name,
				content: [{ type: "text", text: spec.text }],
				isError: false,
				usage: zeroUsage(),
				timestamp: 0,
			});
			continue;
		}
		const content = [];
		// The cot leads the reply, fenced so it reads as reasoning the assistant wrote down rather
		// than as a second thing it said. One block, so the fence and the reply stay one turn.
		const tag = cotTag || "think";
		// `native` names a reasoning field, and only `openai-completions` replays a thinking block that
		// way. On any other adapter a block whose signature is a field name is worse than the fence:
		// `anthropic-messages` sends that string as a real signature and the provider rejects the
		// request, and `openai-responses-shared` JSON.parses it and throws. So the native form is used
		// only where it is understood, and every other adapter gets the text fence it already reads.
		const native = api === "openai-completions" ? (spec.native ?? null) : null;
		const lead = spec.cot && !native ? `<${tag}>\n${spec.cot}\n</${tag}>` : "";
		const visible = [lead, spec.text].filter(Boolean).join("\n\n");
		if (visible) content.push({ type: "text", text: visible });
		// Reasoning first, then what was said: a fabricated turn reads in the order the model writes.
		if (spec.cot && native) content.unshift({ type: "thinking", thinking: spec.cot, thinkingSignature: native });
		if (spec.call) {
			lastCall = `tc_${index}`;
			content.push({ type: "toolCall", id: lastCall, name: spec.call.name, arguments: spec.call.arguments });
		}
		messages.push({
			role: "assistant",
			content,
			api,
			provider,
			model,
			usage: zeroUsage(),
			// `transformMessages` drops an assistant marked error or aborted, so this is load-bearing.
			stopReason: spec.call ? "toolUse" : "stop",
			timestamp: 0,
		});
	}
	return messages;
}
