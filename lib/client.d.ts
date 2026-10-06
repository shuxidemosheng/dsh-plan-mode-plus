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
declare module 'react-dom' {
    function createRoot(container: Element | DocumentFragment): {
        render(node: React.ReactNode): void;
        unmount(): void;
    };
}
interface ClientCtx {
    slots: {
        inject(slot: string, register: () => void): void;
        register(def: {
            name: string;
            id?: string;
            key?: string;
            order?: number;
        }, component: unknown): () => void;
    };
    logger: {
        warn(...args: unknown[]): void;
    };
    remote: {
        commands: {
            execute(sessionId: unknown, slashCommandLiteral: '/plan' | '/plan off', attachments: readonly unknown[]): Promise<{
                ok: boolean;
                value?: unknown;
                error?: {
                    message: string;
                    code: string;
                };
            }>;
        };
    };
}
/**
 * 客户端 half 插件入口。由客户端模块系统在物化时调用（懒 CJS 工厂）。
 * 只导出命名成员（apply/inject），绝不加 export default——
 * Loader 的 unwrapExports 会折叠模块并丢弃 inject（官方 postmortem 0001）。
 */
export declare function apply(ctx: ClientCtx): void;
export declare const inject: string[];
export {};
