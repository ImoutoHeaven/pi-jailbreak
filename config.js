/**
 * The rule table and the resolver.
 *
 * The record has seven slots and they are independent: `persona`, `gate`, `turns`, `forge`, `cot`,
 * `transcribe` and `beat`. Nothing here says "this model is a leviathan" — a model is whatever its
 * slots resolve to. That is the whole point: a model can carry forge alone, or persona and gate with
 * no turns, and no slot drags another along.
 *
 * Every slot resolves on its own, down the same four layers, and reports which layer answered:
 *
 *     session  ->  the first matching rule  ->  the file's `default`  ->  the built-in record
 *
 * The built-in record turns every switch off, so an extension with nothing configured changes
 * nothing. `cot` falls back to `text:think`, and the writers below are off.
 *
 * A rule matches by provider and model: both optional, a missing field matches anything, a pattern
 * without `*` is exact, and `*` is the only wildcard. Every other regex metacharacter is escaped
 * first, so a dot in a model id stays a dot. The first matching rule wins.
 *
 * The resolver is pure, so the check runs it as a table without a session.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

export const CONFIG_NAME = "leviathan.json";
/** The two files that ship with the extension. A slot set to `true` names one of them. */
export const DEFAULT_PROMPT = "prompt.md";
export const DEFAULT_TURNS = "turn0.yml";
export const INHERITS = Object.freeze(["keyed", "tree", "none"]);
export const TRANSCRIBE_MODES = Object.freeze([false, true, "strict"]);
/**
 * How the cot reaches a request, in the two forms it has. The form and the name are one value, so a
 * slot cannot say "toolcall" without saying which tool: `text:<tag>` fences the reasoning in a tag
 * at the head of the reply, `toolcall:<name>` sends it as the argument of that real tool's call.
 */
export const COT_FORMS = Object.freeze(["text", "toolcall"]);
/** The value a session uses when nothing names one. */
export const DEFAULT_COT = "text:think";
/**
 * Tool names a `toolcall:` form may not take: built-in Pi tools and standard companion extension
 * tools. A cot that borrows a real tool's name registers a second tool under that name, which
 * replaces the real tool in the session and makes fabricated calls indistinguishable from live ones.
 */
export const RESERVED_COT_NAMES = Object.freeze([
	"read",
	"write",
	"edit",
	"bash",
	"powershell",
	"ls",
	"find",
	"grep",
	"glob",
	"codemode",
	"tool_search",
	"ask_authorize_gate",
	"team",
	"subagent",
	"checkpoint",
	"history_read",
	"history_search",
	"history_list_items",
	"history_list_windows",
	"get_context_remaining",
]);

/** The slots, in the order the footer renders them. */
export const SLOTS = Object.freeze(["persona", "gate", "turns", "forge", "cot", "transcribe", "beat"]);
/** The switches, which are what a footer glyph and a panel row report as on or off. */
export const SWITCHES = Object.freeze(["persona", "gate", "turns", "forge", "transcribe", "beat"]);
/** The slots a session answer may carry. `inherit` is the scope, not a slot. */
export const SETTINGS_KEYS = Object.freeze([...SLOTS, "inherit"]);

const CONFIG_KEYS = Object.freeze(["default", "inherit", "rules"]);
const RULE_KEYS = Object.freeze(["provider", "model", ...SLOTS]);
const COT_ERROR = `cot must be text:<tag> or toolcall:<name>, and not ${RESERVED_COT_NAMES.join(", ")}`;
const PATH_ERROR = (slot) => `${slot} must be false, true, or a non-empty path`;
const BOOL_ERROR = (slot) => `${slot} must be false or true`;
const TRANSCRIBE_ERROR = 'transcribe must be false, true, or "strict"';

/**
 * The record a session uses when nothing is configured, and the tail of every resolution. Every switch
 * is off: installing the extension and writing no config changes no request.
 */
export function emptyRecord() {
	return { persona: false, gate: false, turns: false, forge: false, cot: DEFAULT_COT, transcribe: false, beat: false };
}

/**
 * One cot spec as `{ form, name }`, or null when the value is not one. The form prefix is required,
 * because a bare name cannot say whether the fence is a tag or a tool. The one tolerance left is
 * brackets around a text tag: `text:<think>` and `text:think` are one fence.
 */
