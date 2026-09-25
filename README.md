# opencode-feishu-v2

把 [OpenCode](https://opencode.ai) 接入飞书**单聊**，并把 OpenCode 的**权限审批**做成飞书**卡片按钮**。

> **只使用 OpenCode V2 插件 API**（`Plugin.define({ id, setup(ctx) })`），不依赖任何 `@opencode-ai/*` V1 包。
> 通过飞书**长连接**（WebSocket）收发事件与卡片回调，**不监听端口、不暴露公网地址**。

---

## 能力（P0）

| 能力 | 说明 |
| --- | --- |
| 单聊对话 | 飞书单聊消息 → 映射/新建 OpenCode session → `ctx.session.prompt` |
| 流式回复 | 订阅 `session.text.delta`，把 assistant 文本增量以**原地更新的飞书卡片**回填（节流 ≥400ms） |
| 卡片审批 | `permission.evaluate` 降级为 `ask` → 发审批卡（允许一次 / 始终允许 / 拒绝）→ 点击后 `permission.reply` 闭环 |
| 会话管理 | 一个飞书单聊可绑定**多个** opencode 会话：`/new` `/sessions` `/use` `/current` `/stop`，以及会话列表卡片按钮切换 |
| 立即回执 | 收到消息**先**发一张运行卡片（思考中 / 已排队）再发起 prompt |
| 原生排队 | session 正在执行时用 `delivery:"queue"` 排队，空闲时 `delivery:"steer"` |
| 工具可见 | 工具调用以折叠面板回填卡片（≥3 自动折叠，最新一个展开） |
| 跨实例去重 | 按 `messageId` 经 `ctx.storage` 去重，防重复投递导致双处理 |

---

## 一、最小权限集（精确 scope 名，一个不多）

| 类型 | 项 | 精确值 | 用途 |
| --- | --- | --- | --- |
| 应用能力 | 机器人 | Bot | 收发消息/卡片 |
| 权限 | 读取单聊消息 | `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| 权限 | 以应用身份发消息 | `im:message:send_as_bot` | 发送消息、卡片，及**更新卡片**（`im.message.patch` 满足任一：`im:message` / `im:message:send_as_bot` / `im:message:update`） |
| 事件订阅 | 接收消息 | `im.message.receive_v1` | 单聊消息触发 |
| 回调订阅 | 卡片回传交互 | `card.action.trigger` | 按钮点击（**零权限要求**） |
| 可用范围 | 可用成员 | **仅本人（1 人）** | 平台层单人边界 |
| 订阅方式 | 长连接 | 使用长连接接收事件/回调 | 无需公网地址/端口 |

**明确不申请**：任何 `im:message.group_*` / `im:message.group_at_*` 等群权限。机器人**物理上收不到群消息**，单人边界由平台 scope 层保证，而非只靠代码判断。

> 卡片更新走 `PATCH /open-apis/im/v1/messages/:message_id`，官方文档明确该接口权限「满足任一：`im:message`、`im:message:send_as_bot`、`im:message:update`」——因此**不需要额外申请 CardKit 权限**。

---

## 二、飞书后台配置步骤

1. 在[飞书开放平台](https://open.feishu.cn/app)创建**自建应用**。
2. **添加应用能力 → 机器人**。
3. **权限管理**，只开通：
   - `im:message.p2p_msg:readonly`
   - `im:message:send_as_bot`
4. **事件与回调 → 事件配置**：
   - 订阅方式选择**「使用长连接接收事件」**（不是 Webhook）。
   - 添加事件 `im.message.receive_v1`。
5. **事件与回调 → 回调配置**：
   - 订阅方式同样选**长连接**。
   - 添加回调 `card.action.trigger`（无需额外权限）。
6. **应用发布 → 版本管理与发布**：
   - **可用范围 = 仅本人**（只勾选你自己 1 人）。
   - 创建版本并发布，等待管理员/自己审核通过。
7. 记下 **App ID**（`cli_...`）与 **App Secret**，填入 OpenCode 配置（见下）。

---

## 三、部署

本插件通过 opencode 的 **plugins 目录自动加载**：

```
~/.config/opencode/plugins/
  feishu/          # 插件本体（目录内需 package.json + main 入口）
  feishu.json      # 插件配置（可选；建议权限 600）
```

### 1. 放入插件目录

**方式 A：拷贝构建产物**

```bash
cd /path/to/opencode-feishu-v2
npm install && npm run build
mkdir -p ~/.config/opencode/plugins/feishu
cp -r dist package.json ~/.config/opencode/plugins/feishu/
```

> 构建产物 `dist/index.js` 已自包含飞书 SDK，运行时无需额外 `node_modules`。

**方式 B：npm 安装到该目录**（未发布公共 registry 时用本地 tarball / 私有 registry）

```bash
cd ~/.config/opencode/plugins/feishu
npm init -y
npm install /path/to/opencode-feishu-v2-0.1.0.tgz
```

放入后执行 `opencode reload` 即时生效（插件目录内必须有 `package.json`，且 `main` 指向入口）。

> ⚠️ **不要**在 `~/.config/opencode/opencode.json` 的 `plugins` 数组里写**本地路径**（如 `"./plugins/feishu"` 或绝对路径）——实测**无效**。
> 写成包名（`"opencode-feishu-v2"`）则会触发 `npm install`，私有包会 **404**。
> 正确做法就是上面把插件放进 `plugins/<name>/` 目录，**无需**在 `plugins` 数组里引用它。

### 2. 配置：`<configDir>/plugins/feishu.json`

配置文件字段与 `options` **完全一致**，并支持 `${ENV}` / `{env:ENV}` 展开。
`configDir` 取 `OPENCODE_CONFIG_DIR`（若设置），否则 `~/.config/opencode`：

```bash
install -m 600 /dev/null ~/.config/opencode/plugins/feishu.json
cat > ~/.config/opencode/plugins/feishu.json <<'JSON'
{
  "appId": "{env:FEISHU_APP_ID}",
  "appSecret": "{env:FEISHU_APP_SECRET}",
  "allowUsers": ["ou_你的open_id"],
  "permissionGate": "gate",
  "allowTools": ["read", "glob", "grep", "webfetch"],
  "stream": true,
  "streamThrottleMs": 400
}
JSON
chmod 600 ~/.config/opencode/plugins/feishu.json
```

**优先级（字段级）**：`options` > `<configDir>/plugins/feishu.json` > 环境变量。

- 环境变量兜底仅针对 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，便于**零配置**运行：把插件放进目录后，只在服务进程里设置这两个变量即可。
- **配置错误永不导致 opencode 崩溃**：文件缺失 / 非法 JSON / 顶层非对象 / 读取失败都只 `warn` 并退回下一优先级；最终缺 `appId`/`appSecret` 时**禁用插件**（不抛异常）。
- App Secret **永远不写入日志**，配置告警文案也不会回显 secret 明文。

> 🔐 建议 `feishu.json` 权限设为 `600`（`chmod 600`），避免同机其他用户读取 App Secret。

### 3. `opencode.json` 的 `options`（可选）

仅当你把此包发布到可解析的 registry 时，才在 `~/.config/opencode/opencode.json` 用**对象形式**传 `options`：

```jsonc
{
  "plugins": [
    {
      "package": "opencode-feishu-v2",
      "options": { "appId": "{env:FEISHU_APP_ID}", "appSecret": "{env:FEISHU_APP_SECRET}" }
    }
  ]
}
```

> 目录部署 + `feishu.json` 已能满足配置，**通常不需要**这一节；若同时存在，`options` 优先级最高。
> `{env:FEISHU_APP_ID}` 由 OpenCode 在服务进程内解析，本插件也会兜底解析 `{env:NAME}` / `${NAME}`。
> **App Secret 永远不会写入日志**——日志里只记录 `hasAppSecret: true/false`。

### 配置字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appId` | string | — | 飞书 App ID，必填 |
| `appSecret` | string | — | 飞书 App Secret，必填；缺失则**禁用插件**（不抛异常） |
| `allowUsers` | string[] | `[]` | open_id 白名单。**空 = 仅应用 owner**：首个发消息者被绑定为 owner 并持久化到 `ctx.storage` |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | 权限门档位，见下 |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | 免打扰白名单：命中直接放行；支持 `*` / `prefix*` |
| `denyTools` | string[] | `[]` | 强制拒绝名单（可选），优先于 `allowTools` |
| `stream` | boolean | `true` | 是否用流式卡片回填回复 |
| `streamThrottleMs` | number | `400` | 卡片更新最小间隔，**下限强制 400ms**（飞书单条消息更新 5 QPS） |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | stderr 结构化日志级别 |
| `approvalTtlMs` | number | `600000` | 审批 token / 卡片有效期 |
| `domain` | `feishu`\|`lark` | `feishu` | 飞书 / Lark 国际版 |
| `signSecret` | string | 由 appSecret 派生 | 审批按钮 token 的 HMAC 密钥（一般不用配） |
| `maxResourcesShown` | number | `8` | 审批卡最多展示的 resource 行数 |

### `permissionGate` 档位

| 档位 | 行为 |
| --- | --- |
| `off` | 完全不介入：不注册 hook、不订阅权限事件，零副作用 |
| `notify` | 不改变原生判定；但**本来就产生**的 `permission.asked` 会推送审批卡 |
| `gate` | 白名单外一律置为 `ask` → 弹飞书审批卡（推荐默认） |
| `lockdown` | 白名单外一律 `deny`（不弹卡，最严格） |

> ⚠️ **关键安全边界**：`gate` 的 `ask` **只对「能从飞书投递」的会话生效**（即通过本插件发起、存在 chat↔session 映射的会话）。
> TUI 或其它来源的会话不会被降级为 `ask`，否则会因为没有审批出口而**永久挂起**。

---

## 四、审批卡工作流与安全

```
permission.evaluate (hook)                    permission.asked (SSE)
─────────────────────────                     ──────────────────────
allowTools 命中      → allow                  事件携带 {id, sessionID, action, resources, save, ...}
denyTools / lockdown → deny                            │
其它                 → ask ───────────────────────────┘
                                                        ▼
                                          发飞书审批卡（按钮 value = 自签 token）
                                                        │ 用户点击
                                                        ▼
                              card.action.trigger（长连接到达，3 秒内回 toast）
                                                        │
                          校验：operator.open_id ∈ 白名单 → token 签名 → 绑定字段 → 防重放
                                                        ▼
                              ctx.permission.reply({ sessionID, requestID, reply })
```

- **自签 token**：HMAC-SHA256，绑定 `requestID + sessionID + operatorOpenId + 过期时间 + nonce`。
  token 由 appSecret 派生密钥签发，任何人伪造/转发/重放都会被拒。
- **防重放**：nonce 单次消费；重复点击返回「该操作已处理」。
- **`always` 语义**：仅当请求带 `save[]` 时才会持久化为「已保存权限」；否则等价于 `once`（卡片文案已提示）。
- **`reject` 级联**：会同时驳回**同一 session 内其余挂起请求**（卡片文案已警示）。
- 卡片更新前后都在 `config` 声明 `update_multi: true`（飞书 `im.message.patch` 的硬要求）。

---

## 五、会话管理（多会话）

一个飞书单聊不再只映射一个 opencode 会话，而是维护**一个会话列表 + 一个当前会话**。
在私聊里发送以 `/` 开头的文本即触发命令，**命令不会作为 prompt 发给模型**。

### 命令

| 命令 | 说明 |
| --- | --- |
| `/new [标题]` | 新建 opencode 会话并设为当前；缺省标题为时间戳 |
| `/sessions`（别名 `/ls`） | 发送**会话列表卡片**（见下） |
| `/use <序号\|会话id前缀>` | 切换当前会话，例如 `/use 2`、`/use ses_abc` |
| `/current` | 查看当前会话（标题 + id + 会话总数） |
| `/stop` | 中断当前会话正在跑的任务（`ctx.session.interrupt`） |
| `/help` | 命令列表 |
| 未知 `/xxx` | 回复帮助提示，**不**发给模型 |

> 没有显式建过会话时，**第一条普通消息**仍会自动新建会话并绑定（向后兼容旧行为）。

### 会话卡片

`/sessions` 或点击卡片按钮均可与会话列表交互：

```
🧩 OpenCode 会话
1. 会话标题一（ses_aaa…） ← 当前
2. 会话标题二（ses_bbb…）

[切换 1] [切换 2] [➕ 新建会话]
```

- 每个会话一行（序号 + 标题 + 短 id + 是否为当前），带一个「切换 N」按钮；当前会话按钮高亮。
- 「➕ 新建会话」= `/new`（缺省标题）。
- 点击后：校验 `operator.open_id` 在白名单 → 切换/新建 → 返回 toast → **原地更新卡片**为最新列表。
- 与审批卡共用 `card.action.trigger` 链路，靠按钮 value 路由（会话卡 `{cmd}` / 审批卡 `{t,d}`）。
- 回调必须 **3 秒内**返回：校验同步完成，`create/switch/patch` 全部 fire-and-forget。

### 持久化与迁移

| key | 结构 | 说明 |
| --- | --- | --- |
| `feishu:v2:chat:<chatId>:sessions` | `{ sessions: [{sessionID,title,updatedAt}], active? }` | **新**多会话结构 |
| `feishu:v2:chat:<chatId>` | `{ sessionID, openId }` | **旧**单值，仅向后兼容读取；读到即迁移到新结构并删除 |
| `feishu:v2:session:<sid>` | `{ chatId, openId }` | 不变；权限路由（`resolveBySession`/`hasSession`）依赖它 |

> 迁移是无损的：旧记录会变成新结构的第一个会话并设为当前，同时补齐 `session:<sid>` 索引。

### 进程级幂等

opencode 会按 location 多次加载全局插件，导致同一进程内 `setup` 被调用多次（起两个长连接 → 重复回复/重复发卡）。
插件用模块级 `SetupGuard` 保证**同一进程只真正启动一次** gateway/事件订阅：
第二次 setup 只打一条 debug 日志并返回 no-op cleanup，**不会**影响第一个实例的资源；第一个实例的 cleanup 仍能正常关闭并在之后允许重新 setup。

---

## 六、卡片交互（回执 / 原生排队 / 工具可见 / 流式）

收到私聊文本后，插件**先**发一张「运行卡片」再发起 prompt；随后所有事件都回填到这张卡上。

```
你：帮我看看这个 bug

🤖 OpenCode            （蓝色 = 运行中 / 绿色 = 完成 / 红色 = 失败）
已收到，思考中…
🧰 正在调用工具…
  ▸ 🔧 bash — npm test
  ▸ ✅ read — /home/me/app.ts
✍️ 正在输出…
```

| 能力 | 行为 |
| --- | --- |
| 立即回执 | 收到消息**先**发卡（`已收到，思考中…` / `已排队`），再 `session.prompt`，避免「无反馈」 |
| 原生排队 | 该 session 有正在跑的 execution（`session.execution.started` 置位，`succeeded/failed` 清除）→ `delivery:"queue"` + 卡片显示「已排队」；空闲则 `delivery:"steer"` |
| 工具可见 | `session.tool.input.started` 加工具块（🔧 名称，running）；`input.ended` 附输入（截断）；`tool.success` 标 ✅ + 结果首行；`tool.error` 标 ❌ 红框 |
| 工具折叠 | 连续工具 ≥ 3 折叠为一个摘要面板（**只留名称行**，防 30KB 超限），运行中最新一个展开、历史折叠；终态整体折叠 |
| 流式回复 | `text.started/delta/ended` 增量更新正文块，卡片 patch 节流 ≥ 400ms |
| 状态页脚 | 思考中 / 正在调用工具 / 正在输出 / 已排队，随事件切换；`execution.succeeded` 收尾（清页脚、卡片转绿） |
| 失败收尾 | `execution.failed` 清页脚、卡片转红并附错误摘要，同时补发一条文本提示 |

### 去重（跨实例）

插件会被实例化两次（独立 VM context，进程内单例无效），飞书可能重复投递；因此按 `messageId` 去重：

| key | 值 | TTL |
| --- | --- | --- |
| `feishu:v2:msg:<messageId>` | `{ at: <ms> }` | 10 分钟 |

- 同实例走内存快路径；跨实例用共享 `ctx.storage` 兜底，命中即打 debug 日志并丢弃。
- ⚠️ **已知限制**：`get-then-set` **非原子**，极端并发（两实例几乎同时处理同一消息）下可能双处理（storage 无 CAS）；单实例顺序执行不受影响。

### 状态与实现（纯函数，可单测）

- `src/feishu/run-state.ts` — **纯 reducer**：文本块 / 工具块 / 页脚 / 终态，按 `assistantMessageID` 区分 step。
- `src/feishu/run-renderer.ts` — 卡片 JSON 2.0 渲染 + 工具折叠 + 体积保护（超 30KB 时逐级截断、必要时丢弃最旧元素）。
- `src/feishu/run-controller.ts` — 回执卡发送、per-session active/queued 卡片、节流 patch、终态强制 flush。
- `src/feishu/dedup.ts` / `src/feishu/delivery.ts` — messageId 去重 与 排队决策 / 执行态跟踪。

---

## 七、故障排查

| 现象 | 可能原因 / 处理 |
| --- | --- |
| 日志出现「飞书插件未启用」 | `appId`/`appSecret` 缺失或 `{env:...}` 未解析；检查 `plugins/feishu.json` 与 **opencode 服务进程**内的环境变量 |
| 改了 `feishu.json` 不生效 | 配置目录取 `OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`；确认文件位于 `<configDir>/plugins/feishu.json`，改完执行 `opencode reload` |
| 日志出现「不是合法 JSON / 顶层必须是 JSON 对象」 | 配置文件格式有误，插件会**忽略该文件并退回环境变量**（不会崩溃）；修正 JSON 后 reload |
| 把本地路径写进 `opencode.json` 的 `plugins` 数组没反应 | 该写法无效；写成包名会触发 npm install（私有包 404）。请把插件放进 `plugins/<name>/` 目录 |
| 飞书发消息机器人无反应 | ① 应用未发布 / 可用范围没勾选你；② 事件订阅误选 Webhook 而非长连接；③ `im.message.p2p_msg:readonly` 未开通 |
| 只有单聊可用是预期的吗 | 是。**故意不申请群权限**，机器人收不到群消息 |
| 审批卡收不到 | 该 session 不是从飞书发起的（无 chat↔session 映射），插件按安全设计不降级为 ask |
| 点了按钮没反应 / 提示凭证无效 | token 过期（默认 10 分钟）；或点击者不在 `allowUsers` |
| 回复卡片不更新 | `stream: false`；或日志里 `运行卡片更新失败`（检查 `im:message:send_as_bot` 是否开通） |
| 卡片内容被截断 | 飞书卡片上限 ~30KB，插件截断到 28KB 并标注「已截断」；极端超长时会丢弃卡片上最旧的块 |
| 卡片一直显示「已排队」 | 当前 execution 尚未结束，或服务端未发出下一次 `session.execution.started`；可用 `/stop` 中断后重试 |
| 同一条消息被处理两次 | 去重为 `get-then-set` 非原子，极端并发下可能双处理；日志搜 `忽略重复消息` 确认去重是否命中 |
| 想临时关闭审批 | 把 `permissionGate` 设为 `off` |
| `/sessions`、`/use` 等命令没反应 | 命令仅识别**以 `/` 开头的单聊文本**；确认是 p2p 且发送者在白名单内。未知命令会回帮助提示 |
| 切换会话后再发消息仍进旧会话 | `/use` 成功会回执「已切换」；也可用 `/current` 复核。切换只改变当前会话，历史消息不受影响 |
| 重复回复 / 重复发卡 | 旧版本因 opencode 多次 setup 起了两个长连接；现已用进程级 `SetupGuard` 修复（debug 日志「检测到同进程重复 setup」） |
| 想看详细日志 | 把 `logLevel` 设为 `debug`（日志只打 secret 存在性，绝不含明文） |

---

## 八、安全边界（三重保险）

1. **平台层**：应用可用范围 = 仅本人，其他人无法与机器人建立单聊。
2. **scope 层**：只申请 p2p 读权限，不申请任何群权限，群消息物理收不到。
3. **代码层**：`allowUsers` / owner 白名单之外的 `sender.open_id` **静默忽略**；审批点击同样校验白名单 + 自签 token。

另有两条工程红线：**不监听端口**（纯长连接）、**不打印密钥**（日志只记录存在性）。

---

## 九、开发

```bash
npm install
npm run typecheck   # tsc --noEmit（含 test/）
npm run build       # tsup → dist/
npm test            # vitest run（纯逻辑单测，不连真飞书）
npm run dev         # tsup --watch
```

目录结构：

```
src/
  index.ts              # Plugin.define，装配所有部件 + 进程级幂等守卫
  config.ts             # 配置解析/校验（options > plugins/feishu.json > 环境变量，永不抛异常）
  lifecycle.ts          # SetupGuard：同进程 setup 只真正启动一次
  permission.ts         # permission.evaluate 策略 + 审批卡闭环 + reply
  session-commands.ts   # 会话命令编排（文本命令 + 会话卡片按钮）
  logger.ts             # 结构化 stderr 日志（secret 脱敏）
  types.ts
  security/
    token.ts            # 审批 token 签名/校验/防重放
    allowlist.ts        # 单人白名单 + owner 引导
  feishu/
    gateway.ts          # WSClient 长连接 + EventDispatcher
    events.ts           # 飞书事件 → 归一化模型（纯函数）
    cards.ts            # 审批卡 / 流式卡 / 结果卡构建（纯函数）
    session-cards.ts    # 会话列表卡片构建 + 按钮 value 解析（纯函数）
    commands.ts         # 会话命令解析 / 匹配 / 文案（纯函数）
    sender.ts           # im.message.create/patch/delete 薄封装
    session-map.ts      # chat ↔ 多会话映射（ctx.storage 持久化 + 旧格式迁移）
    run-state.ts        # 运行卡片纯 reducer（文本/工具/页脚/终态）
    run-renderer.ts     # 运行卡片 JSON 2.0 渲染 + 工具折叠 + 体积保护（纯函数）
    run-controller.ts   # 回执卡 + per-session active/queued + 节流 patch
    dedup.ts            # messageId 跨实例去重（ctx.storage + 内存快路径）
    delivery.ts         # 排队决策 + execution 态跟踪
    streaming.ts        # [deprecated] 早期独立流式卡片（已由 run-* 取代，保留单测参考）
  test/                   # vitest 纯逻辑单测
```

---

## 十、已知限制（P0 范围外）

- 只处理**单聊文本**（含富文本 post）；图片/文件/音视频只给出文字占位描述，不下载。
- 会话管理提供 `/new` `/sessions` `/use` `/current` `/stop`；`removeSession` / `renameSession` API 已就绪但暂无对应命令。
- 只处理从飞书发起的会话的审批；TUI 会话不接管（避免挂起）。
- 未做「问答卡 / question」审批，仅 `permission`。
- 未申请群相关能力，故不支持群聊（未来按 `APP_MODE_SCOPES.md` 的 T1–T6 逐档扩展）。
- **messageId 去重非原子**：`ctx.storage` 无 CAS，两个实例极端并发处理同一条消息时理论上可能双处理（详见「六、卡片交互」）。
- 排队卡片依赖 `session.execution.started` 晋升；若服务端在排队任务开始时未发出该事件，卡片会停留在「已排队」（可用 `/stop` 或重新发消息兜底）。
- 运行卡片体积保护会**丢弃最旧**的 body 元素（保证 ≤30KB），超长会话早期内容可能不出现在卡片上；完整内容仍在日志/会话里。

## 许可证

MIT

### 关于「插件被 setup 两次」

opencode 会按 location 加载全局插件，同一服务器进程内会出现**多个独立 VM context**（实测 `process` 与 `globalThis` 都不共享），因此进程内单例（含 `globalThis` 槽位）无法阻止第二份 setup，会出现两个飞书长连接。

实测影响：**飞书把事件只投递给其中一个连接**，观察到的 `收到飞书消息` 只有一条，未出现重复回复/重复发卡。故保留这一现象但不再尝试强行消除；如后续确需单实例，需要从 opencode 侧的插件加载方式入手。
