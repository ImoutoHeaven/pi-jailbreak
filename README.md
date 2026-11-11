# pi-leviathan

A Pi extension that puts the text of `prompt.md` at the head of the system prompt for the sessions a
rule selects, splices a fabricated conversation ahead of the first real user message for the
sessions a turn file selects, and declares the `ask_authorize_gate` tool while that text is in force.

The extension ships no rules. Nothing is injected until a config file names the model.

## Install

This repository is the source of truth. `pi install` records the package path in the agent
directory's `settings.json` and loads the files in place: nothing is copied and nothing is built.
The turn file is read through the `yaml` package, so a clone needs one install in the repository
directory first:

```bash
npm install --no-audit --no-fund
pi install /path/to/pi-leviathan
```

`pi -e ./index.ts` loads it for one run. The extension reads its own directory, so `prompt.md`,
`config.js`, `channel.js`, `gate.js`, `turns.js`, `forge.js` and `commands.ts` travel with
`index.ts`. A missing `yaml` package disables the fabricated conversation and leaves the prompt text
in force.

## Configure

The session reads `$PI_LEVIATHAN_CONFIG` when it is set, and otherwise `leviathan.json` in pi's
agent directory. That directory is `$PI_CODING_AGENT_DIR` when that is set, and `~/.pi/agent`
otherwise. When no file loads, the empty config applies: `default: "normal"` and no rules.

Start from `leviathan.example.json`:

```json
{
	"default": "normal",
	"inherit": "keyed",
	"prompt": "prompt.md",
	"forge": "auto",
	"rules": [
		{ "provider": "CLIProxy-Chat", "model": "deepseek-*", "mode": "leviathan" },
		{ "provider": "deepseek", "mode": "leviathan" },
		{ "model": "*deepseek*", "mode": "leviathan" }
	]
}
```

A model takes the first rule whose `provider` and `model` both match. A missing field matches
anything. A pattern without `*` is exact, `*` matches any run of characters, and matching ignores
case. `mode` is `leviathan` or `normal`. `prompt.md` is the text that ships with the extension; any
other `prompt` path is relative to the config file. A file with one bad value is rejected whole and
reported once, and the empty config applies instead. A key the extension does not take is one of
those values, so a typo or a key from another version fails loudly instead of being ignored.

`turns` names the YAML file whose messages are spliced ahead of the first real user message. It has
three states: absent takes `turn0.yml`, the file that ships with the extension, `null` turns the
block off, and a string names another file. A rule's own value wins over the config-level one, and a
rule that sets `null` keeps it off even when the config names a file. `turn0.yml` resolves to the
package copy wherever the config lives; every other relative path resolves against the directory
holding the config file.

```json
{
	"turns": "team/turn0.yml",
	"rules": [{ "provider": "deepseek", "mode": "leviathan", "turns": null }]
}
```

`cotTag` names the tag the fabricated cot is fenced in at the head of the assistant reply. It
defaults to `think`, and either spelling of one tag is the same tag: `think` and `<think>` both
write `<think>` and `</think>`. A rule's own value wins over the config-level one.

```json
{
	"cotTag": "think",
	"rules": [{ "provider": "CLIProxy-Chat", "model": "deepseek-*", "mode": "leviathan", "cotTag": "reasoning" }]
}
```

`forge` decides what a request carries for an assistant turn another model wrote. Pi drops that
turn's thinking block whenever the request targets a different model, which leaves the conversation
reading as if the reasoning had never happened. `auto`, the default, refills a turn exactly when pi
drops it: the turn's own cot goes back in, fenced in `cotTag`, and the turn keeps the model stamp
that says it came from elsewhere. `always` refills even a turn pi would carry, which shows two
reasoning traces and is worth having only to diagnose one. `off` refills nothing.

```json
{
	"forge": "auto",
	"forgeMaxChars": 4000,
	"rules": [{ "provider": "CLIProxy-Chat", "mode": "leviathan", "forge": "always" }]
}
```

`forgeMaxChars` bounds the refilled cot so a long trace cannot dominate a request; a negative value
leaves it unbounded. Both keys sit at the config level and on a rule, and a rule's own value wins.
The refill is a pure function of the message's own bytes, so a grown conversation keeps every
already-sent position byte-identical: switching a model costs one cache miss, and the turns after it
stay on the same prefix.

