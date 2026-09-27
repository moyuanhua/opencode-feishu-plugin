# opencode-feishu-plugin

[English](./README.en.md) | **简体中文**

把 [OpenCode](https://opencode.ai) 接进飞书：**一个飞书话题 = 一个 OpenCode 会话**。你在飞书里用话题管理多个会话，在话题里指挥 AI 写代码，**权限审批直接在飞书卡片上点按钮**。

> **只用 OpenCode V2 插件 API**（`Plugin.define({ id, setup(ctx) })`），不依赖任何 V1 包。
> **纯长连接**（WebSocket）收发事件与卡片回调，**不监听端口、不需要公网地址**。

---

## 亮点

| | 说明 |
|---|---|
| 🔐 **最小权限** | 只要 2 个 scope（单聊读 + 发消息）。**不申请任何群权限**，机器人物理上收不到群消息 |
| 💬 **话题 = 会话** | 每个飞书话题对应一个 OpenCode 会话。主聊天流只做管理，话题里干活，互不串台 |
| 🚀 **一键进入** | `/new` 直接发建会话表单，提交后机器人自动在你消息下开话题 |
| 📝 **表单一次填完** | `/new` 与 `/form` **完全等价**：目录 + 模型 + 权限一张表单一次提交即建会话。目录既可直接输入，也可从下拉选择允许根目录的一级子目录。**零新增权限** |
| 🗂 **目录容错** | 目录留空 = 用允许根目录；不存在会自动创建（仍受 `allowedRoots` 白名单约束） |
| ✅ **卡片审批** | 权限请求变成飞书卡片（允许一次 / 始终允许 / 拒绝），点击即批准，带签名防伪防重放 |
| 🪜 **权限预设** | 只读 / 可编辑 / 高风险审批 / 完全信任，四档一次选定，告别逐次审批 |
| 📊 **实时可见** | 先回执「思考中」，工具调用实时上卡（≥3 个自动折叠），文本流式更新，页脚显示当前模型 |
| 🚦 **状态一眼看** | 话题根卡按会话状态变色（运行中/待审核/待回复/完成…）+ 正文页脚；标题默认不抖动，摘要不丢 |
| 🧵 **原生排队** | 会话忙时自动排队（OpenCode 原生 `delivery:"queue"`），不丢消息 |
| ⏹ **一键强停** | **所有 AI 回复卡片都带「强制停止」按钮**，点击即中断（签名校验：白名单 + HMAC）。卡死会话由看门狗自动中断，不再永久排队 |
| 🚫 **无端口** | 全程长连接，服务器不用开放任何入站端口 |

---

## 一、飞书后台配置（约 3 分钟）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**。
2. **添加应用能力 → 机器人**。
3. **权限管理**，只开通这两个：
   - `im:message.p2p_msg:readonly` —— 读取用户发给机器人的单聊消息
   - `im:message:send_as_bot` —— 以应用身份发消息（也用于更新卡片）
4. **事件与回调 → 事件配置**：订阅方式选 **「使用长连接接收事件」**（不要选 Webhook），添加事件 `im.message.receive_v1`。
5. **事件与回调 → 回调配置**：订阅方式同样选 **长连接**，添加回调 `card.action.trigger`（**该项零权限要求**）。
6. **版本管理与发布**：**可用范围 = 仅本人**（只勾你自己），创建版本并发布。
7. 记下 **App ID**（`cli_…`）与 **App Secret**。

> **为什么不申请群权限？** 本插件的设计是"一个人的遥控台"。不申请群权限，机器人**物理上收不到群消息**，
> 单人边界由平台 scope 层保证，而不是只靠代码判断。

---

## 二、安装

### 1. 安装插件（V2：由 npm 自动加载，推荐）

OpenCode V2 通过配置 `plugins` 数组声明要加载的包，启动时自动用 Bun 安装
（缓存于 `~/.cache/opencode/node_modules/`）。两种等价写法：

```bash
# 方式 A：CLI（推荐）
opencode plugin add opencode-feishu-plugin
```

```jsonc
// 方式 B：手写 ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-feishu-plugin"]
}
```

插件入口由 `package.json#exports` 指向**自包含**的 `dist/index.js`（含飞书 SDK 等依赖），
运行时不需要你手动 `npm install`，也不需要额外 `node_modules`。

**本地开发（不走 npm）**：克隆后 `npm install && npm run build`，把本地目录写进 `plugins`：

```jsonc
{ "plugins": ["./path/to/opencode-feishu-plugin"] }
```

### 2. 另一种加载方式：全局插件目录（离线 / 固定目录）

也可把构建产物放进 `<configDir>/plugins/<任意名>/`（`configDir` = `OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`）。
OpenCode 会自动发现该目录下的 `index.js`（本包根部已带该入口，转发到 `dist/`）：

```bash
cd /path/to/opencode-feishu-plugin && npm install && npm run build
mkdir -p ~/.config/opencode/plugins/feishu
cp -r dist index.js package.json ~/.config/opencode/plugins/feishu/
```

> 无论用哪种方式加载，**升级后都需要重启服务**才会重新 import 模块：
> ```bash
> opencode service restart
> ```

### 3. 写配置

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

把凭证放进 OpenCode **服务进程**的环境变量（不是你的交互 shell）：

```bash
opencode service set env FEISHU_APP_ID cli_xxxxxxxx
opencode service set env FEISHU_APP_SECRET xxxxxxxx
```

也可以直接把明文写进 `feishu.json`（权限记得 `600`）。**优先级**：`options` > `feishu.json` > 环境变量。

### 4. 生效与确认

```bash
opencode reload          # 重新加载配置与插件
opencode mcp list        # 顺带确认服务健康
```

在飞书里给机器人发一条消息。**第一次发消息的人会被自动绑定为 owner**，之后其他人被静默忽略。

---

## 三、怎么用

### 主聊天流（管理台）

主聊天流**只做管理**，普通文本不会进入任何会话。

| 命令 | 作用 |
|---|---|
| `/new [标题]` | **直接发建会话表单卡**，提交即建会话并自动开话题（与 `/form` 等价；标题作为会话标题） |
| `/form [标题]` | 同上，`/new` 的等价入口 |
| `/sessions`（`/ls`） | **全部**会话列表卡片：每条显示标题/短 id/相对时间/「💬 已绑话题」/「📍 目录」，并提供「▶️ 进入话题」按钮；分页 8 条（可配 `sessionPageSize`，5–20） |
| `/use <序号\|id前缀>` | 切换当前会话（旧行为，保留兼容） |
| `/resume [序号]` | **续聊历史会话**：对最近更新（或列表第 N 个）的会话在主聊天流发一张「🔄 恢复卡」，**回复该卡**即续聊 |
| `/current` | 查看当前会话 |
| `/stop` | 中断当前会话正在跑的任务（每张运行卡上也都有「⏹ 强制停止」按钮） |
| `/steer <文本>` | 发送一条**立即插队**的消息（打断当前步骤插入执行，不等排队） |
| `/now` | 把该会话**已排队**的未执行消息全部改为立即插队执行 |
| `/dir <路径>` | 给表单**预填**工作目录（留空 = 允许根目录；不存在会自动创建） |
| `/model [关键词]` | 给表单**预填**模型（也可在话题内切换当前会话模型） |
| `/perm [档位]` | 给表单**预填**权限档位（也可在话题内修改当前会话权限） |
| `/cancel` | 放弃未提交的表单 |
| `/help` | 命令列表 |

### 话题内（干活）

一个话题 = 一个会话。**在话题里发普通文本就是给 AI 下指令**；回复会留在同一话题内。

| 命令 | 作用 |
|---|---|
| `/model` | 切换本会话模型 |
| `/perm` | 修改本会话权限档位 |
| `/cd <路径>` | 迁移本会话工作目录（留空 = 回到允许根目录；不存在会自动创建） |
| `/steer <文本>` | 立即插队发送一条消息（打断当前步骤插入执行） |
| `/now` | 把本会话已排队的未执行消息改为立即插队执行 |
| `/current` `/stop` `/help` | 同主聊天流，作用于本话题会话 |

### 模型切换的真实语义（`/model`）

`/model` 切换只影响**后续**的模型调用，**不会**改写历史消息：

- opencode 的 `switchModel` 语义就是「切换后续 provider turn」，并在会话里追加一条 `model-switched` 标记；此前的 assistant 消息仍带着它们**当时实际使用**的模型。
- 因此「`Session.Info.model` 已经是新模型，但更早那批消息仍是旧模型」是**预期行为**，不是没切成功。
- 为稳妥起见，插件切换后会**读回** `ctx.session.get` 校验真实模型：一致才显示「✅ 已切换模型」；读回不一致会明确提示「⚠️ 模型可能未生效」；读回失败会降级为请求值并提示未校验。**运行卡页脚与 `/current` 显示的模型同样以读回的真实值为准**。
- 切换失败（无权限 / 会话不存在等）时回执会给出错误原因，而不是假装成功。

### 主题软引导（话题内不硬拦截离题）

从飞书 `/new <标题>` 或表单建会话时，标题就是该话题的「主题」。插件**不会**拦截话题内离题的消息，只在 system 里注入一句轻量说明，让 AI 在用户明显转向无关任务时**简短提醒**「可用 `/new` 开新会话」，但不会因此拒答、也不会长篇说教：

- 仅对**从飞书发起的会话**注入；本地 TUI 等会话**绝不注入**（不污染你自己的会话）。
- 取不到会话标题时跳过注入；注入失败只记 `log.warn`，不影响正常执行。
- 可用 `topicGuidance: false` 完全关闭。

### 建会话（`/new` 与 `/form` 完全等价）

```
/new 修一下登录 bug        （或 /form 修一下登录 bug）
  ↓
📝 建会话表单卡
   工作目录：输入框手填，或从下拉选择（允许根目录的一级子目录）；留空 = 允许根目录，不存在会自动创建
   模型：    下拉选（默认最近/当前）
   权限：    四档选一
  ↓ 点 「✅ 创建会话」
表单消息本身成为话题根：机器人对它 reply_in_thread 发出「会话已就绪」卡
  ↓
表单卡被就地改写成成功卡，标题 = `✅ 已创建 · <会话标题>`
（该标题就是话题显示名，一眼可见这是一个已成功创建的会话）
  ↓
点进话题直接发消息即可
```

- `/new` 与 `/form` 走**同一入口**、直接发建会话表单卡；**不再有**目录→模型→权限→确认的分步卡。
- `/dir` `/model` `/perm` 仍可用，但只作为**给表单预填字段**的能力（不再是必经步骤）：执行后会自动回一张预填好的新表单卡。
- 表单提交后先消费向导状态，防连点重复建会话；目录非法时**不建会话**，回带错误说明并保留已填项。
- 随时发 `/cancel` 放弃未提交的表单。

### 目录容错规则

| 输入 | 行为 |
|---|---|
| 留空 | 使用**允许根目录** `allowedRoots[0]`（默认用户家目录），不视为错误 |
| 不存在的绝对路径 | 自动 `mkdir -p` 创建，但**必须仍在 `allowedRoots` 之下** |
| 越界 / 系统目录 / `/` | 拒绝，不创建 |
| 符号链接 | 创建后以 `realpath` 复核，逃逸出 `allowedRoots`或落系统目录 → 拒绝 |

`/cd` 遵循**完全相同**的规则。

**表单里目录的取值优先级**（下拉与输入框并存时）：下拉选中（非「✍️ 手动输入路径」）＞ 文本输入框 ＞ 两者皆空则用 `allowedRoots[0]`。
下拉默认停在「✍️ 手动输入路径」，保证手填优先、不会误选一个意料外的目录；用 `/dir <路径>` 预填时写入输入框，若该路径恰是下拉中的某个选项则同步选中，否则回退到「手动输入路径」（任意路径仍可手填）。

### 表单一次填完（`/form`）

- 发 `/form`（或 `/new`，二者等价）直接打开表单卡。
- 表单里一次填好：**工作目录**（输入框手填，或从下拉选允许根目录的一级子目录；可留空）、**模型**（下拉，最近使用 + 常用若干，默认选中当前/最近模型）、**权限档位**（下拉，四档带说明），点「✅ 创建会话」提交。
- 目录下拉的选项：`✍️ 手动输入路径（用上面的输入框）` + `🏠 <根目录>（就用这个根目录）` + 该根目录的**一级子目录**（过滤隐藏目录与 `node_modules`，按名称排序，最多 15 个；含 `.git` 的子目录前缀 `📦 `）。
- 下拉**只用 `allowedRoots[0]`**（第一个允许根目录）；扫描失败（不存在 / 无权限）静默降级为仅「手动输入 + 根目录」两项，不影响表单与插件；扫描在渲染表单卡时进行（低频、不缓存）。`/dir` 仍可手填任意（在允许范围内的）路径。
- 提交后：`session.create` → 对**表单卡消息** `reply_in_thread` 引发会话就绪卡（表单消息即话题根）→ 绑定，随即在新话题里干活。
- `/new <标题>` 的标题会写入向导状态，提交后作为会话标题。
- **零新增权限**：表单提交复用的就是 `card.action.trigger` 回调（官方权限要求为 None），**不需要**新开 scope、也不需要重发应用版本。
- 目录非法时**不会建会话**：会回一张带错误说明的表单卡，并保留你已填的目录/模型/权限，改完再提交即可。

### 续聊历史会话（`/sessions` + `/resume`）

除了从飞书新建的会话，还能**加载任意一个 opencode 本机可见的历史会话**接着聊。

**`/sessions`（别名 `/ls`）— 全部会话列表**

```
/sessions
  ↓
🧩 OpenCode 会话（全部）
  1. 修一下登录 bug（`ses_ab12cd34…`）· 3 小时前 · 💬 已绑话题 · 📍 my-app
  2. 重构 API（`ses_ef56gh78…`）· 2 天前 · 📍 api-server
  …
  [▶️ 进入话题] [▶️ 再开话题] [⬅️ 上一页] [➡️ 下一页] [➕ 新建会话]
```

- 数据源是 `ctx.session.list()`（opencode **全部**会话，按 `time.updated` 倒序），不再只列插件映射表里的会话；拿不到时回退映射表列表并记 `log.warn`。
- 每条显示：标题（截断）、短 id、相对时间、`💬 已绑话题`（该会话已有话题映射）、`📍 <目录尾段>`。
- **分页**：默认每页 8 条（`sessionPageSize`，夹取 5–20），底部按钮翻页（`{cmd:"list", page:N}`）。
- **「➕ 新建会话」** = 打开发建会话表单卡（与 `/new` `/form` 等价），不再直接建会话。

**「▶️ 进入话题」— 在主聊天流发一张恢复卡**

- 点按钮（值 `{cmd:"open", s, c}`）：先校验会话存在（`ctx.session.get`），不存在 → toast「会话不存在」并把列表卡改写成提示卡。
- 存在 → 在**主聊天流**发一张普通恢复卡：**标题 = `🔄 <会话标题>`**，正文含会话 ID / 目录 / 模型 / 最近活动 / 摘要；同时把**这张卡片消息**记为会话的 root（`root → session` 映射）。**此阶段不预先开话题、不绑 `thread_id`**。
- **如何续聊**：**直接回复这张恢复卡**（飞书会在该卡下形成话题）即可继续这个历史会话。用户首次回复的入站事件**可能只带 `root_id` 而不带 `thread_id`**，插件靠 `root → session` 兜底路由到会话，并在拿到 `thread_id` 后补写 `thread → session` 映射；之后该话题内的消息按常规话题路由。（opencode 会话上下文天然持久，等同于 resume。）
- **摘要区块（任务 B，三条路径）**：
  1. **复用（零模型调用）**：读该会话**完整消息**（`session.message.list`，即 `/api/session/{id}/message`；注意 `/context` 是精简形状、不含 `summary`），取最近一条 `status:"completed"` 的 compaction `summary`，标注「会话摘要」直接渲染；
  2. **快摘要（默认路径）**：无原生摘要时，**绝不喂整个会话**——只取最近消息构造**精简转写**（每条截断、总量 ≤6K 字符）交给一次性临时生成，标注「摘要（快摘要）」，秒级完成；该请求**必须携带 `x-opencode-session`**（否则 opencode-go 端按路由要求拒绝：`Request is missing x-opencode-session`）。实现为**优先 A、失败回退 B**：A 用 `ctx.generate.text(input, { headers: { "x-opencode-session": sessionID } })`；B 用本机 HTTP `POST /api/experimental/generate`（`service.json` 的 Basic 认证 + URL 编码的 `x-opencode-directory`）并显式带该头。**绝不**回退到 `ctx.session.generate`（会把整个会话喂给模型，大会话必超时）。超时（`resumeSummaryTimeoutMs`，默认 **15s**，夹取 3–60s）降级为「（摘要生成失败，可直接发消息继续）」；
  3. **原生压缩（仅用户主动）**：卡片带**「🗜 压缩并总结」**按钮（值 `{cmd:"compact", s, t}`，自签 token + 白名单 + 防重放）。点击后（3 秒内回 toast）**异步** `POST /api/session/{id}/compact`，卡片进入「🗜 正在压缩会话…」态，并每 2s 轮询该会话消息直到出现**新的** completed 摘要，patch 为「已压缩 · 会话摘要」；失败/超时（`resumeCompactTimeoutMs`，默认 **120s**，夹取 30–300s）只 patch 说明，不影响继续干活。**压缩会修改会话历史，插件绝不在「进入会话」时隐式触发**。
  可用 `resumeSummary: false` 关闭整个摘要区块与压缩按钮。
- 只影响被点击的那一个会话：恢复卡只绑定该会话的 root，其它会话的映射不受影响。
- 已绑话题的会话按钮文案变成「▶️ 再开话题」，**同一会话可被多个话题路由**（每个话题各自会话上下文；回复落在触发话题内）。

**`/resume [序号]` — 跳过列表直接恢复**

- `/resume` = 对**最近更新**的会话走同一「发恢复卡」流程；`/resume 3` = 列表第 3 个。序号越界会提示有效范围。
- 与 `/sessions` 用同一份排序（`time.updated` 倒序）。同样是发恢复卡，**回复该卡**即续聊。

**限制**

- 只能续 **opencode 本机可见**的会话；已删除 / 不属于本机 / `session.list` 看不到的会话无法进入。
- `/sessions` `/resume` 属主聊天流命令，**话题内被禁用**（会提示回主聊天流）；进入某个话题后无需再敲命令，直接发消息即可。
- `threadRouting=false`（回退模式）下不支持进入话题 / `/resume`。

### 话题根卡工作状态（颜色 + 页脚）

话题根卡（`/new` 建会话成功卡 / `/resume` 恢复卡）会**实时反映该会话当前在干什么**，让你在话题列表里一眼看出哪些会话需要你：

| 档位 | header 颜色 | 正文页脚 | 触发来源 |
|---|---|---|---|
| 🟡 待审核 | `orange` | `🟡 待审核：<工具>` | 有**未答复**的权限请求（`permission.asked`，回复后解除） |
| 🧠 运行中 | `blue` | `🧠 运行中 · 12:03` | `execution.started` / `session.status(busy\|retry)` 起，终态收 |
| ⏳ 待回复 | `grey` | `⏳ 待回复（排队 2）` | inbox 有**排队未投递**消息（`inbox.enqueued` / `delivered`） |
| 🔴 失败 | `red` | `🔴 失败` | 最近终态为失败（`execution.failed` / 运行卡失败收尾） |
| ⏹ 已中断 | `grey` | `⏹ 已中断` | 最近终态为中断（`execution.interrupted` / `/stop` / 看门狗） |
| ✅ 完成 | `green` | `✅ 完成` | 空闲 / `execution.succeeded` / `session.status(idle)` |

**优先级（高 → 低）：待审核 > 运行中 > 待回复 > 失败/中断 > 完成。** 「待审核」刻意排在「运行中」之前——卡在审批上时最需要你去点按钮。

- **标题默认不带状态**：话题名会显示在侧栏，随状态频繁变动会很乱。状态只通过 **header 颜色 + 正文页脚**表达；标题保持固定的 `🔄 <会话主题>`（`/new` 创建时为 `✅ 已创建 · <主题>`）。若确实想让标题也带状态 emoji，设 `topicStatusInTitle: true`（如 `🟡 已完成 · 主题`）。
- **摘要/元信息不会丢**：根卡上可能有会话摘要与目录/模型等元信息，而状态刷新是**整卡 patch**。插件先把根卡的「基础内容」持久化到会话记录（`rootCard`），刷新时用统一构建器**基于基础内容重渲染**再叠加状态，因此状态变化**不会抹掉摘要**。
- **只更新会话最近一次的根卡**：目标消息 id 是会话记录里的 `replyMessageId`。没有该字段（非飞书会话）或没有基础内容的旧会话 → **跳过**，不会凭空造卡。
- **节流与容错**：只在**档位变化**时 patch，且两次 patch 至少间隔 `topicStatusThrottleMs`（默认 1s）；patch 失败只 `warn`（用户可能删了卡），**不抛、不重试风暴**，同一会话连续失败达阈值后停止刷新并记日志。
- 与每条消息那张**运行卡**完全独立：状态刷新只碰话题根卡，不影响运行卡既有的流式行为。

配置：`topicStatus`（默认 `true`，关闭则完全不刷新）、`topicStatusInTitle`（默认 `false`）、`topicStatusThrottleMs`（默认 `1000`，夹取 500–10000）。

### 卡片内容守卫（表格超限降级）

飞书**单张卡片最多 5 个表格组件**，超限时 `im.message.patch` 直接返回 400 `code=230099 card table number over limit`。真实的坑：某次 assistant 回复里出现**大量 markdown 对照表**（一次 5 个以上）时，**每一次卡片 patch 都失败**，卡片永远停在旧内容 → 用户以为机器人「卡死」。

插件对**整张卡片**做内容守卫（不只是每个元素各自计数）：

- **表格数按整卡累计**：多个 markdown 元素**共用**一个额度（默认 `cardMaxTables=4`，留 1 个余量；夹取 1–5，即使配到 5 也正好等于飞书硬上限）。
- **超出额度的表格降级为围栏代码块**（`` ``` `` / `~~~`）：内容**一字不丢**，只是不再被飞书当作表格渲染，因此不会触发 400。
- **代码块内的 `|` 绝不被误判为表格**：识别前先逐行计算围栏遮罩（``` / ~~~，允许最多 3 空格缩进），代码块内的行一律跳过；因此降级后的结果**再次处理是幂等的**，不会无限降级。
- **组件数兜底**：单卡组件数收敛到 ≤200（超限时从**最旧**元素开始丢弃，保留最新内容），避免另一类 400。
- 应用范围：运行卡文本块、话题根卡 / 恢复卡 / 摘要，以及发送层（`sendCard` / `replyCard` / `patchCard`）的**最后一道兜底**——任何路径都不会把超限卡片发出去。发生降级时按 `sessionID` 记 `warn`（含识别表格数 / 降级数）便于观测。

配置：`cardMaxTables`（默认 `4`，夹取 `1–5`）。

### 四档权限预设

| 档位 | 含义 | 会话级规则 |
|---|---|---|
| 🔒 只读 | 只看不改，最安全 | 禁止 `edit` / `shell` |
| ✏️ 可编辑 | 改文件免审批，**跑命令要问** | 允许 `edit`，`shell` 转审批 |
| ⚠️ 高风险审批 | 改文件 / 跑命令 / 越目录都问 | 高风险动作逐次审批 |
| 🔓 完全信任 | 什么都不问 | 全部放行 |

档位写入**会话级** `permissions`，可在话题内用 `/perm` 随时改，不影响其它会话。

### 审批卡：会话粒度的「本会话内允许该工具」

审批卡默认有 **4 个按钮**：`✅ 允许一次` / `🔓 始终允许` / `✅ 本会话内允许该工具` / `❌ 拒绝`。

「始终允许」只按 opencode 给的**命令前缀**（如 `ls *`）持久化，换个命令又会问；「完全信任」又太宽（连 edit / 越目录也放开）。「**本会话内允许该工具**」是中间粒度：

- 只对**当前会话**生效：把该工具 action 记入会话的 `allowActions`，并**追加**到会话级 ruleset（`{action, resource:"*", effect:"allow"}`）；`permission.evaluate` gate 命中后**不再降级为 ask**，因此本会话后续同类调用不再打扰你。
- **其它会话、全局配置都不变**——切到别的会话该问还是问。
- `shell` 与 `bash` 一起放行（opencode 实测工具 id 是 `bash`，设计稿写作 `shell`，两者都覆盖）。
- 点击会**同时**用「允许一次」答复当前这条挂起请求（否则本次执行仍会卡住），随后审批卡收敛为「✅ 已允许本会话内 `<action>`」（无按钮）。
- 用 `/perm` **换档**属于显式权限变更，会**清除本会话已有的「本会话内允许」授权**，避免旧授权压过新档位。
- 安全边界与「强制停止」一致：按钮 value 形如 `{cmd:"allow_session", a:"<action>", t:"<签名>"}`，token 复用 HMAC 并绑定 `sessionID + action + 过期时间 + nonce`（另带 requestID 以定位卡片），点击校验顺序为 **白名单 → 验签 → sessionID 匹配 → 防重放**；伪造 / 跨会话 / 重放都被拒，重复点击只回 toast。
- 不想用这个按钮时设 `sessionAllowButton: false`（审批卡回到三按钮）。

### 排队与插队（`/steer` `/now`）

会话正在干活时，再发的消息默认走 opencode 的**原生排队**（`delivery:"queue"`，卡片页脚显示「已排队」），当前任务跑完才轮到它。想立刻插队有两种方式：

- `/steer <文本>`：把这条消息以 `delivery:"steer"` **立即插入**执行（打断当前步骤，类似 TUI 里的 steer 发送）。
- `/now`：把该会话**已经排队、尚未投递**的消息全部改成 `steer`，立刻执行（走 opencode 的 `session.inbox.update`，不重新发送内容）。

排队消息存放在 opencode 的 session inbox 中，`/now` 只是把它们「插队」，不会丢失或重复。

### 强制停止按钮与卡死自动恢复（看门狗）

**每张 AI 回复卡片底部都有「⏹ 强制停止」按钮**（回执卡、流式运行卡、终态卡、卡死提示卡全覆盖）：

- 运行中 / 排队中：按钮为**红色 danger**「⏹ 强制停止」，点击即中断该会话当前执行，并取消尚未投递的排队消息；
- 已完成 / 失败 / 已中断：按钮为 `default` 样式「⏹ 停止」，点击只回 toast「该任务已结束」（避免误以为还能停）。

按钮走**签名动作** `{ cmd:"stop", sid:<sessionID>, t:<token> }`，token 复用审批卡的 HMAC 机制，
绑定 `sessionID + 用途标签 + 过期时间 + nonce`；卡片**每次 patch 都会重签**，长任务不会因 token 过期点不动。
点击校验顺序：**白名单（allowUsers/owner）→ 验签 → 绑定 sessionID → 防重放**；伪造 / 跨会话 / 重放点击都会被拒。

**看门狗（5 分钟阈值，可配置）**：执行态超过阈值无任何事件即视为卡死，插件会**真正中断服务端会话**
（`session.interrupt`）+ **取消排队中的 inbox 消息** + 收尾运行卡 + 发一张带「强制停止」按钮的提示卡。
若某会话处于排队且超过同一阈值仍无 `execution.started`，也会触发同样的恢复流程并提示——
避免历史上「一个会话卡死后，后续消息永远排队、无人处理」的问题。

阈值由 `staleExecutionMs` 配置（默认 5 分钟，夹取 1–60 分钟）。

### 表单 / 提问（`question` 工具）

agent 主动调用 `question` 工具（或其它 form 类交互）时，opencode 会创建一个 pending form 并阻塞执行。插件会把它转发成飞书卡片：

- 单选题直接点选项按钮；多字段表单逐项点选，填满后自动提交；
- 需要自由文本的字段点「✍️ 直接回复答案」，然后在**同一话题**里发一条消息作为答案；
- 提交/取消后卡片自动收敛为结果态。

没有这层转发时，agent 只要一反问，飞书会话就会永久卡住、后续消息全部排队——这也是「会话卡死」的常见原因之一。

---

## 四、配置项

`<configDir>/plugins/feishu.json`（或 OpenCode `plugins[].options`），支持 `{env:NAME}` / `${NAME}` 展开。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | string | — | 飞书 App ID（**必填**，缺失则禁用插件，不抛异常） |
| `appSecret` | string | — | 飞书 App Secret（**必填**，永不写入日志） |
| `domain` | `feishu`\|`lark` | `feishu` | 飞书 / Lark 国际版 |
| `allowUsers` | string[] | `[]` | open_id 白名单。**空 = 仅应用 owner**（首个发消息者绑定并持久化） |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | 全局审批门档位 |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | 免审批白名单，支持 `prefix*` |
| `denyTools` | string[] | `[]` | 强制拒绝（优先于白名单） |
| `allowedRoots` | string[] | `[用户家目录]` | 会话工作目录的允许根目录（默认目录即 `allowedRoots[0]`）；`/`、文件系统根与系统目录一律拒绝；目录留空回退到第一个根、不存在会自动创建。**目录下拉只扫描第一个根的一级子目录** |
| `stream` | boolean | `true` | 是否用流式卡片回填回复 |
| `streamThrottleMs` | number | `400` | 卡片更新最小间隔（下限 400ms，飞书限 5 QPS） |
| `threadRouting` | boolean | `true` | 话题路由总开关；`false` 时主聊天流普通文本进当前会话（回退用） |
| `topicGuidance` | boolean | `true` | 主题软引导：对飞书会话注入一句「离题可 `/new` 开新会话」的 system 说明（不拦截消息）；非飞书会话绝不注入 |
| `recentDirsLimit` | number | `5` | 「最近使用目录」条数（1–20） |
| `recentModelsLimit` | number | `5` | 「最近使用模型」条数（1–20） |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | 日志级别（只记 secret 存在性，绝不含明文） |
| `logFile` | string \| boolean | — | `true` = 写 `<configDir>/plugins/feishu.log`；或指定路径。**服务模式下插件 stderr 会被丢弃，排查问题请开它** |
| `gatewayLocation` | string | — | 只在该 location 启动网关。OpenCode 会按 location 多次加载全局插件（独立 VM context，无法用进程内单例收敛）；**强烈建议设为你常用的工作目录**，否则会出现多个长连接 |
| `approvalTtlMs` | number | `600000` | 审批 token / 卡片有效期 |
| `staleExecutionMs` | number | `300000` | 看门狗阈值：执行态超过此时长无事件即视为卡死，主动中断并收尾；排队超过此时长仍无 `execution.started` 也提示。夹取 1–60 分钟 |
| `maxResourcesShown` | number | `8` | 审批卡最多展示的资源行数 |
| `sessionAllowButton` | boolean | `true` | 审批卡是否显示「✅ 本会话内允许该工具」按钮；关闭后回到「允许一次 / 始终允许 / 拒绝」三按钮 |
| `resumeSummary` | boolean | `true` | 恢复卡是否展示会话摘要（复用原生 compaction 摘要 → 缺失才走快摘要；关闭则完全不生成、也不显示压缩按钮） |
| `resumeSummaryTimeoutMs` | number | `15000` | 恢复卡**快摘要**生成超时（夹取 3000–60000）；超时按失败处理并降级提示 |
| `resumeCompactTimeoutMs` | number | `120000` | 恢复卡**用户主动压缩**（`session.compact`）后的轮询超时（夹取 30000–300000）；超时只 patch 说明。压缩是显式操作、会修改会话历史 |
| `topicStatus` | boolean | `true` | 话题根卡工作状态总开关（颜色 + 页脚）。关闭则完全不刷新根卡状态 |
| `topicStatusInTitle` | boolean | `false` | 是否在根卡标题加状态 emoji 前缀（如 `🟡 会话名`）。默认关闭：话题名显示在侧栏，频繁变动会很乱 |
| `topicStatusThrottleMs` | number | `1000` | 根卡状态刷新最小间隔（夹取 500–10000）；仅在档位变化时才 patch |
| `cardMaxTables` | number | `4` | 单卡最多保留的 markdown 表格数（夹取 1–5）；超出的表格**按整卡累计**降级为围栏代码块（内容不丢），避免飞书 400 `code=230099` |

---

## 五、安全设计

```
permission.evaluate (插件 hook)                 permission.asked (事件流)
──────────────────────────                      ──────────────────────
白名单工具      → allow                          事件带 {id, sessionID, action, resources, save}
拒绝名单        → deny                                     │
会话内已放行     → allow（allowActions 命中）                  │
其余（按会话预设）→ ask ─────────────────────────────────────┘
                                                           ▼
                                            发飞书审批卡（按钮 value = 自签 token）
                                                           │ 用户点击
                                                           ▼
                                   card.action.trigger（长连接到达，3 秒内回 toast）
                                                           │
                                   校验：点击人在白名单 → 验签 → 绑定字段 → 防重放
                                                           ▼
                                      ctx.permission.reply({sessionID, requestID, reply})
```

- **自签 token**：HMAC-SHA256，绑定 `requestID + sessionID + 点击人 openId + 过期时间 + nonce`；伪造 / 转发 / 重放都会被拒。
- **强停按钮同源签名**：运行卡「强制停止」token 绑定 `sessionID + 用途标签 + 过期时间 + nonce`，点击先过 open_id 白名单再验签，且与审批 token 用途隔离（互不通用）。
- **会话内放行同源签名**：审批卡「本会话内允许该工具」token 绑定 `sessionID + action + 过期时间 + nonce`（另带 requestID 定位卡片），用途标签隔离；命中会在 `SessionMap` 记 `allowActions` 并追加会话级 ruleset，`evaluate` gate 对命中 action **不再降级为 ask**（`denyTools` 安全红线仍优先），且**只影响该会话**。
- **只对飞书来源的会话生效**：没有 chat↔session 映射的会话（例如你本地 TUI）**不会被降级为 ask**，否则会因为没有审批出口而永久挂起。
- **三重单人边界**：平台可用范围「仅本人」+ 不申请群权限 + 代码层 open_id 白名单静默忽略。
- **`always` 语义**：仅当请求带 `save[]` 时才持久化，否则等价于「允许一次」（卡片会提示）。

---

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 发消息没反应 | ① 应用是否**已发布**、可用范围是否勾了你；② 事件/回调订阅是否选了**长连接**（不是 Webhook）；③ 是否开通 `im:message.p2p_msg:readonly` |
| 改了 `feishu.json` 不生效 | 确认路径是 `<configDir>/plugins/feishu.json`，然后 `opencode reload` |
| 放了插件但完全没被加载（无日志、无报错） | npm 方式：确认包名已写进配置 `plugins` 数组（`opencode plugin list` 可见）。目录方式：确认 `plugins/<名>/index.js` 存在（OpenCode 不读 `package.json#main`） |
| 改了插件代码不生效 | `opencode reload` **只重跑 `setup`，不会重新 import 同路径模块**。升级插件用 `opencode plugin update opencode-feishu-plugin`，或重启服务（`opencode service restart`） |
| 出现多个长连接 / 重复回复 | 设置 `gatewayLocation` 为你常用的工作目录（OpenCode 按 location 多次加载全局插件） |
| 审批卡收不到 | 该会话不是从飞书发起的（无映射）；插件按安全设计不接管 |
| 点按钮提示凭证无效 | token 过期（默认 10 分钟）或点击者不在白名单 |
| 卡片内容被截断 | 飞书卡片上限约 30KB，插件截断并标注；超长会话会丢弃卡片上最旧的块（完整内容仍在会话里） |
| 表单卡提交没反应 / 报错 | 客户端过旧（`select_static` 需 ≥ V3.7.0）；或该卡已失效（表单被消费/取消）——重新发 `/form` 或 `/new` 打开新表单 |
| 表单提交后没建会话 | 目录越出白名单 / 命中系统目录时会回错误卡且**不建会话**，按提示改目录再提交；留空或不存在的允许范围内目录会自动创建，不会因此失败 |
| 建会话后没看到话题 | 自动开话题失败时表单卡会改写为「✅ 已创建 · …」并附手动创建话题指引；可在 `/sessions` 会话卡上手动「创建话题」 |
| 看不到插件日志 | 服务模式下插件 stderr 会被丢弃；设 `logFile: true`，然后看 `<configDir>/plugins/feishu.log` |
| 主聊天流发消息只回提示卡 | 预期行为：主聊天流只做管理。用 `/new` 进话题；想恢复旧行为设 `threadRouting: false` |
| 会话像卡死、发消息只排队 | 看门狗会在 `staleExecutionMs`（默认 5 分钟）后自动中断该会话并取消排队，同时发提示卡；也可直接点卡片上的「⏹ 强制停止」或发 `/stop` |
| 切了 `/model` 但历史消息还是旧模型 | 预期行为：切换只影响**后续**回复，历史消息保留各自当时的模型；回执 / 运行卡页脚 / `/current` 均以读回的真实值为准 |

---

## 七、开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/（自包含 bundle）
npm test            # vitest（纯逻辑单测，不连真飞书）
npm run dev         # tsup --watch
```

**架构**：`src/index.ts` 只做装配（配置、gateway、watchdog、hook 注册与 cleanup）；`src/runtime/` 放可单测的事件分发（`event-router.ts`）、卡片回调分流（`card-action-router.ts`）与话题根卡状态接线（`topic-status.ts`）；会话命令编排拆在 `src/session/`（`session-commands.ts` 为薄门面，实现分在 `session-list.ts` / `setup-wizard.ts` / `session-ops.ts` / `model-perm.ts` / `context.ts`，话题状态机在 `topic-status.ts`）；飞书交互层在 `src/feishu/`（事件解析、卡片构建、话题路由、向导状态机、流式卡片 reducer 等，**以纯函数为主便于单测**）；安全层在 `src/security/`（token 签名、白名单）。

**设计要点**：
- 卡片一律 **JSON 2.0**（按钮直接放 `body.elements`，回调用 `behaviors`；1.0 的 `tag:"action"` 在 2.0 会 400）。表单卡额外约束：`form` 必须在 `body.elements` 根节点、交互组件 `name` 全局唯一、至少一个 `form_action_type:"submit"` 按钮。
- 卡片更新统一节流 ≥400ms；连续工具调用 ≥3 个自动折叠（只留名称行）以防 30KB 超限。
- 运行卡状态用一个**纯 reducer** 维护（文本块 / 工具块 / 页脚 / 终态），事件按 `assistantMessageID` 分步。

---

## 八、与其它项目的区别

- 本插件**只支持 OpenCode V2**（`@opencode/plugin`，`Plugin.define` 形态）。
- 生态里另有 `opencode-feishu`（V1 插件，`@opencode-ai/plugin`），两者**不兼容**，也不共用代码，请按你的 OpenCode 版本选择。

## 已知限制

- 只处理**单聊文本**（含富文本）；图片 / 文件 / 音视频只给文字占位，不下载。
- 只接管**从飞书发起的会话**的审批；本地 TUI 会话不受影响（安全设计）。
- 消息去重为 `get-then-set`，非原子：极端并发下理论上可能双处理（正常情况下单实例顺序处理）。
- 话题被删除后映射不主动清理（惰性忽略）。
- 建会话只有一条主路径：**`/new` 与 `/form` 等价的表单卡**；`/dir` `/model` `/perm` 仅用于给表单预填字段。旧的目录/模型/权限/确认分步卡已从 `/new` 下线（目录卡的构建函数已彻底移除；模型/权限/确认卡的构建函数与兼容回调保留，标注 deprecated，供仍持有旧卡片的用户点击时继续可用）。
- 表单为 JSON 2.0（`form` 置于 `body.elements` 根节点，交互组件 `name` 全局唯一，提交按钮带 `form_action_type:"submit"`）；部分老客户端对 `select_static` 有最低版本要求（≥ V3.7.0）。

- **话题首条消息可能不带 `thread_id`**：飞书有时在事件里省略 `thread_id`（随后才归属到话题）。**回复带有 root 映射的卡片**（例如恢复卡）时，插件会靠 `root_id` 兜底路由到对应会话，并在拿到 `thread_id` 后补写话题映射；但若是**新话题**且事件省略了 `thread_id`，此时敲 `/new` 这类仅限主聊天流的命令会被当作主聊天流命令执行（例如表单卡发到主聊天流）。遇到这种情况，直接进话题重新发普通消息即可。


> 本地发布小贴士：`npm publish` 会触发 `prepublishOnly`（typecheck + build + test）。若 `node_modules` 不存在会**自动先跑 `npm ci`**，所以新克隆的仓库可以直接 `npm publish`，无需手动安装依赖。


> 本地发布注意：provenance 只能在 CI（GitHub Actions）里生成，因此 `package.json` 里**没有**设 `publishConfig.provenance`；CI 工作流用 `npm publish --provenance` 显式开启。本地发布直接 `npm publish --access public` 即可。

## 许可证

MIT
