# log-diagnostic-mcp

只读的服务器日志查询与诊断 MCP Server。它通过 SSH 在一台或多台服务器上搜索日志，并向 Codex Desktop、Codex CLI、Cursor、Claude Desktop 等标准 MCP 客户端返回：

- 命中日志及前后文
- 请求入参、响应、SQL 和异常堆栈
- SaaS 日志事件聚合与 trace 信息
- 报错类、方法、源码文件和行号
- 当前日志与历史 `.gz` 归档日志的实际查询来源
- 基于日志证据的原因分析和检查建议

本项目只注册一个 MCP 工具：`search_logs`。它不提供任意 Shell 执行能力，也不会修改远程服务器状态。

## 功能概览

| 能力 | 当前行为 |
| --- | --- |
| 普通日志查询 | `mode: "lines"`，按关键词返回匹配行及上下文 |
| SaaS 事件诊断 | `mode: "saas_event"`，按 traceId 或线程聚合事件，默认只查询 `saas.log` |
| 多服务器查询 | 支持按 `environment`、`serverNames` 筛选，并限制并发数和服务器数 |
| 时间范围 | 支持 ISO 8601 `startTime` / `endTime`；未传时默认最近 30 分钟 |
| 当前日志 | 使用 `tail -n ... | grep -n -F`，只扫描配置的尾部行数 |
| 历史归档 | 根据时间范围定位 `yyMMdd` 目录，读取 `<日志名>.<yyMMdd>*.gz` |
| 归档策略 | `auto`、`current_only`、`archive_only` |
| 诊断结果 | 返回 `diagnosticEvents`：报错位置、根因、入参、SQL、响应、上下文和堆栈 |
| 查询来源 | 返回 `searchedSources`：实际查询文件、当前/归档类型、命令类型和命中状态 |
| 通用解析 | 提取请求、响应、MyBatis SQL、异常并生成三段式基础分析 |
| 安全保护 | 输入白名单、Shell 参数转义、只读命令模板、出口敏感信息脱敏 |

## 环境要求

- Windows、Linux 或 macOS
- Node.js 20 或更高版本
- npm
- Git
- 能通过 SSH 访问日志服务器
- 远程服务器具备 `ls`、`tail`、`grep`、`gzip` 等常见只读命令

推荐为本工具创建专用的服务器只读账号，只授予目标日志目录的读取权限。

## 新用户首次安装

### 1. 检查本地环境

```powershell
node --version
npm --version
git --version
```

Node.js 版本必须为 20 或更高。

### 2. 获取工程并安装依赖

```powershell
git clone https://github.com/18303364826/log-diagnostic-mcp.git
cd log-diagnostic-mcp
npm install
```

### 3. 初始化服务器配置

PowerShell：

```powershell
Copy-Item config\servers.example.yaml config\servers.yaml
Copy-Item .env.example .env
```

Bash：

```bash
cp config/servers.example.yaml config/servers.yaml
cp .env.example .env
```

如果目标文件已经存在，不要覆盖。`config/servers.yaml` 和 `.env` 已被 `.gitignore` 忽略。

### 4. 填写服务器连接信息

编辑 `config/servers.yaml`。用户通常只需要填写：

- `name`：服务器唯一名称
- `environment`：环境名称，如 `prod`、`staging`
- `host`、`port`、`username`
- `auth`：私钥或密码认证
- `logPaths`：日志根目录，例如 `/home/logdir/log/saas-set01`

完整模板：

```yaml
limits:
  maxServers: 10
  maxLines: 3000
  timeoutSeconds: 30
  maxConcurrentConnections: 5
  scanLines: 20000

servers:
  - name: saas-prod-01
    environment: prod
    host: 192.168.1.10
    port: 22
    username: log-reader
    auth:
      type: private_key
      privateKeyPath: ${SSH_PRIVATE_KEY}
    logPaths:
      - /home/logdir/log/saas-set01

  - name: saas-staging-01
    environment: staging
    host: 192.168.2.10
    port: 22
    username: log-reader
    auth:
      type: password
      password: ${SSH_PASSWORD_STAGING}
    logPaths:
      - /home/logdir/log/saas-set01
```

