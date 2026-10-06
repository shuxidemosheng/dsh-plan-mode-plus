/**
 * dsh-plan-mode-plus 客户端 half：会话标题栏的"计划模式"一键进出按钮。
 *
 * 架构（机制全部沿用 dsh-tool-todo-plus 已验证的做法）：
 *
 *   conversation.input.dock 槽位（会话域，运行时提供 useProjection / sessionId）
 *     └─ PlanBridge（隐形组件，渲染 null）：订阅 'plan' 投影 → 写入模块级 store
 *        官方 plan 投影的 wire view 是 { active, pending }：
 *          active  = 计划模式已生效
 *          pending = 已选择但尚未落到下一个 step 边界（"生效中"）
 *
 *   conversation.session.header.actions 槽位
 *     └─ PlanHeaderAction 按钮：显示状态；点击经 ctx.remote.commands.execute
 *        执行 "/plan" 或 "/plan off"（官方 Plan chip 同款通道，
 *        从 @deepseek-ai/dsh-client-ui-plan 的打包产物里逐字核实）。
 *
 * 与官方 UI 的分工：composer 蓝色 Plan chip 已提供"活跃指示 + 点击退出"，
 * 本按钮补的是"一键进入"（官方入口只有 /plan 命令或 + 菜单）。
 *
 * 构建约束：产物是懒 CJS 工厂（平台模块表解析 react/react-dom），两者必须
 * external；其余一律 inline styles，避免任何平台表之外的模块请求。
 *
 * @module dsh-plan-mode-plus/client
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createRoot } from 'react-dom'

// @types/react-dom 只在 'react-dom/client' 子路径声明 createRoot，而平台模块表
// 只提供 'react-dom' 主入口（运行时主入口确实导出 createRoot）。声明合并让主
// 入口导入通过类型检查；运行时代码不变。
declare module 'react-dom' {
  export function createRoot(container: Element | DocumentFragment): {
    render(node: React.ReactNode): void
    unmount(): void
  }
}

// —— 客户端 ctx 的最小本地类型 ——
// remote 的形状对照官方 dsh-client-ui-plan 的用法：
//   await ctx.remote.commands.execute(sessionId, "/plan off", [])
//   → { ok: boolean; value?: unknown; error?: { message, code } }
// 'remote' 是客户端 cordis 上下文里的服务（官方 dsh-api-remotes 的 apply 就
// inject ["remote"] 并在其上挂载 typert remote 命名空间）——通过本插件导出的
// inject 声明依赖，而不是 manifest 的 dsh.client.inject（那是模块装载清单，
// 实测添加非本插件必需的宿主模块反而会让 entry 激活失败）。
interface ClientCtx {
  slots: {
    inject(slot: string, register: () => void): void
    register(def: { name: string; id?: string; key?: string; order?: number }, component: unknown): () => void
  }
  logger: { warn(...args: unknown[]): void }
  remote: {
    commands: {
      execute(sessionId: unknown, slashCommandLiteral: '/plan' | '/plan off', attachments: readonly unknown[]): Promise<{
        ok: boolean
        value?: unknown
        error?: { message: string; code: string }
      }>
    }
  }
}

// —— 桥组件在 conversation.input.dock 里的注册条目 id ——
const BRIDGE_ID = 'plan-mode-plus-bridge'
// —— 会话标题栏按钮的注册条目 id ——
const HEADER_ACTION_ID = 'plan-mode-plus-header-action'

// —— 模块级共享状态 ——
// 纪律与 todo-plus 相同：这些是 useSyncExternalStore 的快照源，只在 emit() 前
// 成对更新；"内容没变就提前 return"必须发生在赋值之前，否则 React 会在下次
// 渲染时发现快照变了却没收到通知（getSnapshot 缓存被破坏）。
// 全部用原始值做快照，天然满足引用稳定要求。
let planActive = false
let planPending = false
let sessionId: string | number | undefined
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setPlanState(next: { active?: boolean; pending?: boolean; sessionId?: string | number | undefined }): void {
  let changed = false
  if (next.active !== undefined && next.active !== planActive) { planActive = next.active; changed = true }
  if (next.pending !== undefined && next.pending !== planPending) { planPending = next.pending; changed = true }
  if (next.sessionId !== undefined && next.sessionId !== sessionId) { sessionId = next.sessionId; changed = true }
  if (changed) emit()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// —— 宿主通道（apply 时用 ctx.remote 装配）——
// 独立于 React 渲染树存活：按钮点击时读 store 里的 sessionId 发起调用。
// 没装配好（apply 未跑/宿主无 remote）时按钮点了只记警告。
// 入参类型收窄为两个字面量之一——本插件只会执行这两个固定的斜杠命令，
// 不存在任何来自用户/模型输入的动态命令串。
let dispatchPlanCommand: ((slashCommandLiteral: '/plan' | '/plan off') => Promise<void>) | undefined

function togglePlanMode(): void {
  const dispatch = dispatchPlanCommand
  if (sessionId === undefined) {
    console.warn('[dsh-plan-mode-plus] no active session; cannot toggle plan mode')
    return
  }
  if (dispatch === undefined) {
    console.warn('[dsh-plan-mode-plus] remote channel unavailable')
    return
  }
  // 两个调用点都是纯字面量，按当前状态二选一；无任何字符串拼接。
  if (planActive) void dispatch('/plan off')
  else void dispatch('/plan')
}

// —— 桥组件 ——————————————————————————————————————
// 隐形组件：订阅 'plan' 投影与 sessionId，写进模块级 store。
// 投影键 'plan' 的 wire view 由官方 dsh-plan-mode 注册：
// { active: boolean, pending: boolean }。早期会话物化时可能拿到
// undefined——按"未活跃"处理即可，无需特殊分支。
function PlanBridge(props: {
  useProjection?: (key: 'plan') => { active: boolean; pending: boolean } | null | undefined
  sessionId?: string | number
}): ReactElement {
  const value = props.useProjection?.('plan')
  useEffect(() => {
    setPlanState({
      active: value?.active ?? false,
      pending: value?.pending ?? false,
      sessionId: props.sessionId,
    })
  }, [value?.active, value?.pending, props.sessionId])
  // 零尺寸标记：语义占位（dock 槽位要求渲染点什么），视觉不可见。
  return <span aria-hidden style={{ position: 'absolute', width: 0, height: 0 }} />
}

// —— 标题栏按钮 ——————————————————————————————————
function buttonStyle(active: boolean, pending: boolean): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, padding: '3px 10px', borderRadius: 'var(--dsw-radius-sm, 8px)',
    // 活跃态用淡蓝底 + 蓝字（对齐官方 Plan chip 的"蓝色状态按钮"观感），
    // 非活跃态是中性描边胶囊；pending 再叠一层半透明表示"未落定"。
    border: active
      ? '1px solid var(--dsw-alias-border-accent, rgba(88,166,255,0.55))'
      : '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
    background: active
      ? 'var(--dsw-alias-fill-accent-subtle, rgba(88,166,255,0.16))'
      : 'transparent',
    color: active ? 'var(--dsw-alias-label-accent, #58a6ff)' : 'inherit',
    cursor: 'pointer', opacity: active ? 1 : pending ? 0.75 : 0.85,
    transition: 'opacity 160ms ease, background 160ms ease',
  }
}

function PlanHeaderAction(_props: unknown): ReactElement {
  const active = useSyncExternalStore(subscribe, () => planActive, () => planActive)
  const pending = useSyncExternalStore(subscribe, () => planPending, () => planPending)
  return (
    <button
      type="button"
      title={active ? '退出计划模式（执行 /plan off）' : '进入计划模式（执行 /plan）'}
      aria-label={`计划模式${active ? '已开启' : '未开启'}`}
      onClick={togglePlanMode}
      style={buttonStyle(active, pending)}
    >
      <span aria-hidden>◎</span>
      计划模式
      {pending && <span style={{ opacity: 0.7 }}> · 生效中…</span>}
    </button>
  )
}

// —— 插件入口 ——————————————————————————————————
/**
 * 客户端 half 插件入口。由客户端模块系统在物化时调用（懒 CJS 工厂）。
 * 只导出命名成员（apply/inject），绝不加 export default——
 * Loader 的 unwrapExports 会折叠模块并丢弃 inject（官方 postmortem 0001）。
 */
