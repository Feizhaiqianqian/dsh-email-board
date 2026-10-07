/**
 * 离线冒烟：用一个假 ctx 跑真实的宿主半侧，验证
 *   profile patch → 账号解析 → dsh-email 的 IMAP 池 → 卡片 JSON → 路由响应
 * 整条链路。它不依赖 DSH 进程，直接读 profile 的 cordis.patch.yml 当作
 * `ctx.settings.describe()` 会给出的 value。
 *
 *   node test/offline-route.mjs [账号名...]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const pluginDir = path.resolve(import.meta.dirname, '..');
const profileDir = process.env.DSH_PROFILE_DIR
  ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop');

const profileRequire = createRequire(path.join(profileDir, 'package.json'));
const YAML = profileRequire('yaml');

const patch = YAML.parse(readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'));
const row = patch.find(entry => entry.id === 'tool-email');
if (row === undefined) throw new Error('profile patch 里没有 id: tool-email 这一行');
// ctx.settings.describe() 的 value 就是这条插件条目的活配置投影。
const emailValue = { ...row.config };

const wanted = process.argv.slice(2).filter(name => name !== '' && !name.startsWith('--'));
const plugin = await import(pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href);

const routes = new Map();
const disposers = [];
const webServer = {
  register(route) {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  },
};
// 真实的 settings.describe() 用 profile **条目 id** 当 ns（这里是 tool-email），
// 而不是 dsh-email 自己注册的命名空间；两种都试一遍，确认查找逻辑不挑形状。
const nsArg = process.argv.find(arg => arg.startsWith('--ns='));
const namespace = nsArg === undefined ? 'tool-email' : nsArg.slice('--ns='.length);
// --redact 模拟「value 被脱敏」：账号 YAML 与密码只留在 base/user 层，
// 用来验证 effectiveSettings 的候选回退链（避免真机上再改一次代码）。
const redact = process.argv.includes('--redact');
const exposed = redact ? { ...emailValue, accountsYaml: '', password: '' } : emailValue;
const settings = {
  describe: () => [{
    ns: namespace,
    value: exposed,
    ...(redact ? { base: emailValue } : {}),
    user: emailValue,
    revision: 0,
    applies: 'live',
  }],
};

function childCtx(services) {
  return {
    ...services,
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
  };
}

const ctx = {
  effect: (fn) => {
    const result = fn();
    if (typeof result === 'function') disposers.push(result);
    return result;
  },
  inject: (deps, callback) => {
    const services = {};
    for (const dep of deps) {
      if (dep === 'settings') services.settings = settings;
      if (dep === 'webServer') services.webServer = webServer;
    }
    callback(childCtx(services));
  },
};

plugin.apply(ctx, { accounts: wanted, perAccountLimit: 5, cacheMs: 0, timeoutMs: 30000 });
if (!routes.has(plugin.ROUTE)) throw new Error('路由未注册：' + plugin.ROUTE);

const handler = routes.get(plugin.ROUTE);
const response = await new Promise((resolve, reject) => {
  const chunks = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(payload) { chunks.push(payload); resolve({ status: this.status, body: Buffer.concat(chunks).toString('utf8') }); },
    on() {},
    once() {},
    removeListener() {},
    emit() {},
  };
  const req = { method: 'GET', url: plugin.ROUTE, headers: {} };
  handler(req, res).catch(reject);
});

const parsed = JSON.parse(response.body);
console.log('HTTP', response.status);
if (process.argv.includes('--fixture')) {
    const { writeFileSync } = await import('node:fs');
    // 真机数据只落到 .local.json：它被 .gitignore 忽略，不会被误提交。
    const target = path.join(pluginDir, 'test', 'fixture-state.local.json');
    writeFileSync(target, JSON.stringify(parsed, null, 2), 'utf8');
    console.log('已写入本机渲染样本（git 忽略）：' + target);
}
if (parsed.ok !== true) {
  console.log(JSON.stringify(parsed, null, 2));
} else {
  const value = parsed.value;
  console.log('fetchedAt', new Date(value.fetchedAt).toISOString(), '| accounts', value.accountNames.join('、'), '| 未读合计', value.totals.unread, '| 失败', value.totals.failed);
  for (const account of value.accounts) {
    console.log('\n== ' + account.name + ' <' + account.address + '> [' + account.folder + '] 未读 ' + account.totalUnread + (account.error ? ' 错误：' + account.error : ''));
    for (const message of (account.messages ?? []).slice(0, 5)) {
      const from = message.from?.[0]?.name || message.from?.[0]?.address || '(未知)';
      console.log('   - ' + from + ' | ' + (message.subject || '(无主题)') + ' | ' + message.date);
    }
  }
}

for (const dispose of disposers.reverse()) {
  try { await dispose(); } catch (error) { console.error('dispose 失败：', error?.message ?? error); }
}