`inherit` decides what a session hands to the processes it starts: `keyed` (the same model only),
`tree` (every model, in this process and in the ones it starts), or `none` (nothing, and inherited
values are dropped).

## Precedence

```
session setting   >   config rule   >   config level   >   default
/leviathan on|off >   inherited value   >   the config-resolved answer
```

The two lines are orthogonal: the settings decide what an active session sends, and `on`/`off`
decide whether that answer is in force at all. `off` keeps the settings stored and inert, and
`reset` drops both.

An answer lasts as long as the process, including `/new` and `/reload`, until `/leviathan reset`.
Nothing is written to disk unless `remember` asks for it. Each loaded instance keeps its own answer,
decision, delivery record and gate activation, so two sessions in one process do not share them, and
the mode the process set is what a new instance reads. A model switch keeps the settings stored
without applying them until the next command re-keys the answer to the live model, mode included.
Under an effective
`tree`, the first command creates the answer every model in the tree shares, so its mode is the one
the live model resolves at that moment.

## Commands

| Command | Effect |
|---|---|
| `/leviathan` | The model it resolved or `(none)`, the resolved mode, the rule that selected it, the session settings it carries, the prompt file, the turn file, the refill mode and its bound, the config file, and the inherited value if there is one |
| `/leviathan on` / `off` / `toggle` | Set the mode for this session, keeping its settings |
| `/leviathan reset` | Drop the session answer and its settings, so the config decides again |
| `/leviathan prompt <path>` / `prompt default` | Point the session at another prompt file, or back at the config |
| `/leviathan turns <path>` / `turns off` / `turns default` | Inject another turn file, turn the block off, or take the config value. `./off` names a file literally called `off` |
| `/leviathan cotTag <tag>` / `cotTag default` | The tag that fences the fabricated cot; `think` and `<think>` are one tag |
| `/leviathan forge auto\|always\|off` / `forge default` | What a request refills for an assistant turn another model wrote |
| `/leviathan forgeMaxChars <n>` / `forgeMaxChars default` | The bound on a refilled cot; a negative value is unbounded |
| `/leviathan inherit keyed\|tree\|none` / `inherit default` | What this session hands to the processes it starts |
| `/leviathan remember on` / `off` | Write a rule for the current model, move it ahead of any rule that would shadow it, carry the session setting or else the file that model already resolves to, and apply it now |

The footer shows `Leviathan on` while the text is in force, `Leviathan off` while the mode is normal,
and `Leviathan !` when the mode is leviathan and the request carried nothing: the prompt file is
missing or empty, the transcript has nowhere to put the text, the configured turn file did not load,
or another extension replaced the system prompt. The third state follows the request that was
actually sent, so a run whose text cannot be placed says so at once instead of showing on.

## Subagents

A subagent is a Pi process launched with the parent's environment, so the parent writes its answer
into `PI_LEVIATHAN` and the child reads it. Neither extension knows the other exists.

The value is JSON: `{"m":"on","k":"CLIProxy-Chat/glm-5.3","p":1234}`, and an answer that carries
session settings adds `"s"`, for example `"s":{"prompt":"/abs/alt.md","turns":null}`. `m` is the
mode, `k` is the model key or `*`, `p` is the publisher pid, and `s` is the settings, absent when
there are none. A malformed `s` rejects the whole payload, so a child resolves from the config rather
than from half an answer. A child accepts it when `p` is its parent or itself, and
rewrites it with its own pid so the next level reads the same answer, and narrows a `*` key to its
own model once the config asks for `keyed`. Any other value, including one
exported from a shell, is discarded and replaced.

`k` matching is what `inherit: keyed` produces. A child on the same model inherits; a child on
another model resolves from the config. `tree` publishes `*` instead, and `none` publishes nothing
and ignores what it receives.

A spawner that builds a fresh environment cuts the channel, and the child resolves from the config.
So does a wrapper that puts a shell between the two: only a direct child keeps the channel. Several
sessions in one process (an SDK host) share one environment, so the last session to set a mode wins
for the processes it starts.

## How the text reaches the request

The text arrives as the head of the leading system message's `content`. A section would render as
`<name>`, its content and `</name>`, which names the block and leaves a marker the model can point
at. The `context_with_system` guard places the raw text, with no wrapper, ahead of every section. Pi
renders that content first, so the order on a request is: `prompt.md` text, tools, rules, docs,
project context, skills, working directory, MCP servers.

