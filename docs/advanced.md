# 高级主题

本文档收录不适合放进主 README 的深度内容：安全模型、位置保活、卡片守卫、会话恢复、网关选举、完整配置项与开发架构。

## 安全设计

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
- **审批卡按钮**：默认 4 个（`✅ 允许一次` / `🔓 始终允许` / `✅ 本会话内允许该工具` / `❌ 拒绝`）。「始终允许」按命令前缀持久化；「本会话内允许」是中间粒度，只对当前会话生效（记入 `allowActions` 并追加会话级 ruleset）；换档（`/perm`）会清除「本会话内允许」授权，不需要时设 `sessionAllowButton: false` 回到三按钮。

## 位置保活

opencode 会**回收空闲的 location**，这会连带卸载插件、关闭飞书长连接：

| 机制 | 位置 | 触发条件 | 表现 |
|---|---|---|---|
| LayerMap `idleTimeToLive` | `packages/core/src/location-services.ts`（硬编码 `60 minutes`） | 60 分钟内无**会话级请求** | location 服务被销毁（静默） |
| `@opencode/LocationActivity` | 同为硬编码 60 分钟 | 60 分钟内无**带 location 的 durable 事件** | 先 interrupt 活动会话，再 `invalidate(location)`，日志 `location services evicted` |

