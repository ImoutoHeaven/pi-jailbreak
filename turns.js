/**
 * The fabricated conversation: the file format, its parse, its cache, and its mapping to messages.
 *
 * One YAML item is one message, and item order is conversation order. The block is spliced ahead of
 * the first non-system message, so the model reads it as history rather than as a request, and it is
 * rebuilt from the file on every request: the transcript records nothing for it.
 */

import { createRequire } from "node:module";
import { cotPair, cotText, pairId, zeroUsage } from "./cot.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const require = createRequire(import.meta.url);
let YAML = null;
try {
	YAML = require("yaml");
} catch {
	YAML = null;
}

const MISSING = "the yaml package is not installed (run npm install in the pi-leviathan directory)";
const KEYS = ["user", "assistant", "result"];
const TAKES = { user: ["text"], assistant: ["text", "cot", "call"] };
const CALL_KEYS = ["name", "arguments"];

const files = new Map();

function firstLine(error) {
	const text = String(error?.message ?? error).split("\n")[0].trim().replace(/:$/, "");
	return text || "unreadable";
}

export function cachedFile(path, kind, parse) {
	const key = `${kind}\u0000${path}`;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { error: `${basename(path)} unreadable` };
	}
	const hit = files.get(key);
	if (hit && hit.text === text) return hit;
	const entry = { text, ...parse(text) };
	files.set(key, entry);
	return entry;
}

export function loadTurns(path) {
	const hit = cachedFile(path, "turns", (text) => {
		const parsed = parseTurns(text);
		return parsed.error ? { error: `${basename(path)}: ${parsed.error}` } : { value: parsed.specs };
	});
	return hit.error ? { error: hit.error } : { specs: hit.value };
}

function fieldsOf(role, value, at) {
	if (typeof value === "string") return { fields: { text: value } };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${at}: ${role} must be a string or a mapping` };
	for (const key of Object.keys(value)) {
		if (!TAKES[role].includes(key)) return { error: `${at}: ${role} carries ${key}, which it does not take` };
	}
	return { fields: value };
}

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
	let pending = -1;
	for (let index = 0; index < items.length; index++) {
		const at = `item ${index + 1}`;
		const item = items[index];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `${at} is not a mapping` };
		const keys = Object.keys(item);
		if (keys.length !== 1) return { error: `${at} needs exactly one of ${KEYS.join(", ")}` };
		const [key] = keys;
		if (!KEYS.includes(key)) return { error: `${at}: ${key} is not one of ${KEYS.join(", ")}` };
		if (index === 0 && key === "assistant") return { error: "the first item must be user" };
		if (key !== "result" && pending >= 0) return { error: `${at}: the call in item ${pending + 1} has no result` };

		if (key === "user") {
			const read = fieldsOf("user", item.user, at);
			if (read.error) return { error: read.error };
			const { text } = read.fields;
			if (typeof text !== "string") return { error: `${at}: text must be a string` };
			if (!text.trim()) return { error: `${at}: empty text` };
			specs.push({ role: "user", text: text.trim() });
			continue;
		}

		if (key === "assistant") {
			const read = fieldsOf("assistant", item.assistant, at);
			if (read.error) return { error: read.error };
			const { text = "", cot = "", call } = read.fields;
			if (typeof text !== "string") return { error: `${at}: text must be a string` };
			if (typeof cot !== "string") return { error: `${at}: cot must be a string` };
			let normalized = null;
			if (call !== undefined) {
				const readCall = callOf(call, at);
				if (readCall.error) return { error: readCall.error };
				normalized = readCall.call;
			}
			if (!text.trim() && !normalized) return { error: `${at}: an assistant needs text or a call` };
			specs.push({ role: "assistant", cot: cot.trim(), text: text.trim(), call: normalized });
			if (normalized) pending = index;
			continue;
		}

		if (typeof item.result !== "string") return { error: `${at}: result must be a string` };
		if (!item.result.trim()) return { error: `${at}: empty text` };
		if (pending < 0) {
			const second = specs.at(-1)?.role === "toolResult";
			return { error: second ? `${at}: a second result for one call` : `${at}: a result needs a preceding call` };
		}
		specs.push({ role: "toolResult", name: specs[pending].call.name, text: item.result.trim() });
		pending = -1;
	}
	if (pending >= 0) return { error: `item ${pending + 1}: the call has no result` };
	return { specs };
}

export function toMessages(specs, { provider, api, model, cot }) {
	const messages = [];
	const stamp = { provider, api, model };
	let lastCall = null;
	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index];
		const text = String(spec.text ?? "").trim();
		if (spec.role === "user") {
			messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
			continue;
		}
		if (spec.role === "toolResult") {
			messages.push({
				role: "toolResult",
				toolCallId: lastCall,
				toolName: spec.name,
				content: [{ type: "text", text }],
				isError: false,
				usage: zeroUsage(),
				timestamp: 0,
			});
			continue;
		}
		const cotValue = String(spec.cot ?? "").trim();
		if (cotValue && cot?.form === "toolcall") {
			messages.push(...cotPair(cotValue, cot.name, pairId(`${index}\u0000${cotValue}`, stamp), stamp));
		}
		const content = [];
		const fence = cotValue && cot?.form !== "toolcall" ? cotText(cotValue, cot.name) : "";
		const visible = [fence, text].filter(Boolean).join("\n\n");
		if (visible) content.push({ type: "text", text: visible });
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
			stopReason: spec.call ? "toolUse" : "stop",
			timestamp: 0,
		});
	}
	return messages;
}
