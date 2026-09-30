# opencode-feishu-plugin

**English** | [简体中文](./README.md)

Connect [OpenCode](https://opencode.ai) to Feishu/Lark: **one Feishu topic = one OpenCode session**, and permission approvals happen right on Feishu cards.

- OpenCode **V2 only** (`@opencode/plugin`, `Plugin.define`); no V1 packages.
- **Pure long connection** (WebSocket) for events and card callbacks: no port listening, no public endpoint.

## Preview

![Full session inside a Feishu topic: tool calls, permission approval card, force stop](image/image.png)

## Highlights

| | Description |
|---|---|
| 🔐 **Minimal permission** | Only 2 scopes; no group permission is requested, so the bot physically cannot receive group messages |
| 💬 **Topic = session** | Each Feishu topic maps to one OpenCode session; the main chat is console-only |
| 🚀 **One-shot session** | `/new` opens a single form (directory + model + permission preset); submit to create a session and auto-open a topic |
| ✅ **Card approvals** | Permission requests become cards: allow once / always / this session only / deny — signed tokens prevent forgery and replay |
| 📊 **Real-time visible** | "Thinking" receipt → live tool-call cards → streaming text updates; footer shows the current model |
| ⏹ **Controllable** | Every reply card has a "force stop" button; a watchdog auto-interrupts stuck sessions; native queue with `/steer` `/now` to cut in |
| 📎 **Images / files** | Images and files sent in Feishu are downloaded and attached to the session, so vision/file-capable models can see and read them |
| 🚫 **No ports** | Full long-connection; no inbound port needed on the server |

## 1. Feishu app setup (~3 minutes)

1. Open the [Feishu Open Platform](https://open.feishu.cn/app) → **Create an enterprise self-built app**.
2. **Add app capability → Bot**.
3. **Permission management** — enable these two minimal scopes:
   - `im:message.p2p_msg:readonly` — read messages users send to the bot in p2p chat
   - `im:message:send_as_bot` — send messages as the app (also used to update cards)

   To **receive images / files** (downloaded and attached to sessions), add one more:
   - `im:message:readonly` — fetch message resources (required to download images / files)
4. **Events & Callbacks → Event configuration**: subscription method **"Use long connection to receive events"** (do **not** pick Webhook), add event `im.message.receive_v1`.
5. **Events & Callbacks → Callback configuration**: same long-connection method, add callback `card.action.trigger` (zero permission requirement).
6. **Version management & release**: availability = **only yourself**, create a version and **publish**. ⚠️ Without publishing the app stays in "development" state and the long connection cannot connect — the bot will never respond.
7. Note down the **App ID** (`cli_…`) and **App Secret**.

> **Why no group permission?** This plugin is a "single-user remote control". Without group permission the bot **physically cannot receive group messages** — the single-user boundary is guaranteed by the platform scope layer, not only by code.

## 2. Installation

### 2.1 Install the plugin

```bash
# Option A — CLI (recommended)
opencode plugin add opencode-feishu-plugin
```

```jsonc
// Option B — write config manually (APPEND to the existing plugins array, don't overwrite the file)
{ "plugins": ["opencode-feishu-plugin"] }
```

The entrypoint is a **self-contained** `dist/index.js` (Feishu SDK bundled); no manual `npm install` needed at runtime.

### 2.2 Configuration

Create `~/.config/opencode/plugins/feishu.json` (`configDir` = `OPENCODE_CONFIG_DIR` or `~/.config/opencode`):

```bash
install -m 600 /dev/null ~/.config/opencode/plugins/feishu.json
cat > ~/.config/opencode/plugins/feishu.json <<'JSON'
{
  "appId": "cli_xxxxxxxx",
  "appSecret": "xxxxxxxx",
  "logFile": true
}
JSON
```

- Credential **priority**: `plugins[].options` > `feishu.json` > environment variables. You may also use `{env:NAME}` / `${NAME}` placeholders in values to pull from env.
- **We recommend `logFile: true`**: stderr is discarded in server mode; the log file is your only window into plugin behavior.

### 2.3 Activate & verify

```bash
opencode reload
tail -f ~/.config/opencode/plugins/feishu.log   # you should see "飞书长连接已启动（WSClient）"
```

Then send a message to the bot in Feishu. **The first person to message is auto-bound as owner** — a card reply means installation succeeded; everyone else is silently ignored.

> After upgrading the plugin or switching to a global plugin directory, run `opencode service restart` so it re-imports.

## 3. Quick start

### Main chat (console)

The main chat **only manages**; plain text never enters any session.

| Command | Effect |
|---|---|
| `/new [title]` | Send a session-create form; submit to create a session and auto-open a topic (same as `/form`) |
| `/sessions` (`/ls`) | **All** sessions list (including every local opencode session); paginate, enter, create |
| `/resume [index]` | Send a resume card for the most recent (or Nth) session; **reply to the card** to continue |
| `/current`, `/stop` | Show current session / interrupt current run |
| `/steer <text>`, `/now` | Cut in immediately / run all queued messages now |
| `/dir`, `/model`, `/perm` | **Pre-fill** the create-session form (directory / model / permission tier) |
| `/cancel`, `/help` | Discard pending form / list commands |

![Create-session form card: directory, model, permission](image/new.png)  ![Session list card: paginate, enter/reopen, create](image/sessions.png)

### Inside a topic (work)

A topic = a session; sending plain text is giving the AI a command.

| Command | Effect |
|---|---|
| `/model` | Switch this session's model (affects follow-up replies only) |
| `/perm` | Change this session's permission tier |
| `/cd <path>` | Migrate this session's working directory |
| `/steer <text>`, `/now` | Cut in / run queued messages now |
| `/current`, `/stop`, `/help` | Same as main chat, scoped to this topic's session |

### Permission tiers

| Tier | Meaning |
|---|---|
| 🔒 **Read-only** | Look only (denies `edit` / `shell`) |
| ✏️ **Editable** | File edits free, shell commands ask |
| ⚠️ **High-risk approval** | File edits, shell commands and out-of-root access all ask |
| 🔓 **Full trust** | Never ask |

Permission requests become approval cards: `✅ Allow once` / `🔓 Always allow` / `✅ Allow this tool in this session` / `❌ Deny`. Changing tier (`/perm`) clears this session's "allow in this session" grants.

### Forms & questions (`question` tool)

When the agent asks via `question` or other form tools, the form becomes a Feishu card. **Click buttons or just reply in the topic with text** — both work, and the card is withdrawn after answering. For pure option questions you can reply with the option number/letter directly; any other content is treated as a normal message to the AI.

## 4. Configuration (common)

`<configDir>/plugins/feishu.json` (or `plugins[].options` in opencode config); `{env:NAME}` / `${NAME}` expansion supported.

| Field | Type | Default | Description |
|---|---|---|---|
| `appId` | string | — | Feishu App ID (**required**; plugin disabled when missing) |
| `appSecret` | string | — | Feishu App Secret (**required**; never written to logs) |
| `domain` | `feishu`\|`lark` | `feishu` | Feishu / Lark global |
| `allowUsers` | string[] | `[]` | open_id allowlist; empty = owner only |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | Global permission gate tier |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | No-approval allowlist, supports `prefix*` |
| `denyTools` | string[] | `[]` | Forced deny (takes precedence over allowlist) |
| `allowedRoots` | string[] | `[user home]` | Allowed working-directory roots; out-of-root / system dirs denied |
| `stream` | boolean | `true` | Stream reply updates |
| `threadRouting` | boolean | `true` | Topic routing master switch |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | Log level |
| `logFile` | string \| boolean | — | `true` = write `<configDir>/plugins/feishu.log`; recommended in server mode |
| `approvalTtlMs` | number | `600000` | Approval token / card validity |
| `staleExecutionMs` | number | `300000` | Watchdog threshold (1–60 min) |
| `gatewayLocation` | string | — | Only start the gateway at this location (or its subdirectories); empty = any location |

Full config (including `cardMaxTables`, `topicStatus*`, `resumeSummary*`, `keepalive*`, `gatewayMatchGraceMs`) → [docs/advanced.en.md](./docs/advanced.en.md#full-configuration).

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| No response to messages | ① Is the app **published** and does availability include you? ② Is the subscription **long connection** (not Webhook)? ③ Is `im:message.p2p_msg:readonly` enabled? |
| `feishu.json` changes don't apply | Check the path, then `opencode reload` |
| Plugin not loaded at all | npm: confirm the package name is in the `plugins` array; directory: confirm `plugins/<name>/index.js` exists |
| No approval cards | That session wasn't started from Feishu (no mapping); by design the plugin doesn't take it over |
| Button click says invalid credential | Token expired (10 min default) or clicker not in allowlist |
| Session seems stuck, messages only queue | Watchdog auto-interrupts after 5 min; or tap "⏹ force stop" / send `/stop` |
| Bot goes silent after ~1h idle | opencode recycles idle locations; built-in keepalive restores automatically, see [docs/advanced.en.md](./docs/advanced.en.md#location-keep-alive) |
| Can't see plugin logs | stderr is discarded in server mode; set `logFile: true` |
| Multiple long connections / duplicate replies | Set `gatewayLocation` to a common working directory, see [docs/advanced.en.md](./docs/advanced.en.md#multiple-instances-and-gateway-election) |

## 6. Known limitations

- Image / file messages are **downloaded and attached to the session** (requires `im:message:readonly`); audio / video / stickers still get a text placeholder.
- Only takes over approvals for **Feishu-originated sessions**; local TUI sessions are unaffected.
- One main path to create a session: the `/new` / `/form` form card.
- Forms are JSON 2.0; old clients need ≥ V3.7.0 for `select_static`.
- A topic's first message may lack `thread_id`: the plugin falls back to `root_id` routing; if a command lands in the main chat from a new topic, just send it inside the topic.
- There is another `opencode-feishu` (V1 plugin); it is incompatible and shares no code with this one.

## 7. Roadmap

Iterating from real usage feedback; current plan:

- [x] **Accept images / files**: done — downloaded automatically into `<configDir>/plugins/feishu-files/` and attached to the session (requires `im:message:readonly`; default max 20MB per attachment).
- [ ] **New messages cut in by default when busy**: currently new messages queue natively while a session is busy (manual cut-in via `/steer`, `/now`). Planned: new messages default to **cutting in immediately**, interrupting the current step to run first.

## Advanced topics & development

Security model, location keep-alive, card guard, session resume, multi-instance gateway election, full config reference, and development architecture → [docs/advanced.en.md](./docs/advanced.en.md).

## License

MIT