# pi-leviathan

A Pi extension with seven independent slots per model: `persona` puts text at the head of the system
prompt, `gate` declares the `ask_authorize_gate` tool, `turns` splices a fabricated conversation
ahead of the first real user message, `forge` refills the reasoning Pi drops for a turn another model
wrote, `cot` says how that reasoning is written, `transcribe` writes a turn's own reasoning as that
text, and `beat` stamps each turn with its position.

The slots are orthogonal. A model can carry `forge` alone, or `persona` and `gate` with no `turns`,
and no slot drags another along. Every slot is off until a config file or a command turns it on:
installing the extension changes nothing.

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
`config.js`, `channel.js`, `cot.js`, `gate.js`, `turns.js`, `forge.js` and `commands.ts` travel with
`index.ts`. A missing `yaml` package disables `turns` and leaves every other slot working.

## Configure

The session reads `$PI_LEVIATHAN_CONFIG` when it is set, and otherwise `leviathan.json` in pi's
agent directory. That directory is `$PI_CODING_AGENT_DIR` when that is set, and `~/.pi/agent`
otherwise. When no file loads, every slot falls through to the built-in record: every switch off
and `cot` set to `text:think`.

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

A config takes three keys: `default` (a record), `inherit` (the scope), and `rules`. A rule adds
`provider` and `model` to a record. A model takes the first rule whose `provider` and `model` both
match; a missing field matches anything, a pattern without `*` is exact, `*` matches any run of
characters, and matching ignores case.

A file with one bad value is rejected whole and reported once, and the built-in record applies
instead. A key the extension does not take is one of those values, so a typo or a key from another
version fails loudly instead of being ignored.

### The seven slots

| Slot | Values | What it does |
|---|---|---|
| `persona` | `false`, `true`, or a path | Places that text at the head of the system prompt. `true` names `prompt.md`, which ships with the extension; any other path resolves against the directory holding the config file |
| `gate` | `false` or `true` | Declares `ask_authorize_gate` while the slot is on |
| `turns` | `false`, `true`, or a path | Splices that YAML file ahead of the first real user message. `true` names `turn0.yml`, which ships with the extension |
| `forge` | `false`, `true`, or `{ "maxChars": n }` | Refills a foreign turn's cot when the request targets this model. `true` is no bound; `maxChars` cuts the trace |
| `cot` | `text:<tag>` or `toolcall:<name>` | How the writers write the cot. `text:<think>` and `text:think` are one tag |
| `transcribe` | `false` or `true` | Writes a turn's own reasoning as one fence — the summary behind a signature merged in, every readable block replaced — so the next request carries bytes a model reads instead of a signature it cannot use |
| `beat` | `false` or `true` | Appends `[turn <position>]` inside a text block of every assistant turn |

Each slot resolves on its own, down the same layers, and reports which layer answered:

```
session  ->  the first matching rule  ->  the file's default  ->  the built-in record
```

So a rule that names only `gate` leaves the other six to the layers below it, and changing
`default.forge` moves nothing else.

### forge

Pi drops an assistant turn's thinking block whenever the request targets a different model than the
one that wrote it, which leaves the conversation reading as if the reasoning had never happened.
`forge` puts that reasoning back as fenced text in the turn's own reply, so the turn keeps the model
stamp that says it came from elsewhere and no turn ever shows two reasoning traces. The destination
model's record decides: switching to a model whose `forge` is off refills nothing, and the model
being left behind has no say.

`forge` has no bound unless a config asks for one. A truncated trace is not the reasoning the turn
wrote, and a model shown a cut-off version of its own thinking has a reason to distrust the turn. A
cut that was backed off to keep a character whole and so reached the end of a short trace states no
truncation: the marker is written only when something was actually dropped.

The refill is a pure function of the message's own bytes, so a grown conversation keeps every
already-sent position byte-identical: switching a model costs one cache miss, and the turns after it
stay on the same prefix.

### cot

`cot` decides how `turns` and `forge` write a cot, and it is per model. The form is part of the
value, because a tag name cannot say whether the fence is a tag or a tool:

- `text:<tag>` writes the reasoning into the reply's first text block:
  `<tag>`, the cot, `</tag>`, then the reply. One block, so the cot and the reply stay one turn, and
  the bytes are the same on every provider.