配置限制：

| 字段 | 限制或默认值 |
| --- | --- |
| `limits.maxServers` | 1-100，默认 10 |
| `limits.maxLines` | 1-100000，默认 3000 |
| `limits.timeoutSeconds` | 1-300，默认 30 |
| `limits.maxConcurrentConnections` | 1-50，默认 5 |
| `limits.scanLines` | 100-1000000，默认 20000 |
| `servers` | 至少 1 台；服务器名称不能重复 |
| `logPaths` | 每台服务器 1-20 个 POSIX 绝对路径 |

### 5. 配置认证环境变量

编辑 `.env`：

```dotenv
SSH_PRIVATE_KEY=C:\Users\your-name\.ssh\id_ed25519
SSH_PASSWORD_STAGING=replace-with-your-password

# 可选：覆盖默认配置文件位置
# LOG_MCP_CONFIG=C:\absolute\path\log-diagnostic-mcp\config\servers.yaml
```

敏感信息必须放在 `.env` 或操作系统环境变量中。不要把真实密码、私钥内容、Token 或生产日志写入 README、Git 提交、Issue 或聊天消息。

### 6. 本地验证和构建

```powershell
npm test
npm run build
```

这些测试使用 mock SSH，不会连接真实生产服务器。安装阶段到此为止，不要自动执行 SSH 连通性测试或生产日志查询。

## 交给 AI Coding 工具自动安装

把下面的指令和本工程一起交给 AI Coding 工具。用户只需在 AI 初始化配置文件后填写真实服务器连接信息。

```text
请完整阅读本项目根目录 README.md，并按“新用户首次安装”执行。

执行边界：
1. 检查 Node.js 20+、npm 和 Git。
2. 安装依赖，但不要升级依赖版本。
3. config/servers.yaml 或 .env 不存在时，从 example 文件复制；存在时绝不覆盖。
4. 不读取、打印、提交或回显密码、私钥内容、Token 和真实日志。
5. 只生成服务器配置模板，缺少 host、username、logPaths 或认证信息时停止并提示用户填写。
6. 执行 npm test 和 npm run build。
7. 按 README 为当前 MCP 客户端生成 stdio 配置，所有工程路径使用绝对路径。
8. 安装阶段不得连接真实服务器，不得执行 search_logs。
9. 完成后只报告本地安装、构建和 MCP 配置状态，以及仍需用户填写的字段。
```

## 启动方式

生产/客户端方式：

```powershell
npm start
```

它执行 `node dist/index.js`，因此首次运行或修改 TypeScript 后必须先执行 `npm run build`。

开发方式：

```powershell
npm run dev
```

MCP 使用 stdio 传输。stdout 专用于 MCP 协议，不要直接在终端中与进程对话。

## 配置 Codex Desktop

Codex Desktop、Codex CLI 和 Codex IDE 扩展共享 `~/.codex/config.toml`。也可以在 Codex Desktop 的 MCP 设置界面中填写相同配置。

Windows 推荐配置：

```toml
[mcp_servers.log-diagnostic]
command = "cmd"
args = ["/c", "npm", "start"]
cwd = "C:\\absolute\\path\\log-diagnostic-mcp"
startup_timeout_sec = 120

[mcp_servers.log-diagnostic.env]
LOG_MCP_CONFIG = "C:\\absolute\\path\\log-diagnostic-mcp\\config\\servers.yaml"
```

说明：

- 将两个路径替换为工程和配置文件的真实绝对路径。
- `cwd` 保证 `npm start`、`.env` 和默认相对路径都从工程根目录解析。
- `LOG_MCP_CONFIG` 避免客户端工作目录变化导致找不到服务器配置。
- 保存后点击 MCP 的 Restart，或完全退出并重新启动 Codex Desktop。
- 不要把 `.env` 中的密码或私钥内容复制到 Codex 配置中。

也可以直接使用构建产物：

