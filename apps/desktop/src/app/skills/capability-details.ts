import type { Locale } from '@/i18n'
import { asText, toolsetDisplayLabel } from '@/app/settings/helpers'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

export interface CapabilityDetailCopy {
  bestFor: string[]
  configuration: string
  examples: string[]
  policyImpact: string
  riskBoundary: string
  summary: string
}

export function shortCapabilitySummary(detail: CapabilityDetailCopy): string {
  const text = detail.summary.trim()
  const match = text.match(/^(.+?[。.!?])(?:\s|$)/)

  return (match?.[1] || text).trim()
}

type DetailLocale = 'en' | 'zh'

interface ToolsetDetailEntry {
  aliases: string[]
  en: CapabilityDetailCopy
  zh: CapabilityDetailCopy
}

function detailLocale(locale: Locale): DetailLocale {
  return locale === 'zh' || locale === 'zh-hant' ? 'zh' : 'en'
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\s/]+/g, '-')
}

const TOOLSET_DETAILS: ToolsetDetailEntry[] = [
  {
    aliases: ['env', 'environment', 'environment-variable', 'environment variable tools', '环境变量工具'],
    zh: {
      summary: '用于查看环境变量和密钥相邻配置，帮助判断某个能力为什么显示已配置、缺密钥或被策略限制。',
      bestFor: ['排查 provider、MCP、外部服务是否具备必要环境变量。', '确认密钥是否已存在，但不直接暴露密钥明文。'],
      configuration: '通常由本机环境、配置文件或企业下发策略提供；普通用户可能只能查看受限状态。',
      policyImpact: '企业策略可以限制读取范围，受限时即使开关显示也不会进入当前会话 callable tools。',
      riskBoundary: '不要在说明、截图或日志里泄露密钥值；页面只应展示是否配置和必要提示。',
      examples: ['为什么模型提供方显示需要密钥？', '检查浏览器工具需要哪些环境配置。']
    },
    en: {
      summary: 'Inspect environment-variable and secret-adjacent configuration without exposing raw secrets.',
      bestFor: ['Checking whether a provider, MCP server, or external service has required variables.', 'Diagnosing missing-key states.'],
      configuration: 'Usually provided by local environment, profile config, or enterprise policy.',
      policyImpact: 'Enterprise policy may restrict what can be inspected and whether tools enter callable schemas.',
      riskBoundary: 'Never expose secret values in UI, logs, screenshots, or prompts.',
      examples: ['Why does a provider say it needs keys?', 'Check what configuration a browser tool requires.']
    }
  },
  {
    aliases: ['browser', 'browser-tools', '浏览器工具'],
    zh: {
      summary: '用于浏览器导航、页面检查和自动化操作，适合让助手打开网页、点击、滚动、读取页面结构或截图。',
      bestFor: ['复查实际网页界面、后台页面、登录后的产品页面。', '让助手基于页面快照判断按钮、文案、布局是否正确。'],
      configuration: '通常需要本地浏览器自动化运行环境；部分 web_search 能力可能还需要单独服务或策略允许。',
      policyImpact: '页面显示浏览器工具已配置，不代表当前会话一定有 web_search callable tool；最终以当前会话实际可用工具列表为准。',
      riskBoundary: '避免让助手操作高风险按钮；涉及账号、付款、删除、发布时需要人工确认。',
      examples: ['打开后台权限页面并检查工具开关。', '用浏览器访问网页，但不要假设 web_search 工具已经可调用。']
    },
    en: {
      summary: 'Browser navigation, page inspection, and automation for real UI checks.',
      bestFor: ['Inspecting product pages, admin screens, and logged-in experiences.', 'Reading snapshots, clicking, scrolling, and checking layout.'],
      configuration: 'Requires the local browser automation runtime; web search may still be a separate tool or policy gate.',
      policyImpact: 'Configured browser access does not guarantee web_search is callable in the current session.',
      riskBoundary: 'Avoid destructive or account-sensitive actions without human confirmation.',
      examples: ['Open an admin page and inspect tool toggles.', 'Browse a page without assuming web_search is callable.']
    }
  },
  {
    aliases: ['model-provider', 'model-provider-tools', 'provider', 'providers', '模型提供方工具'],
    zh: {
      summary: '用于管理模型 provider endpoint、API key 和路由配置，是模型列表、模型可见性和供应商切换的基础。',
      bestFor: ['排查为什么某个模型不可见、不可用或需要密钥。', '理解企业下发的 provider 策略是否覆盖了本地配置。'],
      configuration: '通常需要 endpoint、API key、模型映射和可见性配置；企业环境可能由后台统一下发。',
      policyImpact: '被禁止或受限时，用户开关不能绕过 provider 策略，相关模型也不应进入可选列表。',
      riskBoundary: '不要在客户端展示完整 API key；变更 provider 可能影响所有新会话的路由。',
      examples: ['为什么 kimi 模型显示不可用？', '确认企业 provider 是否覆盖了本地模型配置。']
    },
    en: {
      summary: 'Provider endpoints, API keys, and routing configuration for model access.',
      bestFor: ['Diagnosing unavailable models or missing keys.', 'Understanding enterprise-provider overrides.'],
      configuration: 'Requires endpoints, API keys, model mappings, and visibility settings.',
      policyImpact: 'Restricted or blocked provider policy cannot be bypassed from the toggle UI.',
      riskBoundary: 'Do not reveal raw API keys; provider changes affect new-session routing.',
      examples: ['Why is a model unavailable?', 'Check whether enterprise policy overrides local providers.']
    }
  },
  {
    aliases: ['file', 'files', 'file-operations', 'filesystem', '文件工具'],
    zh: {
      summary: '用于读取、搜索、写入或补丁修改工作区文件。它决定助手能否直接查看代码、编辑文档和落地计划。',
      bestFor: ['代码审查、wiki 写入、配置修复、批量搜索。', '把讨论结果沉淀为实际文件变更。'],
      configuration: '需要工作区权限和文件系统策略允许；受限目录即使页面显示工具存在也不能写入。',
      policyImpact: '企业策略可以只允许读取、禁止写入，或限制到指定 workspace root。',
      riskBoundary: '写入、删除、移动文件需要遵守工作区边界；高风险改动要保留可追溯 diff。',
      examples: ['搜索技能说明来源。', '把 U2.5 计划写入 wiki，但不要改 references 目录。']
    },
    en: {
      summary: 'Read, search, write, and patch workspace files.',
      bestFor: ['Code review, wiki updates, config fixes, and repository searches.', 'Persisting conclusions as actual file changes.'],
      configuration: 'Requires workspace file permissions and policy allowance.',
      policyImpact: 'Enterprise policy may allow read-only access or restrict writable roots.',
      riskBoundary: 'Writes, deletes, and moves must respect workspace boundaries and preserve reviewable diffs.',
      examples: ['Search skill instruction sources.', 'Write the U2.5 plan into the wiki.']
    }
  },
  {
    aliases: ['terminal', 'shell', '终端工具'],
    zh: {
      summary: '用于执行本地命令、构建、测试和查看进程状态，是最强也最需要管控的本机能力之一。',
      bestFor: ['运行测试、构建项目、读取 git 状态、启动开发服务器。', '复现错误并收集命令输出证据。'],
      configuration: '需要 shell runtime 和策略授权；企业环境常把它标为受限或禁止。',
      policyImpact: '受限/已禁止时，开关不能让 terminal 进入当前 callable schema；需要管理员策略放行。',
      riskBoundary: '避免破坏性命令、批量删除、跨目录写入和泄密输出；必要时要求人工批准。',
      examples: ['运行 Skills 页面测试。', '查看 git diff，但不要执行 destructive reset。']
    },
    en: {
      summary: 'Run local commands for builds, tests, process inspection, and diagnostics.',
      bestFor: ['Running tests, builds, git status, and dev servers.', 'Reproducing errors and collecting command evidence.'],
      configuration: 'Requires shell runtime and policy permission.',
      policyImpact: 'Restricted or blocked shell access will not enter the current callable schema.',
      riskBoundary: 'Avoid destructive commands, broad writes, and secret leakage.',
      examples: ['Run the Skills page tests.', 'Inspect git diff without destructive reset.']
    }
  },
  {
    aliases: ['mcp', 'mcp-tools', 'mcp 工具'],
    zh: {
      summary: '用于安装、探测、测试或连接 MCP server，让助手接入外部系统和专用工具。',
      bestFor: ['检查某个 MCP 是否可用。', '连接 GitHub、浏览器、企业内部系统等外部能力。'],
      configuration: '通常需要 server 配置、认证信息和本地进程/网络可达性。',
      policyImpact: '企业策略可禁止安装、探测或运行 MCP；页面显示条目不代表 server 已被加载。',
      riskBoundary: 'MCP 可能触达外部数据源，需注意权限范围、审计和凭据隔离。',
      examples: ['检查 filesystem MCP 为什么被禁止。', '确认 MCP server 是否能进入当前上下文。']
    },
    en: {
      summary: 'Install, probe, test, and connect MCP servers for external capabilities.',
      bestFor: ['Checking whether an MCP server is available.', 'Connecting GitHub, browser, or internal systems.'],
      configuration: 'Requires server configuration, authentication, process, and network availability.',
      policyImpact: 'Enterprise policy may block install, probe, or runtime loading.',
      riskBoundary: 'MCP servers may reach external data; keep permissions, audit, and credentials scoped.',
      examples: ['Why is filesystem MCP blocked?', 'Check whether a server enters the current context.']
    }
  },
  {
    aliases: ['browser-automation', 'browser automation'],
    zh: {
      summary: '用户创建的浏览器自动化工具集，包含导航、点击、输入、滚动、截图、控制台和页面视觉检查等工具。',
      bestFor: ['让助手在真实页面上复查交互。', '定位 UI 文案、布局、按钮状态和页面错误。'],
      configuration: '显示已配置说明本地工具集存在；具体工具是否进入会话仍取决于当前上下文和策略。',
      policyImpact: '若企业策略限制浏览器或 web 搜索，工具集开关不会覆盖策略限制。',
      riskBoundary: '不要默认授权提交、付款、删除、发布等不可逆操作。',
      examples: ['打开工具页截图并判断哪些状态容易误解。', '访问新闻页，但说明 web_search 不一定可调用。']
    },
    en: {
      summary: 'User-created browser automation tools: navigate, click, type, scroll, screenshot, console, and vision.',
      bestFor: ['Reviewing real-page interactions.', 'Checking UI copy, layout, button state, and page errors.'],
      configuration: 'Configured means the local toolset exists; current-session callable tools are still context gated.',
      policyImpact: 'Enterprise browser or web-search restrictions still apply.',
      riskBoundary: 'Do not perform irreversible submit, payment, delete, or publish actions without confirmation.',
      examples: ['Inspect the tool page state.', 'Browse a news page while clarifying web_search availability.']
    }
  },
  {
    aliases: ['code-execution', 'execute-code', 'code execution'],
    zh: {
      summary: '用于在受控环境执行代码片段，适合快速验证算法、解析数据或生成临时计算结果。',
      bestFor: ['验证小段代码逻辑。', '处理一次性数据转换或结果计算。'],
      configuration: '需要可用执行沙箱；不等同于完整 terminal 权限。',
      policyImpact: '企业策略可限制执行语言、网络、文件访问或完全禁止。',
      riskBoundary: '不要执行不可信代码、持久化副作用或读取敏感文件。',
      examples: ['快速验证 JSON 解析逻辑。', '用受控代码计算一组统计值。']
    },
    en: {
      summary: 'Execute snippets in a controlled environment for quick validation or data processing.',
      bestFor: ['Testing small logic blocks.', 'One-off data transforms or calculations.'],
      configuration: 'Requires an execution sandbox; it is not full terminal access.',
      policyImpact: 'Policy may restrict language, network, file access, or block execution.',
      riskBoundary: 'Do not run untrusted code or read sensitive files.',
      examples: ['Validate JSON parsing.', 'Compute a small statistic.']
    }
  },
  {
    aliases: ['web', 'web-search', 'web-search-scraping', 'web search & scraping'],
    zh: {
      summary: '用于网页搜索和抓取。它和浏览器工具相关但不是同一个能力：浏览器能打开网页，不代表 web_search 当前可调用。',
      bestFor: ['查找公开网页信息。', '抽取网页内容并进行来源核验。'],
      configuration: '可能需要搜索服务、网络策略、API key 或工具 schema 注入；当前会话未注入时无法调用。',
      policyImpact: '企业策略可以禁用 web_search，同时仍允许浏览器导航或页面检查。',
      riskBoundary: '搜索结果需要来源核验；不要把未验证网页内容当作内部事实。',
      examples: ['查今天新闻时确认当前是否有 web_search。', '浏览网页可用，但向用户说明搜索工具未必可用。']
    },
    en: {
      summary: 'Web search and scraping. Related to browser access, but not the same callable capability.',
      bestFor: ['Finding public web information.', 'Extracting page content with source checks.'],
      configuration: 'May require a search service, network policy, API key, and schema injection.',
      policyImpact: 'Policy can disable web_search while still allowing browser navigation.',
      riskBoundary: 'Verify sources; do not treat unchecked web content as internal fact.',
      examples: ['Check whether web_search is callable before current-news lookup.', 'Explain that browsing is not search-tool access.']
    }
  },
  {
    aliases: ['task-delegation', 'delegate-task', 'delegation'],
    zh: {
      summary: '用于把任务拆给 subagent 并收集结果。适合实现、审查、调研并行推进，但主线程仍要负责合并判断。',
      bestFor: ['让 worker 实现，主线程做 review。', '并行检查代码、测试、文档和验收标准。'],
      configuration: '需要可用的多 agent runtime；不同 worker 仍受各自工具和策略限制。',
      policyImpact: '企业策略可能限制可派发工具、文件权限和外部访问。',
      riskBoundary: '不要把最终决策完全交给 worker；敏感修改需要主线程复核。',
      examples: ['派 subagent 修复，主线程只审查。', '并行审查 U2.5 的 UI 和策略语义。']
    },
    en: {
      summary: 'Delegate work to subagents and collect results while the main thread coordinates review.',
      bestFor: ['Workers implement while the main thread reviews.', 'Parallel code, test, doc, and acceptance checks.'],
      configuration: 'Requires multi-agent runtime; workers still follow their own tool and policy limits.',
      policyImpact: 'Policy may restrict delegated tools, file access, or external access.',
      riskBoundary: 'Do not outsource final decisions; sensitive changes need main-thread review.',
      examples: ['Have a subagent fix while this thread reviews.', 'Parallel-review UI and policy semantics.']
    }
  },
  {
    aliases: ['memory'],
    zh: {
      summary: '用于跨会话读取或维护长期记忆，帮助助手找回之前的项目决策、路径、偏好和证据。',
      bestFor: ['复查之前讨论过的 Hermes 规划。', '根据历史偏好保持 wiki、审查和交付格式一致。'],
      configuration: '需要本地记忆目录和读取权限；更新记忆通常需要用户明确要求。',
      policyImpact: '企业策略可限制记忆读取范围或禁用持久化。',
      riskBoundary: '记忆可能过期；关键事实需要重新验证后再作为当前结论。',
      examples: ['回忆 U3 为什么不包含 AdminWeb。', '查之前怎么约定 subagent 分工。']
    },
    en: {
      summary: 'Persistent memory across sessions for prior decisions, paths, preferences, and evidence.',
      bestFor: ['Recovering prior Hermes planning context.', 'Keeping wiki, review, and delivery format consistent.'],
      configuration: 'Requires local memory access; updates usually need explicit user request.',
      policyImpact: 'Policy may restrict memory scope or disable persistence.',
      riskBoundary: 'Memory may be stale; verify important facts before using them as current truth.',
      examples: ['Recall why U3 excluded AdminWeb.', 'Find prior subagent coordination rules.']
    }
  },
  {
    aliases: ['skills', 'skill', 'skill-management'],
    zh: {
      summary: '用于列出、查看和管理技能。技能通过 SKILL.md 给模型补充任务流程、约束和领域经验。',
      bestFor: ['查看某个技能适合什么任务。', '确认技能说明是否足够让新 agent 接手。'],
      configuration: '技能启用通常应用于新会话；详情可读取原始 SKILL.md。',
      policyImpact: '企业策略可默认启用、推荐、限制或禁止技能，但不应删除用户创建技能的可见性。',
      riskBoundary: '技能说明不是权限本身；最终可调用工具仍由当前会话 schema 和策略决定。',
      examples: ['展开 project-llm-wiki 查看原始说明。', '确认某个 skill 是推荐还是用户创建。']
    },
    en: {
      summary: 'List, inspect, and manage skills. Skills use SKILL.md to add workflow guidance and domain context.',
      bestFor: ['Understanding when to use a skill.', 'Checking whether instructions are clear enough for a new agent.'],
      configuration: 'Skill toggles usually apply to new sessions; details can show the raw SKILL.md.',
      policyImpact: 'Policy can default-enable, recommend, restrict, or block skills without hiding user-created entries.',
      riskBoundary: 'Skill instructions are not permissions; callable tools still depend on the current schema and policy.',
      examples: ['Open project-llm-wiki raw instructions.', 'Check whether a skill is recommended or user-created.']
    }
  }
]

