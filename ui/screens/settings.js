// 设置页（参考 Codex）：侧栏换成设置导航（返回应用 + 查找 + 分页），主区是大标题 + 按用途分段的 list，一行一项；改动即保存。
// 外观的主题是三张缩略图，Modelflare 顶部是账户和余额；搜索时它们退回普通的行（searchOnly）。
// 入口只有左下角账户按钮、⌘/Ctrl+, 和命令面板。
// 外观（主题、字体、动画…）和对话习惯（发送键、通知）是本机界面偏好，存在浏览器里（lib/theme.js、lib/prefs.js）；
// 其余设置走服务端 /settings。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html, Button, GoRow, Icon, IconButton, Seg, Switch, Sheet, CopyButton, Skeleton, MenuButton } from "../components/ui.js";
import { AccountButton, SideActions } from "./sidebar.js";
import { accountIdentity } from "../components/user-avatar.js";
import { AccountBalance, balanceText } from "../components/account-balance.js";
import { PickModel, effortOptions, setEffort, shortModel, showsStrategy, strategyOptions, useEffort } from "../components/model-picker.js";
import { DomainConnection } from "../components/domain-connection.js";
import { NotificationsSheet, UsageSheet } from "./account.js";
import { api } from "../lib/api.js";
import { UpdateActions, updateDescription } from "../components/app-update.js";
import { MF_CONSOLE, MF_DOCS_LINK, MF_TOPUP, usd } from "../lib/links.js";
import { useStore, confirmSheet, failed, saved, toast } from "../lib/store.js";
import { guide, resetGuide, showGuide, progress, visibleSteps } from "../lib/guide.js";
import { themeMode, setThemeMode } from "../lib/theme.js";
import { prefs, setPrefs, resetAppearance, appearanceChanged, fontStack } from "../lib/prefs.js";
import { canNotify, requestNotify } from "../lib/notify.js";
import { TroubleshootPane } from "./troubleshoot.js";
import { AboutMePane } from "../components/about-me.js";
import { CommunityLinks } from "../components/community.js";
import { QQ_GROUP } from "../lib/community.js";
import { openFeedback } from "../lib/feedback.js";
import { CollabPane } from "../components/collab.js";
import { ConnectionSheets, connectionRows, useConnections } from "./connections.js";
import { PwshHint } from "../components/pwsh-hint.js";
import { OfficialKeyForm, officialName } from "../components/official-keys.js";
import { AccountLogin } from "./onboarding.js";
import { t, has, useLang, getLangPref, onLangChange, changeLang, LANGS, LANG_NAMES } from "../lib/i18n.js";
import { fold } from "../lib/text-fold.js";
import { fmtTimeOfDay } from "../lib/format.js";

/** [id, 标题的文案键, 图标]；标题渲染时再 t()（tabLabel） */
export const TABS = [
  ["general", "settings.tabs.general", "sliders"],
  ["appearance", "settings.tabs.appearance", "palette"],
  ["modelflare", "settings.tabs.modelflare", "spark"],
  ["connections", "settings.tabs.connections", "link"],
  ["privacy", "settings.tabs.privacy", "lock"],
  ["network", "settings.tabs.network", "globe"],
  ["data", "settings.tabs.data", "database"],
  ["about", "settings.tabs.about", "info"],
];

const AI_PRESETS = () => [
  ["https://api.openai.com/v1", "OpenAI"],
  ["https://generativelanguage.googleapis.com/v1beta/openai", "Google Gemini"],
  ["https://openrouter.ai/api/v1", "OpenRouter"],
  ["https://api.deepseek.com/v1", "DeepSeek"],
  ["https://api.anthropic.com/v1", "Anthropic"],
  ["http://127.0.0.1:11434/v1", "Ollama (local)"],
  ["custom", t("auth.aiCustom")],
];
const tabLabel = (key) => t(key);
const ZOOMS = [
  [1, "100%"],
  [1.1, "110%"],
  [1.25, "125%"],
  [1.5, "150%"],
];
// 带文案的选项都写成函数：切换语言后重新取
const gatewayState = (st) => (has(`settings.gateway.${st}`) ? t(`settings.gateway.${st}`) : st);
const THEMES = () => [["system", t("common.system")], ["light", t("settings.theme.light")], ["dark", t("settings.theme.dark")]];
const TEXT_SIZES = () => ["sm", "md", "lg", "xl"].map((v) => [v, t(`settings.textSize.${v}`)]);
const FONTS = () => ["system", "serif", "custom"].map((v) => [v, t(`settings.font.${v}`)]);
const WIDTHS = () => ["normal", "wide", "full"].map((v) => [v, t(`settings.width.${v}`)]);
const AUTO_ON_OFF = () => [["system", t("common.system")], ["on", t("common.on")], ["off", t("common.off")]];
const LANG_OPTIONS = () => [["system", t("common.lang.system")], ...LANGS.map((lang) => [lang, LANG_NAMES[lang]])];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_ENTER = isMac ? "⌘Enter" : "Ctrl+Enter";
// 本机没开放字体列表（queryLocalFonts）时的候选：常见的中文 / 西文界面字体与等宽字体
const SUGGEST_UI = ["LXGW WenKai", "霞鹜文楷", "HarmonyOS Sans SC", "MiSans", "Source Han Sans SC", "Noto Sans SC", "Sarasa UI SC", "Inter"]; // i18n-ignore
const SUGGEST_CODE = ["JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", "Source Code Pro", "Sarasa Mono SC", "Maple Mono"];
const ALERT_LINES = () => [
  [0, t("settings.rows.lowBalance.none")],
  [1, "$1"],
  [5, "$5"],
  [20, "$20"],
];

