# log-diagnostic-mcp 安装指南（交给 AI 自动执行）

> **用途**：把这份文档和工程代码包一起交给你的 AI Coding 工具（Codex / Cursor / Claude 等），AI 能自主完成依赖安装、构建、配置文件初始化和 MCP 客户端配置。你只需填写服务器连接信息（地址、账号、密码/私钥、日志目录）。
>
> **适用场景**：同事拿到 GitHub 仓库的打包代码后，无需了解项目细节，按本文档操作即可完成安装。

---

## 给 AI Coding 工具的执行指令

把以下指令复制给你的 AI 工具，连同本工程代码一起发送：

```text
请完整阅读本文件（SETUP_FOR_COLLEAGUE.md），并严格按照其中的步骤执行安装。

执行边界：
1. 检查 Node.js 20+、npm 和 Git 是否已安装。
2. 在工程根目录执行 npm install 安装依赖，不要升级依赖版本。
3. 如果 config/servers.yaml 不存在，从 config/servers.example.yaml 复制；如果已存在，绝不覆盖。
4. 如果 .env 不存在，从 .env.example 复制；如果已存在，绝不覆盖。
5. 不读取、打印、提交或回显密码、私钥内容、Token 和真实日志。
6. 只生成服务器配置模板，缺少 host、username、logPaths 或认证信息时停止并提示用户填写。
7. 执行 npm test 和 npm run build。
8. 根据用户使用的 MCP 客户端（Codex Desktop / Cursor / Claude Desktop 等），生成对应的 MCP 配置，所有工程路径使用绝对路径。
9. 安装阶段不得连接真实服务器，不得执行 search_logs。
10. 完成后只报告本地安装、构建和 MCP 配置状态，以及仍需用户填写的字段。
```

---

## 环境要求

- Windows、Linux 或 macOS
- Node.js **20** 或更高版本
- npm
- Git
- 能通过 SSH 访问日志服务器
- 远程服务器具备 `ls`、`tail`、`grep`、`gzip` 等常见只读命令

检查命令：

```powershell
node --version   # 必须 v20+
npm --version
git --version
```

---

## 安装步骤

### 第 1 步：进入工程目录

如果你下载的是 ZIP 压缩包，先解压到一个目录，然后进入工程根目录：

```powershell
cd log-diagnostic-mcp
```

工程根目录下应该能看到 `package.json`、`src/`、`config/`、`.env.example` 等文件。

### 第 2 步：安装依赖

```powershell
npm install
```

### 第 3 步：初始化配置文件

**Windows PowerShell：**

```powershell
Copy-Item config\servers.example.yaml config\servers.yaml
Copy-Item .env.example .env
```

**Linux / macOS Bash：**

```bash
cp config/servers.example.yaml config/servers.yaml
cp .env.example .env
```

如果目标文件已存在，不要覆盖。

### 第 4 步：填写服务器连接信息

这一步需要你手动填写真实信息。打开 `config/servers.yaml`，按以下格式填写：

#### 密码认证（最常用）

```yaml
limits:
  maxServers: 10
  maxLines: 3000
  timeoutSeconds: 30
  maxConcurrentConnections: 5
  scanLines: 20000

servers:
  - name: my-server          # 服务器名称，自定义，不能重复
    environment: prod         # 环境名称，如 prod / staging
    host: 192.168.1.100       # 服务器 IP 或主机名
    port: 22                  # SSH 端口
    username: myuser          # SSH 用户名
    auth:
      type: password
      password: ${SERVER_PASSWORD}   # 引用环境变量，不要直接写密码
    logPaths:
      - /home/logdir/log/saas-set01  # 日志根目录
```

然后打开 `.env`，填入对应的环境变量：

```dotenv
SERVER_PASSWORD=你的真实密码
```

#### 私钥认证

```yaml
servers:
  - name: my-server
    environment: prod
    host: 192.168.1.100
    port: 22
    username: myuser
    auth:
      type: private_key
      privateKeyPath: ${SSH_PRIVATE_KEY}
    logPaths:
      - /home/logdir/log/saas-set01
```

对应 `.env`：

