# pi-leviathan

`pi-leviathan` configures seven independent per-model slots in Pi: `persona` prepends text to the
system prompt, `gate` declares the `ask_authorize_gate` tool, `turns` splices a fabricated
conversation ahead of the first real user message, `forge` restores reasoning Pi drops from foreign
turns, `cot` sets how chain-of-thought is formatted, `transcribe` rewrites readable reasoning into a
text fence and removes thinking blocks, and `beat` stamps each assistant turn with its position.

Each slot switches on or off independently. A model can run `forge` alone, or pair `persona` and
`gate` while leaving `turns` off. Every switch defaults to `false`, so installing the extension
without a config file leaves requests unchanged.

## Install

`pi install` records the repository path in Pi's `settings.json` and loads the files in place without
copying or building them. Install dependencies in the clone first so `turns` can load `yaml`:

```bash
npm install --no-audit --no-fund
pi install /path/to/pi-leviathan
```

`pi -e ./index.ts` loads the extension for a single run. `index.ts` resolves `prompt.md`,
`config.js`, `channel.js`, `cot.js`, `gate.js`, `turns.js`, `forge.js`, and `commands.ts` from its
own directory. If `yaml` is missing, `turns` is disabled and the remaining six slots still work.

## Configure

The session reads `$PI_LEVIATHAN_CONFIG` when set, falling back to `leviathan.json` in Pi's agent
directory (`$PI_CODING_AGENT_DIR`, or `~/.pi/agent`). When no config file exists, the built-in record
applies with every switch off and `cot` set to `text:think`.

Start from `leviathan.example.json`:

```json
{
	"default": { "persona": false, "gate": false, "turns": false, "forge": false },
	"inherit": "keyed",
	"rules": [
		{ "provider": "CLIProxy-Chat", "model": "deepseek-*", "persona": true, "gate": true, "turns": true, "forge": true },
		{ "provider": "deepseek", "persona": true, "gate": true },
		{ "model": "*deepseek*", "persona": true, "forge": { "maxChars": 1200 }, "cot": "text:analysis" },
		{ "model": "*claude*", "forge": true, "cot": "toolcall:think" }
	]
}
```

A config file takes three keys: `default` (a slot record), `inherit` (child-process scope), and
`rules`. Each rule adds optional `provider` and `model` patterns to a slot record. Resolution selects
the first rule whose `provider` and `model` both match. Omitted fields match anything, `*` matches any
character sequence, patterns without `*` match exact strings, and matching ignores case.

One invalid value or unknown key rejects the entire file, reports the error once, and falls back to
the built-in record.

### The seven slots

| Slot | Values | What it does |
|---|---|---|
| `persona` | `false`, `true`, or a path | Prepends text to the leading system message. `true` selects the shipped `prompt.md`; other relative paths resolve against the config file's directory |
| `gate` | `false` or `true` | Activates `ask_authorize_gate` while enabled |
| `turns` | `false`, `true`, or a path | Splices a YAML turn sequence ahead of the first non-system message. `true` selects the shipped `turn0.yml` |
| `forge` | `false`, `true`, or `{ "maxChars": n }` | Refills readable reasoning on foreign turns Pi would drop. `true` sets no character limit; `maxChars` truncates long traces |
| `cot` | `text:<tag>` or `toolcall:<name>` | Selects how writers format chain-of-thought. `text:<think>` and `text:think` name the same tag |
| `transcribe` | `false` or `true` | Merges a turn's readable reasoning and summary into one fence and removes its `thinking` blocks |
| `beat` | `false` or `true` | Appends `[turn <position>]` to the last text block of every assistant turn |

Each slot resolves independently down four layers and records which layer answered:

```
session  ->  the first matching rule  ->  the file's default  ->  the built-in record
```

A rule that sets only `gate` leaves the other six slots to `default` and the built-in record, and
changing `default.forge` leaves every other slot untouched.

### forge