/**
 * 设置行。go / href：只有一个「查看 / 打开」的行整行可点（GoRow），右侧浅灰 ›；打开站外网页的右侧 ↗（href，或 ext + go）。
 * 其余行右侧是控件：按钮一律是小胶囊（.btn.sm；危险的 .danger.soft 放最右；站外的文字后带 ↗；每页最多一个主按钮），
 * 一行最多两个胶囊，多出的收进最右侧的「⋯」（MoreButton）
 */
function Row({ id, name, sub, title, children, flash, off, go, href, ext, disabled }) {
  if (go || href) return html`<${GoRow} id=${`set-${id}`} name=${name} sub=${sub} title=${title} onClick=${go} href=${href} ext=${ext} disabled=${disabled} flash=${flash} />`;
  return html`<div class=${`row${flash ? " flash" : ""}${off ? " off" : ""}`} id=${`set-${id}`} title=${title}>
    <div class="who"><div class="name">${name}</div>${sub && html`<div class="sub">${sub}</div>`}</div>
    <div class="ctl">${children}</div>
  </div>`;
}

// 本机已安装字体（Local Font Access API）：第一次聚焦字体输入框时读一次，浏览器里可能会先弹权限
let localFonts = null;
function loadLocalFonts() {
  if (!localFonts)
    localFonts = (typeof window.queryLocalFonts === "function" ? window.queryLocalFonts() : Promise.resolve([]))
      .then((list) => [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b)))
      .catch(() => {
        localFonts = null; // 拒绝了或不支持：下次聚焦再试，这次先用候选
        return [];
      });
  return localFonts;
}

/** 字体名输入框：边打字边生效（外观实时变），离开或从候选里选中时提示"已保存"；输入框自己用这个字体显示 */
function FontInput({ id, value, onChange, placeholder, suggest, fallback, label }) {
  const ref = useRef(null);
  const [v, setV] = useState(value);
  const [fonts, setFonts] = useState(null);
  // 外面改了（恢复默认）且没在输入时，跟着变
  useEffect(() => {
    if (document.activeElement !== ref.current) setV(value);
  }, [value]);
  const stack = fontStack(v);
  return html`<input ref=${ref} class="field font-in" type="text" list=${`${id}-list`} aria-label=${label} placeholder=${placeholder} value=${v}
      spellcheck="false" autocomplete="off" style=${{ fontFamily: stack ? `${stack}, ${fallback}` : "" }}
      onFocus=${() => !(fonts && fonts.length) && loadLocalFonts().then(setFonts)}
      onInput=${(e) => { setV(e.target.value); onChange(e.target.value); }}
      onChange=${() => saved()} />
    <datalist id=${`${id}-list`}>${(fonts && fonts.length ? fonts : suggest).map((f) => html`<option key=${f} value=${f} />`)}</datalist>`;
}

// 联网搜索的接口：自动 = 免费搜索，不用 Key
const SEARCH_OPTIONS = () => [
  ["auto", t("settings.rows.webSearch.auto")],
  ["tavily", "Tavily"],
  ["exa", "Exa"],
  ["bocha", t("settings.rows.webSearch.bocha")],
  ["zhipu", t("settings.rows.webSearch.zhipu")],
  ["keenable", "Keenable"],
  ["searxng", "SearXNG"],
];

/** 填 Key 或地址：回车或离开输入框时保存。Key 输入框总是空的（服务端只回末 4 位，显示在占位里），地址照原样显示 */
function SaveInput({ id, value = "", secret, label, placeholder, onSave }) {
  const ref = useRef(null);
  const [v, setV] = useState(value);
  useEffect(() => {
    if (document.activeElement !== ref.current) setV(value);
  }, [value]);
  const commit = () => {
    const x = v.trim();
    if (secret ? x : x !== value) onSave(x);
    if (secret) setV("");
  };
  return html`<input ref=${ref} id=${id} class="field mono key-in" type=${secret ? "password" : "url"} autocomplete="off" spellcheck="false"
    aria-label=${label} placeholder=${placeholder} value=${v} onInput=${(e) => setV(e.target.value)} onBlur=${commit}
    onKeyDown=${(e) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && (e.preventDefault(), e.currentTarget.blur())} />`;
}

/** 主题的缩略图：一扇小窗口，局部 data-theme 让它用那个主题的真实颜色 */
const ThemeSketch = ({ theme }) => html`<span class="tsk" data-theme=${theme}><i class="tsk-side"></i><span class="tsk-main"><i class="tsk-bubble"></i><i class="tsk-line"></i><i class="tsk-line short"></i><i class="tsk-box"></i></span></span>`;

/** 外观分页顶部：三张主题缩略图。跟随系统那张左半浅、右半深 */
function ThemeCards({ value, flash, onChange }) {
  return html`<div class=${`theme-cards${flash ? " flash" : ""}`} id="set-theme" role="group" aria-label=${t("settings.rows.theme.name")}>
    ${THEMES().map(([v, label]) => html`<button type="button" key=${v} class=${`theme-card${value === v ? " on" : ""}`} aria-pressed=${value === v} onClick=${() => onChange(v)}>
      <span class=${`theme-thumb${v === "system" ? " split" : ""}`} aria-hidden="true">
        ${v === "system" ? html`<${ThemeSketch} theme="light" /><${ThemeSketch} theme="dark" />` : html`<${ThemeSketch} theme=${v} />`}
      </span>
      <span class="theme-name">${label}</span>
    </button>`)}
  </div>`;
}

