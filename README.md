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
| 🧵 **原生排队** | 会话忙时自动排队（OpenCode 原生 `delivery:"queue"`），不丢消息 |
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

### 1. 安装插件

**方式 A：npm（推荐）**

```bash
cd ~/.config/opencode
npm init -y                       # 若尚无 package.json
npm install opencode-feishu-plugin
```

**方式 B：本地构建**

```bash
git clone https://github.com/moyuanhua/opencode-feishu-plugin.git
cd opencode-feishu-plugin && npm install && npm run build
```

> 构建产物 `dist/index.js` **已自包含**飞书 SDK 等依赖，运行时不需要额外 `node_modules`。

### 2. 让 OpenCode 加载插件

OpenCode 会**自动加载 `<configDir>/plugins/<任意名>/` 下的插件目录**。
把插件放进该目录，**不要**在 `opencode.json` 的 `plugins` 数组里写本地路径（实测无效；写包名会触发 npm install，私有包会 404）。

```bash
# npm 方式
mkdir -p ~/.config/opencode/plugins/feishu
cp -r ~/.config/opencode/node_modules/opencode-feishu-plugin/{dist,package.json} \
      ~/.config/opencode/plugins/feishu/

# 本地构建方式同理，把 dist 与 package.json 拷进 plugins/feishu/
```

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
| `/sessions`（`/ls`） | 会话列表卡片（切换 / 新建） |
| `/use <序号\|id前缀>` | 切换当前会话 |
| `/current` | 查看当前会话 |
| `/stop` | 中断当前会话正在跑的任务 |
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
| `/current` `/stop` `/help` | 同主聊天流，作用于本话题会话 |

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

### 四档权限预设

| 档位 | 含义 | 会话级规则 |
|---|---|---|
| 🔒 只读 | 只看不改，最安全 | 禁止 `edit` / `shell` |
| ✏️ 可编辑 | 改文件免审批，**跑命令要问** | 允许 `edit`，`shell` 转审批 |
| ⚠️ 高风险审批 | 改文件 / 跑命令 / 越目录都问 | 高风险动作逐次审批 |
| 🔓 完全信任 | 什么都不问 | 全部放行 |

档位写入**会话级** `permissions`，可在话题内用 `/perm` 随时改，不影响其它会话。

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
| `recentDirsLimit` | number | `5` | 「最近使用目录」条数（1–20） |
| `recentModelsLimit` | number | `5` | 「最近使用模型」条数（1–20） |
| `logLevel` | `debug`\|`info`\|`warn`\|`error` | `info` | 日志级别（只记 secret 存在性，绝不含明文） |
| `logFile` | string \| boolean | — | `true` = 写 `<configDir>/plugins/feishu.log`；或指定路径。**服务模式下插件 stderr 会被丢弃，排查问题请开它** |
| `gatewayLocation` | string | — | 只在该 location 启动网关。OpenCode 会按 location 多次加载全局插件（独立 VM context，无法用进程内单例收敛）；**强烈建议设为你常用的工作目录**，否则会出现多个长连接 |
| `approvalTtlMs` | number | `600000` | 审批 token / 卡片有效期 |
| `maxResourcesShown` | number | `8` | 审批卡最多展示的资源行数 |

---

## 五、安全设计

```
permission.evaluate (插件 hook)                 permission.asked (事件流)
──────────────────────────                      ──────────────────────
白名单工具      → allow                          事件带 {id, sessionID, action, resources, save}
拒绝名单        → deny                                     │
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
- **只对飞书来源的会话生效**：没有 chat↔session 映射的会话（例如你本地 TUI）**不会被降级为 ask**，否则会因为没有审批出口而永久挂起。
- **三重单人边界**：平台可用范围「仅本人」+ 不申请群权限 + 代码层 open_id 白名单静默忽略。
- **`always` 语义**：仅当请求带 `save[]` 时才持久化，否则等价于「允许一次」（卡片会提示）。

---

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 发消息没反应 | ① 应用是否**已发布**、可用范围是否勾了你；② 事件/回调订阅是否选了**长连接**（不是 Webhook）；③ 是否开通 `im:message.p2p_msg:readonly` |
| 改了 `feishu.json` 不生效 | 确认路径是 `<configDir>/plugins/feishu.json`，然后 `opencode reload` |
| 改了插件代码不生效 | `opencode reload` **只重跑 `setup`，不会重新 import 模块**。升级插件要换 `plugins/` 下的目录名，或重启服务（`opencode service restart`） |
| 出现多个长连接 / 重复回复 | 设置 `gatewayLocation` 为你常用的工作目录（OpenCode 按 location 多次加载全局插件） |
| 审批卡收不到 | 该会话不是从飞书发起的（无映射）；插件按安全设计不接管 |
| 点按钮提示凭证无效 | token 过期（默认 10 分钟）或点击者不在白名单 |
| 卡片内容被截断 | 飞书卡片上限约 30KB，插件截断并标注；超长会话会丢弃卡片上最旧的块（完整内容仍在会话里） |
| 表单卡提交没反应 / 报错 | 客户端过旧（`select_static` 需 ≥ V3.7.0）；或该卡已失效（表单被消费/取消）——重新发 `/form` 或 `/new` 打开新表单 |
| 表单提交后没建会话 | 目录越出白名单 / 命中系统目录时会回错误卡且**不建会话**，按提示改目录再提交；留空或不存在的允许范围内目录会自动创建，不会因此失败 |
| 建会话后没看到话题 | 自动开话题失败时表单卡会改写为「✅ 已创建 · …」并附手动创建话题指引；可在 `/sessions` 会话卡上手动「创建话题」 |
| 看不到插件日志 | 服务模式下插件 stderr 会被丢弃；设 `logFile: true`，然后看 `<configDir>/plugins/feishu.log` |
| 主聊天流发消息只回提示卡 | 预期行为：主聊天流只做管理。用 `/new` 进话题；想恢复旧行为设 `threadRouting: false` |

---

## 七、开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/（自包含 bundle）
npm test            # vitest（纯逻辑单测，不连真飞书）
npm run dev         # tsup --watch
```

**架构**：`src/index.ts` 装配所有部件；飞书交互层在 `src/feishu/`（事件解析、卡片构建、话题路由、向导状态机、流式卡片 reducer 等，**以纯函数为主便于单测**）；安全层在 `src/security/`（token 签名、白名单）。

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
- 建会话只有一条主路径：**`/new` 与 `/form` 等价的表单卡**；`/dir` `/model` `/perm` 仅用于给表单预填字段。旧的目录/模型/权限/确认分步卡已从 `/new` 下线（相关构建函数与兼容回调保留，标注 deprecated）。
- 表单为 JSON 2.0（`form` 置于 `body.elements` 根节点，交互组件 `name` 全局唯一，提交按钮带 `form_action_type:"submit"`）；部分老客户端对 `select_static` 有最低版本要求（≥ V3.7.0）。

- **话题首条消息可能不带 `thread_id`**：飞书有时在事件里省略 `thread_id`（随后才归属到话题）。若此时你敲了 `/new` 这类仅限主聊天流的命令，它会被当作主聊天流命令执行（例如表单卡发到主聊天流）。遇到这种情况，直接进话题重新发普通消息即可。

## 许可证

MIT
