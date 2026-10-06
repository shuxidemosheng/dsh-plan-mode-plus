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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "plan-mode-plus";
export declare const inject: string[];
/** 插件配置（对应 patch 行里的 config 字段）。 */
export interface Config {
    /**
     * 注册的工具名（默认 'enter_plan_mode'）。
     * 与 todo-plus 的 toolName 同款逃生口：万一别的插件占了这个名字，
     * 改这里即可共存，而不是双注册竞态炸掉 preset 审计。
     */
    toolName?: string;
    /**
     * 计划模式期间被硬拦截的模型侧工具名（默认对齐 ZCode 的写类分类：
     * Write/Edit/ApplyPatch/Bash → dsh 的 write/edit/str_replace_editor/bash+pwsh）。
     * 空数组等价于 enforce: false。
     */
    denyTools?: string[];
    /**
     * 是否启用硬拦截（默认 true）。false 时回到官方"纯引导"行为：
     * 只保留 enter_plan_mode 工具与工作流提示词节。
     */
    enforce?: boolean;
}
/**
 * 注册 enter_plan_mode 工具、写类工具硬拦截与四阶段工作流提示词节。
 * 由 Cordis Loader 在组合挂载时调用（host 平面，全局可见——todo_write_plus
 * 同款可见性：web 表面的 per-session agent 都能看到全局注册的工具）。
 * @param ctx - 携带 tools / systemPrompt / sessionProjections 的 Cordis 上下文。
 * @param config - patch 行里的 config（缺省时用默认值）。
 */
export declare function apply(ctx: Context, config: Config | undefined): void;