function fallbackToolsetDetail(toolset: ToolsetInfo, locale: Locale): CapabilityDetailCopy {
  const label = toolsetDisplayLabel(toolset)
  const description = asText(toolset.description)

  if (detailLocale(locale) === 'zh') {
    return {
      summary: description || `${label} 是当前运行时暴露的一组工具能力。`,
      bestFor: ['查看这组能力包含哪些工具。', '判断开关状态、配置状态和当前会话可调用工具之间的关系。'],
      configuration: '若页面只显示短说明，说明该工具集尚未维护专门中文详情；可先参考工具名和原始描述。',
      policyImpact: '企业策略可能让条目显示为默认启用、推荐、受限或禁止；当前会话仍以实际可用工具列表为准。',
      riskBoundary: '未知工具集先按最小权限理解，涉及外部系统、文件或命令时需要额外确认。',
      examples: [`什么时候使用 ${label}？`, `这个工具集包含哪些 callable tools？`]
    }
  }

  return {
    summary: description || `${label} is a toolset exposed by the current runtime.`,
    bestFor: ['Checking which tools are included.', 'Understanding toggle, configuration, and callable-schema state.'],
    configuration: 'No curated detail is available yet; use the short description and tool names as the fallback.',
    policyImpact: 'Enterprise policy may default-enable, recommend, restrict, or block this entry.',
    riskBoundary: 'Treat uncategorized toolsets with least privilege, especially for external systems, files, and commands.',
    examples: [`When should I use ${label}?`, `Which callable tools are included?`]
  }
}