- `toolcall:<name>` sends the reasoning as the argument `{ "thought": ... }` of a real call to that
tool, answered by its result, ahead of the assistant message it belongs to. The pair is inserted
  rather than the message rewritten, because the message may carry a call of its own and a second
  `toolCall` would leave two calls waiting for results Pi then answers with a fabricated error.

The tool is registered and declared while `forge` or `turns` needs it, because a provider that
validates a historical function name against the declared tools rejects the request otherwise. Its
`execute` answers `OK` and nothing else, so a live call is harmless. A name Pi already declares a
tool for — `read`, `write`, `edit`, `bash`, `powershell`, `ls`, `find`, `grep`, `glob`, `codemode`,
`tool_search` — is refused as a cot name, and so is `ask_authorize_gate`: registering over one of
them would replace Pi's own tool for the session.

Every name the file names travels with the record, whatever form it was written in, so a turn already
carrying a cot under one model's name counts as carrying one for a model configured with another: no
turn is ever fenced twice. A call counts only when it carries the id prefix the extension writes, so
a genuine call to the cot tool is the model's own reasoning and never passes for a fence. Switching a
model is one request where the shape changes; after it, every turn the extension wrote stays
byte-identical, so the prompt cache keeps hitting.

### transcribe

`forge` answers one question: a turn pi will not carry, whose reasoning is about to be lost. The turn
in front of it, written by the live model, pi carries as it is — and on a backend that signs its
reasoning, that means the next request carries a signature the model cannot read, plus whatever
summary the provider chose to include. `transcribe` closes that gap: it writes that reasoning into the
turn's own text as the fence `cot` names, and the thinking block goes.

A turn can carry reasoning in three places at once, and any two of them can be present together: the
thinking blocks, the interior of a fence the model wrote itself, and the words ahead of that fence.
`transcribe` reads all three into one piece of text and writes exactly one fence, so the shape a model
meets on the next request is the same shape every time — one opening tag, the reasoning, one closing
tag, then the reply. It is the only writer that reconstructs a turn rather than adding to one.

Where each piece comes from is settled by the blocks, not by their order. Whether a text block is
reasoning or reply depends on whether it came before or after the fence: with no fence anywhere the
text is the reply and the reasoning is the thinking blocks alone, and with one, every text block ahead
of it is reasoning and every block behind it is the reply. A block that carries the fence contributes
both — the words in front of the tag, then its interior, then whatever follows as the reply. The rule
is stated once and holds for every arrangement a wire can produce.

The thinking blocks are read, not discarded, and this is the part that changed. Measured over real
turns that carry a fence and a signature together, the fence holds almost none of the summary: the two
are different traces. Keeping only the fence threw away reasoning the model had already paid for, and
keeping the block beside the fence showed two traces on one turn. So the summary is written into the
fence, ahead of the model's own words, because it is the provider's compression of the whole turn and
the model's own words read as the detail that follows it. Nothing readable is dropped and the turn
ends up with one trace.

A signature is a credential, and a credential beside a fence vouches for reasoning the request cannot
read anyway. Every reasoning block is replaced by the fence, so no signature survives a pass.

`maxChars` bounds the reasoning, never the reply. A cut reply is a turn that stopped talking.

The result is a fixed point. Every piece is stripped of the configured tags and trimmed before it is
joined, a piece another piece already contains is dropped, and a blank reply is left out, so a second
pass finds one fence with no tags inside it and nothing outside it and rebuilds the same bytes. A turn
the extension has written is therefore byte-identical on every request after the first, which is what
keeps the prompt cache hitting; only the first request that carries a turn written by a model changes
it once. The decision reads the message and the spec and nothing else — not the live model, not the
clock, not the run — so the same history yields the same bytes and a model switch costs nothing beyond
the request it happens on.

A model that learned the fence leaves the closing tag in its own reasoning, so the fence is stripped of
every configured fence tag — the union of names, in either case, and before the fence is built, so the
fence this module writes can not be a candidate. Removal rather than escaping: an escape is a spelling
the model has never seen, and a model that learns it starts emitting it, while a removal is invisible
and teaches nothing.

That strip is applied as a rule and not as a judgement. A reply that mentions the tag is folded into
the reasoning like any other words ahead of a fence, and a closing tag quoted in a reply is drawn into
the fence, because the fence ends at the last closing tag in the block. Both are pinned in the check so
a later change makes the trade again on purpose. A tag with an attribute is not the fence: only a
configured name is stripped, and only as a whole tag.