```dotenv
SSH_PRIVATE_KEY=C:\Users\你的用户名\.ssh\id_ed25519
```

#### 多服务器配置示例

```yaml
servers:
  - name: prod-01
    environment: prod
    host: 192.168.1.100
    port: 22
    username: log-reader
    auth:
      type: password
      password: ${PROD_PASSWORD}
    logPaths:
      - /data/logs/saas-set01

  - name: prod-02
    environment: prod
    host: 192.168.1.101
    port: 22
    username: log-reader
    auth:
      type: password
      password: ${PROD_PASSWORD}
    logPaths:
      - /data/logs/saas-set01

  - name: staging-01
    environment: staging
    host: 192.168.2.100
    port: 22
    username: log-reader
    auth:
      type: password
      password: ${STAGING_PASSWORD}
    logPaths:
      - /data/logs/saas-set01
```

对应 `.env`：

```dotenv
PROD_PASSWORD=生产服务器密码
STAGING_PASSWORD=预发服务器密码
```

#### 配置字段说明

| 字段 | 说明 | 限制 |
| --- | --- | --- |
| `name` | 服务器唯一名称，查询时用 `serverNames` 筛选 | 不能重复 |
| `environment` | 环境名称，查询时用 `environment` 筛选 | 最长 50 字符 |
| `host` | 服务器 IP 或主机名 |  |
| `port` | SSH 端口 | 通常 22 |
| `username` | SSH 用户名 |  |
| `auth.type` | 认证方式 | `password` 或 `private_key` |
| `auth.password` | 密码，用 `${变量名}` 引用 `.env` | 不要直接写明文 |
| `auth.privateKeyPath` | 私钥文件路径，用 `${变量名}` 引用 `.env` |  |
| `logPaths` | 日志根目录列表 | 每台服务器 1-20 个 POSIX 绝对路径 |
| `limits.maxServers` | 单次查询最多搜索的服务器数 | 1-100，默认 10 |
| `limits.maxLines` | 单次查询返回的匹配行总数上限 | 1-100000，默认 3000 |
| `limits.scanLines` | 只扫描每个日志文件的末尾 N 行 | 100-1000000，默认 20000 |

#### 安全要求

- 真实密码、私钥路径只放在 `.env` 或系统环境变量中
- `config/servers.yaml` 中用 `${变量名}` 引用，不直接写明文
- `.env` 和 `config/servers.yaml` 已被 `.gitignore` 忽略，不会被提交
- 不要把真实密码、私钥内容、Token 发到聊天、Issue 或提交记录中

### 第 5 步：本地验证和构建

```powershell
npm test
npm run build
```

测试使用 mock SSH，不会连接真实生产服务器。构建成功后会生成 `dist/` 目录。

### 第 6 步：配置 MCP 客户端

根据你使用的 AI 工具，选择对应的配置方式。

---

## 配置 Codex Desktop / Codex CLI

Codex Desktop、Codex CLI 和 Codex IDE 扩展共享 `~/.codex/config.toml` 配置文件。Windows 下路径通常为 `C:\Users\你的用户名\.codex\config.toml`。

在 `config.toml` 中添加以下配置（路径替换为你的工程实际绝对路径）：

```toml
[mcp_servers.log_diagnostic]
command = "cmd"
args = ["/c", "npm", "start"]
cwd = "C:\\absolute\\path\\log-diagnostic-mcp"
startup_timeout_sec = 120

[mcp_servers.log_diagnostic.env]
LOG_MCP_CONFIG = "C:\\absolute\\path\\log-diagnostic-mcp\\config\\servers.yaml"
```

也可以直接使用构建产物：

```toml
[mcp_servers.log_diagnostic]
command = "node"
args = ["C:\\absolute\\path\\log-diagnostic-mcp\\dist\\index.js"]
cwd = "C:\\absolute\\path\\log-diagnostic-mcp"

[mcp_servers.log_diagnostic.env]
LOG_MCP_CONFIG = "C:\\absolute\\path\\log-diagnostic-mcp\\config\\servers.yaml"
```

要点：