export function getToolsetDetail(toolset: ToolsetInfo, locale: Locale): CapabilityDetailCopy {
  const haystack = normalize(`${toolset.name} ${toolset.label}`)
  const rawHaystack = `${toolset.name} ${toolset.label}`.toLowerCase()
  const entry = TOOLSET_DETAILS.find(item =>
    item.aliases.some(alias => haystack.includes(normalize(alias)) || rawHaystack.includes(alias.toLowerCase()))
  )

  return entry ? entry[detailLocale(locale)] : fallbackToolsetDetail(toolset, locale)
}

interface SkillZhDetail {
  bestFor: string[]
  examples?: string[]
  summary: string
}

const SKILL_DETAILS_ZH: Record<string, SkillZhDetail> = {
  'ascii-art': {
    summary: '生成 ASCII 字符画、横幅文字、cowsay/boxes 文本框，以及图片转字符画。',
    bestFor: ['需要纯文本视觉效果、终端横幅、README 装饰或图片转字符画时使用。', '适合快速生成不依赖复杂图形资产的文本视觉。'],
    examples: ['把“Release Ready”做成 ASCII 横幅。', '把一张小图转成终端可显示的字符画。']
  },
  'ascii-video': {
    summary: '把视频或音频转换成彩色 ASCII MP4/GIF，适合做文本风格的视频效果。',
    bestFor: ['制作 ASCII 风格演示、动图或短视频。', '把普通视频转换成可分享的字符画视觉。']
  },
  'baoyu-infographic': {
    summary: '生成信息图和可视化版式，提供多种布局与风格组合。',
    bestFor: ['把调研结论、流程、对比关系做成信息图。', '需要快速产出结构化视觉摘要时使用。']
  },
  'claude-design': {
    summary: '生成一次性 HTML 设计稿，例如 landing page、deck 或 prototype。',
    bestFor: ['快速探索产品视觉方向。', '需要可打开预览的 HTML 原型时使用。']
  },
  comfyui: {
    summary: '通过 ComfyUI 生成或处理图像、视频和音频，并管理模型、节点和工作流。',
    bestFor: ['运行 ComfyUI 工作流。', '需要图像/视频生成或参数化工作流执行时使用。']
  },
  excalidraw: {
    summary: '生成手绘风格的 Excalidraw JSON 图，例如架构图、流程图和时序图。',
    bestFor: ['需要可继续编辑的手绘图。', '把系统结构或流程关系画成轻量图示。']
  },
  humanizer: {
    summary: '润色文本，去掉明显 AI 腔，让语气更自然、更像真人表达。',
    bestFor: ['改写公告、总结、邮件和说明文案。', '把机械表达变得更自然。']
  },
  'manim-video': {
    summary: '用 Manim 生成数学、算法或概念讲解动画。',
    bestFor: ['制作 3Blue1Brown 风格的数学/算法视频。', '把抽象概念转成动态演示。']
  },
  p5js: {
    summary: '生成 p5.js 草图、生成艺术、交互动画、shader 或 3D 小实验。',
    bestFor: ['做浏览器里的创意编码实验。', '快速验证视觉互动或动效想法。']
  },
  'popular-web-designs': {
    summary: '参考真实设计系统，生成接近 Stripe、Linear、Vercel 等风格的 HTML/CSS。',
    bestFor: ['需要成熟产品视觉参考。', '快速生成不同品牌感的网页设计变体。']
  },
  pretext: {
    summary: '生成复杂文字布局、动效排版、文字几何和文本驱动的创意浏览器 demo。',
    bestFor: ['做文字为主体的互动视觉。', '需要 DOM-free 文本布局或动态排版效果。']
  },
  sketch: {
    summary: '生成 2 到 3 个可比较的 HTML mockup 设计方案。',
    bestFor: ['早期比较多个页面设计方向。', '需要低成本快速看方案差异。']
  },
  'songwriting-and-ai-music': {
    summary: '辅助写歌、歌词构思和 Suno AI 音乐提示词。',
    bestFor: ['创作歌词、曲风描述和音乐生成 prompt。', '把主题转成可用于音乐生成的结构化提示。']
  },
  plan: {
    summary: '只写可执行 Markdown 计划，不直接执行；强调小任务、明确路径和完整代码边界。',
    bestFor: ['先规划再实现的复杂改动。', '需要把任务拆成 agent 可接手的步骤。']
  },
  'requesting-code-review': {
    summary: '提交前做代码审查，覆盖安全、质量门禁和可自动修复的问题。',
    bestFor: ['准备提交前复查风险。', '需要优先发现 bug、回归和缺测试点。']
  },
  'simplify-code': {
    summary: '并行清理近期代码改动，降低复杂度并去掉不必要的实现。',
    bestFor: ['改动完成后做简化。', '发现实现变重、重复或难维护时使用。']
  },
  spike: {
    summary: '在正式实现前做小实验，用最低成本验证想法是否可行。',
    bestFor: ['技术路线不确定。', '需要先确认 API、性能或交互方案能跑通。']
  },
  'systematic-debugging': {
    summary: '按阶段做根因分析，先理解 bug 再修复。',
    bestFor: ['问题复杂、症状和根因不一致。', '需要复现、定位、假设验证和修复闭环。']
  },
  'test-driven-development': {
    summary: '按 RED-GREEN-REFACTOR 方式先写测试再实现。',
    bestFor: ['行为边界清楚但实现未写。', '希望用测试锁住回归风险。']
  }
}