/** 文字预览：排在「文字」这组的最后，跟着字体大小、字体、代码字体和代码换行实时变 */
function TextPreview() {
  return html`<div class="text-sample" aria-hidden="true">
    <span class="t-label">${t("settings.preview.label")}</span>
    <p>${t("settings.preview.reply", { b: html`<b>${t("settings.rows.codeWrap.name")}</b>` })}</p>
    <pre>const res = await fetch(\`\${base}/v1/chat/completions\`, { method: "POST", headers, body: JSON.stringify({ model, messages }) });</pre>
  </div>`;
}

/** 按 group 分段：相邻同组的行排在一块 .list 里，第一段可以没有标题 */
function groupRows(list) {
  const out = [];
  for (const r of list) {
    const key = r.group || "";
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else out.push({ key, label: key ? t(`settings.groups.${key}`) : "", note: r.groupNote, rows: [r] });
  }
  return out;
}

function NoticesSheet({ onClose }) {
  const [d, setD] = useState(null);
  const lang = useLang();
  useEffect(() => {
    let active = true;
    setD(null);
    api("/notices").then((value) => active && setD(value)).catch((e) => active && setD({ license: e.message, notices: "" }));
    return () => { active = false; };
  }, [lang]);
  return html`<${Sheet} title=${t("settings.rows.licenses.name")} wide onClose=${onClose}>
    <pre class="doc">${d ? `${d.license}\n\n${d.notices}` : t("common.loading")}</pre>
  <//>`;
}