export function apply(ctx: ClientCtx): void {
  // 装配宿主通道：会话存在时执行固定的两个斜杠命令之一。
  // 结果处理对齐官方 chip：!ok 记警告；value undefined 说明宿主不认识该命令。
  dispatchPlanCommand = async (slashCommandLiteral: '/plan' | '/plan off') => {
    if (sessionId === undefined) return
    try {
      const result = await ctx.remote.commands.execute(sessionId, slashCommandLiteral, [])
      if (!result.ok) {
        ctx.logger.warn(`dsh-plan-mode-plus: ${slashCommandLiteral} failed:`, result.error?.message, `(${result.error?.code})`)
      } else if (result.value === undefined) {
        ctx.logger.warn(`dsh-plan-mode-plus: unknown command: ${slashCommandLiteral}`)
      }
    } catch (error) {
      ctx.logger.warn('dsh-plan-mode-plus: dispatch threw:', error)
    }
  }

  // 数据桥：dock 槽位（有 useProjection）订阅 plan 投影，喂给模块级 store
  ctx.slots.inject('conversation.input.dock', () => {
    ctx.slots.register({ name: 'conversation.input.dock', id: BRIDGE_ID, order: 60 }, PlanBridge)
  })

  // 会话标题栏按钮：一键进出计划模式
  ctx.slots.inject('conversation.session.header.actions', () => {
    ctx.slots.register({ name: 'conversation.session.header.actions', id: HEADER_ACTION_ID, order: 60 }, PlanHeaderAction)
  })
}

// 插件自身声明的服务依赖（客户端运行时按"属性路径"校验访问权限：
// 要调 ctx.remote.commands.execute 就必须声明到 "remote.commands" 这一级，
// 否则运行时抛 "cannot get property remote.commands without inject"）。
export const inject = ['slots', 'remote', 'remote.commands']
