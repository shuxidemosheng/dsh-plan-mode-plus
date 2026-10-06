window.__ModuleLoader__.load({ id: "dsh-plan-mode-plus", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_react_dom = require("react-dom");
var import_jsx_runtime = require("react/jsx-runtime");
var BRIDGE_ID = "plan-mode-plus-bridge";
var HEADER_ACTION_ID = "plan-mode-plus-header-action";
var planActive = false;
var planPending = false;
var sessionId;
var listeners = /* @__PURE__ */ new Set();
function emit() {
  for (const listener of listeners) listener();
}
function setPlanState(next) {
  let changed = false;
  if (next.active !== void 0 && next.active !== planActive) {
    planActive = next.active;
    changed = true;
  }
  if (next.pending !== void 0 && next.pending !== planPending) {
    planPending = next.pending;
    changed = true;
  }
  if (next.sessionId !== void 0 && next.sessionId !== sessionId) {
    sessionId = next.sessionId;
    changed = true;
  }
  if (changed) emit();
}
var subscribe = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
var dispatchPlanCommand;
function togglePlanMode() {
  const dispatch = dispatchPlanCommand;
  if (sessionId === void 0) {
    console.warn("[dsh-plan-mode-plus] no active session; cannot toggle plan mode");
    return;
  }
  if (dispatch === void 0) {
    console.warn("[dsh-plan-mode-plus] remote channel unavailable");
    return;
  }
  if (planActive) void dispatch("/plan off");
  else void dispatch("/plan");
}
function PlanBridge(props) {
  const value = props.useProjection?.("plan");
  (0, import_react.useEffect)(() => {
    setPlanState({
      active: value?.active ?? false,
      pending: value?.pending ?? false,
      sessionId: props.sessionId
    });
  }, [value?.active, value?.pending, props.sessionId]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": true, style: { position: "absolute", width: 0, height: 0 } });
}
function buttonStyle(active, pending) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: "var(--dsw-radius-sm, 8px)",
    // 活跃态用淡蓝底 + 蓝字（对齐官方 Plan chip 的"蓝色状态按钮"观感），
    // 非活跃态是中性描边胶囊；pending 再叠一层半透明表示"未落定"。
    border: active ? "1px solid var(--dsw-alias-border-accent, rgba(88,166,255,0.55))" : "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))",
    background: active ? "var(--dsw-alias-fill-accent-subtle, rgba(88,166,255,0.16))" : "transparent",
    color: active ? "var(--dsw-alias-label-accent, #58a6ff)" : "inherit",
    cursor: "pointer",
    opacity: active ? 1 : pending ? 0.75 : 0.85,
    transition: "opacity 160ms ease, background 160ms ease"
  };
}
function PlanHeaderAction(_props) {
  const active = (0, import_react.useSyncExternalStore)(subscribe, () => planActive, () => planActive);
  const pending = (0, import_react.useSyncExternalStore)(subscribe, () => planPending, () => planPending);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      type: "button",
      title: active ? "\u9000\u51FA\u8BA1\u5212\u6A21\u5F0F\uFF08\u6267\u884C /plan off\uFF09" : "\u8FDB\u5165\u8BA1\u5212\u6A21\u5F0F\uFF08\u6267\u884C /plan\uFF09",
      "aria-label": `\u8BA1\u5212\u6A21\u5F0F${active ? "\u5DF2\u5F00\u542F" : "\u672A\u5F00\u542F"}`,
      onClick: togglePlanMode,
      style: buttonStyle(active, pending),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": true, children: "\u25CE" }),
        "\u8BA1\u5212\u6A21\u5F0F",
        pending && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.7 }, children: " \xB7 \u751F\u6548\u4E2D\u2026" })
      ]
    }
  );
}
function apply(ctx) {
  dispatchPlanCommand = async (slashCommandLiteral) => {
    if (sessionId === void 0) return;
    try {
      const result = await ctx.remote.commands.execute(sessionId, slashCommandLiteral, []);
      if (!result.ok) {
        ctx.logger.warn(`dsh-plan-mode-plus: ${slashCommandLiteral} failed:`, result.error?.message, `(${result.error?.code})`);
      } else if (result.value === void 0) {
        ctx.logger.warn(`dsh-plan-mode-plus: unknown command: ${slashCommandLiteral}`);
      }
    } catch (error) {
      ctx.logger.warn("dsh-plan-mode-plus: dispatch threw:", error);
    }
  };
  ctx.slots.inject("conversation.input.dock", () => {
    ctx.slots.register({ name: "conversation.input.dock", id: BRIDGE_ID, order: 60 }, PlanBridge);
  });
  ctx.slots.inject("conversation.session.header.actions", () => {
    ctx.slots.register({ name: "conversation.session.header.actions", id: HEADER_ACTION_ID, order: 60 }, PlanHeaderAction);
  });
}
var inject = ["slots", "remote", "remote.commands"];
return module.exports; } });