Where the fence ends is the one place a block can be read two ways, and the reasoning wins it: a
closing tag inside a cot is the shape every real one had, so the scan takes the last one. A half-written
fence — the model opened the tag and never closed it — runs to the end of its block and is closed here,
and a stray closer with nothing behind it is dropped. Two opening tags in one block are read as one
fence: the prefix is reasoning and the rest is the interior, so the turn still ends up with a single
tag pair.

The toolcall form writes the same reasoning as the argument of a call and leaves the turn with only
what it did besides reasoning, so the two forms differ in where the cot lands and in nothing else. A
turn already preceded by a cot pair is that pair's turn: the reasoning goes into the pair's `thought`
and the turn keeps only its own calls. The pair's id is kept — it is derived from the cot and the turn,
and the position that salts it moves when a message is inserted, so recomputing it would rewrite an id
the transcript already holds.

Nothing here is written to the session. The transcript keeps its thinking blocks and its signatures,
so turning the slot off restores the native shape exactly; the writing lives in the request and
nowhere else. The two slots are independent: `forge` alone keeps the native wire format, `transcribe`
alone writes the live model's own turns, and both together write everything readable.

With both on, the promotion is the stronger writer and runs first, on every turn it can read — the
live model's and a foreign one's alike. That has one consequence worth naming: `forge`'s `maxChars`
stops applying to any turn the promotion reached, because the turn is already carrying a cot and
`forge` leaves it alone. A bound is a decision about what to cut from a trace that is being brought
back, and `transcribe` exists to make the trace visible in the first place, so a cut there would
undo the slot. The order is a preference rather than a requirement: `forge` writes a fence out of the
same bytes a thinking block carries, the strip drops the copy that adds nothing, and both orders
produce the same one-trace request in both forms.

The readable text is what the provider exposes. When that is a summary, the summary is what gets
written into the fence, and the full trace stays encrypted where it was; nothing here can recover it.

### beat

`beat` appends `[turn <position>]` to the last text block of every assistant turn. It is a position
anchor the model can count, not an instruction, and it answers a question a transcript otherwise
cannot: how many tool cycles have passed since the last thing I wrote down.

The marker rides inside the turn it counts. No message is added, and no system message is written:
providers disagree about a mid-conversation system message and several fold it into the head, which
invalidates the whole prefix. The number is the message's position, never a running counter, so
appending a turn renumbers nothing that was already sent, and the marker is removed before it is
rewritten so a second request writes the same bytes.

### inherit

`inherit` decides what a session hands to the processes it starts: `keyed` (the same model only),
`tree` (every model, in this process and in the ones it starts), or `none` (nothing, and inherited
values are dropped).

## Precedence

```
session slot  >  config rule  >  config default  >  built-in record
```

An answer lasts as long as the process, including `/new` and `/reload`, until `/leviathan reset`.
Nothing is written to disk unless `remember` asks for it. Each loaded instance keeps its own answer,
decision, delivery record and gate activation, so two sessions in one process do not share them, and
the answers the process set are what a new instance reads. A model switch keeps the slots stored
without applying them until the next command re-keys the answer to the live model. Under an effective
`tree`, the first command creates the answer every model in the tree shares.

## Commands

| Command | Effect |
|---|---|
| `/leviathan` | Every slot with its value and the layer that answered, the model, the config file, the inherited value, and a table of every rule in the file including the ones an earlier rule makes unreachable |
| `/leviathan persona on\|off\|<path>\|default` | Place that text, the shipped `prompt.md`, or nothing; `default` drops the session slot |
| `/leviathan gate on\|off\|default` | Declare the gate tool or withdraw it |
| `/leviathan turns on\|off\|<path>\|default` | Splice the shipped file, another file, or nothing |
| `/leviathan forge on\|off\|maxChars <n>\|maxChars none\|default` | Refill with no bound, with a bound, or not at all |
| `/leviathan cot <form>:<name>\|default` | How the writers write the cot |
| `/leviathan transcribe on\|off\|default` | Promote each turn's own reasoning into its text, or leave it native |
| `/leviathan beat on\|off\|default` | Stamp each assistant turn with its position |
| `/leviathan inherit keyed\|tree\|none` | What this session hands to the processes it starts |
| `/leviathan remember` | Write this model's whole record as a rule and apply it |
| `/leviathan reset` | Drop the session answer, so the config decides again |

