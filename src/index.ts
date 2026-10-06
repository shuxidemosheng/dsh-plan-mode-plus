/**
 * dsh-plan-mode-plus 宿主 half：在官方 @deepseek-ai/dsh-plan-mode 之上，
 * 把 DeepSeek Harness 的计划模式补齐到 ZCode（zai-org/ZCode）开源实现的形态：
 *
 *  1. `enter_plan_mode` 工具 —— 模型主动请求进入计划模式（对齐 ZCode 的
 *     EnterPlanMode：无参数、权限层自动放行、成功后向模型注入"接下来做什么"）。
 *     官方只允许用户敲 /plan 进入；本工具补上模型发起的入口。
 *     退出仍走官方 exit_plan_mode（评审流原样保留，不重复造）。
 *
 *  2. `ctx.tools.guard()` 硬拦截 —— 计划模式活跃期间，denylist 里的写类工具
 *     在分发前被直接拒绝，拒绝文案逐字取自 ZCode checkPlanMode()
 *     （"Plan mode only allows read-only, non-destructive tools"）。
 *     官方立场是 "Guidance, not enforcement"（纯文本引导）；这是本插件
 *     主动做出的偏离，也是核心卖点。
 *
 *  3. `plan:workflow-plus` 提示词节 —— ZCode 四阶段计划工作流
 *     （探索 → 设计 → 评审 → exit_plan_mode），仅计划模式活跃时渲染。
 *     ZCode 把它作为每回合的 runtime reminder 注入；dsh 的对应机制是
 *     条件化 system prompt section（官方 plan:policy 同款，对请求缓存友好）。
 *
 * —— 状态读写（刻意不触碰 planMode 服务实例）——————————————
 *
 * web/desktop 表面里，host 平面的官方 plan-mode 条目被 dsh-web-app 补丁
 * disable，planMode 服务由 agent preset 逐会话挂载在隔离域内——从本插件的
 * 全局上下文既等不到它，也取不到它。因此本插件只依赖两样全局可见的东西：
 *
 *  - 读：`sessionProjections.stateOf(session, 'plan')`。plan 投影定义由官方
 *    plan-mode 插件注册进共享的投影注册表（sessionProjections 是 host 平面
 *    共享服务，不在 isolate 名单里），键未注册时 stateOf 返回 undefined，
 *    本插件按"计划模式不可用"处理——没有挂官方 plan-mode 的 preset 里
 *    三个部件全部自动失活。
 *
 *  - 写：`session.append('plan/mode', { active: true })`。这是官方词汇表内
 *    的事件类型（KNOWN_SESSION_EVENT_TYPES），官方 planMode.set 落日志时
 *    追加的正是同一事件；直接追加意味着立即生效（不等 step 边界），与
 *    ZCode 的 EnterPlanMode 即时生效一致。官方 plan:policy 节、/plan off、
 *    exit_plan_mode 评审流都读同一个投影，双向兼容。
 *
 * 与官方 set() 的语义差异（有意为之，README 有记录）：官方在轮次中把切换
 * 排队到下一个 accepted pre-step；本工具立即落日志。代价是若本次调用所在
 * 步骤之后被中止，进入计划模式这一事实仍然成立——进入是可逆的（/plan off），
 * 与 ZCode 行为一致。
 *
 * @module dsh-plan-mode-plus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 纯类型导入：引入 @deepseek-ai/dsh-plan-mode 对 SessionEventMap 的
// 'plan/mode' 事件类型增强与 SessionProjectionStateMap 的 'plan' 投影状态
// 增强。运行时不经此包（服务由宿主按 preset 提供，事件类型在宿主
// KNOWN_SESSION_EVENT_TYPES 词汇表内）。
import type {} from '@deepseek-ai/dsh-plan-mode'
// 纯类型导入：引入 ctx.sessionProjections 的服务声明（编译期类型检查需要）。
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
// AssembleContext：system prompt section text 回调的参数类型。
// 注意：npm 版 d.ts 上没有 agent 字段，但运行时官方 plan-mode 就是从这里读
// agent 的（asar 内源码逐字可证）；下方用交叉类型补上并做防御式判空。
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

// 函数式 Cordis 插件三件套：name / inject / apply。
// 注意：绝不能加 export default——Loader 的 unwrapExports 会折叠模块并丢弃
// inject（官方 postmortem 0001）。
export const name = 'plan-mode-plus'
// 硬依赖服务：tools（注册工具 + 挂 guard）、systemPrompt（注册工作流提示词节）、
// sessionProjections（读 plan 投影折叠状态）。三者都是 host 平面共享服务，
// dsh-base 组合必带；不依赖 per-agent 隔离域里的 planMode 服务实例。
export const inject = ['tools', 'systemPrompt', 'sessionProjections']

/** 插件配置（对应 patch 行里的 config 字段）。 */
export interface Config {
  /**
   * 注册的工具名（默认 'enter_plan_mode'）。
   * 与 todo-plus 的 toolName 同款逃生口：万一别的插件占了这个名字，
   * 改这里即可共存，而不是双注册竞态炸掉 preset 审计。
   */
  toolName?: string
  /**
   * 计划模式期间被硬拦截的模型侧工具名（默认对齐 ZCode 的写类分类：
   * Write/Edit/ApplyPatch/Bash → dsh 的 write/edit/str_replace_editor/bash+pwsh）。
   * 空数组等价于 enforce: false。
   */
  denyTools?: string[]
  /**
   * 是否启用硬拦截（默认 true）。false 时回到官方"纯引导"行为：
   * 只保留 enter_plan_mode 工具与工作流提示词节。
   */
  enforce?: boolean
}

