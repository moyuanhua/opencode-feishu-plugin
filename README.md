# opencode-feishu-plugin

[English](./README.en.md) | **简体中文**

把 [OpenCode](https://opencode.ai) 接进飞书：**一个飞书话题 = 一个 OpenCode 会话**。你在飞书里用话题管理多个会话、指挥 AI 写代码，**权限审批直接在飞书卡片上点按钮**。

- **只用 OpenCode V2 插件 API**（`Plugin.define({ id, setup(ctx) })`），不依赖任何 V1 包。
- **纯长连接**（WebSocket）收发事件与卡片回调，不监听端口、不需要公网地址。

---

## 效果预览

在飞书话题里指挥 AI 干活，权限审批、状态跟踪都在卡片上完成：

![飞书话题内的完整会话：工具调用、权限审批卡与强制停止](image/image.png)

## 亮点

| | 说明 |
|---|---|
| 🔐 **最小权限** | 只要 2 个 scope（单聊读 + 发消息）。不申请任何群权限，机器人物理上收不到群消息 |
| 💬 **话题 = 会话** | 每个飞书话题对应一个 OpenCode 会话，主聊天流只做管理，话题里干活，互不串台 |
| 🚀 **一键进入** | `/new` 直接发建会话表单，提交后机器人自动在你消息下开话题 |
| 📝 **表单一次填完** | `/new` 与 `/form` 完全等价：目录 + 模型 + 权限一张表单一次提交即建会话，**零新增权限** |
| ✅ **卡片审批** | 权限请求变成飞书卡片（允许一次 / 始终允许 / 拒绝 / 本会话内允许），点击即批准，带签名防伪防重放 |
| 🪜 **权限预设** | 只读 / 可编辑 / 高风险审批 / 完全信任，四档一次选定，告别逐次审批 |
| 📊 **实时可见** | 先回执「思考中」，工具调用实时上卡（≥3 个自动折叠），文本流式更新，页脚显示当前模型 |
| 🧵 **原生排队** | 会话忙时自动排队（opencode 原生 `delivery:"queue"`），可用 `/steer` `/now` 插队 |
| ⏹ **一键强停** | 所有 AI 回复卡片都带「强制停止」按钮；卡死会话由看门狗自动中断 |
| 🚫 **无端口** | 全程长连接，服务器不用开放任何入站端口 |

---

## 一、飞书后台配置（约 3 分钟）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**。
2. **添加应用能力 → 机器人**。
3. **权限管理**，只开通这两个：
   - `im:message.p2p_msg:readonly` —— 读取用户发给机器人的单聊消息
   - `im:message:send_as_bot` —— 以应用身份发消息（也用于更新卡片）
4. **事件与回调 → 事件配置**：订阅方式选**「使用长连接接收事件」**（不要选 Webhook），添加事件 `im.message.receive_v1`。
5. **事件与回调 → 回调配置**：订阅方式同样选**长连接**，添加回调 `card.action.trigger`（**零权限要求**）。
6. **版本管理与发布**：可用范围 = **仅本人**，创建版本并发布。
7. 记下 **App ID**（`cli_…`）与 **App Secret**。

> **为什么不申请群权限？** 本插件是"一个人的遥控台"。不申请群权限，机器人**物理上收不到群消息**，
> 单人边界由平台 scope 层保证，而不是只靠代码判断。

---

## 二、安装

### 1. 安装插件（V2：npm 自动加载，推荐）

```bash
# 方式 A：CLI（推荐）
opencode plugin add opencode-feishu-plugin
```

```jsonc
// 方式 B：手写 ~/.config/opencode/opencode.jsonc
{ "plugins": ["opencode-feishu-plugin"] }
```

插件入口指向**自包含**的 `dist/index.js`（含飞书 SDK 等依赖），运行时无需手动 `npm install`。
本地开发则克隆后 `npm install && npm run build`，把本地目录写进 `plugins`：`{ "plugins": ["./path/to/opencode-feishu-plugin"] }`。

### 2. 写配置

`<configDir>/plugins/feishu.json`（`configDir` = `OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`）：

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

凭证放进 OpenCode **服务进程**的环境变量（不是交互 shell）：

```bash
opencode service set env FEISHU_APP_ID cli_xxxxxxxx
opencode service set env FEISHU_APP_SECRET xxxxxxxx
```

也可直接明文写进 `feishu.json`（权限记得 `600`）。**优先级**：`options` > `feishu.json` > 环境变量。

### 3. 生效与确认

```bash
opencode reload          # 重新加载配置与插件
opencode mcp list        # 顺带确认服务健康
```

在飞书里给机器人发一条消息。**第一次发消息的人会被自动绑定为 owner**，之后其他人被静默忽略。

> 用全局插件目录加载（离线 / 固定目录）或升级插件后，需要重启服务才重新 import：
> ```bash
> opencode service restart
> ```

---

## 三、怎么用

### 主聊天流（管理台）

主聊天流**只做管理**，普通文本不会进入任何会话。

| 命令 | 作用 |
|---|---|
| `/new [标题]` | 发建会话表单卡，提交即建会话并自动开话题（与 `/form` 等价） |
| `/form [标题]` | 同上，`/new` 的等价入口 |
| `/sessions`（`/ls`） | **全部**会话列表卡片（含本机所有 opencode 会话），可翻页、可进话题、可新建 |
| `/resume [序号]` | 对最近更新（或列表第 N 个）的会话发恢复卡，**回复该卡**即续聊 |
| `/current` | 查看当前会话 |
| `/stop` | 中断当前会话正在跑的任务 |
| `/steer <文本>` | 立即插队发送一条消息（打断当前步骤，不等排队） |
| `/now` | 把该会话已排队的消息全部改为立即执行 |
| `/dir` `/model` `/perm` | 给表单**预填**工作目录 / 模型 / 权限档位 |
| `/cancel` | 放弃未提交的表单 |
| `/help` | 命令列表 |

### 话题内（干活）

一个话题 = 一个会话，发普通文本就是给 AI 下指令。

| 命令 | 作用 |
|---|---|
| `/model` | 切换本会话模型 |
| `/perm` | 修改本会话权限档位 |
| `/cd <路径>` | 迁移本会话工作目录 |
| `/steer <文本>` | 立即插队发一条消息 |
| `/now` | 把本会话排队消息改为立即执行 |
| `/current` `/stop` `/help` | 同主聊天流，作用于本话题会话 |

### 建会话（`/new` 与 `/form` 完全等价）

```
/new 修一下登录 bug
  ↓
📝 建会话表单卡（工作目录 / 模型 / 权限，一次填完）
  ↓ 点「✅ 创建会话」
表单消息本身成为话题根，机器人 reply_in_thread 发「会话已就绪」卡
```

![/new 建会话表单卡：目录、模型、权限一次填完](image/new.png)

- 目录可直接输入，也可从下拉选择允许根目录的一级子目录；**留空 = 允许根目录**，不存在会自动创建。
- `/dir` `/model` `/perm` 只作为表单预填能力，不再是必经步骤。
- 目录非法时**不建会话**，回带错误说明并保留已填项；`/cancel` 放弃表单。

### 续聊历史会话（`/sessions` + `/resume`）

`/sessions` 列出 opencode **本机全部**会话（按更新时间倒序，分页 8 条可配）：

![/sessions 会话列表卡：翻页、进入/再开、新建会话](image/sessions.png)

- 每条显示标题 / 短 id / 相对时间 / 是否已绑话题 / 目录，当前会话标「← 当前」；已绑话题的按钮显示「▶️ 再开」，其余为「▶️ 进入」；底部可翻页 + 「➕ 新建会话」。
- **「▶️ 进入话题」**：在主聊天流发一张恢复卡（含会话摘要），**直接回复这张卡**即续聊该历史会话。
- `/resume [序号]` 跳过列表直达，同一套「发恢复卡 → 回复即续聊」流程。
- 摘要走「复用原生 compaction 摘要 → 缺失才快摘要」，另带「🗜 压缩并总结」按钮（显式触发，不隐式修改会话历史）；快摘要请求**必须携带 `x-opencode-session` 头**（否则 opencode-go 端拒绝），实现为**优先 `ctx.generate.text(input, { headers })`、失败回退本机 HTTP `POST /api/experimental/generate`**，绝不整会话喂模型。

### 话题根卡工作状态

根卡会实时反映会话状态，在话题列表里一眼看出哪些会话需要你：

| 档位 | header 颜色 | 正文页脚 |
|---|---|---|
| 🟡 待审核 | `orange` | `🟡 待审核：<工具>` |
| 🧠 运行中 | `blue` | `🧠 运行中 · 12:03` |
| ⏳ 待回复 | `grey` | `⏳ 待回复（排队 2）` |
| 🔴 失败 | `red` | `🔴 失败` |
| ⏹ 已中断 | `grey` | `⏹ 已中断` |
| ✅ 完成 | `green` | `✅ 完成` |

**优先级：待审核 > 运行中 > 待回复 > 失败/中断 > 完成。** 标题默认不带状态（默认 `topicStatusInTitle: false`，避免侧栏话题名频繁变动），摘要 / 元信息在刷新时不会丢失。

### 四档权限预设

| 档位 | 含义 | 会话级规则 |
|---|---|---|
| 🔒 只读 | 只看不改，最安全 | 禁止 `edit` / `shell` |
| ✏️ 可编辑 | 改文件免审批，跑命令要问 | 允许 `edit`，`shell` 转审批 |
| ⚠️ 高风险审批 | 改文件 / 跑命令 / 越目录都问 | 高风险动作逐次审批 |
| 🔓 完全信任 | 什么都不问 | 全部放行 |

档位写入**会话级** `permissions`，话题内可用 `/perm` 随时改。

### 审批卡

审批卡默认 4 个按钮：`✅ 允许一次` / `🔓 始终允许` / `✅ 本会话内允许该工具` / `❌ 拒绝`。

- 「始终允许」按命令前缀持久化；「**本会话内允许**」是中间粒度：只对当前会话生效（记入 `allowActions` 并追加会话级 ruleset），其它会话 / 全局配置不变。
- 换档（`/perm`）会清除本会话「本会话内允许」授权；不需要时设 `sessionAllowButton: false` 回到三按钮。

### 排队与插队

会话忙时新消息默认**原生排队**（页面页脚显示「已排队」），`/steer <文本>` 立即插队打断当前步骤，`/now` 把已排队未执行的消息全部改插队。

### 强制停止与看门狗

每张回复卡底部都有「⏹ 强制停止」按钮（重签 token，防重放）；已完成 / 失败时变灰并只回 toast。
**看门狗**（默认 5 分钟，`staleExecutionMs` 可配）：执行态或排队超过阈值无进展即视为卡死，主动 `session.interrupt` + 取消排队 + 发提示卡，避免"一个会话卡死、后续永远排队"。

### 表单 / 提问（`question` 工具）

agent 调 `question` 等 form 类交互时，插件把它转成飞书卡片：单选题直接点选项，多字段逐项点选，自由文本点「✍️ 直接回复答案」后在话题里发一条消息。**没有这层转发，agent 一反问飞书会话就会永久卡住**——这也是会话卡死的常见原因。

### 卡片内容守卫（表格超限降级）

飞书**单卡最多 5 个表格组件**，超限时 patch 直接返回 400（`code=230099`）——回复里出现大量 markdown 对照表时，卡片会永远停在旧内容、看起来像卡死。插件对**整张卡片**做守卫：

- 表格数**按整卡累计**（`cardMaxTables`，默认 `4`，夹取 1–5），超出的表格**降级为围栏代码块**：内容一字不丢，只是不再按表格渲染。
- 围栏代码块内的 `|` 不会被误判（先逐行计算围栏遮罩），降级幂等；单卡组件数收敛到 ≤200（超限时丢最旧元素）。
- 覆盖运行卡文本块、话题根卡 / 恢复卡 / 摘要，以及发送层兜底（`sendCard` / `replyCard` / `patchCard`）；降级记 `warn` 便于观测。

---

## 四、配置项

`<configDir>/plugins/feishu.json`（或 OpenCode `plugins[].options`），支持 `{env:NAME}` / `${NAME}` 展开。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | string | — | 飞书 App ID（**必填**，缺失则禁用插件） |
| `appSecret` | string | — | 飞书 App Secret（**必填**，永不写入日志） |
| `domain` | `feishu`\|`lark` | `feishu` | 飞书 / Lark 国际版 |
| `allowUsers` | string[] | `[]` | open_id 白名单。空 = 仅应用 owner |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | 全局审批门档位 |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | 免审批白名单，支持 `prefix*` |
| `denyTools` | string[] | `[]` | 强制拒绝（优先于白名单） |
| `allowedRoots` | string[] | `[用户家目录]` | 会话工作目录允许根目录；越界 / 系统目录拒绝；留空回退第一个根，不存在自动创建 |
| `stream` | boolean | `true` | 是否流式回填回复 |
| `streamThrottleMs` | number | `400` | 卡片更新最小间隔（下限 400ms） |
| `threadRouting` | boolean | `true` | 话题路由总开关；`false` 时主聊天流普通文本进当前会话 |
| `topicGuidance` | boolean | `true` | 对飞书会话注入一句轻量 system 说明（离题可 `/new`），不拦截；本地会话绝不注入 |
| `recentDirsLimit` / `recentModelsLimit` | number | `5` | 表单「最近使用」条数（1–20） |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | 日志级别 |
| `logFile` | string \| boolean | — | `true` = 写 `<configDir>/plugins/feishu.log`；服务模式建议开启 |
| `gatewayLocation` | string | — | 只在该 location 启动网关（OpenCode 按 location 多次加载全局插件，建议设为常用工作目录） |
| `approvalTtlMs` | number | `600000` | 审批 token / 卡片有效期 |
| `staleExecutionMs` | number | `300000` | 看门狗阈值（夹取 1–60 分钟） |
| `maxResourcesShown` | number | `8` | 审批卡最多展示的资源行数 |
| `sessionAllowButton` | boolean | `true` | 审批卡是否显示「本会话内允许该工具」按钮 |
| `resumeSummary` | boolean | `true` | 恢复卡是否展示会话摘要 |
| `resumeSummaryTimeoutMs` | number | `15000` | 快摘要生成超时（3–60s），超时降级提示 |
| `resumeCompactTimeoutMs` | number | `120000` | 用户主动压缩后的轮询超时（30–300s） |
| `topicStatus` | boolean | `true` | 话题根卡工作状态总开关 |
| `topicStatusInTitle` | boolean | `false` | 是否在根卡标题加状态 emoji 前缀 |
| `topicStatusThrottleMs` | number | `1000` | 根卡状态刷新最小间隔（500–10000） |
| `cardMaxTables` | number | `4` | 单卡最多保留的 markdown 表格数（1–5）；超出按整卡累计降级为围栏代码块，避免飞书 400 `code=230099` |

---

## 五、安全设计

```
permission.evaluate (插件 hook)               permission.asked (事件流)
白名单 → allow   拒绝名单 → deny              发飞书审批卡（自签 token）
会话内已放行 → allow                          用户点击 → card.action.trigger（长连接）
其余（按会话预设）→ ask ────────────────────► 校验：白名单 → 验签 → 绑定字段 → 防重放
                                               → ctx.permission.reply(...)
```

- **自签 token**：HMAC-SHA256，绑定 `requestID + sessionID + 点击人 openId + 过期时间 + nonce`；伪造 / 转发 / 重放都会被拒。
- **强停 / 会话内放行按钮同源签名**：各自绑定专属字段 + 用途标签隔离，权责互不通用。
- **只对飞书来源的会话生效**：本地 TUI 等无映射会话不会被降级为 ask（否则会因没有审批出口而永久挂起）。
- **三重单人边界**：可用范围「仅本人」+ 不申请群权限 + 代码层 open_id 白名单。
- **`always` 语义**：仅当请求带 `save[]` 时才持久化，否则等价于「允许一次」。

---

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 发消息没反应 | ① 应用是否已发布、可用范围是否勾了你；② 订阅是否选了**长连接**（不是 Webhook）；③ 是否开通 `im:message.p2p_msg:readonly` |
| 改了 `feishu.json` 不生效 | 确认路径，然后 `opencode reload` |
| 插件完全没被加载 | npm 方式确认包名在 `plugins` 数组；目录方式确认 `plugins/<名>/index.js` 存在 |
| 改了插件代码不生效 | `opencode reload` 不会重新 import 同路径模块；用 `opencode plugin update` 或重启服务 |
| 出现多个长连接 / 重复回复 | 设置 `gatewayLocation` 为常用工作目录 |
| 审批卡收不到 | 该会话不是从飞书发起的（无映射），插件按设计不接管 |
| 点按钮提示凭证无效 | token 过期（默认 10 分钟）或点击者不在白名单 |
| 卡片内容被截断 | 飞书卡片上限约 30KB，超长会话丢弃卡片上最旧块（完整内容仍在会话里） |
| 建会话后没看到话题 | 表单卡会改写为「✅ 已创建 · …」并附手动创建话题指引 |
| 会话像卡死、发消息只排队 | 看门狗默认 5 分钟后自动中断；也可点「⏹ 强制停止」或发 `/stop` |
| 看不到插件日志 | 服务模式下 stderr 被丢弃，设 `logFile: true` |
| 切了 `/model` 但历史还是旧模型 | 预期行为：切换只影响后续回复，历史消息保留各自当时的模型 |

---

## 七、开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/（自包含 bundle）
npm test            # vitest（纯逻辑单测，不连真飞书）
npm run dev         # tsup --watch
```

**架构**：`src/index.ts` 只做装配（配置、gateway、watchdog、hook 注册与 cleanup）；`src/runtime/` 放可单测的事件分发（`event-router.ts`）、卡片回调分流（`card-action-router.ts`）与话题根卡状态接线（`topic-status.ts`）；会话命令编排拆在 `src/session/`（`session-commands.ts` 为薄门面，实现分在 `session-list.ts` / `setup-wizard.ts` / `session-ops.ts` / `model-perm.ts` / `context.ts`）；飞书交互层在 `src/feishu/`（以纯函数为主便于单测）；安全层在 `src/security/`。

**设计要点**：卡片一律 **JSON 2.0**（按钮放 `body.elements`，回调用 `behaviors`）；更新统一节流 ≥400ms；连续工具调用 ≥3 个自动折叠；运行卡状态用**纯 reducer** 维护。

---

## 八、与其它项目的区别

- 本插件**只支持 OpenCode V2**（`@opencode/plugin`，`Plugin.define` 形态）。
- 生态里另有 `opencode-feishu`（V1 插件，`@opencode-ai/plugin`），两者**不兼容**、不共用代码，请按你的 OpenCode 版本选择。

## 已知限制

- 只处理**单聊文本**（含富文本）；图片 / 文件 / 音视频只给文字占位，不下载。
- 只接管**从飞书发起的会话**的审批；本地 TUI 会话不受影响。
- 消息去重为 `get-then-set`，非原子：极端并发下理论上可能双处理。
- 话题被删除后映射不主动清理（惰性忽略）。
- 建会话只有一条主路径：`/new` 与 `/form` 等价的表单卡；`/dir` `/model` `/perm` 仅用于预填。
- 表单为 JSON 2.0，部分老客户端对 `select_static` 有最低版本要求（≥ V3.7.0）。
- 话题首条消息可能不带 `thread_id`：回复带 root 映射的卡片时插件会靠 `root_id` 兜底路由；新话题缺 `thread_id` 时，敲 `/new` 等命令会落到主聊天流，直接进话题发消息即可。

## 许可证

MIT