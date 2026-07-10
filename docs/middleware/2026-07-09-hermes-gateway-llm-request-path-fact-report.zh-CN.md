# Hermes 直连 LLM 请求与企业网关请求路径事实报告

日期：2026-07-09

## 结论

这次最新的 GLM 529 不像早先的路由或鉴权错误。最近失败簇已经走到正确的 Anthropic Messages 入口：`/v1/messages`、`anthropic-messages`、同一个 GLM profile/provider，并且上游返回的是 HTTP 529 overloaded。

“上下文太多”是当前最可疑的直接触发因素，但还不能严格证明为唯一根因。审计能证明失败请求是重型请求：约 217KB body、55 条 messages、27 个 tools、约 49KB tool schema、`max_tokens=4096`。最近一次成功请求也很接近：约 213KB body、53 条 messages、27 个 tools。差异只有约 4.7KB 和 2 条 messages，所以更准确的说法是：GLM 对这种长历史、多工具、多 tool_result 的 Anthropic 请求形态已经不稳定，而不是简单地“超过上下文长度就必然失败”。

当前企业网关与原版 Hermes 直连路径还没有完全等价。网关当前主要是 endpoint gate + 鉴权重建 + 透明转发 + 少量 `max_tokens` clamp + 流式清理，不是完整的 provider-specific 协议适配层。

## 原版 Hermes 直连路径

原版 Hermes 不通过统一内部 HTTP proxy 发 LLM 请求，而是在 agent 进程内按 provider 创建 SDK client。

代码事实：

- `tui_gateway/server.py` 调 `resolve_runtime_provider()`，然后创建 `AIAgent`。见 `tui_gateway/server.py:3486`。
- `AIAgent` 在 Anthropic mode 下创建 `build_anthropic_client(...)`，不创建 OpenAI client。见 `agent/agent_init.py:685`。
- Anthropic transport 生成 `messages.create()` / `messages.stream()` 参数，核心 body 是 `model`、`messages`、`max_tokens`，可选 `system`、`tools`、`tool_choice`、`thinking`。见 `agent/transports/anthropic.py:41`、`agent/anthropic_adapter.py:2256`、`agent/anthropic_adapter.py:2395`。
- Anthropic client 会把传入 base_url 去掉尾部 `/v1`，再让 SDK 调 `/v1/messages`。见 `agent/anthropic_adapter.py:753`。
- OpenAI-compatible transport 走 `chat.completions.create()`，即 `<base_url>/chat/completions`。见 `agent/chat_completion_helpers.py:1831`。
- Codex Responses transport 走 Responses 形状，核心是 `instructions`、`input`、`store:false`、可选 `max_output_tokens`。见 `agent/transports/codex.py:60`。

## 企业桌面到网关路径

企业桌面没有重写 conversation loop，而是生成受管 runtime home，把 provider 改成 `company-gateway`，让原来的 transport/client 调企业网关。

代码事实：

- Electron 生成受管 `config.yaml`，写入 `model.provider=company-gateway`、`model.default`、`model.api_mode`、`providers.company-gateway.base_url`、`key_env=COMPANY_GATEWAY_TOKEN`、`transport=apiMode`。见 `apps/desktop/electron/enterprise-runtime-home.cjs:410`。
- `base_url` 被规范化为带 `/v1` 的网关 API base。见 `apps/desktop/electron/enterprise-runtime-home.cjs:113`。
- profile 的 `apiFormat` 映射为 Python runtime 的 `api_mode`：`anthropic_messages`、`chat_completions` 或 `codex_responses`。见 `hermes_cli/runtime_provider.py:218`。
- 企业 provider 解析会从 policy/config 中读取 `company-gateway` 的 base_url、key_env、api_mode。见 `hermes_cli/runtime_provider.py:243`。
- 前端模型选择会保留 enterprise profile id，但发给 Python `session.create` 的主要是 `model` 和 `provider`；profile id 没有作为最终请求字段继续下传。见 `apps/desktop/src/lib/chat-runtime.ts:359`、`apps/desktop/src/app/session/hooks/use-session-actions.ts:467`。

## 企业网关实际行为

网关不会把 OpenAI Chat Completions 请求翻译成 Anthropic Messages 请求。endpoint 必须和 profile 的 `ApiFormat` 匹配。

代码事实：

- Gateway controller 同时暴露 `/v1/chat/completions` 和 `/v1/messages`。见 `EnterpriseGateway.Api/Controllers/Gateway/GatewayController.cs:10`、`GatewayController.cs:33`。
- `/v1/chat/completions` 只允许 `openai-chat` / `openai-compatible`；`/v1/messages` 只允许 `anthropic-messages`。见 `EnterpriseGateway.Api/Services/GatewayService.cs:861`。
- `BuildUpstreamUri()` 用 provider base_url 拼接同一个 endpoint，没有 OpenAI -> Anthropic 路由转换。见 `GatewayService.cs:875`。
- body 只做 `max_tokens` / `maxTokens` clamp，读取 `profile.RuntimeDefaultsJson.maxOutputTokens`，把过大的输出上限降到 profile 默认值。见 `GatewayService.cs:637`。
- `system`、`messages`、`tools`、`tool_choice` 不做协议转换，原样进入上游 body。见 `GatewayService.cs:620`。
- GLM 当前 `AuthMode=bearer`，所以上游使用 `Authorization: Bearer <providerSecret>`；Anthropic format 额外加 `anthropic-version`，默认 `2023-06-01`。见 `GatewayService.cs:716`、`GatewayService.cs:629`。
- 529 只在上游 HTTP 头阶段重试，最多 2 次，延迟 750ms/1500ms。见 `GatewayService.cs:710`。