`remember` writes all seven slots as one complete rule, `false` included, so the file answers for that
model without being read against its `default` afterwards. The spelling is preserved rather than the
resolved value: a slot that said `true` keeps saying `true`, and a relative path keeps being
relative, because writing today's absolute path would tie the record to one machine. The rule goes to
the front, in front of any wildcard that would shadow it, and a second run leaves the file
byte-identical.

The footer names the switches that are on, in a fixed order, and nothing else: 🎭 `persona`,
🛡️ `gate`, 💬 `turns`, ⚒️ `forge`, 📝 `transcribe`, 🕑 `beat`. `Leviathan 🎭🛡️💬⚒️📝🕑` is all six;
`Leviathan ⚒️` is forge alone; `Leviathan` is none. A `!` follows when a switch that is on did not
reach the request: the persona
file is missing or empty, the transcript has nowhere to put the text, the configured turn file did
not load, or another extension replaced the system prompt.

## Subagents

A subagent is a Pi process launched with the parent's environment, so the parent writes its answer
into `PI_LEVIATHAN` and the child reads it. Neither extension knows the other exists.

The value is JSON: `{"k":"CLIProxy-Chat/glm-5.3","p":1234}`, and an answer that carries session slots
adds `"s"`, for example `"s":{"persona":"/abs/alt.md","turns":false,"forge":{"maxChars":1200}}`. `k`
is the model key or `*`, `p` is the publisher pid, and `s` is the slots, absent when there are none.
A malformed `s` rejects the whole payload, so a child resolves from the config rather than from half
an answer. A child accepts it when `p` is its parent or itself, and rewrites it with its own pid so
the next level reads the same answer, and narrows a `*` key to its own model once the config asks for
`keyed`. Any other value, including one exported from a shell, is discarded and replaced.

A spawner that builds a fresh environment cuts the channel, and the child resolves from the config.
So does a wrapper that puts a shell between the two: only a direct child keeps the channel. Several
sessions in one process (an SDK host) share one environment, so the last session to set a slot wins
for the processes it starts.

## How the persona reaches the request

The text arrives as the head of the leading system message's `content`. A section would render as
`<name>`, its content and `</name>`, which names the block and leaves a marker the model can point
at. The `context_with_system` guard places the raw text, with no wrapper, ahead of every section. Pi
renders that content first, so the order on a request is: the text, tools, rules, docs, project
context, skills, working directory, MCP servers.

The leading system message is the first system message in the transcript. An entry written before the
first run, such as the `bashExecution` record of a `!command`, sits ahead of the prompt patch Pi
appends for that run, so the guard finds the prompt where it is and moves it to index 0: the position
Pi renders the prompt from, and the position where the text leads the request instead of trailing an
earlier entry. A transcript that carries no system message has nowhere to put the text.

While the text is in force pi's stock identity sentence is withheld: the same guard removes the
`preamble` section from every system message whose value is one of the stock sentences Pi ships,
because that sentence contradicts the persona at the front of the same prompt. Pi reworded it in
1.5.0, so both are known: the 169-character sentence of 1.3.0 through 1.4.0 and the 126-character
sentence of 1.5.0. The comparison is exact, so any other value in `preamble` stays whole. The
sentence returns the moment the text is not in force. Both are request-scoped, and neither is
recorded in the transcript.

The extension makes one decision per run, and the guard reuses it until the model key or the session
answer changes. A steady conversation parses no config and reads no file, and sends byte-identical
prompts turn after turn, so the prompt prefix cache stays warm. Changing a slot, the model, or the
persona file changes the head and costs one cache miss.

If another extension forces the system prompt, Pi replaces the system messages with that string and
keeps every message that is not one, so the fabricated conversation would reach the model under a
prompt nobody wrote for it. The extension delivers neither: the text is reported as undelivered, the
block is skipped, and the footer shows the loss. The force is read when the request is built, not
when the run starts, because the extension that sets it may be loaded after this one. When the
leading system message holds blocks Pi never puts there, or the transcript carries no system message
at all, the extension places nothing: the text stays out, the identity sentence stays in, and the
loss is reported. A refilled cot is a separate axis on the same request and still travels: the persona
text is what cannot be placed.

## The fabricated conversation

The `turns` file is a YAML sequence, and one item is one message. Three keys:

