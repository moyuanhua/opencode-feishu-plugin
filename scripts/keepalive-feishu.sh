#!/usr/bin/env bash
# opencode-feishu 位置保活（外部兜底）。
#
# 背景：opencode 对每个 location 有 **60 分钟** 的空闲回收（硬编码，无配置项）：
#   - LayerMap idleTimeToLive 由「会话级请求」续期；
#   - @opencode/LocationActivity 由「带 location 的 durable 事件」续期；
# 两者到期都会卸载 location 服务 → 飞书插件被 dispose → 长连接关闭 → 机器人沉默。
# 插件内置保活（默认 20 分钟）只能维持「插件还活着」的场景；服务重启 / 长时间休眠 /
# 已被回收后，插件无法自救。本脚本作为**外部唤起器**：
#   对目标目录里的任一会话发一次「会话级 GET」→ locations.get() 续期，必要时重建 location。
#
# 用法（crontab 每 15 分钟）：
#   */15 * * * * $HOME/.config/opencode/keepalive-feishu.sh
#
# 环境变量：
#   OPENCODE_KEEPALIVE_DIR   要保活的目录（默认 $HOME）
#   OPENCODE_KEEPALIVE_LOG   日志文件（默认 $HOME/.config/opencode/keepalive.log）
#   OPENCODE_KEEPALIVE_PROBE 非空时额外创建+删除一个探针会话（续期 LocationActivity）
set -u

DIR="${OPENCODE_KEEPALIVE_DIR:-$HOME}"
LOG="${OPENCODE_KEEPALIVE_LOG:-$HOME/.config/opencode/keepalive.log}"
PROBE="${OPENCODE_KEEPALIVE_PROBE:-}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

python3 - "$DIR" "$PROBE" <<'PY'
import base64, json, os, sys, time, urllib.error, urllib.parse, urllib.request

directory, probe = sys.argv[1], bool(sys.argv[2])
state = os.path.join(os.environ.get("XDG_STATE_HOME", os.path.join(os.path.expanduser("~"), ".local", "state")), "opencode", "service.json")
try:
    svc = json.load(open(state))
except Exception as exc:  # noqa: BLE001
    print(f"[{time.strftime('%FT%T')}] keepalive: cannot read service.json: {exc!r}")
    sys.exit(0)

url = svc["url"].rstrip("/")
headers = {"content-type": "application/json"}
if svc.get("password"):
    headers["authorization"] = "Basic " + base64.b64encode(f"opencode:{svc['password']}".encode()).decode()

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + path, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, ""
    except Exception as exc:  # noqa: BLE001
        return -1, repr(exc)[:120]

q = urllib.parse.urlencode({"directory": directory, "limit": 1, "parentID": "null"})
status, body = call("GET", "/api/session?" + q)
session_id = ""
try:
    session_id = json.loads(body)["data"][0]["id"]
except Exception:  # noqa: BLE001
    pass

touched = ""
if session_id:
    get_status, _ = call("GET", "/api/session/" + urllib.parse.quote(session_id))
    touched = f"session GET {get_status}"
else:
    touched = f"no session in {directory} (list {status})"

probe_note = ""
if probe:
    create_status, created = call("POST", "/api/session", {"title": "__keepalive_cron__", "location": {"directory": directory}})
    probe_id = ""
    try:
        probe_id = json.loads(created)["data"]["id"]
    except Exception:  # noqa: BLE001
        pass
    if probe_id:
        call("DELETE", "/api/session/" + urllib.parse.quote(probe_id))
    probe_note = f", probe {create_status}"

print(f"[{time.strftime('%FT%T')}] keepalive dir={directory} {touched}{probe_note}")
PY