function skillCategoryLabel(category: string): string {
  const key = normalize(category)
  const labels: Record<string, string> = {
    'autonomous-ai-agents': '代理协作',
    creative: '创意生成',
    'data-science': '数据分析',
    email: '邮件处理',
    general: '通用',
    github: 'GitHub 协作',
    media: '媒体生成',
    mlops: '机器学习工程',
    'note-taking': '笔记整理',
    productivity: '效率工具',
    research: '调研',
    skills: '技能管理',
    'smart-home': '智能家居',
    'software-development': '软件开发',
    system: '系统',
    terminal: '终端执行'
  }

  return labels[key] || category || '通用'
}

function skillDetailZh(skill: SkillInfo, description: string, category: string): CapabilityDetailCopy {
  const key = normalize(skill.name)
  const curated = SKILL_DETAILS_ZH[key]
  const categoryLabel = skillCategoryLabel(category)
  const summary = curated?.summary || (description ? `${skill.name} 用于${categoryLabel}任务：${description}` : `${skill.name} 用于${categoryLabel}任务，展开后可查看完整 SKILL.md 原文。`)
  const bestFor =
    curated?.bestFor ||
    (description
      ? [`当任务需要 ${description} 时使用。`, `需要让模型按 ${categoryLabel} 领域的既定流程工作时使用。`]
      : [`处理 ${categoryLabel} 类任务时使用。`, '需要查看该技能的完整原始说明时使用。'])

  return {
    summary,
    bestFor,
    configuration: '技能开关通常应用于新会话；展开详情会读取现有 SKILL.md 原文，读取失败不影响列表使用。',
    policyImpact: '企业策略可以推荐、默认启用、受限或禁止技能；受限/禁止时用户不能通过开关绕过。',
    riskBoundary: '技能只提供行为指导，不等于授予文件、终端、网络等工具权限；最终可用工具仍以当前会话为准。',
    examples: curated?.examples || [`什么时候应该使用 ${skill.name}？`, `查看 ${skill.name} 的原始 SKILL.md。`]
  }
}

