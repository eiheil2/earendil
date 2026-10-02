# PROVENANCE — unified 仓库出处与冻结基线

> 本文件是 `unified` 仓库的**权威出处声明**。任何移植代码进入本仓库时，必须在对应文件头部附出处头（provenance header），并在此文件的变更记录中登记。
> 首次建立时间：2026-10-02（Phase 0）。

---

## 1. 基底（Base）

| 项 | 值 |
|---|---|
| **基底项目** | **pi** — earendil-works/pi monorepo（`pi-monorepo`，private root package） |
| **固定 commit** | `9b3c19da5cffc4c5e8b6bd74c45abc1ab6bfcd16` |
| commit 标题 | `fix(coding-agent): ignore empty entries in --models` |
| commit 日期 | 2026-10-02 13:42:38 +0200 |
| 上游 URL | https://github.com/earendil-works/pi |
| 冻结分支 | `main` |
| 克隆方式 | **本地浅克隆**（`.git/shallow` 存在），本仓继承同一浅历史边界 |
| 许可 | MIT — Copyright (c) 2025 Mario Zechner |
| 内部包（均为 `@earendil-works/*`） | `pi-agent-core` / `pi-ai` / `chord` / `pi-client` / `pi-codemode` / `pi-coding-agent` / `pi-durable` / `pi-evals` / `pi-mcp` / `pi-protocol` / `pi-server` / `pi-telemetry` / `pi-tui`，版本均为 `1.0.0` |

**基底选择依据**：`C:\Users\eihei\pi-compare\MERGE-FINAL.md` §0 决策记录（用户拍板：DSH 处于 rc/开发者预览期、每次更新插件崩一大片，不能当地基）。

---

## 2. 移植来源（Port sources）—— 仅供移植，**禁止作为运行时依赖**

> ⚠️ **硬约束（用户拍板，见 MERGE-FINAL.md §0-2 / §3）**
> 下列两个仓库**只作为移植来源（port source）**，以固定 commit 引用。
> **禁止**将其作为运行时依赖（runtime dependency）引入 `unified`：不加入 workspaces、不加入 `package.json` / `Cargo.toml` / `pnpm-workspace.yaml` 依赖图、不以其包名 import、不引入其插件机制。
> 原因：DSH 处于 rc/开发者预览期，插件生态不稳定（每次更新崩溃一大片）；若把 rc 代码接进运行时链路，上游一次迭代即可把本项目拖崩。
> 引入方式只能是：**逐文件阅读 → 按本仓风格重写/裁剪 → 附出处头 → 逐文件审查许可**。同步上游必须作为独立评估事件，不得自动进行。

### 2.1 oh-my-pi

| 项 | 值 |
|---|---|
| 项目 | oh-my-pi（can1357/oh-my-pi） |
| **固定 commit** | `855879c9ab0c5ebd1257f268abe3beca871ce298` |
| commit 标题 | `chore: bump version to 18.4.11` |
| commit 日期 | 2026-10-02 14:56:51 +0200（版本 **v18.4.11**） |
| 上游 URL | https://github.com/can1357/oh-my-pi |
| 冻结分支 | `main` |
| 克隆方式 | 本地浅克隆 |
| 许可 | MIT — Mario Zechner / Can Bölük / Stencil Labs, Inc. |
| 角色 | **仅移植来源**。已知独有资产：Rust crates（热路径**重写**而非引用）、KDL 目录（只移植 `classifyModel` 事实 + 重叠守卫）、mnemopi、snapcompact、hashline |
| 明确排除 | 其 Bun / Bazel 构建层**不引入**（构建系统收敛到 pi 的 npm+esbuild/biome 一套） |

### 2.2 deepseek-harness (DSH)

| 项 | 值 |
|---|---|
| 项目 | deepseek-harness（DeepSeek AI） |
| **固定 commit** | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| commit 标题 | `Merge pull request #5479 from deepseek-harness/worktree/release-dsh-0.2.0-rc.2` |
| commit 日期 | 2026-09-29 17:21:31 +0800（发布 **dsh 0.2.0-rc.2**） |
| 上游 URL | https://github.com/deepseek-ai/deepseek-harness |
| 冻结分支 | `master` |
| 克隆方式 | 本地浅克隆 |
| 许可 | MIT — Copyright (c) 2026 DeepSeek。⚠️ 其内部含 **MPL-2.0**（libreoffice-kit）与**非标准许可的 Anthropic SDK** → 移植时**逐文件审查**，MPL-2.0 文件不并入或隔离到独立目录 |
| 角色 | **仅移植来源**。已知可借鉴：扩展面语义（经由映射层桥接到 pi 的 `chord`，不引入其插件机制）、append-only 会话日志（`SESSION_FORMAT_VERSION=4`）、诊断与错误提示风格 |
| 明确排除 | **DSH 运行时依赖**（四份独立方案 + 用户约束一致）；裸 `ExtensionAPI` 不直接移植，须先落 Phase 3 的版本化 Plugin SDK 窄接口 |

---

## 3. 决策依据文档

