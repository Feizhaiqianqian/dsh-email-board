/**
 * 离线渲染冒烟：用一个迷你 React 跑真实的 lib/client.js。
 *
 * 验证的是客户端半侧最容易出错的部分——插件工厂、apply() 的两处注册、
 * 以及拿路由 JSON 渲染一次列表（发件人/主题/时间/附件标签）。
 * 浏览器里的像素与样式它管不了，但渲染崩溃和取数分支能在这里抓到。
 *
 * 样本：优先 test/fixture-state.local.json（本机真机数据，git 忽略），
 * 否则用随仓库发布的虚构样本 test/fixture-state.json。
 *
 *   node test/render-board.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const pluginDir = path.resolve(import.meta.dirname, '..');

// —— 迷你 React：够跑这个 tab 正文的 useState/useEffect/useRef/useMemo/useCallback ——
const stores = new Map();
let hooks = null;
let scheduled = false;
let renderTree = null;

function hookStore() {
  const owner = hooks.owner;
  if (!stores.has(owner)) stores.set(owner, []);
  return stores.get(owner);
}

function slot(init) {
  const list = hookStore();
  const index = hooks.index++;
  if (list[index] === undefined) list[index] = init();
  return list[index];
}

function queueRender() {
  scheduled = true;
}

const ReactShim = {
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    return { type, props: { ...(props ?? {}), ...(kids === undefined ? {} : { children: kids }) } };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const box = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [box.value, (next) => {
      box.value = typeof next === 'function' ? next(box.value) : next;
      queueRender();
    }];
  },
  useRef(initial) {
    return slot(() => ({ current: initial }));
  },
  useMemo(factory, deps) {
    const box = slot(() => ({ deps, value: factory() }));
    if (box.deps !== deps && (box.deps === undefined || deps === undefined || deps.some((item, i) => item !== box.deps[i]))) {
      box.deps = deps;
      box.value = factory();
    }
    return box.value;
  },
  useCallback(fn, deps) {
    return ReactShim.useMemo(() => fn, deps);
  },
  useEffect(run, deps) {
    const box = slot(() => ({ deps: undefined, cleanup: undefined }));
    const changed = box.deps === undefined || deps === undefined || deps.some((item, i) => item !== box.deps[i]);
    box.deps = deps;
    if (changed) hooks.effects.push(() => {
      box.cleanup?.();
      const cleanup = run();
      box.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    });
  },
};

// 注意：hooks 槽按组件 owner 字符串缓存，跨重渲染保持（这就是状态能留住的原因）。

function renderNode(node, owner) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(child => renderNode(child, owner)).join('');
  if (typeof node.type === 'function') {
    const previousHooks = hooks;
    hooks = { owner: owner + '/' + (node.type.name || 'anon'), index: 0, effects: [] };
    const element = node.type({ ...node.props });
    const html = renderNode(element, hooks.owner);
    const effects = hooks.effects;
    hooks = previousHooks;
    effects.forEach(run => run());
    return html;
  }
  const children = renderNode(node.props?.children, owner);
  return children;
}

// —— 假的浏览器环境 ——
// 样本优先用 fixture-state.local.json（本机真机数据，已被 .gitignore 忽略），
// 没有就用随仓库发布的虚构样本 fixture-state.json —— 真实邮件永远不会进仓库。
const localFixture = path.join(pluginDir, 'test', 'fixture-state.local.json');
const sharedFixture = path.join(pluginDir, 'test', 'fixture-state.json');
const fixturePath = existsSync(localFixture) ? localFixture : sharedFixture;
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const route = { body: null };
globalThis.document = {
  hidden: false,
  head: { appendChild() {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.fetch = async (url, init) => {
  route.url = url;
  route.signal = init?.signal;
  route.body ??= fixture;
  return {
    ok: true,
    status: 200,
    json: async () => route.body,
  };
};

let exportsOfBundle = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      globalThis.__loadedId = id;
      exportsOfBundle = factory(name => {
        if (name === 'react') return ReactShim;
        throw new Error('未知模块：' + name);
      });
    },
  },
};

// —— 载入真实的客户端 bundle ——
const source = readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8');
new Function(source)();

if (globalThis.__loadedId !== 'dsh-email-board') throw new Error('bundle id 不对：' + globalThis.__loadedId);

const registrations = { tabType: null, slotName: null, slotKey: null, dicts: null };
const ZH = { "time.justNow": "刚刚" };
const ctx = {
  effect(run) {
    const disposer = run();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: {
    register(ns, dicts) { registrations.dicts = { ns, dicts }; },
    bind() { return (key) => (registrations.dicts?.dicts?.zh?.[key] ?? key); },
  },
  sidebarRightTabs: { register(definition) { registrations.tabType = definition; return () => {}; } },
  slots: {
    inject(name, run) { registrations.slotName = name; return run(); },
    register(definition, component) { registrations.slotKey = definition.key; registrations.body = component; return () => {}; },
  },
};

exportsOfBundle.apply(ctx);

const problems = [];
if (registrations.tabType?.kind !== 'email-board') problems.push('tab kind 未注册：' + JSON.stringify(registrations.tabType));
if (registrations.slotName !== 'sidebar.right.pane.tab') problems.push('slot 名称不对：' + registrations.slotName);
if (registrations.slotKey !== registrations.tabType?.id) problems.push('slot key 与 tab id 不一致');
if (!Array.isArray(registrations.tabType?.guide) || registrations.tabType.guide.length === 0) problems.push('缺少 guide 入口，tab 在开始页里没有入口');
if (registrations.dicts?.ns !== 'emailBoard') problems.push('字典命名空间不对');

// —— 渲染两轮：先骨架，再真实数据 ——
const t = (key, params) => {
  const text = registrations.dicts?.dicts?.zh?.[key] ?? key;
  return params === undefined ? text : text.replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
};

for (let round = 0; round < 4; round += 1) {
  scheduled = false;
  renderTree = renderNode(ReactShim.createElement(registrations.body, { t }), 'root');
  await new Promise(resolve => setTimeout(resolve, 20));
  if (!scheduled) break;
}

console.log('样本：', path.relative(pluginDir, fixturePath));
console.log('tab 类型：', registrations.tabType.id, '/', registrations.tabType.kind);
console.log('渲染长度：', renderTree.length);

// 断言跟着样本走：样本里的每个账号名与每封邮件主题都必须出现在渲染结果里，
// 这样换样本（真机数据 / 虚构数据）都不用改测试。
const expected = new Set(['未读', '刷新']);
for (const account of fixture.value.accounts) {
  expected.add(account.name);
  for (const message of account.messages ?? []) {
    if (typeof message.subject === 'string' && message.subject !== '') expected.add(message.subject);
  }
}
for (const needle of expected) {
  if (!renderTree.includes(needle)) problems.push('渲染结果里缺少「' + needle + '」');
}
if (renderTree.includes('正在读取未读邮件') && !renderTree.includes([...expected][0])) {
  problems.push('仍停在骨架屏，数据没进渲染');
}

const textOnly = renderTree.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
console.log('可见文本片段：', textOnly.slice(0, 300));

if (problems.length > 0) {
  console.error('\n❌ 渲染冒烟发现问题：');
  for (const problem of problems) console.error(' - ' + problem);
  process.exitCode = 1;
} else {
  console.log('\n✅ 客户端注册与渲染冒烟通过');
}
// 正文里的轮询定时器会吊住事件循环，冒烟测试到这里就该结束。
process.exit(process.exitCode ?? 0);