```toml
[mcp_servers.log-diagnostic]
command = "node"
args = ["C:\\absolute\\path\\log-diagnostic-mcp\\dist\\index.js"]
cwd = "C:\\absolute\\path\\log-diagnostic-mcp"

[mcp_servers.log-diagnostic.env]
LOG_MCP_CONFIG = "C:\\absolute\\path\\log-diagnostic-mcp\\config\\servers.yaml"
```

Codex MCP 配置参考：[OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp)。

### Codex 安装验证

1. 在 Codex 中确认工具列表存在 `search_logs`。
2. 先做当前日志测试，使用一个确认存在且不敏感的关键词。
3. 返回对象应包含 `query`、`matches`、`searchedSources` 和 `analysis`。
4. 使用 `mode: "saas_event"` 时还应包含 `saasEvents` 和 `diagnosticEvents`。
5. 使用明确历史时间范围时，`searchedSources` 应显示具体 `.gz` 路径和 `commandKind: "gzip_grep"`。

## 配置其他 stdio MCP 客户端

通用 JSON 配置：

```json
{
  "mcpServers": {
    "log-diagnostic": {
      "command": "node",
      "args": ["C:\\absolute\\path\\log-diagnostic-mcp\\dist\\index.js"],
      "cwd": "C:\\absolute\\path\\log-diagnostic-mcp",
      "env": {
        "LOG_MCP_CONFIG": "C:\\absolute\\path\\log-diagnostic-mcp\\config\\servers.yaml"
      }
    }
  }
}
```

不同客户端的配置文件位置和字段支持可能不同，应以对应客户端官方文档为准。修改配置后通常需要重启 MCP 进程或客户端。

## `search_logs` 参数

只有 `keyword` 必填。

| 参数 | 类型 | 默认值 | 限制与行为 |
| --- | --- | --- | --- |
| `keyword` | string | 必填 | 1-200 字符；按字面量匹配，不作为正则表达式 |
| `environment` | string | 全部 | 最长 50 字符，只查询对应环境 |
| `serverNames` | string[] | 全部 | 最多 20 个名称，每项最长 100 字符 |
| `startTime` | string | `endTime` 前 30 分钟 | ISO 8601，例如 `2026-08-12T03:40:00+08:00` |
| `endTime` | string | 当前时间 | ISO 8601；必须不早于 `startTime` |
| `contextBefore` | integer | 30 | 0-500 |
| `contextAfter` | integer | 50 | 0-500 |
| `mode` | enum | `lines` | `lines` 或 `saas_event` |
| `logFileName` | string | 见下文 | 最长 100；只允许字母、数字、`_`、`.`、`-` |
| `archivePolicy` | enum | `auto` | `auto`、`current_only`、`archive_only` |
| `eventLimit` | integer | 10 | 1-100，仅限制 SaaS 事件返回数量 |
| `includeRawLines` | boolean | false | `saas_event` 是否返回原始事件行 |

`logFileName` 规则：

- `mode: "saas_event"` 未传时默认 `saas.log`。
- `mode: "lines"` 未传时，当前日志查询会枚举每个 `logPath` 下最新的最多 5 个 `.log` 文件。
- `mode: "lines"` 查询历史归档时必须显式传 `logFileName`，否则无法构造归档文件规则。

## 当前日志与归档策略

### `auto`

- 未显式传 `startTime` 和 `endTime`：只查询当前日志，默认最近 30 分钟。
- 显式传入任一时间边界：根据最终时间范围生成归档日期目录。
- 时间范围包含今天时，同时查询当前日志；纯历史范围只查询归档日志。
- 最多覆盖 31 个日期目录，超过会返回错误。

### `current_only`

只查询当前日志文件，不查询日期目录和 `.gz` 文件。适合确认问题仍在当前 `saas.log` 时使用。

### `archive_only`

只查询归档目录，不查询当前日志。建议同时显式传入完整 `startTime` 和 `endTime`。

### 归档目录约定

假设服务器配置为：

```text
/home/logdir/log/saas-set01
```

查询 `2026-08-12` 时，MCP 会寻找：

```text
/home/logdir/log/saas-set01/260812/saas.log.260812*.gz
```

