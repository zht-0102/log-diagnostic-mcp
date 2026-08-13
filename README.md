# log-diagnostic-mcp

**服务器日志查询与基础诊断 MCP Server**（MVP）

一个只读的 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器：通过 SSH 在多台远程服务器上按关键词搜索应用日志（默认最近 30 分钟），并把命中行、上下文、请求入参、响应、MyBatis SQL、异常堆栈与三段式基础分析一起返回给 AI 客户端（Cursor / Claude / Codex 等任意标准 MCP 客户端）。

> **只读铁律**：本服务器不暴露任何任意 Shell 执行工具，远程命令仅由固定的只读模板（`tail` / `grep` / `ls`）生成，所有参数经过白名单校验与 shell 转义。绝不执行 `rm`、`mv`、`kill`、`docker`、`kubectl` 等任何状态变更命令。

---

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 关键词搜索 | 单/多服务器并发搜索，支持 `environment` 与 `serverNames` 过滤 |
| 时间范围 | 默认最近 30 分钟，可传 `startTime` / `endTime`（ISO 8601） |
| 上下文提取 | 每个命中行默认返回前 30 行 / 后 50 行（可配置） |
| 请求入参提取 | 识别 `Request:` / `Parameters:` / `RequestBody:` / `args:` 等标记，JSON 结构化 |
| 响应提取 | 识别 `Response:` / `Result:` / `Return:` 等标记，超长截断并标记 `responseTruncated` |
| MyBatis SQL 还原 | `Preparing:` + `Parameters:` 配对还原完整 SQL，失败时标记 `sqlReconstructionSuccess: false` |
| 异常提取 | 合并 `Exception` / `Caused by` 堆栈，输出 `type` / `message` / `rootCause` |
| 基础分析 | 严格三段式：**已确认事实 / 可能原因 / 建议检查**，仅基于已提取内容推断，绝不编造 |
| 敏感信息脱敏 | 出口统一把 `password` / `token` / `Authorization` / `Cookie` / `accessKey` / `secretKey` 等值替换为 `****` |

**明确不实现（MVP 范围外）**：TraceId 跨服务链路追踪、ELK/ES 查询、K8s/Docker 日志、日志写入或任何状态变更操作。

---

## 环境要求

- Node.js **>= 20**
- 可通过 SSH（私钥认证）访问的日志服务器
- 日志文件时间戳格式：`yyyy-MM-dd HH:mm:ss`（可带毫秒）或 ISO 8601；无法解析时间的行在时间过滤时保守保留

## 安装

```bash
git clone https://github.com/18303364826/log-diagnostic-mcp.git
cd log-diagnostic-mcp
npm install
npm run build        # 编译 TypeScript 到 dist/
```

## 配置

### 1. 服务器配置（config/servers.yaml）

```bash
cp config/servers.example.yaml config/servers.yaml
```

```yaml
limits:
  maxServers: 10                  # 每次查询最多搜索的服务器数
  maxLines: 3000                  # 每次查询返回的最大命中行数
  timeoutSeconds: 30              # 每条 SSH 命令的超时（秒）
  maxConcurrentConnections: 5     # 最大并行 SSH 连接数
  scanLines: 20000                # 每个日志文件只扫描尾部 N 行（不扫全量历史）

servers:
  - name: shipping-prod-01        # 服务器名（search_logs 可按名过滤）
    environment: prod             # 环境（search_logs 可按环境过滤）
    host: 192.168.1.10
    port: 22
    username: log-reader
    auth:
      type: private_key           # 推荐：私钥认证
      privateKeyPath: ${SSH_PRIVATE_KEY}   # 支持 ${ENV} 变量展开
    logPaths:                     # 日志目录（目录内 *.log 文件，最新优先，每目录最多 5 个）
      - /data/logs/shipping
```

配置在启动时经过 zod 严格校验：字段缺失、服务器重名、引用了未定义的环境变量都会**立即报错**，不会带病运行。

### 2. 环境变量（.env）

```bash
cp .env.example .env
```

```bash
SSH_PRIVATE_KEY=/home/you/.ssh/id_ed25519
SSH_PRIVATE_KEY_STAGING=/home/you/.ssh/id_ed25519_staging
# 可选：覆盖配置文件位置（默认 config/servers.yaml）
# LOG_MCP_CONFIG=/absolute/path/to/servers.yaml
```

> `.env` 与 `config/servers.yaml` 均已加入 `.gitignore`，**真实密钥永远不会进入版本库**。

## SSH 准备

建议使用**专用只读账号**：

