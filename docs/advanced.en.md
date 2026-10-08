# Advanced Topics

Deep content that doesn't belong in the main README: security model, location keep-alive, card guard, session resume, gateway election, full configuration, and development architecture.

## Security model

```
permission.evaluate (plugin hook)               permission.asked (event stream)
allowlist → allow    denylist → deny            send Feishu approval card (self-signed token)
session-scoped allow → allow                    user clicks → card.action.trigger (long connection)
else (per session preset) → ask ──────────────► verify: allowlist → verify signature → bound fields → replay guard
                                                → ctx.permission.reply(...)
```

- **Self-signed token**: HMAC-SHA256 over `requestID + sessionID + clicker openId + expiry + nonce`; forgery / forwarding / replay are all rejected.
- **Force-stop and "allow in this session" buttons share the same signing scheme**: each binds its own dedicated fields + purpose tag isolation — capabilities don't leak across actions.
- **Only affects Feishu-originated sessions**: local sessions without a mapping are never downgraded to `ask` (otherwise they'd hang forever with no approval outlet).
- **Three layers of single-user boundary**: availability "only yourself" + no group permission + code-level open_id allowlist.
- **`always` semantics**: persisted only when the request carries `save[]`; otherwise equivalent to "allow once".
- **Approval card buttons**: 4 by default (`✅ Allow once` / `🔓 Always allow` / `✅ Allow this tool in this session` / `❌ Deny`). "Always allow" persists by command prefix; "this session only" is a middle granularity recorded into `allowActions` plus a session-level ruleset; changing tier (`/perm`) clears "this session only" grants; set `sessionAllowButton: false` to go back to three buttons.

## Location keep-alive

opencode **recycles idle locations**, which disposes the plugin and closes the Feishu long connection:

| Mechanism | Where | Trigger | Behavior |
|---|---|---|---|
| LayerMap `idleTimeToLive` | `packages/core/src/location-services.ts` (hardcoded `60 minutes`) | No **location-bound base-route request** for 60 min (`locations.get()`) | Location services destroyed (silent) |
| `@opencode/LocationActivity` | Also hardcoded 60 min | No **event carrying that location** for 60 min | Interrupts active sessions, then `invalidate(location)`; logs `location services evicted` |

Either one disposes the plugin (Feishu long connection closes). **After that, if the location gets no further requests the plugin won't self-recover → the bot goes permanently silent** (upstream issues: [#51343](https://github.com/anomalyco/opencode/issues/51343), [#51891→#48691](https://github.com/anomalyco/opencode/issues/48691), [#51828](https://github.com/anomalyco/opencode/issues/51828); the TTL has no config option).

### Measured locally (v2.0.16, decompiled + verified point by point)

- Session routes (`GET/POST /api/session*`) do **not** call `locations.get()`: they can neither renew LayerMap nor **rebuild** a reclaimed location (the old "keep-alive/rebuild via session requests" assumption was wrong);
- `GET /api/plugin` **does** call `locations.get()`: it renews LayerMap and **directly rebuilds** a reclaimed location (log `location services booted`; the plugin reloads and the long connection reconnects). Bind the location with either the `location[directory]` query parameter or the `x-opencode-directory` header — both verified;
- The `globalThis` slot is **shared across locations within the process** (verified: an instance in another location can see the first instance's process guard) → **the process-level timer lives as long as the process**.

### Two defenses (on by default, **no external script required**)

1. **Gateway keep-alive** (every 20 min, `keepaliveIntervalMs`): `GET /api/plugin` (location-bound) → renews LayerMap; plus create + delete a probe session (auxiliary, to attempt a `LocationActivity` renewal).
2. **Second-scale revive after eviction** (v0.2.20): on dispose the plugin immediately schedules three probes (+1s / +5s / +20s). Those timers live on the host process (they survive location teardown), so the location is re-created within **seconds** → plugin reloaded → WS reconnected. Outage per eviction drops from "up to one heartbeat (20 min)" to **~10 seconds** (hourly availability ~75% → ~99.7%).
3. **Process-level gateway watchdog** (also every 20 min, one timer per process): every plugin instance in any location registers; the timer lives on process-wide `globalThis` and **survives the instance**. Effects:
   - After the gateway location is reclaimed (including the **single-location / headless** case), the next heartbeat uses `GET /api/plugin` to **rebuild the location** → the plugin reloads and the Feishu connection reconnects (self-heal within ≤ `keepaliveIntervalMs`);
   - The watchdog holds an **independent log sink** (not closed by instance cleanup, not replaced by later hot-reload instances' loggers), so post-eviction heartbeat logs still reach disk for diagnostics;
   - After a service restart, it starts on the first plugin load (probing once ~3 seconds later).

> **No external scripts / cron / systemd needed**: all of the above runs inside the plugin process.
> The only uncovered case is "the whole opencode process is down and nobody uses it for a long time" — no plugin can act then;
> it recovers when opencode is used again. `keepalive: false` disables all keep-alive.
> Note: the `LocationActivity` 60-minute recycle **cannot be prevented from the plugin side** (measured on v2.0.18: location-carrying events a plugin can produce — `session.created` / `session.renamed` — do **not** renew its deadline, and the TTL has no config knob). The guarantee here is "**second-scale self-heal after eviction**" (since v0.2.20).

## Watchdog staleness rules

The watchdog (a 60s sweep) force-interrupts a session in two cases: "no progress" (no event for `staleExecutionMs`) and "queue timeout" (queued longer than the threshold without `execution.started`). To avoid false kills (issue #1 fix):

1. **Child-session activity credits the parent chain**: a `task` subagent runs in a **child** session; its events carry only the child ID. The plugin tracks the child→parent chain via `session.created`'s `parentID` and refreshes activity up the chain — the parent is not misjudged while a subagent runs.
2. **Legitimate waits are never stale**: sessions with a **pending form** (`question`) or an **unresolved approval** are not interrupted no matter how long the user takes, and their queued messages are not cancelled (waiting on the user ≠ stuck).
3. **Off switch**: `staleExecutionMs: 0` disables the watchdog entirely ("never auto-interrupt").

> What still triggers it: a genuine hang — no events at all and no pending interaction. In that case the watchdog interrupts and sends the "已自动中断卡死会话" notice card by design.

## Queued-card lifecycle (measured semantics)

> Busy-time delivery now defaults to `steer` (cut in immediately); this section describes the receipt-card lifecycle under `busyDelivery: "queue"`.

An opencode `delivery:"queue"` message is injected for processing **at the next step of the currently running execution** (**no** new `execution.started` is emitted — confirmed by a controlled experiment, 2026-10). The plugin manages receipt cards accordingly:

- New message while busy → its receipt card enters the "waiting" queue;
- Once consumed (within the same execution), its reply renders on **whichever card is running at that time**;
- After the execution reaches a terminal state, remaining queued cards get a **3-second grace window**: if an independent `execution.started` arrives, they are promoted normally; otherwise they are closed as "handled with this run" — never left waiting forever.

## Card content guard (table over-limit degradation)

Feishu allows **at most 5 table components per card**; exceeding it makes patch return 400 (`code=230099`) — with lots of markdown comparison tables the card stays stuck on old content and looks dead. The plugin guards the **whole card**:

- Table count accumulates **per card** (`cardMaxTables`, default `4`, clamped 1–5); tables beyond the limit are **degraded to fenced code blocks**: content is preserved verbatim, only the table rendering is lost.
- `|` inside fenced blocks is never mis-detected (fence masks are computed line by line); degradation is idempotent; component count per card converges to ≤200 (oldest elements dropped when over).
- Covers run-card text blocks, topic root / resume / summary cards, and the send-layer fallback (`sendCard` / `replyCard` / `patchCard`); degradation is logged at `warn` for observability.

## Long answers (run-card slimming + separate final answer)

A long turn (dozens of tool calls) can push a single run card to its limits (28KB / 200 elements), triggering degradation and **dropping the oldest blocks** — the card looks "full" and earlier content disappears. Default strategy:

1. **The run card is progress-only**: keep the last `runnerCardMaxTools` (default 12) tool blocks, collapsing older ones into "…omitted N tool calls"; each text block is capped at `runnerCardTextMax` (default 2KB).
2. **The final answer is sent separately**: when a turn ends and the trailing text is at least `finalAnswerMinChars` (default 600 chars), it is sent as its own "✅ 完整回答" card; the run card keeps only a short notice.
3. **Very long answers become files**: at least `finalAnswerFileMinBytes` (default 20KB) → delivered as a `.md` file (preview/download), never truncated.

## Receiving images / files

- **Permission**: the app must enable `im:message:readonly` (the message-resource API accepts one of `im:message` / `im:message:readonly` / `im:message.history:readonly`). Without it downloads fail and degrade gracefully; text messages are unaffected.
- **Flow**: an image/file message → download via `im.messageResource.get` using `image_key` / `file_key` → save into the **attachment directory** (default `<session workdir>/.opencode/temp/opencode-feishu-plugin/` with a built-in `.gitignore` so `git status` stays clean; override with `attachmentsDir`; falls back to the system temp dir when the session directory is unknown) → attach as a `file://` URI on `session.prompt` (the trailing text notes the saved path; image extension inferred from the response `Content-Type`).
- **Why not the system temp dir**: inside the session workdir, the model's `read` (and similar tools) treat the file as an in-workspace read — **no out-of-directory approval** is required; outside it, every read would need manual approval.
- **Limits**: max 20MB per attachment by default (`attachmentMaxBytes`, clamped 1–100MB); 30s timeout (`attachmentTimeoutMs`); on failure the message is still delivered, with a "download failed: reason" note.
- **Boundaries**: audio / video / stickers are not downloaded (placeholders remain); merged-forward and in-card resources cannot be downloaded via the API. Feishu's own per-resource cap is 100MB.

## AI session management (issue #2 evolution)

**AI routing** for the main chat (`quickNew`, on by default) covers **plain text** and **creation / management
commands** (`/new` `/form` `/dir` `/model` `/perm` `/sessions` `/use` `/resume`); other commands
(`/help` `/stop` `/cancel`…) still go through the deterministic command matrix:

- **Intent recognition**: the temporary-generation channel (no session context, sub-second) returns strict JSON
  `{intent:"create|list|enter|chat|clarify", dir, dir_source, title, perm, model, target, question, reason}`;
- **Intent dispatch**:
  - `create` → once the directory is resolved, turn the card in place into a prefilled form;
  - `list` → session list card (same as `/sessions`);
  - `enter` → resolve `target` (index / title keyword / id prefix) to a **unique** session and reuse `/resume` to
    enter the topic; ambiguity or no match becomes a follow-up question;
  - `clarify` → **conversational follow-up**: send a **plain-text** message (the AI's `question`) and remember the
    context; the next message (even if it looks like `/path`) is treated as the answer and recognition continues;
  - `chat` → console hint card;
  - parse failure / exception → **fall back** to the deterministic command matrix (commands) or hint card (plain text).
- **Directory first (important)**: for `create`, `dir` is never empty — the AI resolves it in priority order:
  ① `given` — a path the user explicitly provided; ② `existing` — matches a candidate (**the allowed root's
  first-level subdirectories** (`scanRootSubdirs`, limit 50) + recent dirs + all session dirs, titles as semantic
  hints; prompt candidates capped at 60); ③ `new` — otherwise create a topic-named dir under an allowed root
  (`<allowedRoot>/<kebab-case topic>`); ④ fall back to the allowed root.
  **When unsure** (both an existing and a new dir seem plausible, or vague wording) it does **not pick for you** —
  it emits `clarify`, asking the user (listing candidates or offering to create a new one). Before prefilling,
  validation runs via `validateDirectory(..., { create: false })` — a **dry check** (no disk writes; out-of-range/system
  dirs are rejected, in-range paths may not exist yet); the actual `mkdir -p` happens only on form submit;
- **Prefilled form (directory filled)**: the form appears only once the directory is resolved, with a source
  note on top ("✓ matched existing/recent dir" / "➕ AI-created" / "✍️ you specified"). A path **you** gave that
  is out of range is **never silently replaced** — no prefill plus a warning, for the user to fix in the form;
- **Form confirmation**: creation **always** goes through form submission (`applySetupFormSubmit`) — the user
  confirms or edits the AI prefill; the anchor is the form message itself, and a topic opens on submit.
  Model/permission etc. are picked in the form.
- **Multi-turn clarification state**: kept in memory per `chatId` as `{originalText, turns}` (TTL 30 minutes); the
  recognition prompt includes the history. `/cancel` clears a pending question.

## `/sessions` data source & resume card

`/sessions` lists **all local opencode sessions** (newest first, 8 per page, configurable):

- **Data source**: plugin-native `ctx.session.list()` first (usually not exposed on V2 runtimes) → **local HTTP `GET /api/session`** (same machine as opencode; full list including TUI/Web sessions) → `SessionMap` fallback (bot-created sessions only). Entering an external session adds a mapping, so approvals / failure notifications keep working.
- Each row shows title / short id / relative time / topic-bound or not / directory; the current session is marked "← current"; bound topics show "▶️ reopen", others "▶️ enter"; pagination at the bottom plus "➕ create session".
- **"▶️ enter topic"**: sends a resume card (with session summary) in the main chat; **reply to the card** to continue that historical session.
- `/resume [index]` skips the list; same "resume card → reply to continue" flow.
- Summary: "reuse native compaction summary → fast-summary only if missing", plus a "🗜 compress & summarize" button (explicit; never implicitly mutates history). Fast-summary / intent-recognition requests **must carry the `x-opencode-session` header** (opencode-go rejects without it), and only the **session pipeline** attaches it automatically — the stateless `generate` endpoint cannot. Implemented as three channels: **① temporary session (create → `session.generate` → delete; preferred, provider-agnostic) → ② `ctx.generate.text(input, { headers })` → ③ local HTTP `POST /api/experimental/generate`**; all carry an explicit model — never feeds the whole session to a model.

## Topic root card status

The root card reflects session state live, so you can see at a glance which sessions need you:

| State | header color | Footer |
|---|---|---|
| 🟡 pending approval | `orange` | `🟡 待审核：<tool>` |
| 🧠 running | `blue` | `🧠 运行中 · 12:03` |
| ⏳ waiting for reply | `grey` | `⏳ 待回复（排队 2）` |
| 🔴 failed | `red` | `🔴 失败` |
| ⏹ interrupted | `grey` | `⏹ 已中断` |
| ✅ done | `green` | `✅ 完成` |

**Priority: pending approval > running > waiting for reply > failed/interrupted > done.** The title carries no status by default (`topicStatusInTitle: false` to avoid churn in the topic sidebar); summaries/metadata survive refreshes. Master switch `topicStatus` (default `true`); minimum refresh interval `topicStatusThrottleMs` (default `1000ms`, clamped 500–10000).

## Forms & questions (`question` tool) — full rules

When the agent asks via `question` or other form tools, the plugin turns it into a Feishu card:

- **Three equivalent ways to answer**: click the option buttons, **fill the input box in the card and tap "✅ 提交"**, or **reply with text directly in the topic** (no need to tap "✍️ reply with text" first). Text is smart-matched — hitting an option label/value uses that value; `boolean` recognizes 是/否, yes/no, 1/0; `number`/`integer` converts to numbers; multi-select splits on 、/,; anything else is treated as **manual input**.
- Multi-field forms can mix: click a few buttons + add one text message; auto-submits once complete.
- **Pure option questions** (options present, no free input): reply with the index/letter (`1`, `B`) or the option text directly; if you send **other content**, the plugin treats it as "you want to say something else" — **skips the form automatically** and passes the message to the AI as a normal one.
- **The card is withdrawn after answering/cancelling** (no leftover pending cards); beyond Feishu's recall window it degrades to a "submitted / cancelled" result card.
- **Without this forwarding layer, an agent question would hang the Feishu session forever** — a common cause of "stuck" sessions.

## Multiple instances and gateway election

The plugin is global and loads in every opened location; starting a WSClient everywhere would create multiple long connections. So the gateway uses "**location match + process guard**" election:

- `gatewayLocation`: start the gateway only at this location (or its **subdirectories** as fallback); `~` expands, relative paths / trailing slashes are normalized. **Empty = any location works**.
- `gatewayMatchGraceMs` (default `3000`): **exact-match-first** grace window — subdirectory candidates wait this long; if a `here === gatewayLocation` instance appears it takes over (0 = no wait, subdirectory immediately falls back).
- Inside one process, `acquireProcessGuard` guarantees **only one instance** holds the gateway; other instances skip during setup.

**Debugging**: if `gatewayLocation` is configured but none of the loaded locations match, the plugin logs a `warn` after ~2 seconds — "已加载的 location 均未命中" (including the seen locations). You can temporarily set `logLevel: "debug"` to see "跳过非网关 location". If it still doesn't respond after checking, first **leave `gatewayLocation` empty** to rule it out.

## Full configuration

`<configDir>/plugins/feishu.json` (or `plugins[].options` in opencode config); `{env:NAME}` / `${NAME}` expansion supported. Credential **priority**: `options` > `feishu.json` > environment variables.

| Field | Type | Default | Description |
|---|---|---|---|
| `appId` | string | — | Feishu App ID (**required**; plugin disabled when missing) |
| `appSecret` | string | — | Feishu App Secret (**required**; never written to logs) |
| `domain` | `feishu`\|`lark` | `feishu` | Feishu / Lark global |
| `allowUsers` | string[] | `[]` | open_id allowlist. Empty = owner only |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | Global permission gate tier |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | No-approval allowlist, supports `prefix*` |
| `denyTools` | string[] | `[]` | Forced deny (takes precedence over allowlist) |
| `allowedRoots` | string[] | `[user home]` | Allowed working-directory roots; out-of-root / system dirs denied; empty falls back to first root, auto-created if missing |
| `stream` | boolean | `true` | Stream reply updates |
| `streamThrottleMs` | number | `400` | Minimum card-update interval (floor 400ms) |
| `threadRouting` | boolean | `true` | Topic routing master switch; `false` routes main-chat text into the current session |
| `topicGuidance` | boolean | `true` | Injects a lightweight system note into Feishu sessions (off-topic → `/new`), non-blocking; never for local sessions |
| `recentDirsLimit` / `recentModelsLimit` | number | `5` | Form "recently used" count (1–20) |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | Log level |
| `logFile` | string \| boolean | — | `true` = write `<stateDir>/opencode/feishu-plugin.log` (default `~/.local/state/opencode/`); **never put it inside the opencode config directory** — writing any file there counts as a config change and reloads the plugin (every log write reloads; self-amplifying during activity); recommended in server mode |
| `gatewayLocation` | string | — | Only start the gateway at this location (or **subdirectories** as fallback); `~` expands, relative / trailing slash normalized. Empty = any location works |
| `gatewayMatchGraceMs` | number | `3000` | **Exact-match-first** grace window: subdirectory candidates wait this long for a `here === gatewayLocation` instance (0 = no wait, immediate fallback) |
| `approvalTtlMs` | number | `600000` | Approval token / card validity |
| `staleExecutionMs` | number | `300000` | Watchdog threshold (clamped 0–60 min; **0 = disabled**; see "Watchdog staleness rules") |
| `quickNew` | boolean | `true` | Main-chat "AI session management" (AI handles plain text and creation/management commands, judges intent + finds the dir; asks back in conversation when unsure); `false` disables |
| `busyDelivery` | `steer`\|`queue` | `steer` | Delivery for new messages while busy: `steer` = cut in (default); `queue` = native queueing, see "Queued-card lifecycle" |
| `messageBatchMs` | number | `1500` | Message buffer window (0–10000, 0=off): messages arriving within this window in the same session are merged into **one prompt / one receipt card** — the receipt card is sent right away on the first message, the prompt is submitted once the last message has been quiet for the window |
| `maxResourcesShown` | number | `8` | Max resource rows shown on approval cards |
| `sessionAllowButton` | boolean | `true` | Show the "allow this tool in this session" button |
| `resumeSummary` | boolean | `true` | Show session summary on resume card |
| `resumeSummaryTimeoutMs` | number | `15000` | Fast-summary timeout (3–60s), degraded with a hint on timeout |
| `resumeCompactTimeoutMs` | number | `120000` | Polling timeout after explicit compact (30–300s) |
| `topicStatus` | boolean | `true` | Topic root card status master switch |
| `topicStatusInTitle` | boolean | `false` | Prefix status emoji in the root card title |
| `topicStatusThrottleMs` | number | `1000` | Root card status minimum refresh interval (500–10000) |
| `cardMaxTables` | number | `4` | Max markdown tables per card (1–5); beyond that, degraded per-card to fenced code blocks to avoid Feishu 400 `code=230099` |
| `runnerCardMaxTools` | number | `12` | Max tool blocks kept on the run card (1–50); older ones collapse into "…omitted N tool calls" |
| `runnerCardTextMax` | number | `2048` | Per-text-block character cap on the run card (512–8192) |
| `finalAnswerMinChars` | number | `600` | Final answers at least this long are sent **as their own card/file** (`0` disables splitting) |
| `finalAnswerFileMinBytes` | number | `20480` | Final answers at least this many bytes are delivered as a `.md` file (8192–102400) |
| `acceptAttachments` | boolean | `true` | Accept images/files: download into `attachmentsDir` and attach to the session; failures degrade to placeholder text |
| `attachmentMaxBytes` | number | `20971520` | Max size per attachment (1–100MB); larger ones are rejected with a notice |
| `attachmentTimeoutMs` | number | `30000` | Attachment download timeout (5–120s) |
| `attachmentsDir` | string | `<session workdir>/.opencode/temp/opencode-feishu-plugin` | Attachment directory; an explicit value is used verbatim (no extra subdir). When unset and the session directory is unknown, falls back to `<tmp>/opencode-feishu-plugin` |
| `keepalive` | boolean | `true` | **Location keep-alive**: periodically `GET /api/plugin` to renew the location; after eviction a **fast revive** rebuilds it within seconds (v0.2.20), with the **process-level watchdog** as a 20-min backstop |
| `keepaliveIntervalMs` | number | `1200000` | Keep-alive interval (default 20 min, clamped 5–45); must stay well below opencode's hardcoded 60-min TTL |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/ (self-contained bundle)
npm test            # vitest (pure logic unit tests; no real Feishu connection)
npm run dev         # tsup --watch
```

**Architecture**: `src/index.ts` only wires things together (config, gateway, watchdog, hooks, cleanup); `src/runtime/` holds testable event dispatch (`event-router.ts`), card-action routing (`card-action-router.ts`) and topic root card status wiring (`topic-status.ts`); session-command orchestration lives in `src/session/` (`session-commands.ts` is a thin facade over `session-list.ts` / `setup-wizard.ts` / `session-ops.ts` / `model-perm.ts` / `context.ts`); the Feishu interaction layer is `src/feishu/` (pure functions for testability); security lives in `src/security/`.

**Design notes**: cards are always **JSON 2.0** (buttons in `body.elements`, callbacks via `behaviors`); updates are throttled to ≥400ms; ≥3 consecutive tool calls auto-collapse; run-card state is maintained with **pure reducers**.