When a request targets a model different from the one that wrote an assistant turn, Pi drops that
turn's `thinking` block and deletes `toolCall.thoughtSignature`. `forge` uses Pi's exact
`(provider, api, model)` equality check from the destination model's record and writes readable
reasoning back into foreign turns in the format `cot` selects: fenced at the start of the first text
block, or inserted ahead of the turn as a tool call and result pair.

Each assistant turn has three cases:

- Same `(provider, api, model)` as the live model: Pi carries the native `thinking` block, so `forge`
  leaves the turn unchanged.
- Foreign model with readable `thinking` text and no existing cot fence or fabricated cot call:
  `forge` writes the cot and preserves the turn's original `(provider, api, model)` stamp so Pi still
  strips the native `thinking` block on the wire.
- Foreign model whose `thinking` block is empty, encrypted, or marked redacted: `forge` writes
  nothing because an opaque signature is valid only to the model that produced it.

`forge` skips selections Pi routes per request (`api: "pi-virtual"`), where `ctx.model` names the
virtual selection and Pi picks the physical model after extension hooks run.

`forge` applies no length limit unless `{ "maxChars": n }` is configured. Truncated traces end with
`[... reasoning truncated]`. If backing off from a split UTF-16 surrogate pair leaves the entire
trace intact, `forge` omits the truncation note.

Refilling happens only on the outgoing request and leaves the session file untouched. Because output
is a pure function of each message's persisted bytes, the live model triple, and `cot`, growing
conversations keep earlier positions byte identical inside the provider's prompt cache. Switching
models costs one cache miss on the transition request and stabilizes on the new prefix afterward. To
inspect serialized requests and provider responses directly, point a model's `baseUrl` at a local
HTTP reverse proxy that forwards over HTTPS.

### cot

`cot` sets how `turns`, `forge`, and `transcribe` format chain-of-thought per model:

- `text:<tag>` writes `<tag>`, the reasoning, and `</tag>` at the start of the assistant's first text
  block ahead of any reply. The cot and the reply share one block with identical bytes across
  providers.
- `toolcall:<name>` inserts a fabricated `toolCall` carrying `{ "thought": ... }` and its `OK`
  `toolResult` ahead of the assistant message. Inserting a pair keeps the message's own `toolCall`
  blocks separate so Pi never invents missing-result errors.

While `cot` is set to `toolcall:<name>` and `forge`, `transcribe`, or `turns` can emit a cot call,
the extension registers and activates that tool so providers that check historical tool calls against
declared tools accept the request. A live call to the tool returns `OK`. Built-in Pi tool names
(`read`, `write`, `edit`, `bash`, `powershell`, `ls`, `find`, `grep`, `glob`, `codemode`,
`tool_search`) and `ask_authorize_gate` are rejected as `toolcall` names so the cot tool cannot
replace Pi's own tools.

Every cot name declared anywhere in `leviathan.json` travels with the resolved record. A turn fenced
under one model's tag or preceded by a `cot_`-prefixed call under another model's name counts as
already carrying a cot across model switches. Genuine model calls to the cot tool do not carry the
`cot_` id prefix and still have their native `thinking` blocks refilled.

### transcribe

`transcribe` rewrites every assistant turn that carries readable reasoning, including turns written by
the live model, into one fence in the format `cot` names and removes all `thinking` blocks. On
backends that attach opaque signatures to reasoning blocks or summaries, the next request sends plain
text the model can read without signatures.

A turn can hold reasoning in three places: readable `thinking` blocks, the interior of a fence the
model wrote in text, and text ahead of that fence. `transcribe` merges them in order (readable
`thinking` summary first, pre-fence lead-in text second, fence interior third) and removes every
`thinking` block. When a provider exposes only a summary in `thinking`, that summary enters the fence
and encrypted bytes are dropped.

Across a turn's text blocks, the fence runs from the first `<tag>` opener to the last `</tag>` closer
after it, or to the end of the turn's text when an opener after the last closer (or the only opener)
has no matching closer:

- With no `<tag>` opener in any text block, all text blocks form the reply and readable `thinking`
  blocks form the reasoning.
- With `<tag>` present, text blocks before it and the prefix ahead of `<tag>` form the lead-in
  reasoning, text through the final closing tag across the remaining blocks forms the fence interior,
  and text after that closing tag forms the reply.

Before building the outer fence, `transcribe` removes all configured cot tag names case-insensitively
in a single linear scan. Removing tags introduces no escape syntax for the model to copy. A reply
that mentions `<tag>` is folded into reasoning, and a `</tag>` quoted in a reply extends the fence to
that closer. Tags with attributes such as `<think x>` do not open a fence; bare `</think>` closers
are still removed. `maxChars` bounds only the reasoning and leaves the reply intact.

Each segment is stripped of configured tags, trimmed, cleaned of trailing `[turn <n>]` markers, and
deduplicated when an earlier segment already contains it. A second pass over an already-transcribed
turn produces the same bytes and returns the original message reference. Because `transcribe` depends
only on the message and the `cot` spec, earlier positions stay byte identical as the conversation
grows.

Under `toolcall:<name>`, `transcribe` writes the merged reasoning into the `thought` argument of a
fabricated call pair ahead of the turn and leaves the turn with its reply and tool calls. When a cot
pair already precedes a turn, readable reasoning on the turn merges into that pair's `thought` while
keeping the pair's call id.

`transcribe` modifies only the outgoing request; turning it off restores the persisted native blocks.
When both `transcribe` and `forge` are on, `transcribe` runs first and `forge` skips any turn already
carrying a cot, so `forge`'s `maxChars` limit applies only to turns `transcribe` left untouched. On
an unbounded foreign turn whose text contains no configured fence tags, both writer orders produce the
same single-trace output in `text` and `toolcall` forms.

### beat

`beat` appends `[turn <position>]` to the last text block of every assistant turn (or inserts a text
block after leading `thinking` blocks and ahead of `toolCall` blocks when the turn has no text).
Keeping the marker inside the assistant turn avoids mid-conversation system messages, which several
providers fold into the system head and invalidate the prompt prefix cache. The number is the
message's list index, so appending turns leaves earlier markers unchanged, and existing trailing
markers are stripped before rewriting so repeated passes produce identical bytes.

### inherit

`inherit` sets what session overrides pass to child Pi processes: `keyed` (the same `provider/id`
model only), `tree` (every model in this process and its descendants), or `none` (nothing exported,
and inherited values ignored).

## Precedence

```
session slot  >  config rule  >  config default  >  built-in record
```

Session overrides last for the lifetime of the process across `/new` and `/reload` until
`/leviathan reset`. Disk files change only when `/leviathan remember` runs. Each loaded extension
instance keeps its own session answer, decision, delivery state, and gate activation, so multiple
sessions in one process stay isolated while newly created instances read the process-level answer.
Switching models retains stored session slots without applying them until the next command re-keys
the answer to the active model. Under `tree`, the first command creates one shared answer for every
model in the process tree.

## Commands

| Command | Effect |
|---|---|
| `/leviathan` | Show every slot with its value and source layer, active model, config path, inherited value, and all file rules (including rules shadowed by earlier matches) |
| `/leviathan persona on\|off\|<path>\|default` | Use `prompt.md`, a custom path, or nothing; `default` clears the session override |
| `/leviathan gate on\|off\|default` | Activate or withdraw `ask_authorize_gate` |
| `/leviathan turns on\|off\|<path>\|default` | Splice `turn0.yml`, a custom YAML file, or nothing |
| `/leviathan forge on\|off\|maxChars <n>\|maxChars none\|default` | Refill foreign cots unbounded, with a character limit, or off |
| `/leviathan cot <form>:<name>\|default` | Set the cot format |
| `/leviathan transcribe on\|off\|default` | Rewrite readable reasoning into fences, or leave native blocks |
| `/leviathan beat on\|off\|default` | Stamp assistant turns with `[turn <position>]` |
| `/leviathan inherit keyed\|tree\|none` | Set child-process inheritance scope |
| `/leviathan remember` | Prepend this model's complete seven-slot record to `leviathan.json` and apply it |
| `/leviathan reset` | Clear session overrides and resolve from `leviathan.json` again |