跨天时间范围会依次查询每个 `yyMMdd` 目录。归档文件通过 `gzip -cd` 流式读取，不会在服务器上解压落盘。

## 调用示例

### 查询当前 `saas.log`

```json
{
  "keyword": "2832996880440973688",
  "mode": "saas_event",
  "archivePolicy": "current_only"
}
```

### 自动查询历史归档

```json
{
  "keyword": "2832996880440973688",
  "mode": "saas_event",
  "startTime": "2026-08-12T03:40:00+08:00",
  "endTime": "2026-08-12T04:20:00+08:00",
  "archivePolicy": "auto"
}
```

### 查询跨天归档

```json
{
  "keyword": "order-1001",
  "mode": "saas_event",
  "startTime": "2026-08-11T23:50:00+08:00",
  "endTime": "2026-08-12T00:20:00+08:00",
  "archivePolicy": "archive_only"
}
```

### 限定环境和服务器

```json
{
  "keyword": "PosSaletoIvn",
  "environment": "prod",
  "serverNames": ["saas-prod-01"],
  "mode": "saas_event",
  "contextBefore": 20,
  "contextAfter": 80
}
```

### 查询普通日志文件

```json
{
  "keyword": "searchShippingOrderSummary",
  "mode": "lines",
  "logFileName": "app.log",
  "archivePolicy": "current_only"
}
```

### 查询普通日志的历史归档

```json
{
  "keyword": "searchShippingOrderSummary",
  "mode": "lines",
  "logFileName": "app.log",
  "startTime": "2026-08-12T09:00:00+08:00",
  "endTime": "2026-08-12T10:00:00+08:00",
  "archivePolicy": "archive_only"
}
```

## 返回结构

顶层结构：

```jsonc
{
  "status": "success",
  "query": {
    "keyword": "2832996880440973688",
    "environment": "prod",
    "serverNames": ["saas-prod-01"],
    "startTime": "2026-08-11T19:40:00.000Z",
    "endTime": "2026-08-11T20:20:00.000Z",
    "contextBefore": 30,
    "contextAfter": 50,
    "mode": "saas_event",
    "logFileName": "saas.log",
    "archivePolicy": "auto",
    "archiveDateDirectories": ["260812"],
    "includeCurrentLogs": false,
    "eventLimit": 10,
    "includeRawLines": false,
    "searchedServers": ["saas-prod-01"],
    "skippedServers": [],
    "serverLimitTruncated": false
  },
  "matches": [],
  "searchedSources": [],
  "matchesTruncated": false,
  "requestParameters": null,
  "response": null,
  "sql": null,
  "exceptions": null,
  "saasEvents": [],
  "diagnosticEvents": [],
  "analysis": {
    "confirmedFacts": [],
    "possibleCauses": [],
    "recommendations": []
  },
  "notes": {
    "droppedByTime": 0,
    "missingContext": 0,
    "searchErrors": []
  }
}
```

未检测到请求、响应、SQL 或异常时，对应字段为 `null`，不会编造内容。`lines` 模式下 `saasEvents` 和 `diagnosticEvents` 为 `null`。

### `searchedSources`

它用于确认 MCP 实际查了哪些文件：

```json
[
  {
    "server": "saas-prod-01",
    "environment": "prod",
    "type": "archive",
    "logFile": "/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz",
    "dateDirectory": "260812",
    "commandKind": "gzip_grep",
    "matched": true
  }
]
```

当前日志的 `type` 为 `current`、`dateDirectory` 为 `null`、`commandKind` 为 `tail_grep`。

### `diagnosticEvents`

`saas_event` 模式会返回面向定位问题的清晰结构：

