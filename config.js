/**
 * The rule table and the resolver.
 *
 * A session model matches at most one rule: the first one whose provider and model both match.
 * Both fields are optional, a missing field matches anything, and a pattern without `*` is exact.
 * `*` is the only wildcard, and every other regex metacharacter is escaped first, so a dot in a
 * model id stays a dot.
 *
 * The resolver is pure, so the check runs it as a table without a session.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

export const CONFIG_NAME = "jailbreak.json";
export const DEFAULT_PROMPT = "prompt.md";
export const DEFAULT_TURNS = "turn0.yml";
export const MODES = Object.freeze(["jailbreak", "normal"]);
export const INHERITS = Object.freeze(["keyed", "tree", "none"]);
/** The tag that fences the cot at the head of the reply. `<think>` and `think` name the same tag. */
export const DEFAULT_COT_TAG = "think";
/** The keys a config file and a rule carry. A file takes these and nothing else. */
const CONFIG_KEYS = Object.freeze(["default", "inherit", "prompt", "turns", "cotTag", "rules"]);
const RULE_KEYS = Object.freeze(["mode", "provider", "model", "prompt", "turns", "cotTag"]);
const TAG_ERROR = "cotTag must be a tag name, such as think or <think>";

/** The keys a session answer carries. `turns` is three-state, and the rest are single values. */
export const SETTINGS_KEYS = Object.freeze(["prompt", "turns", "cotTag", "inherit"]);

/** A tag name from either spelling, or null when the value is not one. A bracketed value has to be
 * exactly one tag, so a stray `>` or a second pair is rejected rather than trimmed away. */
export function tagName(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const name = /^<([^<>]+)>$/.exec(trimmed)?.[1] ?? trimmed;
	return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ? name : null;
}

/** What a session uses when no config file loads. */
export function emptyConfig(dir) {
	return { default: "normal", inherit: "keyed", prompt: DEFAULT_PROMPT, turns: DEFAULT_TURNS, cotTag: DEFAULT_COT_TAG, rules: [], dir, path: null };
}

/**
 * The file a session reads. It sits in the agent directory: a persona is a property of the
 * session, and a repository copy would decide what the model gets for everyone who opens it.
 */
export function configPath(env = process.env, home = homedir()) {
	if (env?.PI_JAILBREAK_CONFIG) return env.PI_JAILBREAK_CONFIG;
	// Pi's own override decides where the agent directory is, and the config sits in it.
	const agentDir = env?.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	return join(agentDir, CONFIG_NAME);
}

/** `*` matches any run of characters; every other character matches itself. Case-insensitive. */
export function globMatch(pattern, value) {
	const escaped = String(pattern)
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\\\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(String(value));
}

/**
 * The absolute path a rule's prompt names. `prompt.md` is the text that ships with the extension,
 * so a config anywhere resolves it to the package copy; every other relative path sits next to
 * the config file.
 */
export function promptPath(config, prompt) {
	if (isAbsolute(prompt)) return prompt;
	if (prompt === DEFAULT_PROMPT) return join(PACKAGE_DIR, prompt);
	return join(config.dir, prompt);
}

/**
 * The absolute path a `turns` value names. `turn0.yml` is the text that ships with the extension, so
 * a config anywhere resolves it to the package copy; every other relative path sits next to the
 * config file.
 */
export function turnsPath(config, turns) {
	if (isAbsolute(turns)) return turns;
	if (turns === DEFAULT_TURNS) return join(PACKAGE_DIR, turns);
	return join(config.dir, turns);
}

/**
 * A `turns` value is three-state: absent takes the shipped file, `null` turns injection off, a
 * string names a file. Every other type rejects the file whole, so a typo never reads as "off".
 */
function turnsValue(value) {
	return value === null || (typeof value === "string" && value !== "");
}

/**
 * Parse and validate one file. A file with a single bad value is rejected whole: a table that
 * silently dropped the entry it could not read would answer with a rule the user did not write.
 */
export function parseConfig(text, dir) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return { error: `invalid JSON: ${error.message}` };
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "not an object" };
	for (const key of Object.keys(data)) {
		if (!CONFIG_KEYS.includes(key)) return { error: `${key} is not a config key (${CONFIG_KEYS.join(", ")})` };
	}
	const mode = data.default ?? "normal";
	if (!MODES.includes(mode)) return { error: `default must be ${MODES.join(" or ")}` };
	const inherit = data.inherit ?? "keyed";
	if (!INHERITS.includes(inherit)) return { error: `inherit must be ${INHERITS.join(", ")}` };
	const prompt = data.prompt ?? DEFAULT_PROMPT;
	if (typeof prompt !== "string" || !prompt) return { error: "prompt must be a non-empty string" };
	// Absent takes the file that ships with the package: the fabricated conversation is on unless a
	// config turns it off with `null`.
	const turns = data.turns === undefined ? DEFAULT_TURNS : data.turns;
	if (!turnsValue(turns)) return { error: "turns must be a non-empty string or null" };
	// The tag names the fence the fabricated cot is written in, and either spelling of it is the
	// same tag.
	const cotTag = data.cotTag === undefined ? DEFAULT_COT_TAG : tagName(data.cotTag);
	if (!cotTag) return { error: TAG_ERROR };
	const rules = data.rules ?? [];
	if (!Array.isArray(rules)) return { error: "rules must be an array" };
	const out = [];
	for (const [index, rule] of rules.entries()) {
		const at = `rule ${index + 1}`;
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) return { error: `${at} is not an object` };
		for (const key of Object.keys(rule)) {
			if (!RULE_KEYS.includes(key)) return { error: `${at}: ${key} is not a rule key (${RULE_KEYS.join(", ")})` };
		}
		if (!MODES.includes(rule.mode)) return { error: `${at} needs mode: ${MODES.join(" or ")}` };
		for (const field of ["provider", "model", "prompt"]) {
			if (rule[field] === undefined) continue;
			if (typeof rule[field] !== "string" || !rule[field]) return { error: `${at}: ${field} must be a non-empty string` };
		}
		// A rule keeps `undefined` apart from `null`: the first inherits the config-level value, the
		// second turns injection off even when the config names a file.
		if (rule.turns !== undefined && !turnsValue(rule.turns)) return { error: `${at}: turns must be a non-empty string or null` };
		const ruleTag = rule.cotTag === undefined ? undefined : tagName(rule.cotTag);
		if (rule.cotTag !== undefined && !ruleTag) return { error: `${at}: ${TAG_ERROR}` };
		out.push({ mode: rule.mode, provider: rule.provider, model: rule.model, prompt: rule.prompt, turns: rule.turns, cotTag: ruleTag });
	}
	return { config: { default: mode, inherit, prompt, turns, cotTag, rules: out, dir, path: null } };
}

