// NOTE（维护者）：本文件就是插件网页端的**源码**，不经过 tsc —— 改这里即可，
// 改完用 `node --check lib/client.js` 自检。它由宿主按 package.json 的
// `dsh.client` 声明经 /plugins 提供，浏览器侧只注册 factory、物化时才执行。
//
// 取数策略：**只手动刷新**。打开 tab 时拉一次，之后只有用户点「刷新」才重新请求；
// 想加定时轮询就在 BoardBody 里补一个 setInterval(load)，宿主侧本来就带短路缓存。
window.__ModuleLoader__.load({ id: "dsh-email-board", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

const React = require("react");
const { useCallback, useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

// Harness 为反向代理挂载点提供 document.baseURI，所以路由用相对路径。
const ROUTE = "_dsh/dsh-email-board/state";
const NS = "emailBoard";
const TAB_ID = "dsh-email-board";
const TAB_KIND = "email-board";
const ACCOUNT_INK = ["#4a7dff", "#0aa06e", "#e08d1a", "#c4557f", "#7a63d6", "#0f9bb5"];

const ZH = {
  "tab.title": "邮件看板",
  "tab.desc": "汇总各邮箱账号的未读邮件",
  "head.unread": "未读",
  "head.updated": "更新于 {time}",
  "head.never": "尚未取到数据",
  "action.refresh": "刷新",
  "action.retry": "重试",
  "filter.all": "全部",
  "state.loading": "正在读取未读邮件…",
  "state.empty": "没有未读邮件，收件箱是干净的。",
  "state.emptyAccount": "该账号没有未读邮件。",
  "state.error": "读取失败",
  "state.partial": "{n} 个账号读取失败",
  "state.truncated": "未读超过 {n} 封，只显示最新 {n} 封",
  "badge.attachment": "含附件",
  "badge.flagged": "已标星",
  "meta.folder": "文件夹 {folder}",
  "meta.manual": "点右上角「刷新」手动拉取",
  "time.justNow": "刚刚",
  "time.minutes": "{n} 分钟前",
  "time.hours": "{n} 小时前",
  "time.yesterday": "昨天",
  "subject.none": "(无主题)",
  "from.unknown": "(未知发件人)",
};

const EN = {
  "tab.title": "Mail board",
  "tab.desc": "Unread mail from every account",
  "head.unread": "unread",
  "head.updated": "updated {time}",
  "head.never": "no data yet",
  "action.refresh": "Refresh",
  "action.retry": "Retry",
  "filter.all": "All",
  "state.loading": "Loading unread mail…",
  "state.empty": "No unread mail — every inbox is clear.",
  "state.emptyAccount": "No unread mail in this account.",
  "state.error": "Failed to load",
  "state.partial": "{n} account(s) failed",
  "state.truncated": "More than {n} unread; showing the newest {n}",
  "badge.attachment": "Attachment",
  "badge.flagged": "Flagged",
  "meta.folder": "Folder {folder}",
  "meta.manual": "Pull manually with the Refresh button",
  "time.justNow": "just now",
  "time.minutes": "{n} min ago",
  "time.hours": "{n} h ago",
  "time.yesterday": "yesterday",
  "subject.none": "(no subject)",
  "from.unknown": "(unknown sender)",
};

const DICTS = { zh: ZH, en: EN };

/** 兜底翻译：t 席位缺席时也要能出字，中文为上表。 */
function localT(key, fallbackLang) {
  const table = DICTS[fallbackLang] ?? ZH;
  return table[key] ?? ZH[key] ?? key;
}

function fill(text, params) {
  return text.replace(/\{(\w+)\}/g, (all, name) => (params !== undefined && params[name] !== undefined ? String(params[name]) : all));
}

const CSS = [
  ".dseb-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:1.5}",
  ".dseb-head{flex:none;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.24))}",
  ".dseb-headRow{display:flex;align-items:center;gap:8px;min-width:0}",
  ".dseb-count{font-size:12px;color:var(--dsw-alias-label-secondary,#4e5969);white-space:nowrap}",
  ".dseb-count b{color:var(--dsw-alias-label-primary,#1f2329);font-size:14px;margin-right:2px}",
  ".dseb-spacer{flex:1;min-width:4px}",
  ".dseb-btn{flex:none;display:inline-flex;align-items:center;gap:4px;padding:3px 9px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#4e5969);background:transparent;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));border-radius:8px;cursor:pointer}",
  ".dseb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,#1f2329)}",
  ".dseb-btn:disabled{opacity:.5;cursor:default}",
  ".dseb-btn[data-busy='true'] svg{animation:dseb-spin 1s linear infinite}",
  "@keyframes dseb-spin{to{transform:rotate(360deg)}}",
  ".dseb-sub{display:flex;align-items:center;gap:8px;margin-top:6px;min-width:0}",
  ".dseb-updated{font-size:11px;color:var(--dsw-alias-label-tertiary,#86909c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".dseb-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}",
  ".dseb-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#4e5969);background:transparent;border:.5px solid transparent;border-radius:999px;cursor:pointer;max-width:100%}",
  ".dseb-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}",
  ".dseb-chip[data-active='true']{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.28));color:var(--dsw-alias-label-primary,#1f2329)}",
  ".dseb-chipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}",
  ".dseb-chipNum{font-size:11px;color:var(--dsw-alias-label-tertiary,#86909c)}",
  ".dseb-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px 14px}",
  ".dseb-group{margin-bottom:14px}",
  ".dseb-groupHead{display:flex;align-items:center;gap:6px;margin:2px 0 7px;font-size:11px;color:var(--dsw-alias-label-tertiary,#86909c)}",
  ".dseb-groupName{color:var(--dsw-alias-label-secondary,#4e5969);font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dseb-card{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;margin-bottom:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}",
  ".dseb-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.07))}",
  ".dseb-dot{flex:none;width:7px;height:7px;margin-top:6px;border-radius:50%}",
  ".dseb-main{flex:1;min-width:0}",
  ".dseb-row{display:flex;align-items:baseline;gap:8px;min-width:0}",
  ".dseb-from{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dseb-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#86909c)}",
  ".dseb-subject{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#4e5969);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dseb-tags{display:flex;gap:6px;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#86909c)}",
  ".dseb-tag{display:inline-flex;align-items:center;gap:3px}",
  ".dseb-note{margin:0 0 10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06));font-size:12px;color:var(--dsw-alias-label-secondary,#4e5969)}",
  ".dseb-note[data-kind='error']{color:var(--dsw-alias-label-error,#d54941);border-color:currentColor}",
  ".dseb-noteRow{display:flex;align-items:center;gap:8px}",
  ".dseb-noteText{flex:1;min-width:0;word-break:break-word}",
  ".dseb-empty{padding:22px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#86909c)}",
  ".dseb-foot{flex:none;padding:6px 12px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#86909c);border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));display:flex;gap:8px;align-items:center;min-width:0}",
  ".dseb-footText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dseb-skeleton{height:52px;margin-bottom:7px;border-radius:10px;background:linear-gradient(90deg,rgba(128,128,128,.07),rgba(128,128,128,.16),rgba(128,128,128,.07));background-size:200% 100%;animation:dseb-shimmer 1.4s ease-in-out infinite}",
  "@keyframes dseb-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}",
].join("\n");

function injectCss() {
  const id = "dsh-email-board/client";
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return () => {};
  const style = document.createElement("style");
  style.dataset.plugin = "dsh-email-board";
  style.dataset.pluginCss = id;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => { style.remove(); };
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

/** 信封时间 → 卡片右上角那行短时间（今天/昨天/日期三档）。 */
function formatTime(iso, now, t) {
  const ts = Date.parse(typeof iso === "string" ? iso : "");
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts);
  const diff = now - ts;
  if (diff >= 0 && diff < 60000) return t("time.justNow");
  if (diff >= 0 && diff < 3600000) return fill(t("time.minutes"), { n: Math.floor(diff / 60000) });
  if (diff >= 0 && diff < 6 * 3600000) return fill(t("time.hours"), { n: Math.floor(diff / 3600000) });
  const clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock;
  const yesterday = new Date(now - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return t("time.yesterday") + " " + clock;
  const monthDay = pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  if (date.getFullYear() === today.getFullYear()) return monthDay + " " + clock;
  return date.getFullYear() + "-" + monthDay;
}

function senderText(from, t) {
  if (!Array.isArray(from) || from.length === 0) return t("from.unknown");
  const first = from[0] ?? {};
  const name = typeof first.name === "string" ? first.name.trim() : "";
  const address = typeof first.address === "string" ? first.address.trim() : "";
  const text = name !== "" ? name : address;
  if (text === "") return t("from.unknown");
  if (from.length > 1) return text + " +" + (from.length - 1);
  return text;
}

function senderTitle(from) {
  if (!Array.isArray(from)) return "";
  return from
    .map((item) => {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      const address = typeof item?.address === "string" ? item.address.trim() : "";
      if (name !== "" && address !== "") return name + " <" + address + ">";
      return name !== "" ? name : address;
    })
    .filter(text => text !== "")
    .join(", ");
}

/** 读宿主路由；错误信息原样透出，方便直接看懂是配置问题还是网络问题。 */
async function fetchState(force, signal) {
  const res = await fetch(ROUTE + (force ? "?force=1" : ""), { credentials: "same-origin", signal });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || body === null || body.ok !== true) {
    const message = body?.error?.message ?? ("request failed " + res.status);
    throw new Error(message);
  }
  return body.value;
}

function Card({ message, now, ink, t }) {
  const tags = [];
  if (message.hasAttachments === true) tags.push(h("span", { className: "dseb-tag", key: "a" }, "📎 " + t("badge.attachment")));
  if (message.flagged === true) tags.push(h("span", { className: "dseb-tag", key: "f" }, "★ " + t("badge.flagged")));
  return h("div", { className: "dseb-card" },
    h("span", { className: "dseb-dot", style: { background: ink } }),
    h("div", { className: "dseb-main" },
      h("div", { className: "dseb-row" },
        h("span", { className: "dseb-from", title: senderTitle(message.from) }, senderText(message.from, t)),
        h("span", { className: "dseb-time" }, formatTime(message.date, now, t))),
      h("div", { className: "dseb-subject", title: message.subject !== "" ? message.subject : t("subject.none") },
        message.subject !== "" ? message.subject : t("subject.none")),
      tags.length > 0 ? h("div", { className: "dseb-tags" }, tags) : null));
}

function RefreshIcon() {
  return h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    h("path", {
      d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.2h-3.2",
      stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
    }));
}

function GuideIcon({ size, className }) {
  const px = typeof size === "number" ? size : 22;
  return h("svg", { width: px, height: px, viewBox: "0 0 24 24", fill: "none", className, "aria-hidden": "true" },
    h("rect", { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5, stroke: "currentColor", strokeWidth: 1.5 }),
    h("path", { d: "M3.5 7.2 12 13l8.5-5.8", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
}

function BoardBody(props) {
  const t = typeof props?.t === "function" ? props.t : (key) => localT(key, "zh");
  const [value, setValue] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("*");
  const [tick, setTick] = useState(0);
  const abortRef = useRef(null);
  const busyRef = useRef(false);

  const load = useCallback(async (force) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const next = await fetchState(force, controller.signal);
      setValue(next);
      setError(null);
    } catch (err) {
      if (err?.name !== "AbortError") setError(err?.message ?? String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
    }
  }, []);

  // 打开 tab 先拉一次（一次请求，不是轮询）；之后只有用户点「刷新」才会再取。
  useEffect(() => {
    void load(false);
    return () => {
      const controller = abortRef.current;
      abortRef.current = null;
      controller?.abort();
    };
  }, [load]);

  // 相对时间自己走：数据可能停在几分钟前，卡片上的「x 分钟前」不该僵住。
  useEffect(() => {
    const timer = setInterval(() => setTick(previous => previous + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const now = useMemo(() => Date.now(), [tick, value]);
  const accounts = useMemo(() => (Array.isArray(value?.accounts) ? value.accounts : []), [value]);
  const inkOf = useCallback((name) => {
    const index = accounts.findIndex(account => account.name === name);
    return ACCOUNT_INK[(index < 0 ? 0 : index) % ACCOUNT_INK.length];
  }, [accounts]);

  const shown = filter === "*" ? accounts : accounts.filter(account => account.name === filter);
  const failed = accounts.filter(account => typeof account.error === "string" && account.error !== "").length;
  const totalUnread = typeof value?.totals?.unread === "number" ? value.totals.unread : 0;

  const head = h("div", { className: "dseb-head" },
    h("div", { className: "dseb-headRow" },
      h("span", { className: "dseb-count" },
        h("b", null, String(totalUnread)), t("head.unread")),
      h("span", { className: "dseb-spacer" }),
      failed > 0 ? h("span", { className: "dseb-count", style: { color: "var(--dsw-alias-label-error,#d54941)" } },
        fill(t("state.partial"), { n: failed })) : null,
      h("button", {
        type: "button",
        className: "dseb-btn",
        "data-busy": busy ? "true" : "false",
        disabled: busy,
        onClick: () => { void load(true); },
        title: t("action.refresh"),
      }, h(RefreshIcon), t("action.refresh"))),
    h("div", { className: "dseb-sub" },
      h("span", { className: "dseb-updated" },
        value === null
          ? t("head.never")
          : fill(t("head.updated"), { time: formatTime(new Date(value.fetchedAt).toISOString(), Date.now(), t) }))),
    accounts.length > 1
      ? h("div", { className: "dseb-chips" },
        h("button", {
          type: "button", className: "dseb-chip", "data-active": filter === "*" ? "true" : "false",
          onClick: () => setFilter("*"),
        }, h("span", { className: "dseb-chipText" }, t("filter.all")), h("span", { className: "dseb-chipNum" }, String(totalUnread))),
        accounts.map(account => h("button", {
          type: "button",
          key: account.name,
          className: "dseb-chip",
          "data-active": filter === account.name ? "true" : "false",
          onClick: () => setFilter(current => (current === account.name ? "*" : account.name)),
          title: account.address !== "" ? account.name + " · " + account.address : account.name,
        },
          h("span", { className: "dseb-dot", style: { background: inkOf(account.name), marginTop: 0 } }),
          h("span", { className: "dseb-chipText" }, account.name),
          h("span", { className: "dseb-chipNum" }, account.totalUnread === null || account.totalUnread === undefined ? "!" : String(account.totalUnread)))))
      : null);

  let body;
  if (value === null && error === null) {
    body = h("div", { className: "dseb-body" },
      h("div", { className: "dseb-skeleton" }), h("div", { className: "dseb-skeleton" }), h("div", { className: "dseb-skeleton" }),
      h("div", { className: "dseb-empty" }, t("state.loading")));
  } else if (value === null) {
    body = h("div", { className: "dseb-body" },
      h("div", { className: "dseb-note", "data-kind": "error" },
        h("div", { className: "dseb-noteRow" },
          h("span", { className: "dseb-noteText" }, t("state.error") + "：" + error),
          h("button", { type: "button", className: "dseb-btn", onClick: () => { void load(true); } }, t("action.retry")))));
  } else {
    const sections = shown.map((account) => {
      const messages = Array.isArray(account.messages) ? account.messages : [];
      const nodes = [];
      if (typeof account.error === "string" && account.error !== "") {
        nodes.push(h("div", { className: "dseb-note", "data-kind": "error", key: "err" },
          h("div", { className: "dseb-noteRow" },
            h("span", { className: "dseb-noteText" }, account.error))));
      }
      if (account.truncated === true) {
        nodes.push(h("div", { className: "dseb-note", key: "trunc" },
          h("div", { className: "dseb-noteRow" },
            h("span", { className: "dseb-noteText" }, fill(t("state.truncated"), { n: messages.length })))));
      }
      if (messages.length === 0 && nodes.length === 0) {
        nodes.push(h("div", { className: "dseb-empty", key: "empty" }, t("state.emptyAccount")));
      }
      for (const message of messages) {
        nodes.push(h(Card, {
          key: account.name + "/" + String(message.uid),
          message,
          now,
          ink: inkOf(account.name),
          t,
        }));
      }
      return h("div", { className: "dseb-group", key: account.name },
        h("div", { className: "dseb-groupHead" },
          h("span", { className: "dseb-dot", style: { background: inkOf(account.name), marginTop: 0 } }),
          h("span", { className: "dseb-groupName" }, account.name),
          h("span", null, account.address !== "" ? "· " + account.address : ""),
          h("span", null, "· " + (account.totalUnread === null || account.totalUnread === undefined ? "?" : String(account.totalUnread)))),
        nodes);
    });
    const anyMessage = shown.some(account => Array.isArray(account.messages) && account.messages.length > 0);
    body = h("div", { className: "dseb-body" },
      error !== null ? h("div", { className: "dseb-note" },
        h("div", { className: "dseb-noteRow" },
          h("span", { className: "dseb-noteText" }, error),
          h("button", { type: "button", className: "dseb-btn", onClick: () => { void load(true); } }, t("action.retry")))) : null,
      shown.length === 0 ? h("div", { className: "dseb-empty" }, t("state.loading")) : null,
      shown.length > 0 && !anyMessage && shown.every(account => account.error === undefined) && accounts.length === shown.length
        ? h("div", { className: "dseb-empty" }, t("state.empty"))
        : null,
      sections);
  }

  return h("div", { className: "dseb-root" },
    head,
    body,
    h("div", { className: "dseb-foot" },
      h("span", { className: "dseb-footText" }, t("meta.manual")),
      h("span", { className: "dseb-spacer" }),
      shown.length === 1 && shown[0].folder !== "" ? h("span", { className: "dseb-footText" }, fill(t("meta.folder"), { folder: shown[0].folder })) : null));
}

const inject = ["slots", "locale", "sidebarRightTabs"];

function apply(ctx) {
  const t = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : (key) => localT(key, "zh");
  ctx.effect(() => ctx.locale.register(NS, DICTS), "dsh-email-board: dictionaries");
  ctx.effect(() => injectCss(), "dsh-email-board: styles");

  // tab 类型：页类型（没有 patterns），靠 kind 打开；guide 条目让它在右侧栏的
  // 开始页里有一个入口胶囊。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: "extension",
    title: () => t("tab.title"),
    guide: [{
      id: "board",
      order: 40,
      title: () => t("tab.title"),
      description: () => t("tab.desc"),
      icon: GuideIcon,
    }],
  }), "dsh-email-board: tab type");

  // tab 正文：key 必须是上面注册的 id。
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TAB_ID,
    locale: NS,
  }, BoardBody)), "dsh-email-board: tab body");
}

exports.apply = apply;
exports.inject = inject;

return module.exports;
}});