- 两个路径都要替换为工程和配置文件的真实绝对路径
- `cwd` 保证 `npm start`、`.env` 和默认相对路径都从工程根目录解析
- `LOG_MCP_CONFIG` 避免客户端工作目录变化导致找不到服务器配置
- 服务名称使用 `log_diagnostic`（下划线），不要用 `log-diagnostic`（短横线）
- 保存后在 Codex Desktop 的 MCP 设置中找到 `log_diagnostic`，先关闭再打开，或点击 Restart
- 如果仍提示缺少环境变量，确认 `.env` 中的变量名与 `servers.yaml` 中 `${变量名}` 完全一致
- 不要把 `.env` 中的密码或私钥内容复制到 Codex 配置中

---

## 配置 Cursor / Claude Desktop 等通用客户端

通用 JSON 配置格式（路径替换为实际值）：

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

macOS / Linux 示例：

```json
{
  "mcpServers": {
    "log-diagnostic": {
      "command": "node",
      "args": ["/absolute/path/log-diagnostic-mcp/dist/index.js"],
      "cwd": "/absolute/path/log-diagnostic-mcp",
      "env": {
        "LOG_MCP_CONFIG": "/absolute/path/log-diagnostic-mcp/config/servers.yaml"
      }
    }
  }
}
```

---

## 安装验证

1. 在 AI 工具中确认工具列表存在 `search_logs`。
2. 用一个确认存在且不敏感的关键词做当前日志测试：

   ```
   帮我查日志 saas.log，关键词 <你的关键词>，只查当前日志
   ```

3. 返回对象应包含 `query`、`matches`、`searchedSources` 和 `analysis` 字段。
4. 使用 `saas_event` 模式时还应包含 `saasEvents` 和 `diagnosticEvents`：

   ```
   用 saas_event 模式查 saas.log，关键词 <你的关键词>，只查当前日志
   ```

5. 使用明确历史时间范围时，`searchedSources` 应显示具体 `.gz` 路径和 `commandKind: "gzip_grep"`：

   ```
   查 saas.log，关键词 <你的关键词>，时间 2026-08-12T03:40:00 到 2026-08-12T04:20:00，自动查归档
   ```

---

## 常见问题

### 工具提示"未配置"或缺少环境变量

- 确认 `.env` 中的变量名与 `config/servers.yaml` 中 `${变量名}` 完全一致
- 确认 MCP 配置中的 `cwd` 指向工程根目录（`.env` 需要从该目录加载）
- 在 Codex Desktop 的 MCP 设置中关闭再打开 `log_diagnostic`，或点击 Restart
- 如果改了配置后仍然不生效，重启 Codex Desktop

### 查询返回空结果

- 确认关键词在目标时间范围内的日志中确实存在
- `current_only` 模式只查当前日志文件末尾 `scanLines` 行（默认 20000），历史上的日志需要用 `auto` 或 `archive_only` 并指定时间范围
- 确认 `logPaths` 指向正确的日志目录

### 历史归档查询报错

- 归档目录约定为 `<logPath>/<yyMMdd>/saas.log.<yyMMdd>*.gz`
- 例如日志根目录 `/data/logs/saas-set01`，查询 2026-08-12 的归档时，MCP 会查找 `/data/logs/saas-set01/260812/saas.log.260812*.gz`
- 跨天时间范围最多覆盖 31 个日期目录

### SSH 连接失败

- 确认服务器 IP、端口、用户名、密码/私钥配置正确
- 确认 `.env` 中变量名与 `servers.yaml` 中引用一致
- 确认远程服务器具备 `ls`、`tail`、`grep`、`gzip` 命令
- 推荐为日志查询创建专用的只读账号，只授予日志目录读取权限

---

## 能力概述

安装完成后，AI 工具可以通过 `search_logs` 工具帮你：

- 按关键词查询服务器日志，返回匹配行及上下文
- 按 traceId 或线程聚合 SaaS 日志事件
- 自动提取入参、SQL、响应、异常堆栈
- 定位报错类、方法、源码文件和行号
- 查询当前日志和 `.gz` 历史归档
- 基于日志证据生成原因分析和检查建议

所有操作都是只读的，不会修改服务器状态。
