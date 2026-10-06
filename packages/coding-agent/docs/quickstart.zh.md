# 快速开始

[English](quickstart.md) | 中文

Pi 运行在你的终端里，直接操作本机文件。要用它，你需要一个受支持提供商的模型访问方式：可以是订阅、API key，或者本地模型。

原生 Windows 环境请读 [Windows 安装](windows.md)；Android 请读 [Termux 安装](termux.md)。

## 1. 安装 Pi

在 macOS 或 Linux 上，可以用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

也可以从 npm 安装，这需要 Node.js 22.19 或更新版本：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

常规的 npm 安装不需要执行依赖的生命周期脚本。

验证安装：

```bash
pi --version
```

## 2. 启动 Pi

切换到想让 Pi 工作的目录，然后启动：

```bash
cd /path/to/folder
pi
```

工作目录帮助 Pi 发现相关文件、指令和配置，Pi 也用它来归类保存的会话。

<p align="center"><img src="images/interactive-mode.png" alt="Pi running in a terminal with a conversation, input editor, and status footer" width="750"></p>

界面包含对话区、用于输入提示词与命令的编辑区，以及显示当前目录、模型和会话状态的底部状态栏。要了解如何添加文件、执行命令、引导进行中的工作和管理结果，见 [在终端里使用 Pi](usage.md)。

## 3. 选择模型

**模型**负责生成 Pi 的回复，**提供商**是 Pi 用来访问该模型的服务或账号。

在 Pi 里执行：

```text
/login
```

先选择提供商，再按提示使用订阅或保存 API key。如果想换成其他可用模型，之后执行 `/model`。

受支持的提供商、环境变量认证、本地模型和自定义端点，见 [选择模型与提供商](models.md)。

## 4. 给 Pi 一个任务

Pi 会展示它每次读文件、搜索、执行命令和编辑的操作，不会为每次工具调用征求同意。

输入一个符合你实际工作的任务，例如：

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

在编辑区输入 `@` 可以搜索文件，而不必手写完整路径。Pi 完成后，请审阅它的回复和改动过的文件。重要工作请配合版本控制或备份；不可信或无人值守的工作请放进容器或其他沙箱，见 [安全](security.md)。

## 稍后继续

Pi 自动保存会话。退出 Pi 后，用下面的命令恢复同一工作目录最近的一次会话：

```bash
pi --continue
```

用 `/resume` 可以选择其他已保存的会话。会话命名、分支、压缩、导出与分享，见 [继续或分叉会话](sessions.md)。

## 下一步

- [交互使用 Pi](usage.md)：了解输入、命令、快捷键和消息排队。
- [添加指令](configuration.zh.md#上下文文件)，让 Pi 在某个目录工作时始终遵循。
- [选择模型与提供商](models.md)。

### 选择如何定制 Pi

从满足需求的最轻量机制开始：

| 需求 | 从这里开始 |
|---|---|
| 给 Pi 一个目录的长期指令 | [`AGENTS.md`](configuration.zh.md#上下文文件) |
| 在 `/` 菜单里复用一条提示词 | [提示词模板](prompt-templates.md) |
| 添加任务专用指令与配套文件 | [技能](skills.md) |
| 添加可执行的工具、命令或事件处理器 | [扩展](extensions.md) |
| 构建自定义终端组件 | [终端 UI](tui.md) |
| 接入尚不支持的模型服务 | [自定义提供商](custom-provider.md) |
| 安装或分发多项资源 | [Pi package](packages.md) |

## 卸载 Pi

如果用 npm 安装，执行：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

如果用安装脚本装的，再执行一次并选择 **Uninstall Pi**：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

两种方式都不会删除 `~/.pi/agent/` 下的配置、凭据、会话和已安装的 Pi package。