1. 在日志服务器上创建账号（如 `log-reader`），仅授予日志目录的读权限；
2. 生成密钥对并把公钥加入该账号的 `authorized_keys`；
3. 私钥路径写入 `.env`（即上面的 `SSH_PRIVATE_KEY`）。

本服务器只会在远程执行三类命令：列目录（`ls -1t`）、读取尾部（`tail -n`）、过滤（`grep -n -F`）。

## 启动

```bash
npm start            # node dist/index.js（stdio 传输）
# 或开发模式：
npm run dev          # tsx src/index.ts
```

启动后 stdout 专用于 MCP 协议消息，日志只输出到 stderr。不要直接在终端与它对话，请通过 MCP 客户端接入（见下文「AI 客户端接入」）。

## 测试

```bash
npm test             # vitest 全量（解析器 / 防护 / 管道 / stdio 启动冒烟）
```

所有测试使用 fixtures / mock SSH，不依赖真实生产环境。

---

## Tool：`search_logs`

唯一的工具。**只有 `keyword` 必填**。

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 必填 | 搜索关键词（方法名、业务 ID 等）。仅允许字母、数字与 `_ . : @ # - / [ ] ( ) { } = + , * " ' \`，最长 200 字符 |
| `environment` | string | 全部环境 | 环境过滤，如 `prod` / `staging` |
| `serverNames` | string[] | 全部服务器 | 限定搜索的服务器名（需在配置中存在） |
| `startTime` | string | `endTime` 前 30 分钟 | ISO 8601，如 `2026-08-13T10:00:00+08:00` |
| `endTime` | string | 当前时间 | ISO 8601 |
| `contextBefore` | number | `30` | 每个命中行返回的前文行数（0–500） |
| `contextAfter` | number | `50` | 每个命中行返回的后文行数（0–500） |

### 调用示例

```json
{
  "keyword": "searchShippingOrderSummary",
  "environment": "prod",
  "startTime": "2026-08-13T09:30:00+08:00",
  "endTime": "2026-08-13T10:00:00+08:00"
}
```

### 返回结构

```jsonc
{
  "status": "success",
  "query": {
    "keyword": "searchShippingOrderSummary",
    "environment": "prod",
    "serverNames": null,
    "startTime": "2026-08-13T01:30:00.000Z",
    "endTime": "2026-08-13T02:00:00.000Z",
    "contextBefore": 30,
    "contextAfter": 50,
    "searchedServers": ["shipping-prod-01"],
    "skippedServers": ["shipping-staging-01"],
    "serverLimitTruncated": false
  },
  "matches": [
    {
      "server": "shipping-prod-01",
      "environment": "prod",
      "logFile": "/data/logs/shipping/app.log",
      "lineNumber": 8,                  // 扫描窗口内的行号（1 开始）
      "timestamp": "2026-08-13 09:41:02",
      "matchedLine": "... ERROR searchShippingOrderSummary failed",
      "contextBefore": ["..."],
      "contextAfter": ["..."]
    }
  ],
  "matchesTruncated": false,
  "requestParameters": [ /* 未检测到时为 null */ ],
  "response":          [ /* 未检测到时为 null */ ],
  "sql":               [ /* 含 preparingSql / reconstructedSql / sqlReconstructionSuccess */ ],
  "exceptions":        [ /* 含 type / message / rootCause / stackTrace */ ],
  "analysis": {
    "confirmedFacts":  ["..."],         // 已确认事实（绝不含推测）
    "possibleCauses":  ["Possibly: ..."],
    "recommendations": ["..."]
  },
  "notes": { "droppedByTime": 0, "missingContext": 0, "searchErrors": [] }
}
```

提取失败时的约定：`requestParameters` / `response` / `sql` / `exceptions` 为 `null`；SQL 无法可靠还原时 `sqlReconstructionSuccess: false` 并附 `reconstructionNote`。**任何环节都不编造数据**。

---

## 安全说明

1. **无 Shell 工具**：MCP 层面只注册了 `search_logs`，没有任何可执行任意命令的工具。
2. **三层注入防护**：关键词/路径白名单校验 → POSIX 单引号转义（shell-quote）→ 命令黑名单拦截（`rm`/`mv`/`kill`/`docker`/`kubectl` 等）。
3. **不扫全量历史**：只读取每个日志文件尾部 `scanLines` 行，每个目录最多扫最新 5 个 `.log` 文件。
4. **出口脱敏**：所有返回内容在序列化前统一经过敏感值掩码（`****`），覆盖 KV、引号 JSON、Bearer 头、浮动 JWT 四类形态。
5. **密钥不入库**：`.env`、`config/servers.yaml` 被 gitignore；配置中只允许出现 `${ENV}` 引用。
6. **限制兜底**：`maxServers` / `maxLines` / `timeoutSeconds` / `maxConcurrentConnections` 防止查询打爆服务器或 AI 上下文。

## FAQ

**Q：为什么搜不到很久以前的日志？**
A：MVP 只扫描每个文件的尾部 `scanLines`（默认 20000）行，且默认时间窗口为最近 30 分钟。历史全量检索不在 MVP 范围。

**Q：命中行号是文件绝对行号吗？**
A：不是，是扫描窗口（tail 窗口）内的行号，用于定位上下文。

**Q：日志没有时间戳会被过滤掉吗？**
A：不会。无法解析时间的行在时间过滤时保守保留，并在返回中 `timestamp: null`。

**Q：带时区的日志怎么处理？**
A：带时区（`Z` / `+08:00`）的时间戳按原时区比较；不带时区的按运行本服务器的机器时区解释。

**Q：配置错误会怎样？**
A：启动或调用时立即返回清晰错误信息（缺文件 / 缺环境变量 / 字段非法 / 服务器重名），不会静默降级。

**Q：支持密码认证吗？**
A：支持（`auth.type: password`），但生产环境强烈建议使用私钥 + 只读账号。

---

## AI 客户端接入

本服务器使用标准 **stdio** 传输，任何支持 MCP 的客户端都能接入。启动命令统一为：

```bash
node /绝对路径/log-diagnostic-mcp/dist/index.js
```

> 请先完成 `npm install && npm run build` 与 `config/servers.yaml` 配置。
> 客户端启动本服务器时的工作目录（cwd）决定了配置查找位置；
> 若不想依赖 cwd，请在 `env` 中设置 `LOG_MCP_CONFIG` 指向配置文件绝对路径。

以下配置格式以各客户端官方文档为准。

### Cursor

全局：`~/.cursor/mcp.json`；项目级：`<项目>/.cursor/mcp.json`。也可在 Settings → MCP 界面添加。

```json
{
  "mcpServers": {
    "log-diagnostic": {
      "command": "node",
      "args": ["/绝对路径/log-diagnostic-mcp/dist/index.js"],
      "env": {
        "LOG_MCP_CONFIG": "/绝对路径/log-diagnostic-mcp/config/servers.yaml"
      }
    }
  }
}
```

### Claude Desktop

配置文件位置：
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "log-diagnostic": {
      "command": "node",
      "args": ["/绝对路径/log-diagnostic-mcp/dist/index.js"],
      "env": {
        "LOG_MCP_CONFIG": "/绝对路径/log-diagnostic-mcp/config/servers.yaml"
      }
    }
  }
}
```

