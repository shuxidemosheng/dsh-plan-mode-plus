# dsh-plan-mode-plus

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）计划模式的 ZCode 式增强插件。基于官方 `@deepseek-ai/dsh-plan-mode` 的状态机（`plan/mode` 事件 + `plan` 投影），把计划模式补齐到 [ZCode](https://github.com/zai-org/ZCode) 开源实现的形态，新增三件事：

| 能力 | 说明 | 对应 ZCode 原件 |
|---|---|---|
| `enter_plan_mode` 工具 | 模型判断任务非平凡时主动请求进入计划模式，无参数、立即生效 | `EnterPlanMode`（`contracts/src/tools/plan-mode.ts`） |
| 硬拦截 | 计划模式期间，写类工具在分发前被 `ctx.tools.guard()` 直接拒绝，拒绝文案逐字取自 ZCode：`Plan mode only allows read-only, non-destructive tools` | `checkPlanMode()`（`permission/service.ts`） |
| 四阶段工作流提示词 | 仅计划模式活跃时渲染的 `plan:workflow-plus` 提示词节：探索 → 设计 → 评审 → `exit_plan_mode` | `buildPlanWorkflow()`（`runtime-reminders.ts`） |

**退出仍走官方 `exit_plan_mode`**（计划评审 UI、Approve / Keep planning + 反馈回流原样保留），`/plan` / `/plan off` 命令与 composer 蓝色 Plan chip 也原样可用——本插件只做增量，不替代官方任何部件。

客户端 half 在会话标题栏加一个"计划模式"胶囊按钮：未开启时点击执行 `/plan` 进入，开启时高亮并点击执行 `/plan off` 退出，切换排队期显示"生效中…"。与官方 chip 分工：chip 管"活跃指示 + 退出"，本按钮补"一键进入"。

## 安装

```bash
# Git Bash，桌面版（先完全退出 DeepSeek Harness 主程序）
ELECTRON_RUN_AS_NODE=1 "/d/DeepSeek Harness/DeepSeek Harness.exe" \
  --expose-internals \
  "D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  plugin --profile desktop add dsh-plan-mode-plus
```

`add` 后面也可以是本地 tgz 路径（`file:D:/.../dsh-plan-mode-plus-x.y.z.tgz`）或 Git 仓库地址。安装完成后重启主程序即可。

## 配置

`cordis.patch.yml` 的 insert 行携带默认配置（denylist 逐名核实自 app.asar 内各官方 `dsh-tool-*` 的 `defineTool` 定义）：

```yaml
- insert:
    - id: plan-mode-plus
      name: dsh-plan-mode-plus
      config:
        enforce: true          # false = 回到官方"纯引导"行为，只留工具与提示词节
        denyTools:             # 计划模式期间被硬拦截的模型侧工具名
          - bash               # ZCode 的 Bash（write + destructive）
          - pwsh
          - write              # ZCode 的 Write
          - edit               # ZCode 的 Edit
          - str_replace_editor # ZCode 的 ApplyPatch 对应物
```

覆盖方式：在你的 profile 层（`~/.dsh/profiles/<name>/cordis.patch.yml`）加同名 id 的 config 行，或直接改本插件 bundle 行的 config。未知配置键会在启动时报错（风格对齐官方 plan-mode 的 `resolveConfig`）。

**放行侧**（对齐 ZCode 的只读分类）：`read` / `read_image` / `glob` / `grep`、`web_search` / `web_fetch`、`todo_write`、`ask_user_question`、`skill`、`present`、goal 系列、`subagent`、`send_message` / `interrupt_agent`，以及全部 MCP 工具（ZCode 放行非破坏性 MCP）。想要更严的部署把 `subagent`、`subagent_fork` 加进 denyTools 即可堵住"子代理代写"的口子。

## 与官方 plan-mode 的关系

- **状态机完全复用官方**：本插件不追加任何新事件类型，进入计划模式 = 直接追加官方词汇表内的 `plan/mode` 事件（`KNOWN_SESSION_EVENT_TYPES` 内），plan 投影折叠出 `active=true` 后，官方 `plan:policy` 提示词节、`/plan off`、`exit_plan_mode` 评审流、UI chip 全部同步生效，双向兼容。
- **读状态走共享投影**：`sessionProjections.stateOf(session, 'plan')`。web/desktop 表面里 host 平面的官方 plan-mode 条目被 dsh-web-app 补丁 disable、`planMode` 服务按 agent preset 逐会话挂载在隔离域——因此本插件刻意不触碰 `planMode` 服务实例，只依赖全局可见的投影与会话日志，host 平面全局注册即对所有会话生效。
- **会话没挂官方 plan-mode 时**（如部分 headless preset）：`stateOf` 返回 `undefined`，工具报错、guard 与提示词节自动失活，不会让会话创建失败。

## 与 ZCode 的对齐点与有意偏离

1. **进入免审批**：ZCode 的 `EnterPlanMode` 描述写着 "REQUIRES user approval"，但实际实现是 `needsApproval: false` 自动放行（描述与实现不一致）。本插件跟实现不跟描述——进入计划模式完全可逆（`/plan off` 即回），无需打断用户。
2. **立即生效 vs step 边界**：官方 `planMode.set()` 在轮次中把切换排队到下一个 accepted pre-step；本工具直接追加事件立即生效（ZCode 的 EnterPlanMode 同款）。代价：若本次调用所在步骤之后被中止，"已进入计划模式"仍然成立——可逆，接受。
3. **硬拦截**：官方立场是 "Guidance, not enforcement"（工具目录保持不变、全靠文本约束）。guard 是本插件主动做出的加强；拒绝发生在分发前，不改工具目录，对请求缓存友好。ZCode 把 `TodoWrite` 归为只读，这里同样放行 `todo_write`（官方 plan-mode 引导词明确规划阶段不要用它，纪律交给文本）。
4. **提示词注入机制**：ZCode 每 5 个回合以 runtime reminder 重注入工作流（全量/精简交替）；dsh 的对应机制是条件化 system prompt section（`text` 回调按当前模式现算、非活跃返回空串），与官方 `plan:policy` 同机制、对请求缓存同样友好。
5. **子代理不剔除计划工具**：ZCode 从子代理工具面剔除 EnterPlanMode/ExitPlanMode（子代理没有计划评审恢复面）；dsh 里子代理会话独立，`enter_plan_mode` 只影响子代理自己的会话、不波及父会话，故不做剔除。

## 构建

```bash
pnpm install   # 或 npm install
npm run build  # tsc + esbuild（宿主 ESM / 客户端懒 CJS 工厂）+ disable-eval 补丁
npm pack
```

要求 Node ≥ 24。peerDependencies 锁 `@deepseek-ai/*` `0.2.0-rc.2`（开发者预览版本，升级宿主后需同步验证）。构建产物零运行时 npm 依赖；`scripts/disable-eval.mjs` 用于剥离打包进来的 Schemastery 字符串回调求值分支（零 eval 产物）。

## 已验证

- headless（plugtest profile）端到端：`enter_plan_mode` 调用 → 工具结果渲染 ZCode 原文 → 计划模式下 shell 工具被拦截并返回逐字拒绝文案 → 工作流四阶段标题被模型逐字引用。
- web（plugweb profile）浏览器实测：标题栏按钮进入/退出计划模式，官方 Plan chip 随投影同步出现/消失。

## License

MIT