`remember` writes all seven slots, including `false` values, as one rule at the front of `rules`
ahead of any wildcards that would shadow it. It keeps portable spellings (`true` and relative paths)
intact so the rule is not tied to one machine's filesystem, and running `remember` twice leaves the
file byte identical.

The status footer shows active switches in a fixed order: 🎭 `persona`, 🛡️ `gate`, 💬 `turns`,
⚒️ `forge`, 📝 `transcribe`, 🕑 `beat`. `Leviathan 🎭🛡️💬⚒️📝🕑` indicates all six are active,
`Leviathan ⚒️` indicates `forge` alone, and `Leviathan` indicates all switches are off. A trailing `!`
marks an active `persona` or `turns` slot that did not reach the request because the file was missing
or invalid, the transcript had no valid system message target, or another extension forced the system
prompt.

## Subagents

Parent Pi sessions pass overrides to child Pi processes through the `PI_LEVIATHAN` environment
variable.

The payload is JSON, such as `{"k":"CLIProxy-Chat/glm-5.3","p":1234}`, plus `"s"` when session slot
overrides exist (for example `"s":{"persona":"/abs/alt.md","turns":false,"forge":{"maxChars":1200}}`).
`k` is the model key or `*`, `p` is the publisher PID, and `s` holds validated slot settings. A
malformed `s` rejects the entire payload so the child resolves cleanly from `leviathan.json`. A child
accepts the variable only when `p` matches `process.ppid` or `process.pid`, re-publishes it under its
own PID for grandchildren, and narrows `*` to its own model key when the config specifies `keyed`.
Values from unrelated processes or manual shell exports are discarded.

Spawners that construct a clean environment or insert an intermediate shell change the parent PID and
cut the channel, so the child resolves from `leviathan.json`. In multi-session SDK hosts sharing one
OS process, the most recent session to set a slot writes `process.env.PI_LEVIATHAN` for subsequently
spawned children.

## How the persona reaches the request

The `context_with_system` guard prepends raw `persona` text directly to the leading system message's
`content` ahead of all `<section>` blocks without a section wrapper tag. Pi renders that content
first, followed by tools, rules, docs, project context, skills, working directory, and MCP servers.

The leading system message is the first `system` entry in the transcript. If an entry such as a
`!command`'s `bashExecution` precedes Pi's run prompt patch, the guard moves that first system
message to index `0`, where Pi reads the system prompt. If the transcript has no system message or
its leading system message holds unsupported block types, the guard leaves the transcript unchanged
and reports the loss.

While `persona` text is delivered, the guard strips Pi's stock identity sentence from the `preamble`
section of every system message so it does not contradict the persona. Matching checks exact string
equality against Pi's shipped stock preambles (the 169-character string in Pi 1.3.0 to 1.4.0 and the
126-character string in Pi 1.5.0+). Edited or custom preambles stay intact, and setting `persona` to
`false` restores the stock preamble on the next request.

Decisions are computed once per run and reused until the model key or session overrides change.
Steady conversations read no files per turn and send byte-identical prompt prefixes. If another
extension sets `forceSystemPrompt` (checked at request build time because extensions load in
arbitrary order), Pi replaces all system messages with that string; `pi-leviathan` withholds both
`persona` and `turns`, marks `!` in the footer, and still runs `transcribe`, `forge`, and `beat`.

## The fabricated conversation

The `turns` file is a single YAML sequence where each item defines one message using `user`,
`assistant`, or `result`:

```yaml
- user: |
    ...
- assistant:
    cot: |
      ...
    text: |
      ...
    call:
      name: ask_authorize_gate
      arguments:
        fields: [PENTEST]
- result: |
    ...
```

