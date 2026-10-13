window.__ModuleLoader__.load({
  id: "dsh-plugin-delete",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    function DeleteSessionMenuItem(props) {
      const [busy, setBusy] = React.useState(false);
      const sessionId = props?.sessionId;
      const title = typeof props?.displayTitle === "string" && props.displayTitle.trim()
        ? props.displayTitle.trim()
        : "此会话";

      if (typeof sessionId !== "string" || sessionId.length === 0) return null;

      async function remove() {
        if (busy) return;
        const confirmed = window.confirm(
          `确定永久删除“${title}”吗？\n\n会话记录和本地缓存会被立即删除，删除后无法恢复。`,
        );
        if (!confirmed) return;

        setBusy(true);
        try {
          const uiWorkspace = props?.ctx?.get?.("uiWorkspace");
          if (uiWorkspace && typeof uiWorkspace.archiveSession === "function") {
            await uiWorkspace.archiveSession(sessionId, { stopActivity: true });
          }

          const response = await fetch("/api/dsh-plugin-delete/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, confirm: true }),
          });
          let result = null;
          try { result = await response.json(); } catch {}
          if (!response.ok || result?.ok !== true) {
            throw new Error(result?.error || `HTTP ${response.status}`);
          }

          // The built-in archive action already removes the active row. Reloading
          // also refreshes the client-side workspace snapshot after JSON cleanup.
          window.location.reload();
        } catch (error) {
          console.error("[dsh-plugin-delete] deletion failed", error);
          window.alert(`删除失败：${error?.message || "未知错误"}`);
          setBusy(false);
        }
      }

      return React.createElement("button", {
        type: "button",
        role: "menuitem",
        disabled: busy,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          void remove();
        },
        style: {
          color: "var(--dsw-alias-label-danger, #d33)",
          opacity: busy ? 0.6 : 1,
        },
      }, busy ? "正在删除…" : "永久删除");
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) {
        console.warn("[dsh-plugin-delete] slots 服务不可用，跳过菜单注册");
        return;
      }
      slots.inject("sidebar.workspaces.session.menu.item", () => slots.register({
        name: "sidebar.workspaces.session.menu.item",
        id: "dsh-plugin-delete",
        order: 500,
        label: () => "永久删除",
        inject: () => ({ ctx }),
      }, DeleteSessionMenuItem));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