/**
 * 默认拦截名单。逐名核实自 app.asar 内各官方 dsh-tool-* 的 defineTool 调用：
 *   - bash / pwsh          —— shell 执行（ZCode 的 Bash：write + destructive）
 *   - write / edit         —— dsh-tool-fs 的文件写入与编辑（ZCode 的 Write/Edit）
 *   - str_replace_editor   —— 单文件编辑器（ZCode 的 ApplyPatch 对应物；
 *                             cordis preset 未挂载它，但列上无害，换 preset 也受保护）
 * 放行侧（对齐 ZCode 只读表）：read/read_image/glob/grep、web_search/web_fetch、
 * todo_write、ask_user_question、skill、present、goal 系列、subagent、
 * send_message/interrupt_agent，以及全部 MCP 工具（ZCode 放行非破坏性 MCP）。
 */
const DEFAULT_DENY_TOOLS = ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor']

/**
 * 手写配置校验（风格对齐官方 plan-mode 的 resolveConfig）：
 * 未知键直接抛错，让部署笔误在启动时就炸出来而不是静默生效。
 */
function resolveConfig(config: Config | undefined): { toolName: string; denyTools: string[]; enforce: boolean } {
  if (config === undefined) {
    return { toolName: 'enter_plan_mode', denyTools: DEFAULT_DENY_TOOLS, enforce: true }
  }
  const unknown = Object.keys(config).filter(key => key !== 'toolName' && key !== 'denyTools' && key !== 'enforce')
  if (unknown.length > 0) {
    throw new Error(
      `dsh-plan-mode-plus config has unknown key(s) ${unknown.join(', ')}`
      + ' — config is { toolName?, denyTools?, enforce? }',
    )
  }
  const toolName = config.toolName
  if (toolName !== undefined && (typeof toolName !== 'string' || toolName.trim() === '')) {
    throw new Error('dsh-plan-mode-plus config: `toolName` must be a non-empty string when present')
  }
  const denyTools = config.denyTools
  if (denyTools !== undefined) {
    if (!Array.isArray(denyTools) || denyTools.some(name => typeof name !== 'string' || name.trim() === '')) {
      throw new Error('dsh-plan-mode-plus config: `denyTools` must be an array of non-empty tool names when present')
    }
  }
  const enforce = config.enforce
  if (enforce !== undefined && typeof enforce !== 'boolean') {
    throw new Error('dsh-plan-mode-plus config: `enforce` must be a boolean when present')
  }
  return {
    toolName: toolName?.trim() ?? 'enter_plan_mode',
    denyTools: denyTools ?? DEFAULT_DENY_TOOLS,
    enforce: enforce ?? true,
  }
}

/**
 * 读一个会话的计划模式状态。
 * 返回 undefined = 本会话的组合里没有挂官方 plan-mode（'plan' 投影键未注册）；
 * 返回 false/true = 投影折叠出的当前生效状态。
 * 投影只反映"已落日志"的状态——这正是硬拦截想要的语义：guard 只拦已生效
 * 的计划模式，官方 /plan 命令的 pending 过渡期不拦（官方 "applies from the
 * next step" 语义的对应面）。
 */
function planStateOf(ctx: Context, session: Parameters<Context['sessionProjections']['stateOf']>[0]): { active: boolean } | undefined {
  return ctx.sessionProjections.stateOf(session, 'plan')
}