修改后完全退出并重启 Claude Desktop。

### Claude Code

命令行一键添加（scope 可选 `local` / `project` / `user`）：

```bash
claude mcp add log-diagnostic \
  --env LOG_MCP_CONFIG=/绝对路径/log-diagnostic-mcp/config/servers.yaml \
  -- node /绝对路径/log-diagnostic-mcp/dist/index.js
```

或在项目根目录手写 `.mcp.json`（团队共享，可提交到仓库——注意不要包含真实密钥）：

```json
{
  "mcpServers": {
    "log-diagnostic": {
      "command": "node",
      "args": ["/绝对路径/log-diagnostic-mcp/dist/index.js"],
      "env": {
        "LOG_MCP_CONFIG": "/绝对路径/log-diagnostic-mcp/config/servers.yaml"
      }
    }
  }
}
```

验证：`claude mcp list` 应显示 `log-diagnostic` 已连接。

### OpenAI Codex CLI

编辑 `~/.codex/config.toml`，顶层键为 `mcp_servers`：

```toml
[mcp_servers.log-diagnostic]
command = "node"
args = ["/绝对路径/log-diagnostic-mcp/dist/index.js"]

[mcp_servers.log-diagnostic.env]
LOG_MCP_CONFIG = "/绝对路径/log-diagnostic-mcp/config/servers.yaml"
```

### Windows 注意事项

部分客户端在 Windows 上无法直接执行 `node`，可改用 `cmd` 包装：

```json
{
  "command": "cmd",
  "args": ["/c", "node", "C:\\绝对路径\\log-diagnostic-mcp\\dist\\index.js"]
}
```

### 接入后如何验证

在客户端里问一句：

> 用 search_logs 查一下最近 30 分钟 prod 环境的 `searchShippingOrderSummary`

能返回带 `query / matches / analysis` 的 JSON 即接入成功。

## License

MIT