export function getSkillDetail(skill: SkillInfo, locale: Locale): CapabilityDetailCopy {
  const description = asText(skill.description)
  const category = asText(skill.category) || 'general'

  if (detailLocale(locale) === 'zh') {
    return skillDetailZh(skill, description, category)
  }

  if (detailLocale(locale) === 'zh') {
    return {
      summary: `${skill.name} 技能用于在相关任务中加载 SKILL.md 流程说明，让模型按既定步骤、限制和交付格式工作。`,
      bestFor: [`处理 ${category} 类任务时，让模型先读取该技能的完整说明。`, '让新会话获得更稳定的领域流程和交付约束。'],
      configuration: '技能开关通常应用于新会话；展开详情会读取现有 SKILL.md 原文，读取失败不影响列表使用。',
      policyImpact: '企业策略可以推荐、默认启用、受限或禁止技能；受限/禁止时用户不能通过开关绕过。',
      riskBoundary: '技能只提供行为指导，不等于授予文件、终端、网络等工具权限。',
      examples: [`什么时候应该使用 ${skill.name}？`, `查看 ${skill.name} 的原始 SKILL.md。`]
    }
  }

  return {
    summary: description || `${skill.name} injects task guidance through SKILL.md.`,
    bestFor: [`Loading the full skill instructions for ${category} tasks.`, 'Giving new sessions stable workflow and delivery guidance.'],
    configuration: 'Skill toggles usually apply to new sessions; expanding details loads the raw SKILL.md when available.',
    policyImpact: 'Policy can recommend, default-enable, restrict, or block a skill.',
    riskBoundary: 'A skill is guidance, not permission for files, terminal, network, or other tools.',
    examples: [`When should ${skill.name} be used?`, `View the raw SKILL.md for ${skill.name}.`]
  }
}
