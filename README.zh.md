# dsh-trek-mcp

[English](README.md) | 中文

把自建的 [TREK](https://github.com/liketrek/TREK) 旅行规划通过 MCP 接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件（bundle）。

在 **设置 → TREK MCP** 里填入 MCP 端点、TREK **机器客户端（machine OAuth client）**
的 ID 和密钥即可；插件自己换取并续期短效 token、自己维持 MCP 会话，不需要手改
`cordis.patch.yml`，也不接触模型。

![license](https://img.shields.io/badge/license-MIT-blue)
![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.2--rc.1-4D6BFE)
![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)

## 功能

- 把 TREK 的 MCP 工具注册成 `mcp__trek__*`：行程、日程、地点、Tours、预订、
  预算、行李清单、收藏、Journey 等，以及 TREK 的 resources 和帮助 prompts。
- **设置 → TREK MCP** 页面：端点、客户端 ID、客户端密钥三个输入框（可选 Token
  URL），外加「测试连接」和「保存并重连」。
- OAuth 2.1 `client_credentials` 自动换 token：到期前 5 分钟续期、401 后立即重换，
  token 只存在进程内存里。
- **闲置会话自动恢复**：TREK 的 MCP 会话一小时无请求会被回收
  （`MCP_SESSION_TTL`），插件自己管理会话映射，回收后自动重新 initialize，下一次
  工具调用照常工作，不会报 `Session not found`。
- 回环 Streamable-HTTP 代理：MCP 协议仍由官方 `@deepseek-ai/dsh-mcp-client` 插件
  处理，客户端密钥不会进入模型上下文。

## 环境要求

- DeepSeek Harness 0.2.2-rc.1 或更新（0.2.x 线），Web profile。
- 已启用 **MCP** addon 的 TREK（管理 → Addons）。
- TREK 里的**机器客户端**：设置 → 集成 → MCP 配置 → OAuth 2.1 客户端 → 新建，
  勾选 **Machine client (no browser login)**，按需勾选 scope（`trips:*`、
  `places:*`、`budget:*` 等）。保存后 `client_id` 与 `client_secret`
  （`trekcs_…`，只显示一次）复制到插件设置页。

## 安装

DSH 没有默认的官方插件索引，直接从本仓库安装。

**Web（推荐）**：打开 **插件（Plugins）**，用下面任一 spec 安装：

```
github:tyrantblue/dsh-trek-mcp
```

或固定版本：

```
git+https://github.com/tyrantblue/dsh-trek-mcp.git#v1.0.0
```

安装后**刷新一次页面**，浏览器才会加载新的设置页。

**命令行**：先装进 profile，再到 Plugins 页面把 bundle 打开：

```sh
dsh plugin --profile web add github:tyrantblue/dsh-trek-mcp
```

## 配置

打开 **设置 → TREK MCP**：

| 字段 | 说明 |
|---|---|
| MCP 端点 | 本机 docker 部署的 TREK 用 `http://127.0.0.1:3000/mcp`，或 `https://<你的域名>/mcp` |
| 客户端 ID | 机器客户端的 UUID |
| 客户端密钥 | 只写；页面只显示"是否已保存"，留空表示保留已保存的密钥 |
| Token URL | 可选；留空时自动取端点同源的 `/oauth/token` |

「测试连接」只用当前填写值换一次 token，不保存；「保存并重连」把值写进 harness 的
profile 配置（不是本仓库文件）并重建连接，期间工具会短暂不可用。

## 工作原理

```mermaid
flowchart LR
  A[Agent] --> C[<b>@deepseek-ai/dsh-mcp-client</b><br/>Streamable HTTP]
  C -->|127.0.0.1:17890/mcp| B[<b>trek-mcp-broker</b><br/>Host 插件]
  B -->|client_credentials| T[TREK /oauth/token]
  B -->|Bearer token + session| M[TREK /mcp]
  S[<b>设置 → TREK MCP</b><br/>浏览器插件] -->|config editor| P[(profile 配置)]
  P -.重启.-> B
```

`cordis.patch.yml` 会安装三行 Loader 配置：

| 行 | 作用 |
|---|---|
| `trek-mcp-ui` | 以包名命名的行，承载浏览器端插件（`dsh.client`，即设置页）。 |
| `trek-mcp-broker` | Host 插件：换 token/续期、提供设置 API（`/api/trek-mcp/*`）、把回环端点代理到 TREK。 |
| `trek-mcp` | 官方 `@deepseek-ai/dsh-mcp-client`，指向回环代理；工具命名、重连、resources 由它负责。 |

保存通过 harness 的 config editor 写入，所以重装插件不会丢配置。

## 配置项

`trek-mcp-broker` 行支持：

| Key | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3000/mcp` | TREK 的 MCP 端点 |
| `tokenUrl` | 端点 origin + `/oauth/token` | OAuth token 端点 |
| `clientId` | — | 机器客户端 ID（设置页填写） |
| `clientSecret` | — | 机器客户端密钥（设置页填写，或用环境变量 `TREK_MCP_CLIENT_SECRET`） |
| `listenPort` | `17890` | 回环代理端口，需与 `trek-mcp` 行 URL 保持一致 |
| `scope` | 客户端允许的 scope | 可选，空格分隔，用于收窄 token 权限 |

HTTP 端点会自动补 `X-Forwarded-Proto: https`，因为 TREK 通常开
`FORCE_HTTPS=true`，否则 POST 会被 301 到公网 HTTPS 地址；想走公网/反代就直接把
`endpoint` 填成公网 URL。

## 安全

- 密钥保存在 harness profile 配置（权限 600）里，由设置页写入；不会回显到浏览器、
  不会写日志、不会进入模型上下文。
- 代理只监听 `127.0.0.1`；本机能访问该端口的进程就能使用该 token 的权限，与
  profile 目录同级信任边界。
- 机器客户端以创建它的 TREK 用户身份行事，权限取决于勾选的 scope，按需最小化。
- 撤销：在 TREK 删除该 OAuth 客户端，或轮换密钥后在设置页填入新值。

## 排障

| 现象 | 原因 |
|---|---|
| `TREK is not configured yet` / 没有 `mcp__trek__*` 工具 | 在设置页填好端点、ID、密钥并保存。 |
| `TREK token request rejected (HTTP 401)` | 密钥错误或已轮换，或该客户端不是机器客户端。 |
| `TREK token request rejected (HTTP 400)` | 客户端没有所请求的 `scope`。 |
| 端点返回 301 | HTTP 端点遇到 `FORCE_HTTPS`；`http:` 端点会自动补 `X-Forwarded-Proto`，或改用公网 HTTPS URL。 |
| 长时间闲置后工具短暂消失 | 应自动恢复；若没有，重新保存一次设置页并附上日志反馈。 |
| 端口被占用 | 同时修改 `listenPort` 和 `trek-mcp` 行的 URL。 |

## 开发

```
broker.js               Host 插件：换 token/续期、设置 API、回环代理、会话恢复
client.js               浏览器插件：设置 → TREK MCP 页面
cordis.patch.yml        三行 Loader 配置
locale/{en,zh}.json     插件管理里显示的标题/描述
icon.svg                插件图标
test/                   node --test 测试（内置 mock TREK MCP 服务）
```

```sh
npm test          # node --test，无依赖
```

测试覆盖会话映射/回收恢复、首次启动无凭据、密钥不回显、测试连接、保存持久化。

## 链接

- TREK：<https://github.com/liketrek/TREK>（内置 MCP 文档：
  <https://github.com/liketrek/TREK/wiki/MCP-Overview>）
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>

## License

[MIT](LICENSE)