export function cotSpec(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	const cut = text.indexOf(":");
	if (cut < 1) return null;
	const form = text.slice(0, cut).trim().toLowerCase();
	if (!COT_FORMS.includes(form)) return null;
	let name = text.slice(cut + 1).trim();
	const bracketed = /^<([^<>]+)>$/.exec(name)?.[1];
	if (bracketed !== undefined) {
		// A bracketed value has to be exactly one tag, and only the text form writes one.
		if (form !== "text") return null;
		name = bracketed;
	}
	if (form === "toolcall") {
		// A tool name travels to a provider as a function name, so the provider's own charset applies.
		if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) return null;
		if (RESERVED_COT_NAMES.includes(name.toLowerCase())) return null;
		return { form, name };
	}
	return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ? { form, name } : null;
}

/** A cot spec as the one string a config, a command and a channel payload all spell. */
export function cotLabel(spec) {
	return `${spec.form}:${spec.name}`;
}

/**
 * One path slot as the spec it names, or null when the value is not one. `true` means the file that
 * ships with the extension, so a config written on one machine reads the same on another.
 */
function pathSlot(value, shipped) {
	if (value === false) return { spec: false };
	if (value === true) return { spec: shipped };
	if (typeof value === "string" && value.trim() !== "") return { spec: value };
	return null;
}

/** One switch that takes no argument. */
function plainSlot(value) {
	return value === false || value === true ? { spec: value } : null;
}

/** The transcribe slot: off, full readable merge (`true`), or summary-free plaintext+fence (`"strict"`). */
function transcribeSlot(value) {
	return TRANSCRIBE_MODES.includes(value) ? { spec: value } : null;
}

/**
 * One slot from a value, or null when the value is invalid. Every slot rejects what it cannot read,
 * so a typo is never quietly read as "off".
 */
function slotSpec(slot, value) {
	if (slot === "persona") return pathSlot(value, DEFAULT_PROMPT);
	if (slot === "turns") return pathSlot(value, DEFAULT_TURNS);
	if (slot === "gate" || slot === "forge" || slot === "beat") return plainSlot(value);
	if (slot === "transcribe") return transcribeSlot(value);
	const cot = cotSpec(value);
	return cot ? { spec: cotLabel(cot) } : null;
}

/** A slot's error message, which names the slot and what it takes. */
function slotError(slot) {
	if (slot === "persona" || slot === "turns") return PATH_ERROR(slot);
	if (slot === "transcribe") return TRANSCRIBE_ERROR;
	if (slot === "cot") return COT_ERROR;
	return BOOL_ERROR(slot);
}

/**
 * The file a session reads. It sits in the agent directory: what a model does is a property of the
 * session, and a repository copy would decide it for everyone who opens the file.
 */
