# 提供商

English | [中文](providers.zh.md)

多数托管提供商支持以下一种或两种认证方式：

- 通过 OAuth 的浏览器或设备流程登录。
- 提供 API key。

用 `/login [provider]` 查看某个提供商支持哪些方式。Amazon Bedrock 和 Google Vertex AI 还可以使用环境中的云凭据。

## 交互式认证

执行 `/login` 并选择一个提供商。Pi 会引导你走完它的 OAuth 或 API key 流程，并把得到的凭据存入 [`auth.json`](configuration.zh.md#agent-目录)。

在远程或无头机器上，OAuth 的回调可能到不了本地进程。被提示时，把最后的重定向 URL 或授权码粘贴回 Pi。

执行 `/logout` 并选择提供商可以删除它保存的凭据。这不会清除环境变量、不会移除 `models.json` 里的认证配置，也不会在提供商侧吊销该凭据。

`auth.json` 可能包含 API key 和 OAuth token。请妥善保管，不要提交到版本库。

## 从环境变量读取 API key

环境变量适合 CI，以及任何不希望 Pi 落盘保存 key 的场景。在启动 Pi 之前设置好变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

下表覆盖只有一个主要 API key 变量、且不需要额外配置的提供商。需要额外设置或支持环境凭据的提供商见[提供商专属配置](#提供商专属配置)。

| 提供商 | 环境变量 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| OpenCode Zen and Go | `OPENCODE_API_KEY` |
| Radius | `RADIUS_API_KEY` |
| TypeSafe（[分类模型](models.md#use-classifier-models)） | `TYPESAFE_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI (Global and China) | `MOONSHOT_API_KEY` |
| Qwen Token Plan and Individual | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

Anthropic 还把 `ANTHROPIC_OAUTH_TOKEN` 识别为 API 凭据，把 `ANTHROPIC_AUTH_TOKEN` 识别为 bearer 认证。

当 key 和 token 都未设置时，如果设置了 `ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID` 和 `ANTHROPIC_IDENTITY_TOKEN_FILE`，Anthropic 会使用工作负载身份联合认证：Anthropic SDK 用身份 token 换取短期 access token 并自行刷新（会重新读取身份 token 文件，所以长会话期间要保持该文件最新）。设置了 `ANTHROPIC_SERVICE_ACCOUNT_ID` 和 `ANTHROPIC_WORKSPACE_ID` 时会被透传。

## 从命令读取 API key

要在不把 key 落盘的前提下使用密钥管理器，把 `auth.json` 中某个提供商的 `key` 设成以 `!` 开头的命令：

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

Pi 会在首次需要该 key 时执行命令，并把它的标准输出缓存在本次进程生命周期内。输出为空、超时或退出码非零都会让 key 保持未解析状态，直到 Pi 重启。

## 提供商专属配置

下面的提供商需要额外准备、需要额外设置，或者可以使用其平台提供的凭据。

保存的 API key 凭据可以包含一个 `env` 对象。它的取值对该提供商优先于进程环境变量：

```json
{
  "cloudflare-workers-ai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "CLOUDFLARE_ACCOUNT_ID": "account-id"
    }
  }
}
```

### Radius

Radius 是 Pi 的构建方 Earendil Works 为 Pi 打造的服务。它提供可定制的 AI 网关，内置组织级管控与分析能力，并提供用于分享你用 Pi 做出的成果的 artifact。

在 Pi 里执行 `/login radius` 即可开始。这会把 Radius 加为提供商，它的模型会像其他提供商一样出现在 `/model` 里。

Radius 还带一个 MCP 服务器，所以 Pi 可以替你管理 Radius。

Radius 目前处于早期 alpha，演进很快。更多内容见 [radius.earendil.com](https://radius.earendil.com)。

Radius 认证使用它自己的网关目录，并缓存刷新后的模型元数据供之后离线启动使用。在 `models.json` 里配置的自定义 Radius 网关会使用它自己的目录，而不会继承公共的 `radius.pi.dev` 目录。

### Azure OpenAI

设置 API key，以及 base URL 或资源名二选一：

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# Or:
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

`ai.azure.com`、`cognitiveservices.azure.com` 和 `openai.azure.com` 下的资源根 URL 会被归一化到 OpenAI API 路径。

### Amazon Bedrock

Bedrock 可以使用 bearer token，也可以使用环境中的 AWS 凭据来源：

```bash
# Named profile
export AWS_PROFILE=your-profile

# IAM keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# Required for temporary credentials
export AWS_SESSION_TOKEN=...

# Bedrock bearer token
export AWS_BEARER_TOKEN_BEDROCK=...

# Region, when not supplied by the profile or AWS SDK configuration
export AWS_REGION=us-west-2
# AWS_DEFAULT_REGION is also supported
```

Pi 还通过标准的 `AWS_CONTAINER_CREDENTIALS_*` 和 `AWS_WEB_IDENTITY_TOKEN_FILE` 变量支持 ECS 任务凭据与 IRSA。

### Cloudflare AI Gateway

该网关需要 token、account ID 和 gateway ID：

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

account ID 与 gateway ID 可以来自进程环境，也可以来自 `auth.json` 中该凭据的 `env` 对象。

`CLOUDFLARE_API_KEY` 用来让 Pi 通过网关认证。对上游的访问可以使用 Cloudflare 统一计费、存放在网关里的凭据，或者在 `models.json` 中为该提供商配置的 `Authorization` 头。

### Cloudflare Workers AI

Workers AI 需要 token 和 account ID：

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

account ID 也可以存放在该凭据的 `env` 对象里。

### Google Vertex AI

使用 Google Cloud API key：

```bash
export GOOGLE_CLOUD_API_KEY=...
```

要使用应用默认凭据，需要配置 project 和 location：

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# GCLOUD_PROJECT is also supported
export GOOGLE_CLOUD_LOCATION=us-central1
```

然后完成认证：

```bash
gcloud auth application-default login
```

要改用服务账号 key 文件，则设置 `GOOGLE_APPLICATION_CREDENTIALS`，并同时给出 project 和 location。