The leading system message is the first system message in the transcript. An entry written before the
first run, such as the `bashExecution` record of a `!command`, sits ahead of the prompt patch Pi
appends for that run, so the guard finds the prompt where it is and moves it to index 0: the position
Pi renders the prompt from, and the position where the text leads the request instead of trailing an
earlier entry. A transcript that carries no system message has nowhere to put the text.

While the text is in force pi's stock identity sentence is withheld: the same guard removes the
`preamble` section from every system message whose value is one of the stock sentences Pi ships,
because that sentence contradicts the persona at the front of the same prompt. Pi reworded it in
1.5.0, so both are known: the 169-character sentence of 1.3.0 through 1.4.0 and the 126-character
sentence of 1.5.0. The comparison is exact, so any other value in `preamble` stays whole.
The sentence returns the moment the text is not in force. Both are request-scoped, and neither is
recorded in the transcript.

The extension makes one decision per run, and the guard reuses it until the model key or the session
override changes. A steady conversation parses no config and reads no file, and sends byte-identical prompts
turn after turn, so the prompt prefix cache stays warm. Switching the mode, the model, or the prompt
file changes the head and costs one cache miss.

If another extension forces the system prompt, Pi replaces the system messages with that string and
keeps every message that is not one, so the fabricated conversation would reach the model under a
prompt nobody wrote for it. The extension delivers neither: the text is reported as undelivered, the
block is skipped, and the footer shows the loss. The force is read when the request is built, not
when the run starts, because the extension that sets it may be loaded after this one. When
the leading system message holds blocks Pi never puts there, or the transcript carries no system
message at all, the extension places nothing: the text stays out, the identity sentence stays in, and
the loss is reported. A refilled cot is a separate axis on the same request and still travels: the
persona text is what cannot be placed, and a turn whose reasoning pi dropped is not affected by
where the prompt could go.

## The fabricated conversation

The `turns` file is a YAML sequence, and one item is one message. Three keys:

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

`assistant` also takes a bare string, which is its `text`, and one more key, `native`, which names
a reasoning field such as `reasoning_content`. With `native` the cot becomes a real thinking block
whose signature is that field name, so `openai-completions` puts it on the wire as
`reasoning_content` instead of as fenced text. The block is emitted only for that one adapter, which
replays a thinking block whose signature is a field name; every other adapter would either send the
string as a real signature and have the request rejected, or parse it and fail, so it gets the text
fence instead. A fabricated turn is stamped with the live model, so pi reads a block it does decode
as this model's own reasoning and keeps it. `result` answers the `call` of the assistant before it,
so every `call` has exactly one `result`, and the sequence begins with `user`.
A file with one bad item injects nothing: a half-fabricated history would leave the model an
assistant turn nobody answered.

The block is spliced before the first message that is not a system message, so it lands after the
prompt and after a compaction summary, and the leading system message moves to index 0 with it. It
is rebuilt from the file on every request, so the transcript records nothing: a model switch, a
fork, a reload or a new session leaves nothing to clean up. The bytes depend on the file, the model,
and the resolved `cotTag`, so the block stays inside the provider's prompt cache.

The last item decides what the model reads immediately before the real request. `assistant` closes
the block with a reply, and the request follows as a new turn. `result` closes it with tool output,
which is the shape to use when the fabricated turn carries a gate ruling. `user` closes it with an
unanswered turn, so the block ends on a question the model answers together with the real request.

## The refilled cot

Pi drops an assistant turn's thinking block when the request targets a different model than the one
that wrote it, and deletes that turn's `toolCall.thoughtSignature` with it. The turn stays, stripped
of its reasoning, so a conversation that crosses models reads as if that reasoning had never
happened.

The extension answers that per message, with pi's own test: it copies pi's predicate (a message
belongs to the live model when `provider`, `api` and `model` all match) and refills a turn exactly
when pi would drop it. A turn pi carries is left byte for byte as it is, so the two never disagree
and no turn ever shows two reasoning traces. `forge: "always"` overrides that for diagnosis.