两者都会让插件被 dispose（飞书长连接关闭）。**此后若该 location 再无请求，插件不会自行恢复 → 机器人永久沉默**（官方 issue：[#51343](https://github.com/anomalyco/opencode/issues/51343)、[#51891→#48691](https://github.com/anomalyco/opencode/issues/48691)、[#51828](https://github.com/anomalyco/opencode/issues/51828)；TTL 无配置项）。

插件内置两道防线（都是默认开启，**无需任何外部脚本**）：

1. **网关保活**（每 20 分钟，`keepaliveIntervalMs`）：① 会话级 `GET /api/session/{id}` → `locations.get()` 续期 LayerMap，若已被回收则**重建 location**；② 创建 + GET + 删除一个探针会话 → 续期 `LocationActivity`（`session.created` 事件）。
2. **进程级网关看门狗**（同样每 20 分钟，每进程仅一个定时器）：**任意** location 的插件实例都会登记，周期性对网关 location 做会话级 GET。效果：
   - 网关实例即使已被回收，只要进程里还有**别的** location 存活（例如你在别的项目里开了 TUI/Web），网关会被自动救活；
   - **服务重启后**，你第一次使用任意 location 时看门狗即启动（并在约 3 秒后立即探测一次），网关随之上线；
   - 首次探测带 3 秒延迟，重启后恢复很快。

> **不需要任何外部脚本 / cron / systemd 配置**：以上两道防线都在插件进程内完成。
> 唯一无法覆盖的是「opencode 进程整个挂掉且长时间无人使用」——此时任何插件都无从执行；
> 重新使用 opencode 时会由看门狗自动恢复。`keepalive: false` 可关闭全部保活。

## 看门狗判活规则

看门狗（默认每 60s 扫一次）会在两类情况下自动中断会话：「长时间无进展」（`staleExecutionMs` 内无任何事件）与「排队超时」（排队超过阈值仍无 `execution.started`）。为减少误杀，判活规则如下（issue #1 修复）：

1. **子会话活动计入父链**：`task` 子代理跑在**子会话**里，其事件只带子会话 ID；插件通过 `session.created` 的 `parentID` 维护 child→parent 链路，任意事件沿父链逐级刷新活动时间——父会话在子代理运行期间不会被误判卡死；
2. **合法等待不判 stale**：有**待答表单**（`question`）或**未决审批**的会话，等用户多久都不自动中断、也不取消其排队消息（等用户操作 ≠ 卡死）；
3. **可关闭**：`staleExecutionMs: 0` 完全关闭看门狗（回到"永不自动中断"）。

> 仍会命中的情形：长时间**无任何事件**且无待答交互的真空转（典型为真正的挂起）。此时看门狗按设计中断并发送「已自动中断卡死会话」提示卡。

## 排队卡生命周期（实测语义）

> 忙时投递默认已改为 `steer`（立即插队）；本节描述 `busyDelivery: "queue"`（排队偏好）下的回执卡生命周期。

opencode 的 `delivery:"queue"` 消息会在**当前执行的下一个步骤**被注入处理（**不会**产生新的 `execution.started`，2026-10 受控实验确认）。插件据此管理回执卡：

- 会话忙时新消息 → 回执卡进入「等待中」队列；
- 消息被消费后（同一执行内），其回复渲染在**当时正在运行的卡片**上；
- 当前执行进入终态后，仍在队列的卡片**宽限 3 秒**：期间若等到独立的 `execution.started` 则正常晋升为运行卡；否则按「已随本轮处理」收尾——避免永久停在「等待中」。

## 卡片内容守卫（表格超限降级）

飞书**单卡最多 5 个表格组件**，超限时 patch 直接返回 400（`code=230099`）——回复里出现大量 markdown 对照表时，卡片会永远停在旧内容、看起来像卡死。插件对**整张卡片**做守卫：

- 表格数**按整卡累计**（`cardMaxTables`，默认 `4`，夹取 1–5），超出的表格**降级为围栏代码块**：内容一字不丢，只是不再按表格渲染。
- 围栏代码块内的 `|` 不会被误判（先逐行计算围栏遮罩），降级幂等；单卡组件数收敛到 ≤200（超限时丢最旧元素）。
- 覆盖运行卡文本块、话题根卡 / 恢复卡 / 摘要，以及发送层兜底（`sendCard` / `replyCard` / `patchCard`）；降级记 `warn` 便于观测。

## 长回答处理（运行卡瘦身 + 最终答案独立）

长任务（几十次工具调用）会把单张运行卡撑到上限（28KB / 200 元素），触发降级与**丢弃最旧块**——用户会看到"卡被撑满、前面内容消失"。默认策略：

1. **运行卡只做进度**：最多保留最近 `runnerCardMaxTools`（默认 12）个工具块，更早的合并为「…已省略前 N 次工具调用」；单个文本块上限 `runnerCardTextMax`（默认 2KB）。
2. **最终答案独立发送**：一轮结束时末尾文本 ≥ `finalAnswerMinChars`（默认 600 字符）→ 单独发一张「✅ 完整回答」卡（不与被工具噪声塞满的运行卡抢空间）；运行卡内只留「完整回答已单独发送」提示。
3. **超长转文件**：最终回答 ≥ `finalAnswerFileMinBytes`（默认 20KB）→ 作为 `.md` 文件发送（可预览/下载），内容不截断、不丢失。

> 想要"完整轨迹保留、不省略工具调用"：把 `runnerCardMaxTools` 调到足够大并接受卡片消息变多（或提高 `finalAnswerMinChars` 降低拆分频率）。

## 图片 / 文件接收

- **权限**：需要应用开通 `im:message:readonly`（获取消息中的资源文件接口要求 `im:message` / `im:message:readonly` / `im:message.history:readonly` 任一）。未开通时下载失败，按降级处理，不影响文本消息。
- **流程**：收到 image / file 消息 → 按 `image_key` / `file_key` 调 `im.messageResource.get` 下载 → 落盘到**附件目录**（默认 `<会话工作目录>/.opencode/temp/opencode-feishu-plugin/`，内置 `.gitignore` 避免污染 `git status`；可用 `attachmentsDir` 覆盖；无法确定会话目录时回退系统临时目录）→ 以 `file://` URI 作为附件挂进 `session.prompt`（文本末尾附保存路径提示）。
- **为什么不放系统临时目录**：文件在会话工作目录**内**，模型用 `read` 等工具再读是"工作区内读取"，**不会触发越目录审批**；放在目录外则每次读取都要人工批准。
- **限制**：单附件默认 ≤20MB（`attachmentMaxBytes`，夹取 1–100MB）；超时默认 30s（`attachmentTimeoutMs`）；失败时消息照常投递，仅附「下载失败：原因」。
- **边界**：音频 / 视频 / 表情包不下载（仍占位文本）；合并转发与卡片内资源飞书不支持直接下载。飞书侧单资源上限 100MB。

## 机器人菜单（主窗口快捷入口）

在开发者后台配置菜单项后，用户在机器人会话窗口点击即可触发（`application.bot.menu_v6` 事件，零权限要求）：

| 菜单项（建议名） | 事件 Key | 等价命令 |
|---|---|---|
| 新建会话 | `new`（也接受 `/new`） | `/new` |
| 会话列表 | `sessions`（也接受 `/sessions`） | `/sessions` |

**实现**：网关注册 `application.bot.menu_v6` handler → 归一化为 `{ eventId, eventKey, operatorOpenId }` → 合成一条**等价命令消息**复用既有 `handleMessage` 路由（白名单、去重、命令矩阵、主聊天流决策完全一致）；未知 event_key 静默忽略。

**chatId 来源**：菜单事件**不带 chat_id**。插件会记住每个用户最近一次单聊的 chatId（`feishu:v2:menu-chat:<openId>`，随本机 storage 持久化），因此**首次使用菜单前需先给机器人发过至少一条消息**（正常使用流程必然满足）；无记录时记 `warn` 并忽略本次点击。

## AI 会话管理（issue #2 演进）

主聊天流普通文本的 AI 路由（`quickNew`，默认开启）：

- **意图识别**：临时生成通道（无会话上下文、秒级）输出严格 JSON
  `{intent:"create|list|chat", dir, dir_source, title, perm, model, reason}`；
  - `create` → 建会话；`list` → 列会话；`chat` → 回管理台提示卡；
- **目录优先（重要）**：`create` 时 dir 绝不允许为空，AI 按优先级给出确定目录：
  ① `given` 用户消息里明确给的路径；② `existing` 命中候选（最近使用 + 全部会话目录，标题作语义线索）；
  ③ `new` 都不命中 → 在允许根目录下按主题新建（`<allowedRoot>/<kebab-case 主题>`）；④ 兜底允许根目录。
  预填前用 `validateDirectory(..., { create: false })` **干校验**（不落盘：越界 / 系统目录拒绝、允许范围内可不存在），
  只有提交表单时才会真正 `mkdir -p`；
- **预填表单（目录已填）**：表单只在目录确定后出现，顶部附来源说明
  （「✓ 匹配历史/最近目录」/「➕ AI 新建」/「✍️ 你指定」）；用户明确指定但越界的路径**不静默替换**——
  不预填 + 警示文案，由用户在表单里改；
  - `list` → 会话列表卡（等同 `/sessions`，翻页/进话题/新建按钮全部可用）；
  - `chat`/失败 → 管理台提示卡；
- **表单确认**：建会话**必须**经表单提交（`applySetupFormSubmit`）——用户可确认或修改 AI 的预填；
  提交后锚点 = 表单消息本身，建会话 + 自动开话题；模型/权限等由用户在表单里选。

## /sessions 数据源与恢复卡

`/sessions` 列出 opencode **本机全部**会话（按更新时间倒序，分页 8 条可配）：

- **数据源**：优先插件原生 `ctx.session.list()`（V2 运行时通常未暴露）→ **本机 HTTP `GET /api/session`**（与 opencode 同机，列出**全量**会话，含 TUI / Web 里开的）→ `SessionMap` 回退（仅机器人自己的会话）。进入外部会话时会补一条映射，审批 / 失败通知照常。
- 每条显示标题 / 短 id / 相对时间 / 是否已绑话题 / 目录，当前会话标「← 当前」；已绑话题的按钮显示「▶️ 再开」，其余为「▶️ 进入」；底部可翻页 + 「➕ 新建会话」。
- **「▶️ 进入话题」**：在主聊天流发一张恢复卡（含会话摘要），**直接回复这张卡**即续聊该历史会话。
- `/resume [序号]` 跳过列表直达，同一套「发恢复卡 → 回复即续聊」流程。
- 摘要走「复用原生 compaction 摘要 → 缺失才快摘要」，另带「🗜 压缩并总结」按钮（显式触发，不隐式修改会话历史）；快摘要 / 意图识别请求**必须携带 `x-opencode-session` 头**（否则 opencode-go 端拒绝），且只有**会话管线**会自动附加该头，无会话的 `generate` 端点拿不到。实现为三级通道：**① 临时会话（建 → `session.generate` → 删，首选、兼容任何 provider）→ ② `ctx.generate.text(input, { headers })` → ③ 本机 HTTP `POST /api/experimental/generate`**；三通道都显式带模型，绝不整会话喂模型。

## 话题根卡工作状态

根卡会实时反映会话状态，在话题列表里一眼看出哪些会话需要你：

| 档位 | header 颜色 | 正文页脚 |
|---|---|---|
| 🟡 待审核 | `orange` | `🟡 待审核：<工具>` |
| 🧠 运行中 | `blue` | `🧠 运行中 · 12:03` |
| ⏳ 待回复 | `grey` | `⏳ 待回复（排队 2）` |
| 🔴 失败 | `red` | `🔴 失败` |
| ⏹ 已中断 | `grey` | `⏹ 已中断` |
| ✅ 完成 | `green` | `✅ 完成` |

**优先级：待审核 > 运行中 > 待回复 > 失败/中断 > 完成。** 标题默认不带状态（默认 `topicStatusInTitle: false`，避免侧栏话题名频繁变动），摘要 / 元信息在刷新时不会丢失。总开关 `topicStatus`（默认 `true`），刷新最小间隔 `topicStatusThrottleMs`（默认 `1000ms`，夹取 500–10000）。

## 表单 / 提问（`question` 工具）完整规则

agent 调 `question` 等 form 类交互时，插件把它转成飞书卡片：

- **两种作答方式等价**：直接点选项按钮，或**直接在话题里发文字**（无需先点「✍️ 直接回复答案」）。文本会智能匹配——命中选项 label/value 用选项值，`boolean` 认「是/否、yes/no、1/0」，`number`/`integer` 转数值，多选按顿号/逗号拆分，其余视为**手动输入**。
- 多字段表单可以混合作答：点几个按钮 + 补一条文字，填满即自动提交。
- **纯选项题**（有选项且不允许自填）：可以直接**回复序号/字母**（如 `1`、`B`）或选项原文；若你发的是**其它内容**，插件会视为「你想说别的」——**自动跳过该表单**并把这条消息当**普通消息**交给 AI 处理，不再被误当成答案。
- **作答 / 取消后卡片会被撤回**（不再残留待填卡）；若超出飞书撤回时限，降级为「已提交 / 已取消」结果卡。
- **没有这层转发，agent 一反问飞书会话就会永久卡住**——这也是会话卡死的常见原因。

## 多实例与网关选举

插件是全局插件，会在每个打开的 location 加载；若每处都启动 WSClient 会长出多个长连接。因此网关采用「**location 匹配 + 进程内守护**」选举：

- `gatewayLocation`：只在该 location（或其**子目录**兜底）启动网关；`~` 自动展开、相对路径/尾斜杠会归一化。**留空 = 任意 location 生效**。
- `gatewayMatchGraceMs`（默认 `3000`）：**精确匹配优先**的宽限窗口——子目录候选先等这么久，出现 `here === gatewayLocation` 就让位（0 = 不等待，子目录立即兜底）。
- 同一进程内由 `acquireProcessGuard` 保证**只有一个实例**持有网关，其余实例在 setup 里直接跳过。

**排查**：配置了 `gatewayLocation` 但已加载的 location 无一命中时，插件会在延迟约 2 秒后用 `warn` 打出「已加载的 location 均未命中」（含已见 location 列表）。可临时设 `logLevel: "debug"` 查看「跳过非网关 location」。确认无误仍无响应就先**留空** `gatewayLocation` 排除该项。

## 完整配置项

`<configDir>/plugins/feishu.json`（或 OpenCode `plugins[].options`），支持 `{env:NAME}` / `${NAME}` 展开。凭证**优先级**：`options` > `feishu.json` > 环境变量。

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
| `gatewayLocation` | string | — | 只在该 location（或其**子目录**兜底）启动网关；`~` 自动展开、相对路径/尾斜杠会归一化。留空 = 任意 location 生效 |
| `gatewayMatchGraceMs` | number | `3000` | **精确匹配优先**的宽限窗口：子目录候选先等这么久，出现 `here === gatewayLocation` 就让位（0 = 不等待，子目录立即兜底） |
| `approvalTtlMs` | number | `600000` | 审批 token / 卡片有效期 |
| `staleExecutionMs` | number | `300000` | 看门狗阈值（夹取 0–60 分钟；**0 = 关闭**；见「看门狗判活规则」） |
| `quickNew` | boolean | `true` | 主聊天流「一句话建会话」（AI 判意图 + 找目录，建议卡一键创建）；`false` 关闭 |
| `busyDelivery` | `steer`\|`queue` | `steer` | 忙时新消息投递方式：`steer` = 立即插队（默认）；`queue` = 原生排队，见「排队卡生命周期」 |
| `maxResourcesShown` | number | `8` | 审批卡最多展示的资源行数 |
| `sessionAllowButton` | boolean | `true` | 审批卡是否显示「本会话内允许该工具」按钮 |
| `resumeSummary` | boolean | `true` | 恢复卡是否展示会话摘要 |
| `resumeSummaryTimeoutMs` | number | `15000` | 快摘要生成超时（3–60s），超时降级提示 |
| `resumeCompactTimeoutMs` | number | `120000` | 用户主动压缩后的轮询超时（30–300s） |
| `topicStatus` | boolean | `true` | 话题根卡工作状态总开关 |
| `topicStatusInTitle` | boolean | `false` | 是否在根卡标题加状态 emoji 前缀 |
| `topicStatusThrottleMs` | number | `1000` | 根卡状态刷新最小间隔（500–10000） |
| `cardMaxTables` | number | `4` | 单卡最多保留的 markdown 表格数（1–5）；超出按整卡累计降级为围栏代码块，避免飞书 400 `code=230099` |
| `runnerCardMaxTools` | number | `12` | 运行卡最多保留的工具块数（1–50）；更早的合并为「…已省略前 N 次工具调用」 |
| `runnerCardTextMax` | number | `2048` | 运行卡单个文本块字符上限（512–8192） |
| `finalAnswerMinChars` | number | `600` | 最终回答 ≥ 该长度即**单独成卡/成文件**（0 = 关闭拆分） |
| `finalAnswerFileMinBytes` | number | `20480` | 最终回答 ≥ 该字节数转为 `.md` 文件发送（8192–102400） |
| `acceptAttachments` | boolean | `true` | 接收图片/文件：下载到 `attachmentsDir` 后作为附件挂进会话；失败降级为占位文本 |
| `attachmentMaxBytes` | number | `20971520` | 单附件大小上限（1–100MB），超限拒绝并提示 |
| `attachmentTimeoutMs` | number | `30000` | 附件下载超时（5–120s） |
| `attachmentsDir` | string | `<会话工作目录>/.opencode/temp/opencode-feishu-plugin` | 附件落盘目录；显式配置则精确使用（不再附加子目录），未配置时无法确定会话目录则回退系统临时目录 `<tmp>/opencode-feishu-plugin` |
| `keepalive` | boolean | `true` | **位置保活**：周期性向 opencode 发一次活动，阻止 60 分钟空闲回收 location（会关掉飞书长连接、机器人失联） |
| `keepaliveIntervalMs` | number | `1200000` | 保活间隔（默认 20 分钟，夹取 5–45）；必须显著小于 opencode 硬编码的 60 分钟 TTL |

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/（自包含 bundle）
npm test            # vitest（纯逻辑单测，不连真飞书）
npm run dev         # tsup --watch
```

**架构**：`src/index.ts` 只做装配（配置、gateway、watchdog、hook 注册与 cleanup）；`src/runtime/` 放可单测的事件分发（`event-router.ts`）、卡片回调分流（`card-action-router.ts`）与话题根卡状态接线（`topic-status.ts`）；会话命令编排拆在 `src/session/`（`session-commands.ts` 为薄门面，实现分在 `session-list.ts` / `setup-wizard.ts` / `session-ops.ts` / `model-perm.ts` / `context.ts`）；飞书交互层在 `src/feishu/`（以纯函数为主便于单测）；安全层在 `src/security/`。

**设计要点**：卡片一律 **JSON 2.0**（按钮放 `body.elements`，回调用 `behaviors`）；更新统一节流 ≥400ms；连续工具调用 ≥3 个自动折叠；运行卡状态用**纯 reducer** 维护。