// —— enter_plan_mode 的模型可见文案 ———————————————
// 工具 description 逐段取自 ZCode createEnterPlanModeProviderDescription()
// （apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts），
// 工具名替换为 dsh 侧（read/glob/grep、subagent、ask_user_question、exit_plan_mode）。
// 与 ZCode 的唯一实质出入：删掉 "This tool REQUIRES user approval" 一句——
// ZCode 的实际实现是 needsApproval: false 自动放行（其描述与实现不一致），
// 本插件跟实现不跟描述：进入计划模式完全可逆（/plan off 即回），无需打断用户。
const ENTER_DESCRIPTION = `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using enter_plan_mode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
2. **Multiple Valid Approaches**: The task can be solved in several different ways
3. **Code Modifications**: Changes that affect existing behavior or structure
4. **Architectural Decisions**: The task requires choosing between patterns or technologies
5. **Multi-File Changes**: The task will likely touch more than 2-3 files
6. **Unclear Requirements**: You need to explore before understanding the full scope
7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use ask_user_question to clarify the approach, use enter_plan_mode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip enter_plan_mode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the subagent tool instead)
- Tasks the user explicitly asked to plan with /plan (plan mode is already active)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using read, glob, and grep
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ask_user_question if you need to clarify approaches
6. Exit plan mode with exit_plan_mode when ready to implement

## Important Notes

- While plan mode is active, write-class tools (bash, write, edit) are denied; only read-only tools are available
- Entering is reversible: the user can leave plan mode at any time with /plan off
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work`

/** 调用成功后对模型说的第一句（ZCode 原文）。 */
const ENTERED_MESSAGE =
  'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.'

/**
 * 成功结果的 follow-up（ZCode formatEnterPlanModeModelContent 原文，
 * 工具名替换为 dsh 侧）。它随工具结果进入模型历史，是"进入后先做什么"的
 * 即时行动指令；与提示词节（每次请求都在）互为冗余，冗余是有意的。
 */
const PLAN_FOLLOWUP = `In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use ask_user_question if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use exit_plan_mode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`

// —— plan:workflow-plus 提示词节 ——————————————————————
// 底本为 ZCode buildPlanWorkflow()（runtime-reminders.ts）逐段适配：
//   Explore agents → subagent 工具；AskUserQuestion → ask_user_question；
//   ExitPlanMode → exit_plan_mode。关键纪律原文保留：
//   "回合只能以 ask_user_question 或 exit_plan_mode 结束"、
//   "不得用文字或 ask_user_question 请求计划批准"。
// ZCode 每 5 个回合以 reminder 形式重注入（全量/精简交替）；dsh 的对应机制是
// 条件 section——每次请求按当前模式现算文本，非活跃返回空串则整节消失，
// 与官方 plan:policy 同机制、对请求缓存同样友好。
const WORKFLOW_SECTION = `## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase use only read-only tools - reads, searches, and the subagent tool for broad exploration.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused - avoid proposing new code when suitable implementations already exist.

2. **Launch up to 3 subagent calls IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach.

**Guidelines:**
- Use the context gathered in Phase 1, including relevant files and code paths.
- Account for the user's requirements and constraints.
- Produce a concrete implementation plan that is detailed enough to execute.
- Consider useful perspectives for the task type:
  - New feature: simplicity vs performance vs maintainability
  - Bug fix: root cause vs workaround vs prevention
  - Refactoring: minimal change vs clean architecture

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ask_user_question to clarify any remaining questions with the user

### Phase 4: Call exit_plan_mode
At the very end of your turn, once you have asked the user questions and are happy with your final plan - you should always call exit_plan_mode to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ask_user_question tool OR calling exit_plan_mode. Do not stop unless it's for these 2 reasons

**Important:** Use ask_user_question ONLY to clarify requirements or choose between approaches. Use exit_plan_mode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no ask_user_question. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use exit_plan_mode.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ask_user_question tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`

/** 计划模式拦截文案：逐字取自 ZCode checkPlanMode 的 deny reason（ruleId mode.plan.nonReadOnly）。 */
const PLAN_DENY_REASON = 'Plan mode only allows read-only, non-destructive tools'

/**
 * 注册 enter_plan_mode 工具、写类工具硬拦截与四阶段工作流提示词节。
 * 由 Cordis Loader 在组合挂载时调用（host 平面，全局可见——todo_write_plus
 * 同款可见性：web 表面的 per-session agent 都能看到全局注册的工具）。
 * @param ctx - 携带 tools / systemPrompt / sessionProjections 的 Cordis 上下文。
 * @param config - patch 行里的 config（缺省时用默认值）。
 */