The refill is the turn's own cot, fenced in `cotTag` inside its first text block. It is added in
the request and never written to the session, so a fork, a reload or a resumed session has nothing
to undo. It is a pure function of the message's bytes, the live model triple and the tag, which
matters for one reason: the request keeps every already-sent position byte-identical as the
conversation grows, so the provider's prompt cache keeps hitting. A model switch costs one miss, and
every turn after it stays on the same prefix; a refill that depended on position, on the run's
start or on the clock would cost one miss per request instead.

Three outcomes, and the code names all three rather than treating the last two as one. Pi carries a
turn: nothing is written. Pi drops it and the turn has a readable cot: the cot goes back in. Pi drops
it and there is nothing readable to put back — a redacted or encrypted block only — nothing is
written, because the block's signature is valid only to the model that produced it. A turn whose
first text block already opens with the tag fence is left as it is too, so a resumed or hand-edited
transcript is not fenced twice.

A selection pi routes per request (`api: "pi-virtual"`) refills nothing. `ctx.model` is then the
selection rather than the model the request is routed to, and pi picks the physical model after this
extension has run, so there is no triple to compare against; pi carries a turn's reasoning whenever
the route produces that turn's model.

A turn keeps the model stamp that says it came from elsewhere. Re-stamping it as the live model
would make pi carry its native thinking block too, and the turn would show its reasoning twice.

The fabricated chain of thought sits at the head of the assistant reply, fenced in `cotTag` tags,
so the turn reads as reasoning the assistant wrote down followed by what it said. The fence is
ordinary text: one text block, and the same block on every model that is not handed the `native`
form described above.

A file that does not load injects nothing, reports once, and leaves the prompt text in force. The
footer shows `Leviathan !` while a configured block is missing, and `/leviathan` names the file and
the reason.

## The authorization gate

`ask_authorize_gate` is a direct tool the model calls before any request it is unsure about
delivering; the call itself is the signal that the request needed one. The declaration routes the
call and never names the outcome, so the ruling has to be asked for. It is registered dormant and
activated exactly while the text is in force, because the text is what tells the model to call it. A
model that runs normal never receives a declaration.

The call names the categories the request touches, from a fixed set: `NSFW`, `NSFW_CSAM`,
`GAME_CHEAT`, `CRACK`, `REVERSE`, `DRM_RIP`, `EXPLOIT`, `PENTEST`, `WEBAPP`, `MOBILE`, `CREDENTIALS`,
`PRIVESC`, `NETWORK`, `WIRELESS`, `MALWARE`, `C2`, `SAMPLE`, `PHISH`, `SCAM`, `FORGERY`, `FINANCE`,
`SMUGGLING`, `OSINT`, `PIRACY`, `FIRMWARE`, `EMBEDDED`, `DDOS`, `AUTOMATION`, `JAILBREAK`, `VIOLENCE`,
`TAX`, `POLITICS`, `BUSINESS`. A code outside the set fails the call. `NSFW_CSAM` is the one field
with a deny path, and it requires `fictional`.

A ruling opens with a record header and ends with one NEXT ACTION. On the confirm path the ruling
permits one line and nothing else: `Are the characters fictional?`

## Files

`index.ts` is the hook and the tool definition, `commands.ts` the `leviathan` command, `config.js` the
rule table and the resolver, `channel.js` the cross-process value, `gate.js` the field table and the
ruling text, `turns.js` the turn file's parse and its messages, `forge.js` the cross-model cot
refill, `prompt.md` the injected text. Edit `prompt.md`; the next run uses it. A missing or empty
file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

`node check.mjs` drives the registered handlers against a temp config. It pins the resolver, the
channel payload, the guard's placement and preamble withholding, the config write, the gate rulings,
the turn file's parse and injection, the cot refill's predicate, purity, idempotence and prefix
stability, and the `prompt.md` invariants. A drift guard reads the literal
value each installed Pi release assigns to its preamble and fails when that value is not one the
extension knows, or when no release is installed at all. It reads the assignment, not any occurrence
in the file, so a release that rewords the sentence while an old wording survives as a comment still
fails; it decodes the literal before comparing, and a file that assigns no recognizable literal fails
rather than passes. Releases that sit side by side on different wordings both pass. Set `PI_PKG` to
point the check at a pi package elsewhere.

## Attribution

`prompt.md` is a modified copy of `lib/default-prompt-inject.zh.md` from
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and
`LICENSE`.