| 文档 | 路径 | 作用 |
|---|---|---|
| **合并方案（定稿）** | `C:\Users\eihei\pi-compare\MERGE-FINAL.md` | §0 决策记录（基底选择 + DSH 仅作移植来源的硬约束）、§1 插件契约设计要求、§2 阶段表（Phase 0-6 + 显式排除项） |
| Phase 0 状态报告 | `C:\Users\eihei\pi-compare\PHASE0-STATUS.md` | 本阶段的冻结信息、构建矩阵、遗留问题 |
| 相关计划 | `C:\Users\eihei\pi-compare\plan-features.md`（81 项，P0=22）、`plan-ootb.md`（58 项验收清单）、`research-*.md` | 功能/OOTB/借鉴调研输入 |

---

## 4. `unified` 仓库是如何建出来的（如实记录）

**实际采用方式：本地 `git clone`（成功，未回退到 robocopy）。**

```
git clone "C:\Users\eihei\pi-merge\pi" "C:\Users\eihei\pi-merge\unified"
```

* 结果：成功，耗时约 17.5 秒，checkout 1849 个文件，`HEAD` 与 pi 完全一致（`9b3c19d`）。
* 浅克隆边界被继承：`unified\.git\shallow` 存在，`git rev-list --count HEAD` = **1**（即历史被截断在该 commit）。
* 未使用 robocopy 回退路径，因此无产物排除项（.git / node_modules / dist）需要处理。

克隆后对 remotes 做的两处**非破坏性**调整（均记录于此）：

| remote | URL | 用途 |
|---|---|---|
| `origin` | `https://github.com/earendil-works/pi` | 上游只读引用（clone 时暂为本地路径 `C:\Users\eihei\pi-merge\pi`，随即改回真实上游） |
| `pi-local` | `C:\Users\eihei\pi-merge\pi` | 保留冻结本地镜像路径，便于日后比对 |

git 身份：全局与原三仓均未配置 `user.name` / `user.email`。**未修改任何全局配置**；仅在 `unified` 仓做局部配置：

```
git -C unified config user.name  "pi-merge phase0"
git -C unified config user.email "phase0@local"
```

原三仓（`pi` / `oh-my-pi` / `deepseek-harness`）**内容零改动**，Phase 0 全程只读对待它们。

---

## 5. 构建系统基线

| 项 | 取值 |
|---|---|
| 包管理器 | **npm**（依据基底 `package-lock.json`） |
| 构建链 | esbuild + TypeScript（`typescript@7.0.2`）+ Biome（`@biomejs/biome@2.3.5`） |
| Node 要求 | `>=22.19.0`（`engines`）；本机实测 node v26.0.0 / npm 12.1.0 |
| 收敛原则 | 构建系统**只保留这一套**（MERGE-FINAL §1.2-4）。oh-my-pi 的 Bun/Bazel 层、DSH 的 pnpm+tsc **不引入**。Bun/Node 接触面须经抽象接口（如 `SessionStorageBackend`）隔离 |

### 5.1 Phase 0 已验证的构建事实

| 步骤 | 结果 |
|---|---|
| `npm ci` | ✅ 成功（319 packages）。注意 npm 12 的 `allowScripts` 门禁拦了 7 个包的 install scripts（含 `esbuild`），但平台二进制 `@esbuild/win32-x64` 就位、`esbuild --version` = 0.28.2，不影响构建 |
| `npm run build` | ✅ 成功（13 个包全部产出 `dist/`；`Built packages\coding-agent\dist\bundle (74 files, 8.6 MiB)`） |
| **可复现构建前提（重要）** | ⚠️ `packages/ai/src/providers/data/` 被 `.gitignore` 排除 —— **模型目录数据是从 models.dev 拉取的生成产物**。新克隆必须能访问 `https://models.dev`（或先跑 `npm run hydrate:model-data`）才能构建 `packages/ai`。`npm run build:offline` 在未 hydrate 的新克隆上必然失败（`ENOENT ... src/providers/data/amazon-bedrock.json`）。这不是本机缺陷，是上游前提 |
| `npm test` | ❌ 失败（Windows 上非绿，详见 `C:\Users\eihei\pi-compare\PHASE0-STATUS.md` §4.4）。已定位 `scripts/coding-agent-consumer.mjs:13-20` 的 `shell: true` + 未转义 `C:\Program Files\...` 为一个上游可移植性缺陷，且它会**短路掉全部 workspace 测试** |

---

## 6. 移植登记处（后续阶段在此追加）

| 日期 | 来源 commit | 目标路径 | 移植内容 | 许可审查 | 备注 |
|---|---|---|---|---|---|
| — | — | — | （Phase 0 尚未移植任何代码；`unified` 当前为 pi 的纯净镜像） | — | — |

### 移植件许可红线（复述）

1. MIT 三仓版权声明须在最终发布声明中并列：Mario Zechner、Can Bölük / Stencil Labs、DeepSeek AI。
2. DSH 侧继承的 **MPL-2.0**（libreoffice-kit）文件：**不并入**，或隔离到独立目录并保留其 notice。
3. **Anthropic SDK** 非标准许可件：逐文件审查后再决定是否可用。
