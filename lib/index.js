/**
 * dsh-email-board —— 邮件看板的宿主半侧。
 *
 * 只做两件事：
 *  1. 从 dsh-email 的设置命名空间读出账号的有效配置（provider/密码/服务器都沿用
 *     它的解析逻辑），再用 dsh-email 自己导出的 `EmailPool` 取每个账号的未读信封
 *     —— 等价于 `email_list` 的 `unreadOnly: true`，但不经过模型；
 *  2. 把结果挂到同源只读路由 `/_dsh/dsh-email-board/state` 上，供客户端插件按需读取
 *     （打开看板或点「刷新」时各取一次，没有定时轮询）。
 *
 * 这里刻意不复制 dsh-email 的任何内部实现：账号解析、IMAP 连接池、信封形状全部
 * 走它公开导出的 API，所以插件升级后不会因为对方改内部结构而失效。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'email-board';
/** webServer 是硬依赖：没有它就没有可读取的接口。settings 走子级注入（见 apply）。 */
export const inject = ['webServer'];

/** 客户端读取未读汇总的同源路由。 */
export const ROUTE = '/_dsh/dsh-email-board/state';

const EMAIL_PACKAGE = 'dsh-email';
/** dsh-email 在 settings 服务里注册的命名空间（= 它的 profile 条目 id）。 */
const EMAIL_NAMESPACE = 'dsh-email';

