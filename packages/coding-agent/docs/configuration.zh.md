# 配置

English | [中文](configuration.zh.md)

Pi 支持用户级配置与项目级配置。用户级配置位于 agent 目录，默认是 `~/.pi/agent`。项目级配置位于工作目录下的 `.pi`，需要先授予[项目信任](security.md#understand-project-trust)才会加载。唯一的例外是 `sessionDir`：Pi 会在解析信任之前读取它，以便定位会话。

在交互模式里，用 `/settings` 修改常用偏好。其他选项可以请 Pi 修改配置，或直接编辑对应文件。手动改过设置、快捷键、指令或资源之后，执行 `/reload`。

## Agent 目录

下文用 `<agent-dir>` 表示 agent 目录。通过 `PI_CODING_AGENT_DIR` 环境变量或 SDK 的 [`agentDir`](sdk.md) 选项设置它的位置。

| 路径 | 职责 |
|---|---|
| `<agent-dir>/settings.json` | 用户级[设置](settings.md)，包含偏好、默认值、资源路径和 Pi package 声明。 |
| `<agent-dir>/keybindings.json` | 自定义终端 UI 与应用[快捷键](keybindings.md)。 |
| `<agent-dir>/mcp.json` | 每个项目都可用的 [MCP 服务器](mcp.md)。 |
| `<agent-dir>/models.json` | [兼容端点、模型与模型覆盖](models.md#configure-a-compatible-endpoint)。 |
| `<agent-dir>/auth.json` | 保存的 API key 与 OAuth 凭据。 |
| `<agent-dir>/AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md` 或 `CLAUDE.MD` | 跨工作目录生效的用户指令。 |
| `<agent-dir>/SYSTEM.md` | 替换 Pi 默认系统提示词。 |
| `<agent-dir>/APPEND_SYSTEM.md` | 为 Pi 的系统提示词追加指令。 |
| `<agent-dir>/extensions/` | 用户[扩展](extensions.md)。 |
| `<agent-dir>/skills/` | 用户[技能](skills.md)及配套文件。 |
| `<agent-dir>/prompts/` | 以斜杠命令形式暴露的用户[提示词模板](prompt-templates.md)。 |
| `<agent-dir>/themes/` | 用户[主题](themes.md)文件。 |

## 项目 `.pi` 目录

| 路径 | 职责 |
|---|---|
| `.pi/settings.json` | 项目级[设置](settings.md)、资源路径和 Pi package 声明。 |
| `.pi/mcp.json` | 项目 [MCP 服务器](mcp.md)。 |
| `.pi/SYSTEM.md` | 替换该项目的系统提示词。 |
| `.pi/APPEND_SYSTEM.md` | 为系统提示词追加项目专属指令。 |
| `.pi/extensions/` | 项目扩展。 |
| `.pi/skills/` | 项目技能及配套文件。 |
| `.pi/prompts/` | 以斜杠命令形式暴露的项目提示词模板。 |
| `.pi/themes/` | 项目主题文件。 |

对于 `SYSTEM.md` 和 `APPEND_SYSTEM.md`，受信任项目的文件优先于 agent 目录中同名的文件；同名文件不会合并。

## 上下文文件

上下文文件与项目 `.pi` 配置是两回事。Pi 从 agent 目录、工作目录及其父目录加载它们。只要 Pi 在某个目录或其任意子目录下运行，对应的上下文文件就生效。

`AGENTS.override.md` 只在同一个目录里替换 `AGENTS.md` 或 `CLAUDE.md`，不会屏蔽来自 agent 目录或其他目录的上下文文件。

加载上下文文件不需要项目信任。