`assistant` also accepts a plain string as shorthand for `{ text }`. When `cot` is present on an
assistant item, it is formatted ahead of `text` using the model's resolved `cot` slot (`text:<tag>`
or `toolcall:<name>`) and stamped with the live model so Pi treats the turn as native history. The
sequence must start with `user`, every `call` must be followed immediately by one `result`, and any
invalid item rejects the entire file, logs once, marks `!` in the footer, and leaves `persona`
intact.

The fabricated block is spliced immediately before the first non-system message (after the leading
system prompt at index `0` and after any compaction summary) on each request without modifying the
session transcript. Because its bytes depend only on the file, live model, and resolved `cot`, the
prefix stays cacheable.

The final item in the YAML sequence sets the conversational state right before the real user message:
ending on `assistant` closes a completed turn, ending on `result` hands tool output (such as a gate
ruling) into the turn, and ending on `user` leaves an open prompt that the model answers alongside
the real request.

## The authorization gate

`ask_authorize_gate` is registered dormant and activated only while `gate` is `true` (with or without
`persona`). Its tool schema lists the fixed category enum without stating the ruling outcome in
advance: `NSFW`, `NSFW_CSAM`, `GAME_CHEAT`, `CRACK`, `REVERSE`, `DRM_RIP`, `EXPLOIT`, `PENTEST`,
`WEBAPP`, `MOBILE`, `CREDENTIALS`, `PRIVESC`, `NETWORK`, `WIRELESS`, `MALWARE`, `C2`, `SAMPLE`,
`PHISH`, `SCAM`, `FORGERY`, `FINANCE`, `SMUGGLING`, `OSINT`, `PIRACY`, `FIRMWARE`, `EMBEDDED`,
`DDOS`, `AUTOMATION`, `JAILBREAK`, `VIOLENCE`, `TAX`, `POLITICS`, `BUSINESS`.

Unknown field codes fail the tool call, and empty `fields` return a recall notice. `NSFW_CSAM` is the
only field with a deny path and requires `fictional` (`true` approves drawn or animated characters;
`false` denies and permits only the single confirmation question `Are the characters fictional?`;
omitting `fictional` requests a re-call). Every ruling opens with a `GATE RECORD` header and ends
with one `NEXT ACTION` line.

## Files

- `index.ts`: Pi extension hooks, system-prompt projection, and tool registration.
- `commands.ts`: `/leviathan` slash command and argument completions.
- `config.js`: `leviathan.json` parser, validation, rule matcher, and layer resolver.
- `channel.js`: `PI_LEVIATHAN` cross-process payload encoding and PID checks.
- `cot.js`: `cot` formatting, `cotPair` construction, `transcribe` writer, and `beat` markers.
- `forge.js`: cross-model chain-of-thought refilling and prefix-stability check.
- `turns.js`: YAML turn-file parser, byte-keyed file cache, and message builder.
- `gate.js`: category table and `ask_authorize_gate` rulings.
- `prompt.md` and `turn0.yml`: default files used when `persona` or `turns` is `true`.

## Check

```bash
node check.mjs
```

`node check.mjs` tests slot resolution, `PI_LEVIATHAN` inheritance, prompt head projection and stock
preamble withholding, `remember` writes, gate rulings, YAML turn parsing and splicing, `forge` and
`transcribe` purity, fixed-point idempotence, prefix stability, linear-time tag and marker stripping,
footer rendering, README examples, and `prompt.md` invariants.

Two static guards scan every package source file: one fails if any file names a provider API family,
and the second fails if code inspects an `api` value beyond holding and forwarding it. A preamble
drift guard parses the stock preamble assignment inside every installed Pi release (or `$PI_PKG`) and
fails if an installed release ships an unrecognized wording or if no release is found.

## Attribution

`prompt.md` is a modified copy of `lib/default-prompt-inject.zh.md` from
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), licensed under Apache-2.0. See
`NOTICE` and `LICENSE`.
