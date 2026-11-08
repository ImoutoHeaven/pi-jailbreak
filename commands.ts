/**
 * `on`, `off` and `toggle` set this session, and `reset` drops that answer. `remember` writes it
 * into the config file, so the next process resolves the same way without the environment channel.
 *
 * `prompt`, `turns`, `cotTag` and `inherit` set one session setting each. They last as long as
 * the process, are written only by `remember`, and never touch the mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Hooks = {
	set(ctx: any, mode: "on" | "off" | "toggle"): { mode: "on" | "off"; applied: boolean };
	reset(ctx: any): "on" | "off";
	remember(ctx: any, mode: "on" | "off"): { ok: boolean; message: string };
	configure(ctx: any, name: string, value: string): { ok: boolean; message: string };
	panel(ctx: any): string;
};

const ARGS = [
	"on",
	"off",
	"toggle",
	"reset",
	"remember on",
	"remember off",
	"prompt",
	"turns",
	"turns off",
	"cotTag think",
	"inherit keyed",
	"inherit tree",
	"inherit none",
];

const USAGE =
	"on | off | toggle | reset | remember on | remember off | prompt <path> | turns <path|off> | cotTag <tag> | inherit keyed|tree|none";

/** The verbs that set one session setting. The first token is lowercased, so `cotTag` arrives as `cottag`. */
const SETTINGS = ["prompt", "turns", "cottag", "inherit"];

function say(ctx: any, text: string, type: "info" | "error" = "info") {
	try {
		ctx?.ui?.notify?.(text, type);
	} catch {
		// A mode without a UI still runs the command.
	}
}

export function registerCommands(pi: ExtensionAPI, hooks: Hooks) {
	pi.registerCommand("jailbreak", {
		description: "Show or set the mode and the session settings: on, off, toggle, reset, remember, prompt, turns, cotTag, inherit",
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
			// Only the verb is case-insensitive: the value is a path, and a path keeps its case.
			const cut = raw.search(/\s/);
			const first = (cut < 0 ? raw : raw.slice(0, cut)).toLowerCase();
			const value = cut < 0 ? "" : raw.slice(cut + 1).trim();
			if (first === "on" || first === "off" || first === "toggle") {
				const result = hooks.set(ctx, first);
				say(ctx, result.applied ? `jailbreak ${result.mode}` : `jailbreak ${result.mode} (unchanged)`);
				return;
			}
			if (first === "reset") {
				say(ctx, `jailbreak ${hooks.reset(ctx)} (config)`);
				return;
			}
			if (first === "remember") {
				const mode = value.toLowerCase();
				if (mode !== "on" && mode !== "off") {
					say(ctx, "remember on | remember off");
					return;
				}
				const result = hooks.remember(ctx, mode);
				say(ctx, result.ok ? `remembered: jailbreak ${mode} in ${result.message}` : result.message, result.ok ? "info" : "error");
				return;
			}
			if (SETTINGS.includes(first)) {
				const result = hooks.configure(ctx, first, value);
				say(ctx, result.message, result.ok ? "info" : "error");
				return;
			}
			say(ctx, USAGE);
		},
	});
}