```yaml
- user: |

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

`assistant` also takes a bare string, which is its `text`. The cot is written ahead of the reply in
whichever form `cot` names: fenced in a tag at the head of the first text block, or as a call to the
cot tool answered by its result. The text form is ordinary text and nothing else: an assistant's own
reply is the one thing every provider carries back unchanged, and no reasoning field is written by
hand. A fabricated turn is stamped with the live model, so pi reads it as this model's own earlier
turn.
`result` answers the `call` of the assistant before it,
so every `call` has exactly one `result`, and the sequence begins with `user`.
A file with one bad item injects nothing: a half-fabricated history would leave the model an
assistant turn nobody answered.

The block is spliced before the first message that is not a system message, so it lands after the
prompt and after a compaction summary, and the leading system message moves to index 0 with it. It
is rebuilt from the file on every request, so the transcript records nothing: a model switch, a
fork, a reload or a new session leaves nothing to clean up. The bytes depend on the file, the model,
and the resolved `cot`, so the block stays inside the provider's prompt cache.

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
and no turn ever shows two reasoning traces.

The refill is the turn's own cot, written in whichever form `cot` names: fenced inside its first text
block, or as a call and result inserted ahead of it. It is added in the request and never written to
the session, so a fork, a reload or a resumed session has nothing to undo. It is a pure function of
the message's bytes, the live model triple and the cot, which matters for one reason: the request
keeps every already-sent position byte-identical as the conversation grows, so the provider's prompt
cache keeps hitting. A model switch costs one miss — the request whose shape changes — and every turn
after it stays on the same prefix; a refill that depended on position, on the run's start or on the
clock would cost one miss per request instead. A turn already carrying its cot is left as it is,
whether it carries a fence or a cot call, so the refill is idempotent.

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
would make pi carry its thinking block as well, and the turn would show its reasoning twice.

The fabricated chain of thought sits ahead of the assistant reply, in the form `cot` names, so the
turn reads as reasoning the assistant wrote down followed by what it said. The text form is ordinary
text: one text block, the same bytes on every model, and no provider's reasoning field is written by
hand. The toolcall form is a real call, which is why that tool is declared while it can appear.

What a request actually carries, and whether the provider accepted it, is a property of the wire
rather than of this extension. A provider entry whose model-level `baseUrl` points at a local reverse
proxy records the serialized request and response as plain HTTP while forwarding to the real
endpoint over HTTPS, which shows the fenced turns, the model stamps and the provider's own reaction
in one place and needs no switch here.

A file that does not load injects nothing, reports once, and leaves the persona alone. The footer's
`!` marks the loss while a configured block is missing, and `/leviathan` names the file and the
reason.

## The authorization gate

`ask_authorize_gate` is a direct tool the model calls before any request it is unsure about
delivering; the call itself is the signal that the request needed one. The declaration routes the
call and never names the outcome, so the ruling has to be asked for. It is registered dormant and
activated exactly while the `gate` slot is on. A model whose record turns `gate` off never receives a
declaration; a record that turns `gate` on without `persona` is allowed, and the panel says so.

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
rule table and the resolver, `channel.js` the cross-process value, `cot.js` the cot spec, the pair
both writers emit, the promotion and the turn marker, `gate.js` the field table and the ruling text, `turns.js` the turn file's parse and
its messages, `forge.js` the cross-model cot refill, `prompt.md` the injected text. Edit `prompt.md`;
the next run uses it. A missing or empty file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

`node check.mjs` drives the registered handlers against a temp config. It pins the resolver slot by
slot and the layer that answered for each, the channel payload, the guard's placement and preamble
withholding, the config write, the gate rulings, the turn file's parse and injection, the cot
refill's predicate, purity, idempotence and prefix stability, the fence across two models' tags, the
footer, the `remember` contract, and the `prompt.md` invariants. One guard reads every
source file in the package and fails when one of them names a provider's api family, and a second
pass over those files fails when a line asks an api value what it is: a method call, an index, a
comparison against a literal, a coercion, or a hand-off to an equality helper. Holding an api and
passing it along is what the extension does; asking it what provider answered is the scope it does
not take. A drift guard reads the literal value each installed Pi release assigns to its preamble
and fails when that value is not one the extension knows, or when no release is installed at all. It
reads the assignment, not any occurrence
in the file, so a release that rewords the sentence while an old wording survives as a comment still
fails; it decodes the literal before comparing, and a file that assigns no recognizable literal fails
rather than passes. Releases that sit side by side on different wordings both pass. Set `PI_PKG` to
point the check at a pi package elsewhere.

## Attribution

`prompt.md` is a modified copy of `lib/default-prompt-inject.zh.md` from
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and
`LICENSE`.
