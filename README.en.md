# opencode-feishu-plugin

**English** | [简体中文](./README.md)

Bring [OpenCode](https://opencode.ai) into Feishu/Lark: **one Feishu topic = one OpenCode session**. Manage multiple sessions from chat, drive the agent from inside topics, and **approve permission requests with a button on a Feishu card**.

> Built **only on the OpenCode V2 plugin API** (`Plugin.define({ id, setup(ctx) })`) — no V1 packages.
> **Pure long connection** (WebSocket) for events and card callbacks: **no listening port, no public URL required**.

---

## Highlights

| | |
|---|---|
| 🔐 **Minimal permissions** | Only 2 scopes (read p2p messages + send as bot). **No group scopes at all** — the bot physically cannot receive group messages |
| 💬 **Topics as sessions** | Each Feishu topic maps to one OpenCode session. The main chat is a management console; work happens inside topics |
| 🚀 **One-tap entry** | `/new` opens the setup form directly; on submit the bot creates a topic under your message automatically |
| 📝 **One-shot form** | `/new` and `/form` are **fully equivalent**: fill directory + model + permissions once and submit. The directory can be typed or picked from a dropdown of the allowed root's first-level subdirectories. **Zero new permissions** |
| 🗂 **Directory tolerance** | Empty directory = the allowed root; a non-existent one is created automatically (still constrained by the `allowedRoots` allowlist) |
| ✅ **In-card approvals** | Permission requests become Feishu cards (allow once / always / reject) with signed, replay-proof buttons |
| 🪜 **Permission presets** | Read-only / Editable / Ask-on-risky / Trust — pick once per session instead of approving every call |
| 📊 **Live visibility** | Instant ack card, live tool calls (auto-collapsed when ≥3), streaming text, current model in the footer |
| 🧵 **Native queueing** | Busy session → messages queue via OpenCode's native `delivery:"queue"` |
| ⏹ **One-tap force stop** | **Every AI reply card carries a "force stop" button** — one tap interrupts (whitelist + HMAC signed). The watchdog auto-interrupts stuck sessions instead of queueing forever |
| 🚫 **No ports** | Everything over a long connection; nothing to expose |

---

## 1. Feishu app setup (~3 minutes)

1. Go to the [Feishu Open Platform](https://open.feishu.cn/app) → **Create a custom app**.
2. **Add capability → Bot**.
3. **Permissions** — enable only these two:
   - `im:message.p2p_msg:readonly` — read direct messages sent to the bot
   - `im:message:send_as_bot` — send messages *as the app* (also used to update cards)
4. **Events & Callbacks → Event subscription**: choose **"Receive events via long connection"** (do **not** pick Webhook), add event `im.message.receive_v1`.
5. **Events & Callbacks → Callback subscription**: also choose **long connection**, add callback `card.action.trigger` (**zero permission required**).
6. **Version management & release**: set **availability = only yourself**, create a version and publish it.
7. Note the **App ID** (`cli_…`) and **App Secret**.

> **Why no group scopes?** This plugin is a *personal console*. With no group scopes the bot **physically cannot**
> receive group messages, so the single-user boundary is enforced by the platform, not just by code.

---

## 2. Installation

### 2.1 Install the plugin (V2: loaded from npm, recommended)

OpenCode V2 declares packages to load in the `plugins` array of its config; on startup it installs them with Bun
(cached under `~/.cache/opencode/node_modules/`). Two equivalent ways:

```bash
# Option A — CLI (recommended)
opencode plugin add opencode-feishu-plugin
```

```jsonc
// Option B — write ~/.config/opencode/opencode.jsonc yourself
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-feishu-plugin"]
}
```

The plugin entrypoint is the **self-contained** `dist/index.js` (Feishu SDK included), referenced by
`package.json#exports`. You do **not** run `npm install` by hand and need no extra `node_modules`.

**Local development (without npm):** clone, `npm install && npm run build`, then point `plugins` at the local directory:

```jsonc
{ "plugins": ["./path/to/opencode-feishu-plugin"] }
```

### 2.2 Alternative: global plugin directory (offline / fixed path)

You can also drop the build output into `<configDir>/plugins/<any-name>/` (`configDir` = `OPENCODE_CONFIG_DIR` or
`~/.config/opencode`). OpenCode auto-discovers `index.js` there (this package ships such a root entry that re-exports `dist/`):

```bash
cd /path/to/opencode-feishu-plugin && npm install && npm run build
mkdir -p ~/.config/opencode/plugins/feishu
cp -r dist index.js package.json ~/.config/opencode/plugins/feishu/
```

> Whichever loading path you use, **restart the service after upgrading** so the module is re-imported:
> ```bash
> opencode service restart
> ```

### 2.3 Configure

`<configDir>/plugins/feishu.json` (`configDir` = `OPENCODE_CONFIG_DIR` or `~/.config/opencode`):

```bash
install -m 600 /dev/null ~/.config/opencode/plugins/feishu.json
cat > ~/.config/opencode/plugins/feishu.json <<'JSON'
{
  "appId": "{env:FEISHU_APP_ID}",
  "appSecret": "{env:FEISHU_APP_SECRET}"
}
JSON
chmod 600 ~/.config/opencode/plugins/feishu.json
```

Put the credentials into the **OpenCode service process** environment (not your interactive shell):

```bash
opencode service set env FEISHU_APP_ID cli_xxxxxxxx
opencode service set env FEISHU_APP_SECRET xxxxxxxx
```

Plaintext values inside `feishu.json` work too (keep it `chmod 600`). **Precedence**: `options` > `feishu.json` > environment.

### 2.4 Activate & verify

```bash
opencode reload
```

Send the bot a direct message. **The first sender is bound as the owner**; everyone else is silently ignored.

---

## 3. Usage

### Main chat (console)

The main chat is management-only; plain text never enters a session.

| Command | Purpose |
|---|---|
| `/new [title]` | **Open the setup form directly**; submit to create the session and auto-open a topic (equivalent to `/form`; the title becomes the session title) |
| `/form [title]` | Same as `/new` — an equivalent entry point |
| `/sessions` (`/ls`) | **All** sessions card: each row shows title / short id / relative time / `💬 topic-bound` / `📍 directory`, with a "▶️ Enter topic" button; 8 per page (`sessionPageSize`, 5–20) |
| `/use <n\|id-prefix>` | Switch current session (legacy, kept for compatibility) |
| `/resume [n]` | **Resume a past session**: post a "🔄 resume card" in the main chat for the most-recently-updated (or the N-th) session; **reply to that card** to continue |
| `/current` | Show current session |
| `/stop` | Interrupt the running task in the current session (every run card also has a "⏹ force stop" button) |
| `/steer <text>` | Send a message that **cuts in immediately** (steers into the running step instead of queuing) |
| `/now` | Promote this session's already-queued, not-yet-delivered messages to run immediately |
| `/dir <path>` | **Pre-fill** the form's working directory (empty = allowed root; a missing path is auto-created) |
| `/model [query]` | **Pre-fill** the form's model (also switches the current session's model inside a topic) |
| `/perm [preset]` | **Pre-fill** the form's permission preset (also changes the current session inside a topic) |
| `/cancel` | Discard an un-submitted form |
| `/help` | Command list |

### Inside a topic (work)

One topic = one session. **Plain text inside a topic is a prompt to the agent**; replies stay in the same topic.

| Command | Purpose |
|---|---|
| `/model` | Switch the model for this session |
| `/perm` | Change the permission preset for this session |
| `/cd <path>` | Move this session's working directory (empty = allowed root; a missing path is auto-created) |
| `/steer <text>` | Steer a message into the running step immediately |
| `/now` | Promote this session's queued messages to run immediately |
| `/current` `/stop` `/help` | Same as main chat, scoped to this topic's session |

### What `/model` really does

A `/model` switch only affects **subsequent** model calls; it does **not** rewrite history:

- opencode's `switchModel` means "switch the model used by subsequent provider turns" and appends a `model-switched` marker to the session. Earlier assistant messages keep the model they **actually ran on** at the time.
- So seeing "`Session.Info.model` is already the new model, but an earlier batch of messages is still the old model" is **expected**, not a failed switch.
- To be safe, the plugin **reads back** `ctx.session.get` after switching: it shows "✅ model switched" only when the read-back matches; a mismatch is reported as "⚠️ model may not have taken effect"; a failed read-back degrades to the requested value with a note. **The run-card footer and `/current` also display the read-back truth**.
- A failed switch (no permission / session not found) reports the error instead of pretending success.

### Topic soft guidance (topics never hard-block off-topic messages)

When you create a session from Feishu via `/new <title>` or the form, the title becomes the topic's "theme". The plugin does **not** block off-topic messages; it only injects a short system note so the model can **briefly remind** the user to open a new session with `/new` when they clearly drift away — without refusing to answer or lecturing:

- Injected only for **Feishu-originated sessions**; local TUI sessions are **never** touched (no pollution of your own sessions).
- Skipped when the session title is unavailable; injection failures only `log.warn` and never affect execution.
- Disable it entirely with `topicGuidance: false`.

### Creating a session (`/new` and `/form` are fully equivalent)

```
/new fix the login bug        (or /form fix the login bug)
  ↓
📝 setup form card
   directory: type it, or pick from the dropdown (first-level subdirectories of the allowed root); empty = allowed root, auto-created if missing
   model:     dropdown (defaults to the current/most recent)
   permissions: pick one of four presets
  ↓ tap "Create"
The form message itself becomes the topic root: the bot replies to it with
`reply_in_thread` to post the "session ready" card inside the topic
  ↓
The form card is rewritten in place into a success card titled
`✅ Created · <session title>` (this title becomes the topic name)
  ↓
Jump into the topic and just send a message
```

- `/new` and `/form` share **one entry point** and post the setup form directly; the old directory → model → permissions → confirm step cards are **gone**.
- `/dir` `/model` `/perm` still work, but only as **form pre-fill** (no longer required steps): each replies with a new pre-filled form card.
- Submission consumes the wizard state first (prevents double-click duplicates); an invalid directory **never creates a session** and returns the form with an error while keeping your input.
- Send `/cancel` to discard an un-submitted form.

### Directory tolerance rules

| Input | Behaviour |
|---|---|
| Empty | Uses the **allowed root** `allowedRoots[0]` (the user's home by default); not an error |
| Non-existent absolute path | Auto-created with `mkdir -p`, but **must still be under `allowedRoots`** |
| Outside the roots / system dir / `/` | Rejected, nothing is created |
| Symlinks | Re-checked with `realpath` after creation; escaping `allowedRoots` or landing in a system dir → rejected |

`/cd` follows **exactly the same** rules.

**Directory precedence in the form** (dropdown and text input coexist): dropdown pick (other than "✍️ Manually enter a path") > text input > both empty falls back to `allowedRoots[0]`.
The dropdown defaults to "✍️ Manually enter a path" so typing stays authoritative and you never accidentally pick an unexpected directory; `/dir <path>` writes to the input and selects it in the dropdown if it is one of the listed options, otherwise it falls back to "Manually enter a path" (any path can still be typed).

### One-shot form (`/form`)

- Send `/form` (or `/new` — they are equivalent) to open the form card.
- Fill in one go: **directory** (type it, or pick from a dropdown of the allowed root's first-level subdirectories; may be empty), **model** (dropdown of recent + popular, defaulting to the current/most recent model) and **permission preset** (dropdown, four presets with descriptions). Tap **Create** to submit.
- Directory dropdown options: `✍️ Manually enter a path (use the input above)` + `🏠 <root> (use this root)` + the **first-level subdirectories** of that root (hidden dirs and `node_modules` filtered out, sorted by name, at most 15; subdirectories containing `.git` are prefixed with `📦 `).
- The dropdown uses **only `allowedRoots[0]`** (the first allowed root). A scan failure (missing / no permission) silently degrades to just "manual input + root" without affecting the form or the plugin; the scan runs while rendering the form (low-frequency, not cached). `/dir` can still type any (in-scope) path.
- On submit: `session.create` → `reply_in_thread` on the **form card message** posts the ready card (the form message becomes the topic root) → bind, and you can start working in the new topic.
- With `/new <title>`, the title is stored in the wizard state and becomes the session title on submit.
- **Zero new permissions**: form submission reuses the `card.action.trigger` callback (permission requirement: None) — **no new scope, no app re-release**.
- An invalid directory **never creates a session**: the bot returns the form with an error and keeps your filled-in directory/model/permissions so you can fix and resubmit.

### Resume a past session (`/sessions` + `/resume`)

Besides sessions created from Feishu, you can **load any past OpenCode session visible to this machine** and keep working on it.

**`/sessions` (`/ls`) — all sessions**

```
/sessions
  ↓
🧩 OpenCode sessions (all)
  1. Fix the login bug (`ses_ab12cd34…`) · 3 hours ago · 💬 topic-bound · 📍 my-app
  2. Refactor the API (`ses_ef56gh78…`) · 2 days ago · 📍 api-server
  …
  [▶️ Enter topic] [▶️ New topic] [⬅️ Prev] [➡️ Next] [➕ New session]
```

- Data source is `ctx.session.list()` (**all** OpenCode sessions, sorted by `time.updated` desc), not just the plugin's mapping table; if unavailable it falls back to the mapping list and logs a `warn`.
- Each row shows: title (truncated), short id, relative time, `💬 topic-bound` (this session already has a topic mapping), `📍 <directory tail>`.
- **Paging**: 8 per page by default (`sessionPageSize`, clamped 5–20); the bottom buttons flip pages (`{cmd:"list", page:N}`).
- **"➕ New session"** opens the setup form card (same as `/new` `/form`) instead of creating a session directly.

**"▶️ Enter topic" — post a resume card in the main chat**

- Tap the button (value `{cmd:"open", s, c}`): first the session is checked for existence (`ctx.session.get`); if missing → toast "session not found" and the list card is patched into a notice.
- If it exists → a plain resume card is posted in the **main chat**: **title `🔄 <session title>`**, body contains session id / directory / model / last activity / summary, and **that card message** is recorded as the session's root (`root → session`). **No topic is opened and no `thread_id` is bound at this stage.**
- **How to continue**: simply **reply to the resume card** (Feishu forms a topic under it) to continue that past session. The user's first reply event **may carry only a `root_id` and no `thread_id`**; the plugin falls back to the `root → session` mapping to route to the session, and once a `thread_id` is available it writes the `thread → session` mapping. Later messages in that topic follow normal topic routing. (OpenCode session context is persistent, so this is effectively a resume.)
- **Summary block (task B)**: first **reuse** an existing compaction summary (`ctx.session.context`, **zero model calls**); if none, the card first shows "⏳ summarizing…", then `ctx.session.generate` runs asynchronously and the result is **patched back into the same resume card**; failure/timeout (`resumeSummaryTimeoutMs`, default 20s) degrades to "(summary generation failed; just send a message to continue)". Disable with `resumeSummary: false`.
- Only the clicked session is affected: the card binds just that session's root; other sessions' mappings are untouched.
- For an already topic-bound session the button becomes "▶️ New topic" — **one session can be routed from several topics** (each topic has its own conversation context; replies land in the triggering topic).

**`/resume [n]` — skip the list**

- `/resume` runs the same "post a resume card" flow for the **most recently updated** session; `/resume 3` picks the 3rd row. An out-of-range index reports the valid range. It is the same resume card — **reply to it** to continue.
- It uses the same ordering as `/sessions` (`time.updated` desc).

**Limitations**

- Only sessions **visible on this machine** can be resumed; deleted / foreign / invisible-to-`session.list` sessions cannot be entered.
- `/sessions` and `/resume` are main-chat commands and are **disabled inside topics** (they tell you to go back); once inside a topic just send plain text.
- With `threadRouting=false` (fallback mode), entering topics and `/resume` are unsupported.

### Permission presets

| Preset | Meaning | Session ruleset |
|---|---|---|
| 🔒 Read-only | Look, don't touch | deny `edit` / `shell` |
| ✏️ Editable | Edits free, **commands need approval** | allow `edit`, `shell` → ask |
| ⚠️ Ask-on-risky | Edits, commands and outside-directory access all ask | risky actions ask each time |
| 🔓 Trust | Never ask | allow all |

The preset is written to a **session-scoped** ruleset and can be changed any time with `/perm`, without affecting other sessions.

### Approval card: per-session "allow this tool in this session"

The approval card has **4 buttons** by default: `✅ Allow once` / `🔓 Always allow` / `✅ Allow this tool in this session` / `❌ Reject`.

"Always allow" only persists the **command prefix** OpenCode provides (e.g. `ls *`), so a different command asks again; "Trust" is too broad (it also opens up edit / outside-directory). "**Allow this tool in this session**" is the middle ground:

- It only affects the **current session**: the tool action is recorded in the session's `allowActions` and **appended** to the session ruleset (`{action, resource:"*", effect:"allow"}`); once matched, the `permission.evaluate` gate **no longer downgrades it to ask**, so later calls of the same tool in this session stop bothering you.
- **Other sessions and the global config are untouched** — switch to another session and it still asks.
- `shell` and `bash` are allowed together (the real tool id is `bash`, the design name is `shell`; both are covered).
- Tapping also replies "once" to the **currently pending request** (otherwise this run would still hang), then the card collapses to "✅ Allowed bash in this session" with no buttons.
- Changing the preset with `/perm` is an explicit permission change: it **clears the session's "allow in this session" grants** so old grants cannot override the new preset.
- Same security boundary as force-stop: the button value is `{cmd:"allow_session", a:"<action>", t:"<token>"}`; the token reuses the HMAC mechanism and binds `sessionID + action + TTL + nonce` (plus requestID to locate the card). Click validation order is **allow-list → signature → sessionID match → replay guard**; forged / cross-session / replayed taps are rejected, and repeat taps only show a toast.
- Set `sessionAllowButton: false` to hide this button (the card goes back to three buttons).

### Queue and cut-in (`/steer` `/now`)

While a session is busy, new messages use OpenCode's native queue (`delivery:"queue"`, the card footer shows "queued") and run only after the current task finishes. Two ways to cut in:

- `/steer <text>` — send this message with `delivery:"steer"` to insert it immediately (interrupts the current step, like steering in the TUI).
- `/now` — promote this session's already-queued, not-yet-delivered messages to `steer` (via OpenCode's `session.inbox.update`; content is neither lost nor re-sent).

### Force-stop button and the watchdog

**Every AI reply card has a "⏹ force stop" button at the bottom** (ack card, streaming run card, terminal card and stuck-notice card):

- running / queued: a **red danger** "⏹ Force stop" button; tapping it interrupts the session's current execution and cancels not-yet-delivered queued messages;
- done / failed / interrupted: still rendered, but as a `default` "⏹ Stop" button; tapping only shows the toast "this task has ended" (so it never looks like you can still stop it).

The button is a **signed action** `{ cmd:"stop", sid:<sessionID>, t:<token> }`. The token reuses the approval-card HMAC mechanism and binds `sessionID + purpose + expiry + nonce`; the card **re-signs on every patch**, so long tasks never become un-stoppable due to an expired token.
Validation order: **allowlist (allowUsers/owner) → signature → sessionID binding → replay guard**; forged, cross-session and replayed clicks are rejected.

**Watchdog (5-minute threshold, configurable)**: when an execution has produced no event for longer than the threshold it is treated as stuck; the plugin **actually interrupts the server-side session** (`session.interrupt`) + **cancels queued inbox messages** + finalizes the run card + sends a notice card with a force-stop button. If a session stays queued past the same threshold without an `execution.started`, the same recovery runs and a notice is sent — no more "session stuck once, every later message queues forever".

The threshold is `staleExecutionMs` (default 5 minutes, clamped to 1–60 minutes).

### Forms and questions (`question` tool)

When the agent calls the `question` tool (or any form interaction), OpenCode creates a pending form that blocks execution. The plugin relays it as a Feishu card:

- tap an option for single-choice fields; multi-field forms submit automatically once every field is filled;
- for free-text fields, tap "✍️ reply directly" and send the answer as a message in the **same topic**;
- the card resolves after submit/cancel.

Without this relay, any clarifying question would stall the Feishu session forever and every later message would queue behind it — a common cause of "stuck sessions".

---

## 4. Configuration

`<configDir>/plugins/feishu.json` (or `plugins[].options` in OpenCode). `{env:NAME}` / `${NAME}` expansion supported.

| Field | Type | Default | Description |
|---|---|---|---|
| `appId` | string | — | Feishu App ID (**required**; missing ⇒ plugin disabled, never throws) |
| `appSecret` | string | — | Feishu App Secret (**required**; never logged) |
| `domain` | `feishu`\|`lark` | `feishu` | Feishu or Lark international |
| `allowUsers` | string[] | `[]` | open_id allowlist. **Empty = app owner only** (first sender is bound and persisted) |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | Global approval gate |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | Auto-allow list; supports `prefix*` |
| `denyTools` | string[] | `[]` | Hard deny (takes precedence) |
| `allowedRoots` | string[] | `[homedir]` | Roots allowed as session working directories (the default directory is `allowedRoots[0]`); `/`, the filesystem root and system dirs are always rejected; an empty directory falls back to the first root and a non-existent one is auto-created. **The directory dropdown only scans the first root's first-level subdirectories** |
| `stream` | boolean | `true` | Stream replies into the card |
| `streamThrottleMs` | number | `400` | Min card update interval (floor 400ms; Feishu limit is 5 QPS) |
| `threadRouting` | boolean | `true` | Topic routing master switch; `false` restores the legacy behaviour |
| `topicGuidance` | boolean | `true` | Topic soft guidance: inject a short "use `/new` for a new topic" system note into Feishu sessions (never blocks messages); local TUI sessions are never touched |
| `recentDirsLimit` | number | `5` | Number of recent directories (1–20) |
| `recentModelsLimit` | number | `5` | Number of recent models (1–20) |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | Log level (secrets are never logged, only their presence) |
| `logFile` | string \| boolean | — | `true` writes `<configDir>/plugins/feishu.log`. **Plugin stderr is discarded in service mode — enable this when debugging** |
| `gatewayLocation` | string | — | Only start the gateway in this location. OpenCode loads global plugins per location (separate VM contexts, so an in-process singleton cannot dedupe). **Set this to your usual working directory**, otherwise you get multiple long connections |
| `approvalTtlMs` | number | `600000` | Approval token / card TTL |
| `staleExecutionMs` | number | `300000` | Watchdog threshold: an execution with no event for this long is treated as stuck and auto-interrupted; a queue stuck this long without `execution.started` also triggers a notice. Clamped to 1–60 minutes |
| `maxResourcesShown` | number | `8` | Max resource lines shown on an approval card |
| `sessionAllowButton` | boolean | `true` | Show the "✅ Allow this tool in this session" button on approval cards; disable to go back to three buttons |
| `resumeSummary` | boolean | `true` | Show a summary on the resume card (reuse an existing compaction summary first, generate only if missing; disabling also skips generation) |
| `resumeSummaryTimeoutMs` | number | `20000` | Resume-card summary generation timeout (clamped 3000–60000); a timeout is treated as failure and degrades gracefully |

---

## 5. Security model

```
permission.evaluate (plugin hook)              permission.asked (event stream)
──────────────────────────                     ──────────────────────
allow-listed tool   → allow                    event carries {id, sessionID, action, resources, save}
deny list           → deny                                │
session allowActions → allow (already granted)            │
otherwise (per session preset) → ask ─────────────────────┘
                                                          ▼
                                      Feishu approval card (button value = signed token)
                                                          │ user taps
                                                          ▼
                                card.action.trigger over the long connection (<3s response)
                                                          │
                     verify: operator allow-listed → signature → bound fields → replay guard
                                                          ▼
                                     ctx.permission.reply({sessionID, requestID, reply})
```

- **Signed tokens**: HMAC-SHA256 binding `requestID + sessionID + operator openId + expiry + nonce`; forgery, forwarding and replay are rejected.
- **Force-stop uses the same signature scheme**: its token binds `sessionID + purpose + expiry + nonce`, the click passes the open_id allowlist before verification, and it is purpose-isolated from approval tokens (neither works for the other).
- **Per-session allow uses the same signature scheme**: the approval card's "allow this tool in this session" token binds `sessionID + action + expiry + nonce` (plus requestID to locate the card) and is purpose-isolated. When matched it records `allowActions`, appends a session ruleset, and the `evaluate` gate **no longer downgrades that action to ask** (the `denyTools` red line still wins) — and **only for that session**.
- **Only Feishu-originated sessions**: sessions without a chat↔session mapping (e.g. your local TUI) are **never downgraded to `ask`**, otherwise they would hang forever with no approval channel.
- **Three layers of single-user isolation**: platform availability (only you) + no group scopes + code-level open_id allowlist with silent ignore.
- **`always` semantics**: persisted only when the request carries `save[]`; otherwise it behaves like "once" (the card says so).

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Bot does not respond | ① App **published** and availability includes you? ② Event/callback subscription set to **long connection** (not Webhook)? ③ `im:message.p2p_msg:readonly` granted? |
| `feishu.json` changes ignored | Confirm the path is `<configDir>/plugins/feishu.json`, then `opencode reload` |
| Plugin never loads (no logs, no error) | npm path: make sure the package name is in the config `plugins` array (`opencode plugin list` shows it). Directory path: make sure `plugins/<name>/index.js` exists (OpenCode ignores `package.json#main`) |
| Plugin code changes ignored | `opencode reload` only re-runs `setup`; it does **not** re-import the module from the same path. Upgrade with `opencode plugin update opencode-feishu-plugin`, or restart the service |
| Multiple long connections / duplicate replies | Set `gatewayLocation` to your usual working directory |
| No approval cards | The session did not originate from Feishu (no mapping); by design the plugin does not take it over |
| "Invalid credentials" on button tap | Token expired (default 10 min) or the tapper is not allow-listed |
| Card content truncated | Feishu card limit is ~30KB; the plugin truncates and marks it. Very long sessions drop the oldest blocks from the card (full content stays in the session) |
| Form submit does nothing / errors | Client too old (`select_static` needs ≥ V3.7.0), or the card is stale (form consumed/cancelled) — send `/form` or `/new` again for a fresh form |
| Form submitted but no session | A directory outside the allowlist or in a system dir returns an error card and **does not create a session**; fix it and resubmit. Empty / non-existent in-scope dirs are auto-created and never fail |
| No topic after creating a session | If auto-opening the topic fails, the form card is rewritten to "✅ Created · …" with manual-topic guidance; you can also create a topic manually from the `/sessions` card |
| No plugin logs | Plugin stderr is discarded in service mode; set `logFile: true` and read `<configDir>/plugins/feishu.log` |
| Main chat replies with a hint card | Expected: the main chat is management-only. Use `/new` and work inside a topic; set `threadRouting: false` to revert |
| Session looks stuck and messages only queue | The watchdog auto-interrupts it after `staleExecutionMs` (default 5 min) and cancels the queue, then sends a notice card; you can also tap the card's "⏹ force stop" or send `/stop` |
| Switched `/model` but older messages still show the old model | Expected: a switch only affects **subsequent** replies; history keeps each message's model. The receipt / run-card footer / `/current` all show the read-back truth |

---

## 7. Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/ (self-contained bundle)
npm test            # vitest (pure logic, no live Feishu)
npm run dev         # tsup --watch
```

**Architecture**: `src/index.ts` is assembly only (config, gateway, watchdog, hook registration and cleanup); `src/runtime/` holds the unit-testable event dispatch (`event-router.ts`) and card-callback routing (`card-action-router.ts`); the session command orchestration is split under `src/session/` (`session-commands.ts` is a thin facade; implementations live in `session-list.ts` / `setup-wizard.ts` / `session-ops.ts` / `model-perm.ts` / `context.ts`); the Feishu interaction layer lives in `src/feishu/` (event parsing, card builders, topic routing, wizard state machine, streaming-card reducer — mostly **pure functions** for testability); `src/security/` holds token signing and the allowlist.

**Implementation notes**
- Cards are **JSON 2.0** (buttons directly in `body.elements`, callbacks via `behaviors`; the 1.0 `tag:"action"` container returns HTTP 400 on 2.0). Form cards add: `form` must sit at the root of `body.elements`, interactive `name`s must be globally unique, and at least one button must carry `form_action_type:"submit"`.
- Card updates are throttled to ≥400ms; ≥3 consecutive tool calls collapse into one summary panel (names only) to stay under the 30KB limit.
- Run-card state is maintained by a **pure reducer** (text blocks / tool blocks / footer / terminal state), keyed per `assistantMessageID`.

---

## 8. Relationship to other projects

This plugin targets **OpenCode V2 only** (`@opencode/plugin`, `Plugin.define`). The separately maintained `opencode-feishu` package is a **V1** plugin (`@opencode-ai/plugin`) — the two are incompatible and share no code. Pick according to your OpenCode version.

## Known limitations

- Text-only inbound (including rich text); images/files/audio get a textual placeholder and are not downloaded.
- Only approvals for **Feishu-originated** sessions are handled. Local TUI sessions are untouched by design.
- Message dedup is `get-then-set` (not atomic): under extreme concurrency a duplicate is theoretically possible.
- Deleted topics leave stale mappings (lazily ignored).
- There is a single main path for creating sessions: the **`/new` / `/form` setup form card**; `/dir` `/model` `/perm` only pre-fill the form. The old directory/model/permissions/confirm step cards are retired from `/new` (their builders and compatibility callbacks remain, marked deprecated).
- The form is JSON 2.0 (`form` at the root of `body.elements`, globally unique interactive `name`s, a submit button with `form_action_type:"submit"`); some older clients require `select_static` ≥ V3.7.0.

- **A topic's first message may omit `thread_id`**: Feishu sometimes delivers the event without `thread_id` (it is assigned afterwards). When you **reply to a card that has a root mapping** (e.g. a resume card), the plugin falls back to the `root_id` to route to the corresponding session and writes the topic mapping once a `thread_id` is available. However, for a **brand-new topic** whose event omits `thread_id`, a main-chat-only command such as `/new` sent at that moment runs as a main-chat command (e.g. the form card lands in the main chat). Just continue inside the topic with a normal message.


> Publishing tip: `npm publish` triggers `prepublishOnly` (typecheck + build + test). If `node_modules` is missing it **runs `npm ci` first**, so a fresh clone can be published directly without a manual install.


> Publishing note: provenance can only be generated in CI (GitHub Actions), so `package.json` deliberately does **not** set `publishConfig.provenance`; our workflows pass `npm publish --provenance` explicitly. Publishing locally is just `npm publish --access public`.

## License

MIT