/** The first rule that matches, or the default. `ruleIndex` is -1 for the default. */
export function resolve(config, model) {
	const provider = String(model?.provider ?? "");
	const id = String(model?.id ?? "");
	for (let ruleIndex = 0; ruleIndex < config.rules.length; ruleIndex++) {
		const rule = config.rules[ruleIndex];
		if (rule.provider !== undefined && !globMatch(rule.provider, provider)) continue;
		if (rule.model !== undefined && !globMatch(rule.model, id)) continue;
		return { mode: rule.mode, prompt: rule.prompt ?? config.prompt, turns: rule.turns === undefined ? config.turns : rule.turns, cotTag: rule.cotTag ?? config.cotTag, ruleIndex };
	}
	return { mode: config.default, prompt: config.prompt, turns: config.turns, cotTag: config.cotTag, ruleIndex: -1 };
}

/** A path a session setting names. A typed path means the session's cwd, and an absolute one stays. */
function absolutePath(value) {
	return isAbsolute(value) ? value : resolvePath(process.cwd(), value);
}

/** One key's value, or the reason it is not one. `undefined` removes the key. */
function settingValue(key, value) {
	if (value === undefined) return { value: undefined };
	if (key === "prompt") {
		if (typeof value !== "string" || !value.trim()) return { error: "prompt must be a non-empty path" };
		return { value: absolutePath(value.trim()) };
	}
	if (key === "turns") {
		if (value === null) return { value: null };
		if (typeof value !== "string" || !value.trim()) return { error: "turns must be a non-empty path or null" };
		return { value: absolutePath(value.trim()) };
	}
	if (key === "cotTag") {
		const tag = tagName(value);
		if (!tag) return { error: TAG_ERROR };
		return { value: tag };
	}
	if (key === "inherit") {
		const wanted = typeof value === "string" ? value.toLowerCase() : value;
		if (!INHERITS.includes(wanted)) return { error: `inherit must be ${INHERITS.join(", ")}` };
		return { value: wanted };
	}
	// A key the list above does not name has no value, so a key added to `SETTINGS_KEYS` without a
	// branch here is rejected instead of validating as something it is not.
	return { error: `unknown setting: ${key}` };
}

/**
 * A whole settings object, as the channel and the process answer carry it. Every key is checked and
 * every path normalized, so a value written by one side names the same file on the other. Rejection
 * is whole: a half-applied answer would publish a decision nobody wrote.
 */
export function sessionSettings(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "settings must be an object" };
	const out = {};
	for (const key of Object.keys(value)) {
		if (!SETTINGS_KEYS.includes(key)) return { error: `settings carries ${key}, which it does not take` };
		const read = settingValue(key, value[key]);
		if (read.error) return { error: read.error };
		if (read.value !== undefined) out[key] = read.value;
	}
	return { settings: out };
}

/**
 * One assignment from the command. `default` removes the key, `off`/`none`/`null` turn injection
 * off, and any other value is a path, so a file literally named `off` is `./off`.
 */
export function settingFromCommand(name, value) {
	const key = name === "cottag" ? "cotTag" : name;
	if (!SETTINGS_KEYS.includes(key)) return { error: `unknown setting: ${name}` };
	const text = String(value ?? "").trim();
	const keyword = text.toLowerCase();
	if (keyword === "default") return { key, value: undefined };
	if (key === "turns" && (keyword === "off" || keyword === "none" || keyword === "null")) return { key, value: null };
	if (!text) return { error: `${key} needs a value` };
	const read = settingValue(key, text);
	if (read.error) return { error: read.error };
	return { key, value: read.value };
}

/**
 * Read once per file revision: the prompt and the table are read at run start, not per request.
 * A file that does not load is reported and the empty config takes over.
 */
const cache = new Map();

export function loadConfig(path, fallbackDir) {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return { config: emptyConfig(fallbackDir) };
	}
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
		if (hit.config) return { config: { ...hit.config, path } };
		return { config: emptyConfig(fallbackDir), error: `${path}: ${hit.error}` };
	}
	let parsed;
	try {
		parsed = parseConfig(readFileSync(path, "utf8"), dirname(path));
	} catch (readError) {
		parsed = { error: readError.message };
	}
	cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, config: parsed.config, error: parsed.error });
	if (parsed.config) return { config: { ...parsed.config, path } };
	return { config: emptyConfig(fallbackDir), error: `${path}: ${parsed.error}` };
}
