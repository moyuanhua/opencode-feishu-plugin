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
| `/sessions` (`/ls`) | Session list card (switch / create) |
| `/use <n\|id-prefix>` | Switch current session |
| `/current` | Show current session |
| `/stop` | Interrupt the running task in the current session |
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

### Permission presets

| Preset | Meaning | Session ruleset |
|---|---|---|
| 🔒 Read-only | Look, don't touch | deny `edit` / `shell` |
| ✏️ Editable | Edits free, **commands need approval** | allow `edit`, `shell` → ask |
| ⚠️ Ask-on-risky | Edits, commands and outside-directory access all ask | risky actions ask each time |
| 🔓 Trust | Never ask | allow all |

The preset is written to a **session-scoped** ruleset and can be changed any time with `/perm`, without affecting other sessions.

### Queue and cut-in (`/steer` `/now`)

While a session is busy, new messages use OpenCode's native queue (`delivery:"queue"`, the card footer shows "queued") and run only after the current task finishes. Two ways to cut in:

- `/steer <text>` — send this message with `delivery:"steer"` to insert it immediately (interrupts the current step, like steering in the TUI).
- `/now` — promote this session's already-queued, not-yet-delivered messages to `steer` (via OpenCode's `session.inbox.update`; content is neither lost nor re-sent).

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
| `recentDirsLimit` | number | `5` | Number of recent directories (1–20) |
| `recentModelsLimit` | number | `5` | Number of recent models (1–20) |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | Log level (secrets are never logged, only their presence) |
| `logFile` | string \| boolean | — | `true` writes `<configDir>/plugins/feishu.log`. **Plugin stderr is discarded in service mode — enable this when debugging** |
| `gatewayLocation` | string | — | Only start the gateway in this location. OpenCode loads global plugins per location (separate VM contexts, so an in-process singleton cannot dedupe). **Set this to your usual working directory**, otherwise you get multiple long connections |
| `approvalTtlMs` | number | `600000` | Approval token / card TTL |
| `maxResourcesShown` | number | `8` | Max resource lines shown on an approval card |

---

## 5. Security model

```
permission.evaluate (plugin hook)              permission.asked (event stream)
──────────────────────────                     ──────────────────────
allow-listed tool   → allow                    event carries {id, sessionID, action, resources, save}
deny list           → deny                                │
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

---

## 7. Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/ (self-contained bundle)
npm test            # vitest (pure logic, no live Feishu)
npm run dev         # tsup --watch
```

**Architecture**: `src/index.ts` wires everything; the Feishu interaction layer lives in `src/feishu/` (event parsing, card builders, topic routing, wizard state machine, streaming-card reducer — mostly **pure functions** for testability); `src/security/` holds token signing and the allowlist.

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

- **A topic's first message may omit `thread_id`**: Feishu sometimes delivers the event without `thread_id` (it is assigned afterwards). If you send a main-chat-only command such as `/new` at that moment, it runs as a main-chat command (e.g. the form card lands in the main chat). Just continue inside the topic with a normal message.

## License

MIT
