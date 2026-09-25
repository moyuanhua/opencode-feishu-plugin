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

## 三、OpenCode 配置

在 `~/.config/opencode/opencode.json` 的 `plugins` 中加入（**对象形式**才能传 `options`）：

```jsonc
{
  "plugins": [
    {
      "package": "opencode-feishu-v2",
      "options": {
        "appId": "{env:FEISHU_APP_ID}",
        "appSecret": "{env:FEISHU_APP_SECRET}",
        "allowUsers": ["ou_你的open_id"],   // 空 = 仅应用 owner（首个发消息者绑定并持久化）
        "permissionGate": "gate",           // off | notify | gate | lockdown
        "allowTools": ["read", "glob", "grep", "webfetch"],
        "stream": true,
        "streamThrottleMs": 400
      }
    }
  ]
}
```

> `{env:FEISHU_APP_ID}` 由 OpenCode 在服务进程内解析。本插件也会兜底解析 `{env:NAME}` / `${NAME}`。
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

## 五、故障排查

| 现象 | 可能原因 / 处理 |
| --- | --- |
| 日志出现「飞书插件未启用」 | `appId`/`appSecret` 缺失或 `{env:...}` 未解析；检查环境变量是否在 **opencode 服务进程**内可见 |
| 飞书发消息机器人无反应 | ① 应用未发布 / 可用范围没勾选你；② 事件订阅误选 Webhook 而非长连接；③ `im.message.p2p_msg:readonly` 未开通 |
| 只有单聊可用是预期的吗 | 是。**故意不申请群权限**，机器人收不到群消息 |
| 审批卡收不到 | 该 session 不是从飞书发起的（无 chat↔session 映射），插件按安全设计不降级为 ask |
| 点了按钮没反应 / 提示凭证无效 | token 过期（默认 10 分钟）；或点击者不在 `allowUsers` |
| 回复卡片不更新 | `stream: false`；或日志里 `流式卡片更新失败`（检查 `im:message:send_as_bot` 是否开通） |
| 卡片内容被截断 | 飞书卡片上限 ~30KB，插件截断到 28KB 并标注「已截断」 |
| 想临时关闭审批 | 把 `permissionGate` 设为 `off` |
| 想看详细日志 | 把 `logLevel` 设为 `debug`（日志只打 secret 存在性，绝不含明文） |

---

## 六、安全边界（三重保险）

1. **平台层**：应用可用范围 = 仅本人，其他人无法与机器人建立单聊。
2. **scope 层**：只申请 p2p 读权限，不申请任何群权限，群消息物理收不到。
3. **代码层**：`allowUsers` / owner 白名单之外的 `sender.open_id` **静默忽略**；审批点击同样校验白名单 + 自签 token。

另有两条工程红线：**不监听端口**（纯长连接）、**不打印密钥**（日志只记录存在性）。

---

## 七、开发

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
  index.ts              # Plugin.define，装配所有部件
  config.ts             # 配置解析/校验（永不抛异常）
  permission.ts         # permission.evaluate 策略 + 审批卡闭环 + reply
  logger.ts             # 结构化 stderr 日志（secret 脱敏）
  types.ts
  security/
    token.ts            # 审批 token 签名/校验/防重放
    allowlist.ts        # 单人白名单 + owner 引导
  feishu/
    gateway.ts          # WSClient 长连接 + EventDispatcher
    events.ts           # 飞书事件 → 归一化模型（纯函数）
    cards.ts            # 审批卡 / 流式卡 / 结果卡构建（纯函数）
    sender.ts           # im.message.create/patch/delete 薄封装
    session-map.ts      # chat ↔ session 映射（ctx.storage 持久化）
    streaming.ts        # 流式卡片节流控制器
test/                   # vitest 纯逻辑单测
```

---

## 八、已知限制（P0 范围外）

- 只处理**单聊文本**（含富文本 post）；图片/文件/音视频只给出文字占位描述，不下载。
- 只处理从飞书发起的会话的审批；TUI 会话不接管（避免挂起）。
- 未做「问答卡 / question」审批，仅 `permission`。
- 未申请群相关能力，故不支持群聊（未来按 `APP_MODE_SCOPES.md` 的 T1–T6 逐档扩展）。

## 许可证

MIT
