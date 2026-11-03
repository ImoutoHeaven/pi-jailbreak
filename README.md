# pi-jailbreak

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
pi install /path/to/pi-jailbreak
```

`pi -e ./index.ts` loads it for one run. The extension reads its own directory, so `prompt.md`,
`config.js`, `channel.js`, `gate.js`, `turns.js` and `commands.ts` travel with `index.ts`. A missing
`yaml` package disables the fabricated conversation and leaves the prompt text in force.

## Configure

The session reads `$PI_JAILBREAK_CONFIG` when it is set, and otherwise `jailbreak.json` in pi's
agent directory. That directory is `$PI_CODING_AGENT_DIR` when that is set, and `~/.pi/agent`
otherwise. When no file loads, the empty config applies: `default: "normal"` and no rules.

Start from `jailbreak.example.json`:

```json
{
	"default": "normal",
	"inherit": "keyed",
	"prompt": "prompt.md",
	"rules": [
		{ "provider": "CLIProxy-Chat", "model": "deepseek-*", "mode": "jailbreak" },
		{ "provider": "deepseek", "mode": "jailbreak" },
		{ "model": "*deepseek*", "mode": "jailbreak" }
	]
}
```

A model takes the first rule whose `provider` and `model` both match. A missing field matches
anything. A pattern without `*` is exact, `*` matches any run of characters, and matching ignores
case. `mode` is `jailbreak` or `normal`. `prompt.md` is the text that ships with the extension; any
other `prompt` path is relative to the config file. A file with one bad value is rejected whole and
reported once, and the empty config applies instead.

`turns` names the YAML file whose messages are spliced ahead of the first real user message. It has
three states: absent takes `turn0.yml`, the file that ships with the extension, `null` turns the
block off, and a string names another file. A rule's own value wins over the config-level one, and a
rule that sets `null` keeps it off even when the config names a file. `turn0.yml` resolves to the
package copy wherever the config lives; every other relative path resolves against the directory
holding the config file.

```json
{
	"turns": "team/turn0.yml",
	"rules": [{ "provider": "deepseek", "mode": "jailbreak", "turns": null }]
}
```

`inherit` decides what a session hands to the processes it starts: `keyed` (the same model only),
`tree` (every model, in this process and in the ones it starts), or `none` (nothing, and inherited
values are dropped).

## Precedence

```
/jailbreak on|off   >   inherited value   >   config rule   >   default
```

A session override lasts as long as the process, including `/new` and `/reload`, until
`/jailbreak reset`. Nothing is written to disk unless `remember` asks for it. Each loaded instance
keeps its own answer, decision, delivery record and gate activation, so two sessions in one process
do not share them, and the mode the process set is what a new instance reads.

## Commands

| Command | Effect |
|---|---|
| `/jailbreak` | The model it resolved or `(none)`, the resolved mode, the rule that selected it, the prompt file, the config file, and the inherited value if there is one |
| `/jailbreak on` / `off` / `toggle` | Set the mode for this session |
| `/jailbreak reset` | Drop the session answer, so the config decides again |
| `/jailbreak remember on` / `off` | Write a rule for the current model, move it ahead of any rule that would shadow it, keep the prompt file that model already resolves to, and apply it now |

The footer shows `JailBreak on` while the text is in force, `JailBreak off` while the mode is normal,
and `JailBreak !` when the mode is jailbreak and the request carried nothing: the prompt file is
missing or empty, the transcript has nowhere to put the text, or the configured turn file did not
load. The third state follows the request that was actually sent, so a run whose text cannot be
placed says so at once instead of showing on.

## Subagents

A subagent is a Pi process launched with the parent's environment, so the parent writes its answer
into `PI_JAILBREAK` and the child reads it. Neither extension knows the other exists.

The value is JSON: `{"m":"on","k":"CLIProxy-Chat/glm-5.3","p":1234}`. `m` is the mode, `k` is the
model key or `*`, `p` is the publisher pid. A child accepts it when `p` is its parent or itself, and
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
`preamble` section from every system message whose value is exactly the 169-character sentence Pi
ships, because that sentence contradicts the persona at the front of the same prompt. The comparison
is exact, so any other value in `preamble` stays whole. The sentence returns the moment the text is
not in force. Both are request-scoped, and neither is recorded in the transcript.

The extension makes one decision per run, and the guard reuses it until the model key or the session
override changes. A steady conversation parses no config and reads no file, and sends byte-identical prompts
turn after turn, so the prompt prefix cache stays warm. Switching the mode, the model, or the prompt
file changes the head and costs one cache miss.

If another extension forces the system prompt, Pi sends that string as the whole prompt. The identity
sentence goes with the sections it replaces, and the extension reports the text as undelivered. When
the leading system message holds blocks Pi never puts there, or the transcript carries no system
message at all, the extension places nothing: the text stays out, the identity sentence stays in, and
the loss is reported.

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

`assistant` also takes a bare string, which is its `text`. `result` answers the `call` of the
assistant before it, so every `call` has exactly one `result`, and the sequence begins with `user`.
A file with one bad item injects nothing: a half-fabricated history would leave the model an
assistant turn nobody answered.

The block is spliced before the first message that is not a system message, so it lands after the
prompt and after a compaction summary, and the leading system message moves to index 0 with it. It
is rebuilt from the file on every request, so the transcript records nothing: a model switch, a
fork, a reload or a new session leaves nothing to clean up. The bytes depend on the file and the
model alone, so the block stays inside the provider's prompt cache.

The last item decides what the model reads immediately before the real request. `assistant` closes
the block with a reply, and the request follows as a new turn. `result` closes it with tool output,
which is the shape to use when the fabricated turn carries a gate ruling. `user` closes it with an
unanswered turn, which Anthropic combines with the real request and the OpenAI-compatible apis send
as written.

The fabricated chain of thought travels in `reasoning_content` on `openai-completions`, the field
that adapter writes a thinking block to. Every other api receives it as leading text, and the
extension says so once per session, because `openai-responses` parses any thinking signature it is
given and Anthropic turns a signature-less block into text on its own.

A file that does not load injects nothing, reports once, and leaves the prompt text in force. The
footer shows `JailBreak !` while a configured block is missing, and `/jailbreak` names the file and
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

`index.ts` is the hook and the tool definition, `commands.ts` the `jailbreak` command, `config.js` the
rule table and the resolver, `channel.js` the cross-process value, `gate.js` the field table and the
ruling text, `turns.js` the turn file's parse and its messages, `prompt.md` the injected text. Edit
`prompt.md`; the next run uses it. A missing or empty file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

`node check.mjs` drives the registered handlers against a temp config. It pins the resolver, the
channel payload, the guard's placement and preamble withholding, the config write, the gate rulings,
the turn file's parse and injection, and the `prompt.md` invariants. A drift guard fails when an
installed Pi release rewords the stock preamble, or when no release is installed at all; set
`PI_PKG` to point the check at a pi package elsewhere.

## Attribution

`prompt.md` is a modified copy of the DeepSeek Harness jailbreak prompt from
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and
`LICENSE`.