export function apply(ctx: Context, config: Config | undefined): void {
  const { toolName, denyTools, enforce } = resolveConfig(config)

  // —— 1. enter_plan_mode 工具 ————————————————————————
  // 确定性让位（todo-plus 同款纪律）：目标名被占时不注册，记日志后继续
  // 挂 guard 与提示词节。在 agent preset 审计体系里，entry 激活失败会让
  // 会话创建失败，所以任何冲突都必须优雅退出而不是抛错。
  if (ctx.tools.get(toolName) === undefined) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: ENTER_DESCRIPTION,
      // 无参数（对齐 ZCode EnterPlanModeInputSchema = z.object({}).strict()）。
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entered: { type: 'boolean', const: true, required: true },
          },
        },
        render: () => [{
          type: 'text',
          text: ENTERED_MESSAGE + '\n\n' + PLAN_FOLLOWUP,
        }],
      },
      execute(_args, exec) {
        const agent = exec.agent
        if (agent === undefined) {
          // 模式是 per-session 状态；没有归属会话的调用无处可切，直接拒绝。
          throw new Error(`${toolName} requires a calling agent (no session to switch)`)
        }
        const state = planStateOf(ctx, agent.session)
        if (state === undefined) {
          // 'plan' 投影键未注册 = 本会话的组合没挂官方 plan-mode，
          // 计划模式在这个会话里不存在（如部分 headless preset）。
          throw new Error(`${toolName} is not available in this session: plan mode is not mounted in this preset`)
        }
        if (state.active) {
          // 对齐官方 exit_plan_mode 的反向守卫：恒注册、模式内温和报错，
          // 工具目录跨模式保持稳定（对请求缓存友好）。
          throw new Error(`${toolName} is only available outside plan mode (the session is already in plan mode)`)
        }
        // 直接追加官方词汇表内的 plan/mode 事件——官方 planMode.set 落日志时
        // 写的就是它。追加后：
        //   - plan 投影折叠出 active=true → 本插件的 guard / 工作流节立即生效；
        //   - 官方 plan:policy 节读同一投影 → 同步亮起；
        //   - UI 的 plan 投影 wire view（{active, pending}）→ composer chip 变化；
        //   - /plan off、exit_plan_mode 评审流读同一状态 → 双向兼容。
        // 立即生效是有意的（ZCode EnterPlanMode 同款）：模型在本回合余下的
        // 步骤里就受只读约束，而不是等下一个边界。
        agent.session.append('plan/mode', { active: true })
        return Promise.resolve({ entered: true })
      },
      // 调用在 UI 里的展示卡片：generic 卡、固定标题（无入参可展示）。
      presentCall: () => ({ card: 'generic', title: 'Enter plan mode', kind: 'other' }),
    }))
  } else {
    ctx.logger.warn(
      `dsh-plan-mode-plus: tool "${toolName}" is already registered by another plugin`
      + ' — standing by (set `toolName` in this bundle row\'s config to coexist)',
    )
  }

  // —— 2. 硬拦截（对齐 ZCode checkPlanMode 的效果）———————————
  // ctx.tools.guard 的契约（dsh-tools d.ts 原文）："synchronous check; a
  // returned string denies the execution"，在 tools/pre-execute 瀑布之后、
  // 分发之前运行；多个 guard 里任何一个返回字符串即拒绝（单调），没有
  // 任何 guard 能强行放行另一个 guard 拒掉的调用。拒绝字符串会变成
  // `Error: <reason>` 的工具错误结果回到模型——不终止回合。
  // 全局注册对所有 agent 生效；子代理会话有自己的日志、plan 投影折叠出
  // active=false，天然不受主会话计划状态影响。
  if (enforce && denyTools.length > 0) {
    const deny = new Set(denyTools)
    ctx.tools.guard(exec => {
      // 名单外一律放行（MCP 工具、读类工具、subagent 都在这里通过）。
      if (!deny.has(exec.name)) return
      const agent = exec.agent
      // 没有归属 agent 的执行没有会话，也就没有计划状态——放行。
      if (agent === undefined) return
      const state = planStateOf(ctx, agent.session)
      // undefined = 该会话没挂官方 plan-mode → 无计划模式可拦，放行。
      if (state === undefined) return
      if (!state.active) return
      return PLAN_DENY_REASON
    })
  }

  // —— 3. plan:workflow-plus 提示词节 ———————————————————
  // order 紧跟官方 plan:policy（500）：官方节讲"计划模式的纪律"，
  // 本节讲"计划的工作流"，成对出现在模型面前。
  ctx.systemPrompt.section({
    name: 'plan:workflow-plus',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
    text: (context) => {
      // 官方 plan-mode 的同款访问（运行时 context.agent 由 agent loop 提供；
      // npm 版 d.ts 尚未收录该字段，这里交叉类型补齐并防御式判空）。
      const agent = (context as AssembleContext & { agent?: Agent }).agent
      if (agent === undefined) return ''
      const state = planStateOf(ctx, agent.session)
      return state?.active === true ? WORKFLOW_SECTION : ''
    },
  })
}