function clampInt(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 归一化 row config：坏值退回默认值，绝不让一个笔误把路由打成 500。 */
function normalizeOptions(config) {
    const raw = config ?? {};
    const accounts = Array.isArray(raw.accounts)
        ? raw.accounts.map(name => String(name ?? '').trim()).filter(name => name !== '')
        : [];
    return {
        accounts,
        folder: typeof raw.folder === 'string' ? raw.folder.trim() : '',
        perAccountLimit: clampInt(raw.perAccountLimit, 20, 1, 100),
        cacheMs: clampInt(raw.cacheMs, 20000, 0, 3600 * 1000),
        timeoutMs: clampInt(raw.timeoutMs, 25000, 3000, 300000),
        // 只有在前面的候选都落空时才用到：手填 profile 目录。
        profileDir: typeof raw.profileDir === 'string' ? raw.profileDir.trim() : '',
        // 设置条目的命名空间兜底（默认已经能通过形状识别 dsh-email 的表单）。
        settingsNamespace: typeof raw.settingsNamespace === 'string' ? raw.settingsNamespace.trim() : '',
    };
}

/**
 * DSH profile 目录：插件可能被链接在工作区里（pnpm 的 `file:` 依赖），那时从插件
 * 自己的真实路径解析 `dsh-email` 会失败，所以要能退回 profile 的 node_modules。
 */
function profileDirCandidates(configured) {
    const candidates = [];
    const push = (value) => {
        if (typeof value === 'string' && value.trim() !== '' && !candidates.includes(value.trim()))
            candidates.push(value.trim());
    };
    push(process.env.DSH_PROFILE_DIR);
    const home = process.env.DSH_HOME;
    const profile = process.env.DSH_PROFILE || 'desktop';
    if (typeof home === 'string' && home.trim() !== '')
        push(path.join(home.trim(), 'profiles', profile));
    push(path.join(os.homedir(), '.dsh', 'profiles', profile));
    push(configured);
    return candidates;
}

const emailModules = new Map();
/** 载入 dsh-email 的公开导出：先按普通 ESM 解析，失败再逐个 profile 目录解析。 */
async function loadEmailPackage(configuredProfileDir) {
    const cacheKey = configuredProfileDir ?? '';
    if (emailModules.has(cacheKey))
        return emailModules.get(cacheKey);
    let loaded;
    try {
        loaded = await import(EMAIL_PACKAGE);
    }
    catch (directError) {
        const attempts = [];
        for (const dir of profileDirCandidates(configuredProfileDir)) {
            try {
                const profileRequire = createRequire(path.join(dir, 'package.json'));
                const resolved = profileRequire.resolve(EMAIL_PACKAGE);
                loaded = await import(pathToFileURL(resolved).href);
                break;
            }
            catch (error) {
                attempts.push(dir + '：' + describeError(error));
            }
        }
        if (loaded === undefined)
            throw new Error('需要 dsh-email 插件：无法载入 "' + EMAIL_PACKAGE + '"（' + describeError(directError) + '；已尝试 ' + (attempts.join('；') || '无候选目录') + '）');
    }
    emailModules.set(cacheKey, loaded);
    return loaded;
}

function describeError(error) {
    if (typeof error === 'string')
        return error;
    if (error !== null && typeof error === 'object' && typeof error.message === 'string')
        return error.message;
    return String(error);
}

/** 信封（dsh-email 的 listedFrom 形状）→ 卡片要用的最小字段。 */
function toCard(message) {
    return {
        uid: message.uid,
        subject: typeof message.subject === 'string' ? message.subject : '',
        from: Array.isArray(message.from) ? message.from.map(address => ({
            name: typeof address?.name === 'string' ? address.name : '',
            address: typeof address?.address === 'string' ? address.address : '',
        })) : [],
        date: typeof message.date === 'string' ? message.date : '',
        flagged: message.flagged === true,
        hasAttachments: message.hasAttachments === true,
    };
}

function json(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(payload.length),
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

/**
 * 只读路由的同源判定。
 *
 * 未读信封的标题与发件人是隐私数据，任何网页都不该靠一次 GET 把它读走：浏览器会
 * 带 `Sec-Fetch-Site`，非 same-origin 一律拒绝。非浏览器调用方（curl、测试）不带
 * 这个头，放行——它本来就能直接读本机的 DSH 数据。
 */
function readAllowed(headers) {
    const site = headers['sec-fetch-site'];
    if (typeof site !== 'string' || site === '')
        return true;
    return site === 'same-origin' || site === 'none';
}

/** 设置值长得像 dsh-email 的表单：有 accountsYaml 或 inboxFolder 字段。 */
function looksLikeEmailSettings(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    return 'accountsYaml' in value || 'inboxFolder' in value;
}

/**
 * 在 settings.describe() 的行里认出 dsh-email 那条。
 *
 * settings 服务用 profile **条目 id**（这里是 `tool-email`）当 ns，不一定等于
 * dsh-email 自己注册的命名空间，所以按「显式候选 → 形状像邮件设置」两级查找；
 * 找不到时调用方会把实际存在的 ns 全列出来，省得靠猜。
 */
function findEmailRow(rows, wanted) {
    return rows.find(entry => entry?.ns === EMAIL_NAMESPACE)
        ?? (wanted !== '' ? rows.find(entry => entry?.ns === wanted) : undefined)
        ?? rows.find(entry => looksLikeEmailSettings(entry?.value));
}

/** 看板数据源：设置解析 + 账号池 + 缓存 + 单飞（同一时刻只跑一轮 IMAP）。 */
class EmailBoard {
    options;
    settingsService = null;
    pool = null;
    poolFingerprint = '';
    cached = null;
    inflight = null;
    disposed = false;

    constructor(options) {
        this.options = options;
    }

    /**
     * dsh-email 设置里账号的当前有效配置（含密码/服务器），走它的公开解析函数。
     *
     * settings 服务用 profile **条目 id**（这里是 `tool-email`）当 ns，不一定等于
     * dsh-email 自己注册的命名空间，所以按「显式候选 → 形状像邮件设置」两级查找；
     * 找不到时把实际存在的 ns 全部列在错误里，省得靠猜。
     */
    async effectiveSettings(email) {
        const describe = this.settingsService?.describe;
        if (typeof describe !== 'function')
            throw new Error('settings 服务不可用，无法读取 dsh-email 的账号配置');
        // dsh-email 可能与看板同时在启动：前几秒还看不到它的设置行，等一下再试。
        let rows = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
            rows = describe.call(this.settingsService) ?? [];
            if (findEmailRow(rows, this.options.settingsNamespace) !== undefined)
                break;
            if (attempt < 2)
                await new Promise(resolve => setTimeout(resolve, 700));
        }
        const row = findEmailRow(rows, this.options.settingsNamespace);
        if (row === undefined) {
            const seen = rows.map(entry => entry?.ns).filter(ns => typeof ns === 'string' && ns !== '');
            throw new Error('找不到 dsh-email 的设置项：请确认 dsh-email 插件已启用（当前可配置的条目：' + (seen.join('、') || '无') + '）');
        }
        const value = row.value ?? {};
        // user = null：把候选值里出现的字段全部投影出来（value 就是合并后的活配置，
        // 不需要再叠 profile row config）。serverPresets 不进 EmailConfig，单独补上。
        //
        // 候选顺序是一层保险：万一 value 被脱敏（远程调用方会那样拿），空字符串会盖掉
        // base 层，所以回退候选里先剔掉空字符串字段。只要有一层能解析出账号就用它。
        const trimmed = (source) => {
            const out = {};
            for (const [key, item] of Object.entries(source ?? {})) {
                if (typeof item === 'string' && item.trim() === '')
                    continue;
                out[key] = item;
            }
            return out;
        };
        const candidates = [
            value,
            { ...(row.base ?? {}), ...trimmed(value) },
            { ...(row.base ?? {}), ...(row.user ?? {}), ...trimmed(value) },
        ];
        let settings = null;
        let lastError = null;
        for (const candidate of candidates) {
            try {
                const merged = email.toEmailConfig(candidate, null);
                if (typeof candidate.serverPresets === 'string' && candidate.serverPresets !== '')
                    merged.serverPresets = candidate.serverPresets;
                const resolved = email.resolveEmailSettings(merged);
                if (resolved.accounts.size > 0) {
                    settings = resolved;
                    break;
                }
            }
            catch (error) {
                lastError = error;
            }
        }
        if (settings === null) {
            throw new Error('读不到 dsh-email 的账号配置：'
                + (lastError === null ? '还没有配置任何账号，请先在 设置 → 邮件 里添加' : describeError(lastError)));
        }
        return settings;
    }

    /** 设置一变就换池子，避免改完账号还在用旧连接。 */
    poolFor(email, settings) {
        const fingerprint = JSON.stringify([
            [...settings.accounts.entries()],
            settings.defaultAccount,
            settings.maxBodyChars,
            settings.idleTimeoutMs,
            settings.bodySearchFallback,
            settings.bodySearchLimit,
        ]);
        if (this.pool === null || fingerprint !== this.poolFingerprint) {
            this.pool?.dispose();
            this.pool = new email.EmailPool(settings);
            this.pool.startIdleSweep();
            this.poolFingerprint = fingerprint;
        }
        return this.pool;
    }

    resetPool() {
        this.pool?.dispose();
        this.pool = null;
        this.poolFingerprint = '';
    }

    async state(force) {
        const now = Date.now();
        if (!force && this.cached !== null && now - this.cached.at < this.options.cacheMs)
            return this.cached.value;
        if (this.inflight !== null)
            return this.inflight;
        this.inflight = this.collect()
            .then((value) => {
                this.cached = { at: Date.now(), value };
                return value;
            })
            .finally(() => {
                this.inflight = null;
            });
        return this.inflight;
    }

    async collect() {
        const email = await loadEmailPackage(this.options.profileDir);
        const settings = await this.effectiveSettings(email);
        const known = [...settings.accounts.keys()];
        const names = this.options.accounts.length > 0 ? this.options.accounts : known;
        const pool = this.poolFor(email, settings);
        const accounts = [];
        for (const name of names) {
            const account = settings.accounts.get(name);
            if (account === undefined) {
                accounts.push({
                    name,
                    address: '',
                    folder: this.options.folder,
                    totalUnread: null,
                    messages: [],
                    error: '账号不存在，可用：' + (known.length > 0 ? known.join('、') : '（未配置）'),
                });
                continue;
            }
            const folder = this.options.folder || account.inboxFolder || 'INBOX';
            try {
                const listed = await this.listUnread(email, settings, name);
                accounts.push({
                    name,
                    address: typeof account.user === 'string' ? account.user : '',
                    folder: listed.folder,
                    totalUnread: listed.count,
                    truncated: listed.count > listed.messages.length,
                    messages: listed.messages.map(toCard),
                });
            }
            catch (error) {
                accounts.push({
                    name,
                    address: typeof account.user === 'string' ? account.user : '',
                    folder,
                    totalUnread: null,
                    messages: [],
                    error: describeError(error),
                });
            }
        }
        const failed = accounts.filter(account => account.error !== undefined).length;
        const unread = accounts.reduce((sum, account) => sum + (typeof account.totalUnread === 'number' ? account.totalUnread : 0), 0);
        return {
            fetchedAt: Date.now(),
            defaultAccount: settings.defaultAccount,
            accountNames: known,
            perAccountLimit: this.options.perAccountLimit,
            totals: { unread, failed, accounts: accounts.length },
            accounts,
        };
    }

    /** 一个账号的未读信封；连接坏掉时换一个新池子重试一次。 */
    async listUnread(email, settings, name) {
        const limit = this.options.perAccountLimit;
        const signal = AbortSignal.timeout(this.options.timeoutMs);
        try {
            return await this.poolFor(email, settings).list(name, this.options.folder, limit, 0, true, undefined, undefined, signal);
        }
        catch (error) {
            if (signal.aborted || this.disposed)
                throw error;
            this.resetPool();
            const retrySignal = AbortSignal.timeout(this.options.timeoutMs);
            return await this.poolFor(email, settings).list(name, this.options.folder, limit, 0, true, undefined, undefined, retrySignal);
        }
    }

    async handle(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            json(res, 405, { ok: false, error: { code: 'method', message: '邮件看板只提供只读 GET' } });
            return;
        }
        if (!readAllowed(req.headers ?? {})) {
            json(res, 403, { ok: false, error: { code: 'origin', message: '只允许同源请求读取未读邮件' } });
            return;
        }
        let force = false;
        try {
            const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
            force = url.searchParams.get('force') === '1';
        }
        catch { /* 坏 URL 就当普通刷新 */ }
        try {
            const value = await this.state(force);
            json(res, 200, { ok: true, value });
        }
        catch (error) {
            json(res, 503, { ok: false, error: { code: 'unavailable', message: describeError(error) } });
        }
    }

    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.cached = null;
        this.resetPool();
    }
}

export function apply(ctx, config = {}) {
    const board = new EmailBoard(normalizeOptions(config));
    ctx.effect(() => () => board.dispose(), 'dsh-email-board: pool');
    // settings 用子级注入：没有它时路由照样挂上，请求会收到一条明确的中文错误，
    // 而不是让整个插件永远停在 pending。
    ctx.inject(['settings'], (settingsCtx) => {
        board.settingsService = settingsCtx.settings;
    });
    ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: ROUTE,
            handler: (req, res) => board.handle(req, res),
        }), 'dsh-email-board: state route');
    });
}
