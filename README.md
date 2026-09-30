# opencode-feishu-plugin

[English](./README.en.md) | **简体中文**

把 [OpenCode](https://opencode.ai) 接进飞书：**一个飞书话题 = 一个 OpenCode 会话**，权限审批直接在飞书卡片上点按钮。

- 只支持 OpenCode **V2**（`@opencode/plugin`，`Plugin.define`），不依赖任何 V1 包。
- **纯长连接**（WebSocket）收发事件与卡片回调：不监听端口、不需要公网地址。

## 效果预览

![飞书话题内的完整会话：工具调用、权限审批卡与强制停止](image/image.png)

## 亮点

| | 说明 |
|---|---|
| 🔐 **最小权限** | 只要 2 个 scope，不申请任何群权限，机器人物理上收不到群消息 |
| 💬 **话题 = 会话** | 一个飞书话题对应一个 OpenCode 会话；主聊天流只做管理，互不串台 |
| 🚀 **一键建会话** | `/new` 一张表单（目录 + 模型 + 权限档位）一次填完，提交即建会话并自动开话题 |
| ✅ **卡片审批** | 权限请求变飞书卡片：允许一次 / 始终允许 / 本会话内允许 / 拒绝，自签 token 防伪防重放 |
| 📊 **实时可见** | 「思考中」回执 → 工具调用实时上卡 → 文本流式更新，页脚显示当前模型 |
| ⏹ **可控可停** | 每张回复卡带「强制停止」；看门狗自动中断卡死会话；忙时原生排队，`/steer` `/now` 可插队 |
| 🚫 **无端口** | 全程长连接，服务器无需开放任何入站端口 |

## 一、飞书后台配置（约 3 分钟）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**。
2. **添加应用能力 → 机器人**。
3. **权限管理**，只开通这两个 scope：
   - `im:message.p2p_msg:readonly` —— 读取用户发给机器人的单聊消息
   - `im:message:send_as_bot` —— 以应用身份发消息（也用于更新卡片）
4. **事件与回调 → 事件配置**：订阅方式选**「使用长连接接收事件」**（不要选 Webhook），添加事件 `im.message.receive_v1`。
5. **事件与回调 → 回调配置**：订阅方式同样选**长连接**，添加回调 `card.action.trigger`（零权限要求）。
6. **版本管理与发布**：可用范围 = **仅本人**，创建版本并**发布**。⚠️ 不发布就是开发态，长连接连不上，机器人不会有任何反应。
7. 记下 **App ID**（`cli_…`）与 **App Secret**。

> **为什么不申请群权限？** 本插件是"一个人的遥控台"。不申请群权限，机器人**物理上收不到群消息**，单人边界由平台 scope 层保证，而不是只靠代码判断。

## 二、安装

### 1. 安装插件

```bash
# 方式 A：CLI（推荐）
opencode plugin add opencode-feishu-plugin
```

```jsonc
// 方式 B：手写配置（追加到已有 plugins 数组，别覆盖整个文件）
{ "plugins": ["opencode-feishu-plugin"] }
```

插件入口是**自包含**的 `dist/index.js`（已打包飞书 SDK），运行时无需手动 `npm install`。

### 2. 写配置

新建 `~/.config/opencode/plugins/feishu.json`（`configDir` = `OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`）：

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

- 凭证**优先级**：`plugins[].options` > `feishu.json` > 环境变量。也可在值里用 `{env:NAME}` / `${NAME}` 占位符从环境变量取值。
- `logFile: true` **建议开启**：服务模式下 stderr 会被丢弃，开着才有日志可查。

### 3. 生效与验证

```bash
opencode reload
tail -f ~/.config/opencode/plugins/feishu.log   # 应看到「飞书长连接已启动（WSClient）」
```

然后在飞书里给机器人发一条消息。**第一次发消息的人会被自动绑定为 owner**，机器人回复卡片即安装成功；之后其他人会被静默忽略。

> 升级插件或改用全局插件目录加载后，需要 `opencode service restart` 才会重新 import。

## 三、快速上手

### 主聊天流（管理台）

主聊天流**只做管理**，普通文本不会进入任何会话。

| 命令 | 作用 |
|---|---|
| `/new [标题]` | 发建会话表单，提交即建会话并自动开话题（与 `/form` 等价） |
| `/sessions`（`/ls`） | **全部**会话列表（含本机所有 opencode 会话），可翻页、进话题、新建 |
| `/resume [序号]` | 对最近（或列表第 N 个）会话发恢复卡，**回复该卡**即续聊 |
| `/current`、`/stop` | 查看当前会话 / 中断当前任务 |
| `/steer <文本>`、`/now` | 立即插队发消息 / 把排队消息改为立即执行 |
| `/dir`、`/model`、`/perm` | 为建会话表单**预填**工作目录 / 模型 / 权限档位 |
| `/cancel`、`/help` | 放弃未提交的表单 / 命令列表 |

![建会话表单卡：目录、模型、权限一次填完](image/new.png)  ![会话列表卡片：翻页、进入/再开、新建](image/sessions.png)

### 话题内（干活）

一个话题 = 一个会话，发普通文本就是给 AI 下指令。

| 命令 | 作用 |
|---|---|
| `/model` | 切换本会话模型（只影响后续回复） |
| `/perm` | 修改本会话权限档位 |
| `/cd <路径>` | 迁移本会话工作目录 |
| `/steer <文本>`、`/now` | 插队 / 立即执行排队消息 |
| `/current`、`/stop`、`/help` | 同主聊天流，作用于本话题会话 |

### 权限档位

| 档位 | 含义 |
|---|---|
| 🔒 **只读** | 只看不改（禁止 `edit` / `shell`） |
| ✏️ **可编辑** | 改文件免审批，跑命令要问 |
| ⚠️ **高风险审批** | 改文件 / 跑命令 / 越目录都逐次审批 |
| 🔓 **完全信任** | 什么都不问 |

权限请求会变成审批卡：`✅ 允许一次` / `🔓 始终允许` / `✅ 本会话内允许该工具` / `❌ 拒绝`。换档（`/perm`）会清除本会话「本会话内允许」授权。

### 表单提问（`question` 工具）

agent 反问时表单会变成飞书卡片，**点按钮或在话题里直接发文字**都能作答，作答后卡片自动撤回。纯选项题直接回序号 / 字母即可；若发的是其它内容，会当作普通消息交给 AI。

## 四、配置项（常用）

`<configDir>/plugins/feishu.json`（或 OpenCode `plugins[].options`），支持 `{env:NAME}` / `${NAME}` 展开。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | string | — | 飞书 App ID（**必填**，缺失则禁用插件） |
| `appSecret` | string | — | 飞书 App Secret（**必填**，永不写入日志） |
| `domain` | `feishu`\|`lark` | `feishu` | 飞书 / Lark 国际版 |
| `allowUsers` | string[] | `[]` | open_id 白名单；空 = 仅 owner |
| `permissionGate` | `off`\|`notify`\|`gate`\|`lockdown` | `gate` | 全局审批门档位 |
| `allowTools` | string[] | `["read","glob","grep","webfetch"]` | 免审批白名单，支持 `prefix*` |
| `denyTools` | string[] | `[]` | 强制拒绝（优先于白名单） |
| `allowedRoots` | string[] | `[用户家目录]` | 允许的工作目录根；越界 / 系统目录拒绝 |
| `stream` | boolean | `true` | 流式回填回复 |
| `threadRouting` | boolean | `true` | 话题路由总开关 |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | 日志级别 |
| `logFile` | string \| boolean | — | `true` = 写 `<configDir>/plugins/feishu.log`，服务模式建议开启 |
| `approvalTtlMs` | number | `600000` | 审批 token / 卡片有效期 |
| `staleExecutionMs` | number | `300000` | 看门狗阈值（1–60 分钟） |
| `gatewayLocation` | string | — | 只在该 location（及其子目录）启动网关；留空 = 任意 location 生效 |

完整配置（含 `cardMaxTables`、`topicStatus*`、`resumeSummary*`、`keepalive*`、`gatewayMatchGraceMs` 等进阶项）见 [docs/advanced.md](./docs/advanced.md#完整配置项)。

## 五、故障排查

| 现象 | 处理 |
|---|---|
| 发消息没反应 | ① 应用是否**已发布**、可用范围是否勾了你；② 订阅是否选了**长连接**（不是 Webhook）；③ 是否开通 `im:message.p2p_msg:readonly` |
| 改了 `feishu.json` 不生效 | 确认路径，然后 `opencode reload` |
| 插件完全没被加载 | npm 方式确认包名在 `plugins` 数组；目录方式确认 `plugins/<名>/index.js` 存在 |
| 审批卡收不到 | 该会话不是从飞书发起的（无映射），插件按设计不接管 |
| 点按钮提示凭证无效 | token 过期（默认 10 分钟）或点击者不在白名单 |
| 会话像卡死、只排队 | 看门狗默认 5 分钟后自动中断；也可点「⏹ 强制停止」或发 `/stop` |
| 空闲约 1 小时后失联 | opencode 会回收空闲 location；内置保活默认开启会自动恢复，见 [docs/advanced.md](./docs/advanced.md#位置保活) |
| 看不到插件日志 | 服务模式下 stderr 被丢弃，设 `logFile: true` |
| 多个长连接 / 重复回复 | 设置 `gatewayLocation` 为常用工作目录，见 [docs/advanced.md](./docs/advanced.md#多实例与网关选举) |

## 六、已知限制

- 只处理**单聊文本**（含富文本）；图片 / 文件 / 音视频只给文字占位，不下载。
- 只接管**从飞书发起的会话**的审批；本地 TUI 会话不受影响。
- 建会话只有一条主路径：`/new` 与 `/form` 等价的表单卡。
- 表单为 JSON 2.0，老客户端对 `select_static` 有最低版本要求（≥ V3.7.0）。
- 话题首条消息可能不带 `thread_id`：插件会靠 `root_id` 兜底路由；新话题敲命令落到主聊天流时，直接进话题发消息即可。
- 生态里另有 `opencode-feishu`（V1 插件），与本插件不兼容、不共用代码。

## 七、下一步规划（Roadmap）

按真实使用反馈迭代，当前规划：

- [ ] **接收图片 / 文件**：目前只处理单聊文本，图片 / 文件仅显示文字占位。规划：下载图片 / 文件并作为**附件挂进会话**，让支持视觉 / 文件的模型直接看图、读文件内容。
- [ ] **忙时新消息默认插队**：目前会话忙时新消息默认排队（可用 `/steer`、`/now` 手动插队）。规划：忙时你发的新消息**默认直接插队**，立即打断当前步骤优先执行。

## 高级主题与开发

安全设计、位置保活、卡片守卫、会话恢复、多实例网关选举、完整配置项与开发架构见 [docs/advanced.md](./docs/advanced.md)。

## 许可证

MIT