/** 设置时的侧栏：返回应用 | 查找设置 | 分页 | 账户 */
export function SettingsSide({ tab, query, onQuery, onTab, onBack, username, account, authUser, onLogout, update, onUpdateChanged, nav }) {
  const searching = !!query.trim();
  return html`<aside class="side" aria-label=${t("settings.side.label")}>
    <div class="side-top start">
      ${nav && html`<${SideActions} ...${nav}><span class="grow"></span><//>`}
    </div><div class="settings-back-row">
      <button type="button" class="side-back" title=${t("settings.side.backTitle")} onClick=${onBack}><${Icon} name="arrowLeft" size="md" />${t("settings.side.back")}</button>
    </div>
    <label class="side-search">
      <${Icon} name="search" size="sm" />
      <input type="search" placeholder=${t("settings.side.search")} aria-label=${t("settings.side.search")} value=${query} onInput=${(e) => onQuery(e.target.value)}
        onKeyDown=${(e) => e.key === "Escape" && !e.isComposing && e.keyCode !== 229 && query && (e.stopPropagation(), onQuery(""))} />
    </label>
    <nav class="side-list" aria-label=${t("settings.side.nav")}>
      ${TABS.map(([id, label, icon]) => {
        const on = !searching && id === tab;
        return html`<button type="button" key=${id} class=${`nav-item${on ? " sel" : ""}`} aria-current=${on ? "page" : undefined}
          onClick=${() => { onQuery(""); onTab(id); }}><${Icon} name=${icon} size="md" /><span>${tabLabel(label)}</span></button>`;
      })}
    </nav>
    <div class="side-foot"><${AccountButton} username=${username} account=${account} authUser=${authUser} onLogout=${onLogout} update=${update} onUpdateChanged=${onUpdateChanged} settingsOn onSettings=${() => onTab("general")} onModelflare=${() => { onQuery(""); onTab("modelflare"); }} /></div>
  </aside>`;
}

export function SettingsScreen({ tab, query: q, onQuery: setQ, onTab, focusRow, mf, onMfChanged, onSettings, models, modelsError, reloadModels, status, update, onUpdateChanged, bots, onOpenBotSettings, account: acct, onAccount, authUser, onLogout, onOpenApps }) {
  const [s, setS] = useState(null);
  const g = useStore(guide);
  const effort = useEffort();
  const [notices, setNotices] = useState(false);
  const [sheet, setSheet] = useState(""); // usage | notifications | login
  const [leaving, setLeaving] = useState(false);
  const [balanceRefreshing, setBalanceRefreshing] = useState(false);
  const balanceRequest = useRef(null);
  // 官方 API：各家的连接状态；keySheet 是正在填 Key 的那一家
  const [official, setOfficial] = useState(null);
  const [keySheet, setKeySheet] = useState(null);
  const [invite, setInvite] = useState(null);
  const [unread, setUnread] = useState(null);
  const [cu, setCu] = useState(null);
  const [flash, setFlash] = useState("");
  const mode = useStore(themeMode);
  const p = useStore(prefs);
  const lang = useLang();
  // 语言偏好单独订阅：系统语言本来就是英文时，"跟随系统" → "English" 不改变界面语言，useLang() 不会变
  const [langPref, setLangPrefView] = useState(getLangPref);
  useEffect(() => onLangChange(() => setLangPrefView(getLangPref())), []);

  // 图片 / 视频模型（共用 Key 能用的，按推荐顺序）：连上 Modelflare 后取
  const [media, setMedia] = useState(null);
  const loadMedia = () =>
    api("/media/models")
      .then(setMedia)
      .catch((e) => setMedia({ image: [], video: [], recommended: {}, error: e.message }));
  useEffect(() => {
    api("/settings").then(setS).catch(failed);
  }, []);
  useEffect(() => {
    if (mf && mf.connected) loadMedia();
  }, [mf && mf.connected]);
  useEffect(() => {
    if (bots && bots[0]) api(`/bots/${encodeURIComponent(bots[0].id)}/settings`).then((d) => setCu(d.computerUse)).catch(() => {});
  }, [bots && bots[0] && bots[0].id]);
  useEffect(() => {
    if (!focusRow) return;
    setQ("");
    requestAnimationFrame(() => {
      document.getElementById(`set-${focusRow}`)?.scrollIntoView({ block: "center" });
      setFlash(focusRow);
      setTimeout(() => setFlash(""), 1300);
    });
  }, [focusRow, tab]);

  const put = async (patch, rollback) => {
    const prev = s;
    setS((v) => ({ ...v, ...rollback }));
    try {
      const next = await api("/settings", { method: "PUT", body: patch });
      setS(next);
      onSettings?.(next);
      if (patch.autoDownloadUpdates !== undefined) onUpdateChanged?.();
      saved();
    } catch (e) {
      setS(prev);
      failed(e);
    }
  };
  const setLine = async (line) => {
    try {
      await api("/modelflare/line", { method: "PUT", body: { line } });
      onMfChanged();
      saved();
    } catch (e) {
      failed(e);
    }
  };
  const refreshBalance = () => {
    if (balanceRequest.current) return balanceRequest.current;
    setBalanceRefreshing(true);
    balanceRequest.current = api("/account/refresh", { method: "POST", body: { maxAgeMs: 3000 } })
      .then(onAccount)
      .catch(failed)
      .finally(() => { balanceRequest.current = null; setBalanceRefreshing(false); });
    return balanceRequest.current;
  };
  // 账户操作只放在常规页底部，保留运行中任务提示和退出前的确认。
  const leaveAccount = async () => {
    if (leaving) return;
    try {
      const state = await api("/agent").catch(() => ({}));
      const busy = !!(state.busy?.length || Object.values(state.background || {}).some((n) => Number(n) > 0));
      const title = t(signedIn ? "firstUse.logout" : "firstUse.backConfig");
      const body = signedIn ? t(busy ? "firstUse.logoutBusy" : "firstUse.logoutBody") : t("firstUse.backConfigBody");
      if (!(await confirmSheet({ title, body, confirmLabel: title, danger: signedIn }))) return;
      setLeaving(true);
      const result = await api(signedIn ? "/account/logout" : "/account/setup", { method: "POST", body: signedIn ? { stopRunning: busy } : {} });
      if (signedIn && result.revoked === false) failed(t("settings.logout.notRevoked"));
      window.dispatchEvent(new Event("amb-connection-change"));
    } catch (e) {
      failed(e);
    } finally {
      setLeaving(false);
    }
  };
  // 性价比（Key 的路由策略）：Modelflare 不支持时状态里 supported 变成 false，这一行随之消失
  const putKeyQuality = (strategy) =>
    api("/account/key-quality", { method: "PUT", body: { strategy } })
      .then((r) => {
        onAccount(r);
        saved();
      })
      .catch((e) => {
        failed(e);
        return api("/account").then(onAccount).catch(() => {});
      });
  const putAlerts = (patch) =>
    api("/account/alerts", { method: "PUT", body: patch })
      .then((r) => {
        onAccount(r);
        saved();
      })
      .catch(failed);
  const putSearch = (patch) => put({ webSearch: patch }, { webSearch: { ...s.webSearch, ...(patch.provider ? { provider: patch.provider } : {}) } });
  const conn = useConnections(tab === "connections" ? focusRow : "");
  const desktop = !!(s && s.desktop);
  const pickFont = (v) => {
    setPrefs({ font: v });
    if (v === "custom") requestAnimationFrame(() => document.querySelector("#set-font-name input")?.focus());
    else saved();
  };
  const toggleNotify = async (v) => {
    if (v && !(await requestNotify())) return failed(t("settings.notifyDenied"));
    setPrefs({ notify: v });
    saved();
  };
  const customized = mode !== "system" || appearanceChanged(p) || (desktop && s.zoom !== 1);
  const resetLook = () => {
    setThemeMode("system");
    resetAppearance();
    if (desktop && s.zoom !== 1) put({ zoom: 1 }, { zoom: 1 });
    else saved();
  };
  const managed = mf && mf.mode === "managed";
  const signedIn = !!(acct && acct.state === "signed_in");
  useEffect(() => {
    if (tab === "modelflare" && managed && mf.connected && acct) void refreshBalance();
  }, [tab, managed, !!mf?.connected, !!acct]);
  useEffect(() => {
    if (managed && tab === "modelflare") api("/official").then((r) => setOfficial(r.providers)).catch(failed);
  }, [managed, tab]);
  const officialChanged = async (r) => {
    setOfficial(r.providers);
    setKeySheet(null);
    onMfChanged();
    reloadModels?.();
    saved();
  };
  const removeOfficial = async (p) => {
    const last = !(mf && mf.connected) && official.filter((x) => x.connected).length === 1;
    if (!(await confirmSheet({ title: t("official.remove.title", { name: officialName(p) }), body: last ? t("official.remove.bodyLast") : t("official.remove.body"), confirmLabel: t("official.remove.confirm"), danger: true }))) return;
    try {
      await officialChanged(await api(`/official/${encodeURIComponent(p.id)}`, { method: "DELETE" }));
    } catch (e) {
      failed(e);
    }
  };
  // 登录后才有邀请码和通知；进入模型分页时读一次
  useEffect(() => {
    if (!signedIn || tab !== "modelflare") return;
    api("/account/invite").then(setInvite).catch(() => setInvite(null));
    api("/account/notifications").then((r) => setUnread(r.data ? r.data.unread_count : null)).catch(() => setUnread(null));
  }, [signedIn, tab]);

  // —— 行定义：每行一个稳定 id，可被搜索、可被深链（#/settings/<tab>/<id>）——
  const rows = useMemo(() => {
    if (!s) return [];
    const guideSteps = g.loaded ? visibleSteps(g) : [];
    // 名称和左下角一样；名称是昵称或用户名且有邮箱时写「{名称} · {邮箱}」，名称本身是邮箱时只写一次
    const who = accountIdentity(acct);
    const acctName = signedIn ? (who.real && who.email && !who.nameIsEmail ? `${who.name} · ${who.email}` : who.name) : "";
    const gw = status && status.gateway;
    const alertLines = ALERT_LINES();
    return [
      { tab: "general", id: "language", name: t("common.lang.label"), sub: t("settings.rows.language.sub"), keys: t("settings.rows.language.keys"),
        ctl: html`<${MenuButton} width=${220} label=${t("common.lang.label")} value=${langPref} onChange=${(v) => changeLang(v).then(() => saved()).catch(failed)} options=${LANG_OPTIONS()} />` },
      { tab: "general", id: "send-key", name: t("settings.rows.sendKey.name"), sub: t("settings.rows.sendKey.sub", { key: p.sendKey === "mod" ? "Enter" : "Shift+Enter" }), keys: t("settings.rows.sendKey.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.sendKey.name")} value=${p.sendKey} onChange=${(v) => { setPrefs({ sendKey: v }); saved(); }} options=${[["enter", "Enter"], ["mod", MOD_ENTER]]} />` },
      canNotify && { tab: "general", id: "notify", name: t("settings.rows.notify.name"), sub: t("scheduled.notifySub"), keys: t("settings.rows.notify.keys"),
        ctl: html`<${Switch} label=${t("settings.rows.notify.name")} value=${p.notify} onChange=${toggleNotify} />` },
      desktop && { tab: "general", id: "rules-awake", name: t("scheduled.keepAwakeSetting"), sub: t("scheduled.keepAwakeHint"), keys: "schedule sleep 定时 睡眠", // i18n-ignore: multilingual command search keywords
        ctl: html`<${Switch} label=${t("scheduled.keepAwakeSetting")} value=${!!s.keepAwakeForRules} onChange=${(v) => put({ keepAwakeForRules: v }, { keepAwakeForRules: v })} />` },
      g.loaded && { tab: "general", id: "guide", name: t("settings.rows.guide.name"),
        sub: g.seen.includes("completed") ? t("guide.completed") : g.hidden ? t("settings.rows.guide.hidden") : t("settings.rows.guide.progress", { done: progress(g), total: guideSteps.length }),
        keys: t("settings.rows.guide.keys"),
        ctl: html`<button type="button" class="btn sm" onClick=${() => (g.hidden ? showGuide() : resetGuide()).catch(failed)}>${t(g.hidden ? "welcome.showAgain" : "settings.rows.guide.restart")}</button>` },
      desktop && { tab: "general", group: "desktop", id: "close", name: t("settings.rows.close.name"), sub: t("settings.rows.close.sub"), keys: t("settings.rows.close.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.close.name")} value=${s.closeToTray} onChange=${(v) => put({ closeToTray: v }, { closeToTray: v })} options=${[[true, t("settings.rows.close.tray")], [false, t("settings.rows.close.quit")]]} />` },
      desktop && s.autostart.supported && { tab: "general", group: "desktop", id: "autostart", name: t("settings.rows.autostart.name"), sub: t("settings.rows.autostart.sub"), keys: t("settings.rows.autostart.keys"),
        ctl: html`<${Switch} label=${t("settings.rows.autostart.name")} value=${s.autostart.on} onChange=${(v) => put({ autostart: v }, { autostart: { ...s.autostart, on: v } })} />` },
      desktop && { tab: "general", group: "desktop", id: "auto-download-updates", name: t("updates.autoDownload"),
        sub: t(s.autoUpdateSupported ? "updates.autoDownloadHint" : "updates.manualOnly"), keys: t("settings.rows.version.keys"),
        ctl: html`<${Switch} label=${t("updates.autoDownload")} value=${s.autoDownloadUpdates !== false} disabled=${!s.autoUpdateSupported}
          onChange=${(v) => put({ autoDownloadUpdates: v }, { autoDownloadUpdates: v })} />` },
      desktop && { tab: "general", group: "desktop", id: "browser", name: t("settings.rows.browser.name"), sub: t("settings.rows.browser.sub"), keys: t("settings.rows.browser.keys"),
        go: () => api("/desktop/open-in-browser", { method: "POST", body: {} }).catch(failed), ext: true },
      authUser && onLogout && { tab: "general", group: "account", id: "account-session", name: t("settings.rows.account.name"),
        sub: t("auth.signedInAs", { email: authUser.email || authUser.id || "—" }), keys: `${t("settings.rows.account.keys")} ${t("auth.signOut")}`,
        ctl: html`<${Button} size="sm" variant="danger" class="soft" onClick=${onLogout}>${t("auth.signOut")}<//>` },

      { tab: "appearance", searchOnly: true, id: "theme", name: t("settings.rows.theme.name"), sub: t("settings.rows.theme.sub"), keys: t("settings.rows.theme.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.theme.name")} value=${mode} onChange=${(m) => { setThemeMode(m); saved(); }} options=${THEMES()} />` },
      { tab: "appearance", group: "text", id: "text-size", name: t("settings.rows.textSize.name"), sub: desktop ? t("settings.rows.textSize.subDesktop") : t("settings.rows.textSize.sub"), keys: t("settings.rows.textSize.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.textSize.name")} value=${p.text} onChange=${(v) => { setPrefs({ text: v }); saved(); }} options=${TEXT_SIZES()} />` },
      { tab: "appearance", group: "text", id: "font", name: t("settings.rows.font.name"), sub: t("settings.rows.font.sub"), keys: t("settings.rows.font.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.font.name")} value=${p.font} onChange=${pickFont} options=${FONTS()} />` },
      p.font === "custom" && { tab: "appearance", group: "text", id: "font-name", name: t("settings.rows.fontName.name"), sub: p.fontName ? t("settings.rows.fontName.subSet") : t("settings.rows.fontName.subEmpty"), keys: t("settings.rows.fontName.keys"),
        ctl: html`<${FontInput} id="font-ui" label=${t("settings.rows.fontName.name")} value=${p.fontName} placeholder=${t("settings.rows.fontName.placeholder")} suggest=${SUGGEST_UI} fallback="var(--font-system)"
          onChange=${(v) => setPrefs({ fontName: v })} />` },
      { tab: "appearance", group: "text", id: "code-font", name: t("settings.rows.codeFont.name"), sub: t("settings.rows.codeFont.sub"), keys: t("settings.rows.codeFont.keys"),
        ctl: html`<${FontInput} id="font-code" label=${t("settings.rows.codeFont.name")} value=${p.codeFont} placeholder=${t("settings.rows.codeFont.placeholder")} suggest=${SUGGEST_CODE} fallback="var(--code-system)"
          onChange=${(v) => setPrefs({ codeFont: v })} />` },
      { tab: "appearance", group: "text", id: "code-wrap", name: t("settings.rows.codeWrap.name"), sub: t("settings.rows.codeWrap.sub"), keys: t("settings.rows.codeWrap.keys"),
        ctl: html`<${Switch} label=${t("settings.rows.codeWrap.name")} value=${p.codeWrap} onChange=${(v) => { setPrefs({ codeWrap: v }); saved(); }} />` },
      { tab: "appearance", group: "text", id: "text-preview", custom: html`<${TextPreview} key="text-preview" />` },
      desktop && { tab: "appearance", group: "layout", id: "zoom", name: t("settings.rows.zoom.name"), sub: t("settings.rows.zoom.sub"), keys: t("settings.rows.zoom.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.zoom.name")} value=${s.zoom} onChange=${(z) => put({ zoom: z }, { zoom: z })} options=${ZOOMS} />` },
      { tab: "appearance", group: "layout", id: "chat-width", name: t("settings.rows.chatWidth.name"), sub: t("settings.rows.chatWidth.sub"), keys: t("settings.rows.chatWidth.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.chatWidth.name")} value=${p.width} onChange=${(v) => { setPrefs({ width: v }); saved(); }} options=${WIDTHS()} />` },
      { tab: "appearance", group: "effects", id: "motion", name: t("settings.rows.motion.name"), sub: t("settings.rows.motion.sub"), keys: t("settings.rows.motion.keys"),
        ctl: html`<${Seg} label=${t("settings.rows.motion.name")} value=${p.motion} onChange=${(v) => { setPrefs({ motion: v }); saved(); }} options=${AUTO_ON_OFF()} />` },
      { tab: "appearance", id: "reset-appearance", name: t("settings.rows.resetAppearance.name"), sub: desktop ? t("settings.rows.resetAppearance.subDesktop") : t("settings.rows.resetAppearance.sub"), keys: t("settings.rows.resetAppearance.keys"),
        ctl: html`<button type="button" class="btn sm" disabled=${!customized} onClick=${resetLook}>${t("settings.rows.resetAppearance.button")}</button>` },

      ...(() => {
        const ep = s.llmEndpoint || { baseUrl: "", hasKey: false, keyHint: "" };
        const presets = AI_PRESETS();
        const presetVal = presets.some(([u]) => u !== "custom" && u === ep.baseUrl) ? ep.baseUrl : "custom";
        const putLlm = async (patch) => {
          await put({ llmEndpoint: patch }, {});
          reloadModels?.().catch(() => {});
        };
        return [
          { tab: "modelflare", group: "models", id: "ai-preset", name: t("auth.aiPreset"), sub: ep.baseUrl || "https://api.openai.com/v1", keys: "api provider openai gemini openrouter deepseek ollama",
            ctl: html`<${MenuButton} label=${t("auth.aiPreset")} value=${presetVal} width=${220} options=${presets}
              onChange=${(v) => { if (v !== "custom") void putLlm({ baseUrl: v }); }} />` },
          { tab: "modelflare", group: "models", id: "ai-base-url", name: t("auth.aiBaseUrl"), sub: t("auth.aiBaseUrlSub"), keys: "url endpoint base openai",
            ctl: html`<${SaveInput} id="ai-base-url-in" value=${ep.baseUrl || ""} label=${t("auth.aiBaseUrl")} placeholder="https://api.openai.com/v1" onSave=${(baseUrl) => void putLlm({ baseUrl })} />` },
          { tab: "modelflare", group: "models", id: "ai-api-key", name: t("auth.aiApiKey"), sub: t("auth.aiApiKeySub"), keys: "api key token secret",
            ctl: html`<${SaveInput} id="ai-api-key-in" secret label=${t("auth.aiApiKey")} placeholder=${ep.keyHint || t("settings.rows.webSearchKey.placeholder")} onSave=${(apiKey) => void putLlm({ apiKey })} />
              ${ep.hasKey && html`<button type="button" class="btn sm danger soft" onClick=${() => void putLlm({ apiKey: "" })}>${t("auth.aiApiKeyRemove")}</button>`}` },
        ];
      })(),
      { tab: "modelflare", group: "models", id: "default-model", name: t("settings.rows.defaultModel.name"), sub: t("settings.rows.defaultModel.sub"), keys: t("settings.rows.defaultModel.keys"),
        ctl: html`<${PickModel} value=${s.defaultModel} models=${models} modelsError=${modelsError} reloadModels=${reloadModels} resetLabel=${t("settings.rows.defaultModel.auto")}
          onChange=${(m) => put({ defaultModel: m }, { defaultModel: m })} />` },
      { tab: "modelflare", group: "models", id: "models", name: t("settings.rows.models.name"), sub: modelsError ? t("settings.rows.models.error", { error: modelsError }) : t("settings.rows.models.sub"), keys: t("settings.rows.models.keys"),
        ctl: html`<span class="val num">${models ? t("settings.rows.models.count", { count: models.length }) : "…"}</span><button type="button" class="btn sm" onClick=${() => reloadModels().then(() => saved())}>${t("common.refresh")}</button>` },
      { tab: "modelflare", group: "models", id: "reasoning-effort", name: t("models.effort.name"), sub: t("settings.rows.effort.sub"), keys: t("settings.rows.effort.keys"),
        ctl: html`<${Seg} label=${t("models.effort.name")} value=${effort} onChange=${(v) => setEffort(v).then((ok) => ok && saved())} options=${effortOptions()} />` },

      { tab: "computer", id: "cu-status", name: t("settings.rows.cuStatus.name"), sub: cu ? cu.reason : t("common.reading"), keys: t("settings.rows.cuStatus.keys"),
        ctl: cu && html`<span class=${`badge ${cu.available ? "ok" : "err"}`}>${t(cu.available ? "settings.rows.cuStatus.ready" : "settings.rows.cuStatus.notReady")}</span>` },
      cu && cu.notice && { tab: "computer", id: "cu-notice", name: t("settings.rows.cuNotice.name"), sub: cu.notice, title: cu.notice, keys: t("settings.rows.cuNotice.keys"), ctl: null },
      { tab: "computer", id: "cu-per-bot", name: t("settings.rows.cuPerBot.name"), sub: t("settings.rows.cuPerBot.sub"), keys: t("settings.rows.cuPerBot.keys"),
        go: bots && bots[0] ? () => onOpenBotSettings(bots[0].id, "computer") : undefined, ctl: null },

      { tab: "privacy", id: "key-storage", name: t("settings.rows.keyStorage.name"), sub: t("settings.rows.keyStorage.sub"), ctl: null, keys: t("settings.rows.keyStorage.keys") },
      { tab: "privacy", id: "account-storage", name: t("settings.rows.accountStorage.name"), sub: t("settings.rows.accountStorage.sub"), ctl: null, keys: t("settings.rows.accountStorage.keys") },
      { tab: "privacy", id: "token", name: t("settings.rows.token.name"), sub: s.listen.tokenRequired ? t("settings.rows.token.required") : t("settings.rows.token.local"), keys: t("settings.rows.token.keys"),
        ctl: html`<span class=${`badge ${s.listen.tokenRequired ? "ok" : "off"}`}>${t(s.listen.tokenRequired ? "common.on" : "common.off")}</span>` },
      { tab: "privacy", id: "sandbox", name: t("settings.rows.sandbox.name"), sub: t("settings.rows.sandbox.sub"), ctl: null, keys: t("settings.rows.sandbox.keys") },
      { tab: "privacy", id: "screens", name: t("settings.rows.screens.name"), sub: t("settings.rows.screens.sub"), ctl: null, keys: t("settings.rows.screens.keys") },

      ...connectionRows(conn, bots, onOpenApps),
      { tab: "network", id: "web-search", name: t("settings.rows.webSearch.name"), sub: t("settings.rows.webSearch.sub"), keys: t("settings.rows.webSearch.keys"),
        ctl: html`<${MenuButton} label=${t("settings.rows.webSearch.name")} value=${s.webSearch.provider} width=${200} options=${SEARCH_OPTIONS()} onChange=${(v) => putSearch({ provider: v })} />` },
      s.webSearch.provider === "searxng" && { tab: "network", id: "web-search-url", name: t("settings.rows.webSearchUrl.name"), keys: t("settings.rows.webSearchUrl.keys"),
        ctl: html`<${SaveInput} id="web-search-url-in" value=${s.webSearch.url} label=${t("settings.rows.webSearchUrl.name")} placeholder="https://searx.example.org" onSave=${(url) => putSearch({ url })} />` },
      s.webSearch.provider !== "auto" && s.webSearch.provider !== "searxng" && (() => {
        const ws = s.webSearch;
        const name = t("settings.rows.webSearchKey.name", { provider: SEARCH_OPTIONS().find(([v]) => v === ws.provider)[1] });
        return { tab: "network", id: "web-search-key", name, sub: ws.keyRejected ? t("settings.rows.webSearchKey.rejected") : "", keys: t("settings.rows.webSearchKey.keys"),
          ctl: html`<${SaveInput} key=${ws.provider} id="web-search-key-in" secret label=${name} placeholder=${ws.keyTail ? `••••${ws.keyTail}` : t("settings.rows.webSearchKey.placeholder")} onSave=${(key) => putSearch({ key })} />
            ${ws.keyTail && html`<button type="button" class="btn sm danger soft" onClick=${() => putSearch({ key: "" })}>${t("settings.rows.webSearchKey.remove")}</button>`}` };
      })(),
      { tab: "network", id: "listen", name: t("settings.rows.listen.name"), sub: t("settings.rows.listen.sub"), keys: t("settings.rows.listen.keys"),
        ctl: html`<span class="val">${s.listen.host}:${s.listen.port}</span><${CopyButton} text=${`http://${s.listen.host === "0.0.0.0" ? "127.0.0.1" : s.listen.host}:${s.listen.port}/`} label=${t("settings.rows.listen.copy")} />` },

      { tab: "data", id: "data-dir", name: t("settings.rows.dataDir.name"), sub: t("settings.rows.dataDir.sub"), keys: t("settings.rows.dataDir.keys"),
        ctl: html`<span class="val" title=${s.dataDir}>${s.dataDir}</span><${CopyButton} text=${s.dataDir} label=${t("settings.rows.dataDir.copy")} />
          ${desktop && html`<button type="button" class="btn sm" onClick=${() => api("/desktop/open-data-dir", { method: "POST", body: {} }).catch(failed)}>${t("common.open")}</button>`}` },

      { tab: "about", id: "version", name: t("settings.rows.version.name"), keys: t("settings.rows.version.keys"),
        sub: updateDescription(update),
        ctl: html`<span class="val">${status ? status.version : ""}</span>
          <${UpdateActions} update=${update} onChanged=${onUpdateChanged} rowName=${t("settings.rows.version.name")} />` },
      { tab: "about", id: "licenses", name: t("settings.rows.licenses.name"), sub: t("settings.rows.licenses.sub"), keys: t("settings.rows.licenses.keys"),
        go: () => setNotices(true) },
      { tab: "about", id: "diagnostics", name: t("settings.rows.diagnostics.name"),
        sub: gw ? [t("settings.rows.diagnostics.gateway"), gatewayState(gw.state), gw.restarts && t("settings.rows.diagnostics.restarts", { count: gw.restarts }), gw.lastError].filter(Boolean).join(" · ") : "",
        keys: t("settings.rows.diagnostics.keys"),
        go: () => onTab?.("troubleshoot") },
    ].filter(Boolean);
  }, [s, mf, mode, p, models, modelsError, cu, status, update, bots, acct, authUser, onLogout, invite, unread, g, media, lang, langPref, conn.accounts, conn.channelAccounts, effort, official, leaving, balanceRefreshing]);

  const needle = fold(q.trim());
  const shown = needle ? rows.filter((r) => !r.custom && fold(`${r.name} ${r.sub || ""} ${r.keys || ""}`).includes(needle)) : rows.filter((r) => r.tab === tab && !r.searchOnly);
  // 搜索时按分页分段，平时按 group 分段
  const parts = needle ? TABS.map(([id, label]) => ({ label: tabLabel(label), rows: shown.filter((r) => r.tab === id) })).filter((x) => x.rows.length) : groupRows(shown);
  const acctRow = rows.find((r) => r.id === "account");
  const balRow = rows.find((r) => r.id === "balance");

  const title = needle ? t("settings.searchResults") : tabLabel((TABS.find(([id]) => id === tab) || TABS[0])[1]);
  return html`<section class="settings view" data-screen="settings" key=${needle ? "search" : tab}>
    <div class="set-head"><h1 class="set-title">${title}</h1></div>
    <div class="set-body">
      ${!s && html`<div class="list"><div class="row"><${Skeleton} w="40%" /></div><div class="row"><${Skeleton} w="55%" /></div></div>`}
      ${s && !shown.length && (needle || (tab !== "aboutMe" && tab !== "collab")) && html`<p class="set-none">${t("settings.noMatch")}</p>`}
      ${s && !needle && tab === "general" && html`<${PwshHint} inSettings />`}
      ${s && !needle && tab === "appearance" && html`<div class="set-part">${t("settings.groups.theme")}</div>
        <${ThemeCards} value=${mode} flash=${flash === "theme"} onChange=${(m) => { setThemeMode(m); saved(); }} />`}
      ${s && !needle && tab === "about" && html``}
      ${parts.map(({ label, note, rows: list }) => html`${label && html`<div class="set-part">${label}</div>`}${note && html`<p class="set-note">${note}</p>`}
        <div class="list">${list.map((r) => r.custom || html`<${Row} key=${r.id} id=${r.id} name=${r.name} sub=${r.sub} title=${r.title || r.sub} go=${r.go} href=${r.href} ext=${r.ext} disabled=${r.disabled} flash=${flash === r.id || conn.fresh === r.id}>${r.ctl}<//>`)}</div>`)}
    </div>
    ${notices && html`<${NoticesSheet} onClose=${() => setNotices(false)} />`}
    <${ConnectionSheets} conn=${conn} bots=${bots} />
    ${sheet === "usage" && html`<${UsageSheet} onClose=${() => setSheet("")} />`}
    ${sheet === "notifications" && html`<${NotificationsSheet} onClose=${() => { setSheet(""); setUnread(null); }} />`}
    ${sheet === "login" && html`<${Sheet} title=${t("settings.rows.account.login")} onClose=${() => setSheet("")}>
      <${AccountLogin} manual=${!!(acct && acct.manualLogin)} onSignedIn=${(a) => { setSheet(""); if (a) onAccount(a); onMfChanged(); reloadModels?.(); }} />
    <//>`}
    ${keySheet && html`<${Sheet} title=${officialName(keySheet)} onClose=${() => setKeySheet(null)}>
      <${OfficialKeyForm} desktop=${!!status?.desktop} provider=${keySheet} onConnected=${officialChanged} />
    <//>`}
  </section>`;
}
