/**
 * The `leviathan` command.
 *
 * One verb per slot, and no verb that means "all of them": `on` and `off` used to name a bundle of
 * four things at once, which is how a config ended up unable to say "forge and nothing else". The
 * completion table is the documentation the user actually meets, so it lists the verbs a record has
 * and nothing else.
 */

import { SLOTS } from "./config.js";

type Hooks = {
	reset: (ctx: any) => any;
	remember: (ctx: any) => { ok: boolean; message: string };
	configure: (ctx: any, name: string, value: string) => { ok: boolean; message: string };
	panel: (ctx: any) => string;
};

const ARGS = [
	"persona on",
	"persona off",
	"persona default",
	"gate on",
	"gate off",
	"gate default",
	"turns on",
	"turns off",
	"turns default",
	"forge on",
	"forge off",
	"forge default",
	"forge maxChars 1200",
	"forge maxChars none",
	"cotTag think",
	"cotTag default",
	"inherit keyed",
	"inherit tree",
	"inherit none",
	"remember",
	"reset",
];

const USAGE =
	"persona on|off|<path>|default · gate on|off|default · turns on|off|<path>|default · forge on|off|maxChars <n|none>|default · cotTag <tag>|default · inherit keyed|tree|none · remember · reset";

/** The verbs that set one slot, plus the scope key. The first token is lowercased, so `cotTag`
 * arrives as `cottag`. */
const SETTINGS = [...SLOTS.map((slot) => slot.toLowerCase()), "inherit"];

function say(ctx: any, text: string, type: "info" | "error" = "info") {
	try {
		ctx?.ui?.notify?.(text, type);
	} catch {
		// A session without a UI still runs the command.
	}
}

export function registerCommands(pi: any, hooks: Hooks) {
	pi.registerCommand("leviathan", {
		description: "Show or set this model's record: persona, gate, turns, forge, cotTag, inherit, remember, reset",
		getArgumentCompletions: (prefix: string) => {
			const typed = String(prefix ?? "").trim().toLowerCase();
			const items = ARGS.filter((value) => value.toLowerCase().startsWith(typed));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: any) => {
			const raw = String(args ?? "").trim();
			if (!raw) {
				say(ctx, hooks.panel(ctx));
				return;
			}
			// Only the verb is case-insensitive: the value is a path or a tag, and a path keeps its case.
			const cut = raw.search(/\s/);
			const first = (cut < 0 ? raw : raw.slice(0, cut)).toLowerCase();
			const value = cut < 0 ? "" : raw.slice(cut + 1).trim();
			if (first === "reset") {
				const current = hooks.reset(ctx);
				// The receipt says what the file answers now, one word per slot.
				const said = SLOTS.map((slot) => {
					const value = current[slot === "turns" ? "turnsSpec" : slot];
					if (slot === "forge") return value === false ? "forge off" : `forge ${value.maxChars === null ? "on" : value.maxChars}`;
					if (value === true) return `${slot} on`;
					if (value === false) return `${slot} off`;
					return `${slot} ${value}`;
				});
				say(ctx, `leviathan reset (config: ${said.join(", ")})`);
				return;
			}
			if (first === "remember") {
				const result = hooks.remember(ctx);
				say(ctx, result.message, result.ok ? "info" : "error");
				return;
			}
			if (SETTINGS.includes(first)) {
				const result = hooks.configure(ctx, first, value);
				say(ctx, result.message, result.ok ? "info" : "error");
				return;
			}
			say(ctx, USAGE, "error");
		},
	});
}
