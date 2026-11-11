/**
 * The one value a session hands to the processes it starts.
 *
 * A pi session is an OS process, and a process it spawns inherits its environment. That is the
 * channel: the parent writes its decision, the child reads it.
 *
 * Only a pi process writes it. A value is accepted when its publisher pid is this process's parent
 * (a direct child reading what its session wrote) or this process itself (a reload reading back its
 * own mirror). Anything else is discarded and overwritten. A wrapper that puts a shell between the
 * two changes the parent pid, so that path falls back to the config.
 *
 * JSON, because model ids carry `@`, `/` and `.`, and any single-character separator would split
 * them.
 */

import { sessionSettings } from "./config.js";

export const ENV_NAME = "PI_LEVIATHAN";

/** `provider/id`, the key a rule matches and a value is published under. */
export function modelKey(model) {
	return `${model?.provider ?? ""}/${model?.id ?? ""}`;
}

/** The payload for `value`, or null when the process holds no decision. An empty settings object
 * writes no `s`, so a session that set nothing publishes the bytes it always published. */
export function encode(value, pid) {
	if (!value) return null;
	const out = { k: value.key, p: pid };
	const settings = value.settings && typeof value.settings === "object" ? value.settings : null;
	if (settings && Object.keys(settings).length) out.s = { ...settings };
	return JSON.stringify(out);
}

/**
 * Parse a value, or null when it is malformed or came from outside this process tree. `self`
 * marks a value this process wrote, which survives its own next session.
 *
 * The settings travel with the answer: an absent `s` is an empty set, and a malformed one rejects the
 * whole payload, because a half-applied answer would publish a decision nobody wrote.
 */
export function decode(raw, { ppid, pid }) {
	if (!raw) return null;
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	if (typeof data.k !== "string" || !data.k) return null;
	if (data.p !== ppid && data.p !== pid) return null;
	const read = sessionSettings(data.s === undefined ? {} : data.s);
	if (read.error) return null;
	return { key: data.k, self: data.p === pid, settings: read.settings };
}

/** Write the process mirror: the decision, or nothing at all. */
export function publish(env, value, pid) {
	const encoded = encode(value, pid);
	if (encoded === null) delete env[ENV_NAME];
	else env[ENV_NAME] = encoded;
}

/** Whether a value governs this model. `*` governs every model in the tree. */
export function applies(value, key) {
	return value.key === "*" || value.key.toLowerCase() === key.toLowerCase();
}