```jsonc
[
  {
    "summary": {
      "result": "error",
      "errorType": "java.sql.SQLException",
      "errorMessage": "单据日期不合法",
      "rootCause": "业务日期不在当前允许的核算期或库存账期范围内。",
      "location": {
        "className": "com.example.PosSaleInterfaceImpl",
        "methodName": "PosSaletoIvn",
        "fileName": "PosSaleInterfaceImpl.java",
        "lineNumber": 622,
        "logger": "com.example.PosSaleInterfaceImpl"
      },
      "businessFlow": "POS零售出库回调处理",
      "suggestion": "检查业务日期和当前账期配置。"
    },
    "trace": {
      "traceId": "2832996880440973688",
      "thread": "task-worker-64",
      "startTime": "2026-08-12T03:51:10.123",
      "endTime": "2026-08-12T03:51:10.576",
      "durationMs": 453,
      "server": "saas-prod-01",
      "environment": "prod",
      "logFile": "/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz"
    },
    "request": {},
    "sql": [],
    "response": {},
    "tenant": {},
    "context": {
      "before": [],
      "error": [],
      "after": []
    },
    "stackTrace": []
  }
]
```

字段来自日志解析。无法确认的位置、根因、请求或响应会返回 `null` 或空数组。

## 安全设计

1. MCP 只注册 `search_logs`，不提供任意命令执行工具。
2. 远程命令由固定模板生成，包括 `ls`、`tail`、`grep`、`gzip -cd`。
3. 关键词和路径先经过白名单校验，再进行 POSIX Shell 引号转义。
4. 禁止 `rm`、`mv`、`cp`、`kill`、`docker`、`kubectl`、`curl`、`wget` 等状态变更或外联命令。
5. 当前日志只读取尾部 `scanLines` 行；归档日志只读流式解压，不落盘。
6. 返回前统一脱敏密码、Token、Authorization、Cookie、AccessKey、SecretKey 和 JWT 等敏感值。
7. `maxServers`、`maxLines`、SSH 超时和并发限制用于降低对生产服务器的影响。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm install` | 安装锁定版本的依赖 |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm start` | 启动构建后的 stdio MCP Server |
| `npm run dev` | 直接运行 TypeScript 开发入口 |
| `npm test` | 运行全部 Vitest 测试 |
| `npm run test:watch` | 监听模式运行测试 |

## FAQ

### 为什么查不到历史日志？

确认以下条件：

- 已显式传入 `startTime` 或 `endTime`，或使用 `archivePolicy: "archive_only"`。
- `mode: "lines"` 时已传 `logFileName`。
- 服务器目录符合 `yyMMdd/<日志名>.<yyMMdd>*.gz`。
- 查询范围没有超过 31 个日期目录。
- `searchedSources` 中是否出现目标 `.gz`；`notes.searchErrors` 是否有目录、权限或 gzip 错误。

### 为什么默认没有查询压缩包？

`archivePolicy: "auto"` 在没有明确时间边界时只查询当前日志，避免默认调用扫描历史归档。

### 修改代码后为什么 Codex 仍使用旧功能？

执行 `npm run build`，然后在 Codex 中 Restart 该 MCP，或完全重启 Codex Desktop。已运行的 MCP 进程不会自动加载新的 `dist` 文件。

### 命中行号是日志文件的绝对行号吗？

当前日志的行号是 `tail` 扫描窗口内的行号；归档日志的行号是解压后文本中的行号。应结合 `logFile` 和上下文定位。

### 没有时间戳的日志会被丢弃吗？

不会。无法解析时间戳时采用保守策略保留，并返回 `timestamp: null`。

### 支持密码认证吗？

支持 `auth.type: password`，但生产环境推荐私钥认证和专用只读账号。

## README 与提交维护规范

本 README 是本项目唯一权威使用文档，不维护重复安装文档或逐次变更表。

以后修改本 MCP 时必须遵守：

1. 新增或修改工具参数、返回字段、配置项、日志格式、归档规则、安全边界、安装或客户端接入方式时，必须在同一个功能提交中同步更新 README。
2. README 始终描述当前代码的真实行为；功能历史由 Git 提交记录负责。
3. 每个小功能独立测试、提交并推送，不把无关修改混在一起。
4. 提交标题采用 Conventional Commits：`feat`、`fix`、`docs`、`test`、`refactor`、`chore`。
5. 提交标题和正文使用中文，说明本次功能点以及解决了什么问题。
6. 提交前执行 `npm test`、`npm run build`、`git diff --check`，并检查 diff 中没有真实凭据和生产日志。

## License

MIT