export function configPath(env = process.env, home = homedir()) {
	if (env?.PI_LEVIATHAN_CONFIG) return env.PI_LEVIATHAN_CONFIG;
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
 * The absolute path a `persona` spec names. The shipped name resolves to the package copy wherever
 * the config sits; every other relative path sits next to the config file.
 */
export function promptPath(config, spec) {
	if (isAbsolute(spec)) return spec;
	if (spec === DEFAULT_PROMPT) return join(PACKAGE_DIR, spec);
	return join(config.dir, spec);
}

/** The absolute path a `turns` spec names, resolved the same way. */
export function turnsPath(config, spec) {
	if (isAbsolute(spec)) return spec;
	if (spec === DEFAULT_TURNS) return join(PACKAGE_DIR, spec);
	return join(config.dir, spec);
}

/** One record from a parsed object, or the reason it is not one. Absent slots stay absent. */
function readRecord(value, keys, at) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${at} is not an object` };
	const prefix = at === "default" ? "default: " : `${at}: `;
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) return { error: `${prefix}${key} is not one of ${keys.join(", ")}` };
	}
	const record = {};
	for (const slot of SLOTS) {
		if (value[slot] === undefined) continue;
		const read = slotSpec(slot, value[slot]);
		if (!read) return { error: `${prefix}${slotError(slot)}` };
		record[slot] = read.spec;
	}
	return { record };
}

/**
 * Parse and validate one file. A file with a single bad value is rejected whole: a table that
 * silently dropped what it could not read would answer with a record nobody wrote.
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
		if (!CONFIG_KEYS.includes(key)) {
			const hint = key === "mode" || key === "prompt" || key === "forgeMaxChars" || key === "cotTag" ? " (the record has persona, gate, turns, forge, cot, transcribe and beat)" : "";
			return { error: `${key} is not a config key (${CONFIG_KEYS.join(", ")})${hint}` };
		}
	}
	const inherit = data.inherit ?? "keyed";
	if (!INHERITS.includes(inherit)) return { error: `inherit must be ${INHERITS.join(", ")}` };
	const fallback = readRecord(data.default ?? {}, [...SLOTS], "default");
	if (fallback.error) return { error: fallback.error };
	const rules = data.rules ?? [];
	if (!Array.isArray(rules)) return { error: "rules must be an array" };
	const out = [];
	for (const [index, rule] of rules.entries()) {
		const at = `rule ${index + 1}`;
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) return { error: `${at} is not an object` };
		for (const key of Object.keys(rule)) {
			if (!RULE_KEYS.includes(key)) return { error: `${at}: ${key} is not one of ${RULE_KEYS.join(", ")}` };
		}
		for (const field of ["provider", "model"]) {
			if (rule[field] === undefined) continue;
			if (typeof rule[field] !== "string" || !rule[field]) return { error: `${at}: ${field} must be a non-empty string` };
		}
		const read = readRecord(rule, RULE_KEYS, at);
		if (read.error) return { error: read.error };
		out.push({ provider: rule.provider, model: rule.model, ...read.record });
	}
	return { config: { default: fallback.record, inherit, rules: out, dir, path: null } };
}

/** What no config file gives a session. */
export function emptyConfig(dir) {
	return { default: {}, inherit: "keyed", rules: [], dir, path: null };
}

/** The layer a slot's value came from, in the order `resolve` tries them. */
const LAYERS = Object.freeze(["session", "rule", "default", "builtin"]);

/**
 * Every cot the config names, plus the built-in one, as label strings. `forge` and `turns` both
 * write a cot, and a turn already carrying one must be recognised under any of them, so the set
 * travels with the resolved cot rather than being rebuilt per model.
 */
export function configCots(config) {
	const cots = new Set([DEFAULT_COT]);
	if (config?.default?.cot) cots.add(config.default.cot);
	for (const rule of config?.rules ?? []) {
		if (rule.cot) cots.add(rule.cot);
	}
	return cots;
}

/**
 * The names a caller must treat as "this turn already carries a cot": every configured cot's name,
 * whatever its form. A turn fenced as `text:think` is not refenced as `toolcall:think`, because two
 * fences on one turn read as two reasoning traces.
 */
export function cotNames(cots, resolved) {
	const names = new Set();
	for (const label of cots) {
		const spec = cotSpec(label);
		if (spec) names.add(spec.name);
	}
	if (resolved) names.add(cotSpec(resolved)?.name ?? resolved);
	return [...names];
}

/**
 * One model's record, every slot resolved on its own, with the layer that answered for each. The
 * built-in record closes the chain, so every slot always has a value and a source.
 *
 * `session` is the settings of a session answer that governs this model; a slot it names wins over
 * every file layer, and one it does not name leaves the file in charge.
 */
export function resolve(config, model, session = {}) {
	const provider = String(model?.provider ?? "");
	const id = String(model?.id ?? "");
	let ruleIndex = -1;
	let rule = null;
	for (let i = 0; i < config.rules.length; i++) {
		const candidate = config.rules[i];
		if (candidate.provider !== undefined && !globMatch(candidate.provider, provider)) continue;
		if (candidate.model !== undefined && !globMatch(candidate.model, id)) continue;
		ruleIndex = i;
		rule = candidate;
		break;
	}
	const layers = {
		session: session ?? {},
		rule: rule ?? {},
		default: config.default ?? {},
		builtin: emptyRecord(),
	};
	const record = { ruleIndex, rule, sources: {} };
	for (const slot of SLOTS) {
		for (const layer of LAYERS) {
			const value = layers[layer][slot];
			if (value === undefined) continue;
			record[slot] = value;
			record.sources[slot] = layer;
			break;
		}
	}
	record.inherit = session?.inherit ?? config.inherit;
	return record;
}

/** A path a session setting names. A typed path means the session's cwd, and an absolute one stays. */
function absolutePath(value) {
	return isAbsolute(value) ? value : resolvePath(process.cwd(), value);
}

/**
 * One session setting from a typed or stored value. `undefined` removes the slot, so the file
 * decides again. A path slot accepts a path, and a path that is not absolute is taken from the
 * session's cwd, because a command line names what the user can see.
 *
 * The two shipped names are the exception: `prompt.md` and `turn0.yml` mean the package copy on
 * every layer, so they are kept bare. Turning one into a path would name a different file — the one
 * in whatever directory the recovering process happens to sit in.
 */
function settingValue(key, value) {
	if (value === undefined) return { value: undefined };
	if (key === "inherit") {
		const wanted = typeof value === "string" ? value.toLowerCase() : value;
		if (!INHERITS.includes(wanted)) return { error: `inherit must be ${INHERITS.join(", ")}` };
		return { value: wanted };
	}
	if (key === "persona" || key === "turns") {
		if (value === false) return { value: false };
		const shipped = key === "persona" ? DEFAULT_PROMPT : DEFAULT_TURNS;
		if (value === true) return { value: shipped };
		if (typeof value !== "string" || !value.trim()) return { error: `a ${key} path must be non-empty` };
		const text = value.trim();
		if (text === shipped) return { value: shipped };
		return { value: absolutePath(text) };
	}
	if (key === "transcribe" && typeof value === "string" && value.trim().toLowerCase() === "strict") {
		return { value: "strict" };
	}
	const read = slotSpec(key, value);
	if (!read) return { error: slotError(key) };
	return { value: read.spec };
}

/**
 * A whole settings object, as the channel and the process answer carry it. Every slot is checked and
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

/** The words a command may use for a slot's off and on state. */
const OFF = new Set(["off", "false", "no"]);
const ON = new Set(["on", "true", "yes"]);

/**
 * One assignment from the command, or the reason it is not one. `default` removes the slot, `off`
 * and `on` are the two switch values, `strict` sets summary-free transcription, and anything else is a
 * path or a cot spec.
 */
export function settingFromCommand(name, value) {
	const key = String(name ?? "").toLowerCase();
	if (!SETTINGS_KEYS.includes(key)) return { error: `unknown setting: ${name}` };
	const text = String(value ?? "").trim();
	const keyword = text.toLowerCase();
	if (keyword === "default") return { key, value: undefined };
	if (!text) return { error: `${key} needs a value` };
	// `cot` names a form and a name rather than a switch, so `off` and `on` say nothing here.
	if (key === "cot") {
		const read = settingValue("cot", text);
		return read.error ? { error: read.error } : { key, value: read.value };
	}
	if (key === "inherit") {
		const read = settingValue("inherit", text);
		return read.error ? { error: read.error } : { key, value: read.value };
	}
	if (OFF.has(keyword)) return { key, value: false };
	if (ON.has(keyword)) {
		if (key === "persona") return { key, value: DEFAULT_PROMPT };
		if (key === "turns") return { key, value: DEFAULT_TURNS };
		return { key, value: true };
	}
	if (key === "transcribe" && keyword === "strict") return { key, value: "strict" };
	const read = settingValue(key, text);
	return read.error ? { error: read.error } : { key, value: read.value };
}

/**
 * Read once per revision: the table is read at run start, not per request. A file that does not
 * load is reported and the built-in record takes over, which changes nothing.
 *
 * The revision is the bytes, not the stat. Two writes inside one timestamp tick share an `mtimeMs`,
 * and two spellings of one shape share a `size` (`{"gate":true}` and `{"turns":true}` are the same
 * width), so a stat-keyed cache hands back the record of a file that is no longer there. The text is
 * already being read; comparing it costs nothing the stat was saving.
 */
const cache = new Map();

export function loadConfig(path, fallbackDir) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { config: emptyConfig(fallbackDir) };
	}
	const hit = cache.get(path);
	if (hit && hit.text === text) {
		if (hit.config) return { config: { ...hit.config, path } };
		return { config: emptyConfig(fallbackDir), error: `${path}: ${hit.error}` };
	}
	const parsed = parseConfig(text, dirname(path));
	cache.set(path, { text, config: parsed.config, error: parsed.error });
	if (parsed.config) return { config: { ...parsed.config, path } };
	return { config: emptyConfig(fallbackDir), error: `${path}: ${parsed.error}` };
}