## GLM 当前配置事实

当前 DB：`implementation/enterprise-gateway/EnterpriseGateway.Api/enterprise-gateway.db`

GLM provider：

- `Name=GLM CodePlan`
- `ProviderType=anthropic`
- `BaseUrl=https://open.bigmodel.cn/api/anthropic`
- `AuthMode=bearer`

GLM profile：

- `Name=GLM`
- `Model=glm-5.2`
- `ApiFormat=anthropic-messages`
- `runtimeDefaults.contextLengthTokens=128000`
- `runtimeDefaults.maxOutputTokens=4096`
- `capabilities.contextWindowTokens=960000`
- `capabilities.maxOutputTokens=128000`

这里的 `capabilities.maxOutputTokens=128000` 和 `runtimeDefaults.maxOutputTokens=4096` 表示两层语义：capabilities 描述模型或 provider 可宣称能力，runtime defaults 描述我们运行时默认要用的输出上限。最终请求应该优先使用 runtime defaults。

## 最近 529 审计事实

审计表口径：`ModelRequestAuditEvents WHERE RequestedModel='glm-5.2'`。

最近可比样本：

| 类型 | CreatedAt UTC | StatusCode | RequestId | DurationMs | bodyBytes | messages | tools | maxTokens | retry |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|
| 最近成功 | `2026-07-08 10:33:07.8031709+00:00` | 200 | `gwreq_8cabaf2cb03142c6a07682bde7051077` | 29881 | 212958 | 53 | 27 | 4096 | none |
| 最近失败 | `2026-07-09 02:32:23.2480918+00:00` | 529 | `202607091032244897c705c10e459d` | 3011 | 217710 | 55 | 27 | 4096 | 529 + 750ms, 529 + 1500ms |

更多事实：

- GLM 审计总计 203 条：529 为 108 条，200 为 69 条，404 为 14 条，499 为 6 条，401 为 5 条，400 为 1 条。
- 最后一次 200 之后共有 27 条，全部是 `529 upstream_error / UpstreamStatusCode=529`。
- 这 27 条全部走 `/v1/messages`、`anthropic-messages`、同一 GLM profile/provider。
- 更早确实有过协议/路由类失败：5 条 401 和 14 条 404 走 `/v1/chat/completions` / `openai-chat`；还有 1 条本地 400 `endpoint_api_format_mismatch`。这些不是最近 529 簇。
- 最近成功和最近失败都记录了 `maxTokensClamped from 128000 to 4096`，所以当前最新 529 不是因为输出上限仍是 128000。

## 关于“上下文是不是太多”

事实上还缺一个关键指标：估算 input tokens / context tokens。当前审计只有 bodyBytes、messages、tools、schema 体积，没有 token 估算，所以不能直接说“已经超过 128K context”。

当前更可靠的判断是：

- 不是早先的 404/401 协议入口问题。
- 不是 `max_tokens=128000` 直接打上游的问题，因为网关已经 clamp 到 4096。
- 最可疑的是输入侧过重：长 system、长历史 messages、多 tool_result、27 个 tools、较大的 tool schema。
- 但历史中存在更大的 bodyBytes 成功样本，因此 bodyBytes 不是单独充分条件。需要按 token、工具 schema、tool_result、thinking、上游容量状态一起看。

## 仍未闭环的问题

1. `runtimeDefaults.maxOutputTokens` 在 policy/runtime_provider 层能读到，但 TUI/desktop `_make_agent()` 构造 `AIAgent` 时没有把 `runtime["max_output_tokens"]` 传成 `max_tokens`。见 `tui_gateway/server.py:3511`、`agent/agent_init.py:486`、`agent/agent_init.py:1324`。
2. 当前能看到 `maxTokensClamped from 128000 to 4096`，说明桌面 agent 仍可能先生成 128000，再被网关兜底改成 4096。这是可用但不完整的实现。
3. 网关没有 provider-specific request adapter，不会做 OpenAI body -> Anthropic body 转换，也不会按 GLM 特性清理 tool schema 或 thinking 字段。
4. 网关重建 headers，不转发原版 Hermes/SDK 可能带的 provider-specific beta/header。GLM 现在能走通，但这类差异需要被显式建模。
5. 审计缺少 token 估算、request hash、tool schema hash、auth mode 快照、Retry-After/rate-limit、上游错误 body 安全摘要，因此不能把 529 精确拆成“上下文超限、工具 schema 不兼容、上游限流、容量过载”。

## 建议后续动作

1. 修 TUI/desktop runtime defaults 传递：把 `runtime["max_output_tokens"]` 传入 `AIAgent(max_tokens=...)`，不要只靠 gateway clamp。
2. 给 profile 增加明确的 request adapter 层：至少区分 `openai-chat`、`anthropic-messages`、`codex-responses`，并允许 GLM 这类 Anthropic-compatible provider 有自己的 header/body policy。
3. 增加输入侧保护：按模型 profile 做 token 估算、历史压缩、tool_result 摘要、按任务裁剪 tools。
4. 做最小 A/B 验证：
   - 网关 `/v1/messages` + 最小 GLM 请求。
   - 网关 `/v1/messages` + 当前 27 tools 但短历史。
   - 网关 `/v1/messages` + 当前长历史但裁剪 tools。
   - 同一重型请求绕过网关直连 GLM Anthropic endpoint。
5. 扩展审计 metadata：记录 `providerBaseUrl`、`authMode`、transport、canonical request hash、tool schema hash、估算 input tokens、上游 Retry-After/rate-limit、安全错误摘要。
