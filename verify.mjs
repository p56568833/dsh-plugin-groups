#!/usr/bin/env node
/**
 * dsh-plugin-groups 离线验证。
 *
 * 不启动 GUI，按 DSH 真会做的那样跑：
 *
 *   1. package.json 的 `dsh.client` 声明按 DSH 自己的校验规则核一遍
 *      （platform 必填字符串、inject/external 必须是字符串数组、immediately 必须是
 *       布尔、exports["./client"] 必须存在）；
 *   2. cordis.patch.yml 的 insert 行和 package.json 的 name 对得上；
 *   3. 用假的 window.__ModuleLoader__ 接住 client.js 的工厂并真的执行 factory(require)
 *      （同时等于语法检查），再用一个只够用的假 DOM 真跑一遍 Tab：
 *      · 契约缺失（页面没开 / 分组 id 改了）时一行都不插，只留诊断状态；
 *      · 只分出一类时保持官方原样（不插 Tab、不过滤）；
 *      · 17 个真实已安装包 → 「全部 + 7 类」8 个 Tab，标签、计数、顺序全对；
 *      · 点分类 Tab 只剩该类、点「全部」全回来、点在内层 span 上也管用（冒泡 + closest）；
 *      · 选中的 Tab 记进 localStorage，重开按它渲染；
 *      · 官方要滚到被当前分类挡住的卡时，临时按「全部」渲染，但**不改**用户的记忆；
 *      · 连跑三遍幂等（Tab 不叠加、过滤不变）；
 *      · 没点名的包落「其他」且排在最后；
 *      · 英文界面用英文 Tab 名；
 *      · 观察者的「自己人」过滤真的掐得死自触发；
 *      · disposer 把 Tab、过滤痕迹、style 标签、诊断属性全摘干净。
 *   4. **契约检查**：从 app.asar 里读官方 `dsh-client-ui-plugin-manager` 的 client.js，
 *      确认本插件依赖的那些钩子（`data-plugin-panel` / `data-plugin-group="bundles"` /
 *      `data-plugin-package` / 卡片列表 `display:flex;flex-direction:column`）还在 ——
 *      DSH 一升级就能提前知道契约破没破，不用靠肉眼看界面。另有 4 条反向用例证明这些断言真会失败。
 *   5. **覆盖检查**：读 profile 的 package.json 依赖，确认已安装的插件全都分到了确定的类别
 *      （不是靠关键词糊到「其他」），顺带抓包名拼错。
 *
 * 用法：node verify.mjs [--profile desktop]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const MANAGER_CLIENT = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js'

const results = []
/**
 * @param {string} name - 检查项。
 * @param {() => unknown} body - 断言体。
 */
function check(name, body) {
  try {
    const detail = body()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * @param {unknown} condition - 条件。
 * @param {string} message - 失败信息。
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * @param {unknown} actual - 实际值。
 * @param {unknown} expected - 期望值。
 * @param {string} message - 失败信息。
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

/**
 * @param {unknown} actual - 实际数组。
 * @param {unknown} expected - 期望数组。
 * @param {string} message - 失败信息。
 */
function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n  实际 ${a}\n  期望 ${b}`)
}

const argv = process.argv.slice(2)
const profileIndex = argv.indexOf('--profile')
const PROFILE = profileIndex >= 0 ? (argv[profileIndex + 1] ?? 'desktop') : (process.env.DSH_PROFILE ?? 'desktop')
const PROFILE_MANIFEST = path.join(os.homedir(), '.dsh', 'profiles', PROFILE, 'package.json')

/** 当前已安装的第三方组合包（就是插件页「已安装」那一组的成员，含本插件自己）。 */
const KNOWN_INSTALLED = [
  '@modusensus/dsh-mneme',
  'dsh-balance-widget',
  'dsh-better-sidebar',
  'dsh-claude-style',
  'dsh-cost-balance',
  'dsh-image-gen',
  'dsh-market-sidebar',
  'dsh-plugin-groups',
  'dsh-plugin-l10n-zh',
  'dsh-plugin-subscriptions',
  'dsh-status-rotator',
  'dsh-story-progress',
  'dsh-story-turing',
  'dsh-todo-bar',
  'dshmarket',
  'dsh-skin-fixes',
  'dsh-whale-splash',
]

/* ───────────────────────── 静态声明检查 ───────────────────────── */

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))

check('package.json 的 dsh.client 声明符合 DSH 自己的校验规则', () => {
  const decl = manifest.dsh?.client
  assert(decl !== undefined && typeof decl === 'object' && decl !== null, 'dsh.client 缺失')
  assert(typeof decl.platform === 'string' && decl.platform !== '', 'dsh.client.platform 必须是字符串')
  for (const key of ['inject', 'external']) {
    if (decl[key] === undefined) continue
    assert(Array.isArray(decl[key]) && decl[key].every((item) => typeof item === 'string'), `dsh.client.${key} 必须是字符串数组`)
  }
  if (decl.immediately !== undefined) assert(typeof decl.immediately === 'boolean', 'dsh.client.immediately 必须是布尔')
  assert(typeof manifest.exports?.['./client'] === 'string', 'exports["./client"] 必须存在（浏览器半边要能加载）')
  return `platform=${decl.platform}，inject=${JSON.stringify(decl.inject ?? [])}，immediately=${decl.immediately}`
})

check('cordis.patch.yml 的 insert 行指向本包', () => {
  const text = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
  assert(/-\s*insert:/.test(text), 'patch 里没有 insert 列表')
  const nameLine = /name:\s*'?"?([\w@/.-]+)'?"?/.exec(text)
  assert(nameLine !== null, 'patch 里没有 name')
  assertEqual(nameLine[1], manifest.name, 'patch 的 name 应等于包名')
  return `name=${nameLine[1]}`
})

check('locale/en.json 与 zh.json 都有 meta.title / meta.description（DSH 靠 en.json 才去读别的语言）', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(HERE, 'locale', file), 'utf8'))
  const zh = read('zh.json')
  const en = read('en.json')
  for (const [name, dict] of [['zh.json', zh], ['en.json', en]]) {
    assert(typeof dict.meta?.title === 'string' && dict.meta.title !== '', `${name} 缺 meta.title`)
    assert(typeof dict.meta?.description === 'string' && dict.meta.description !== '', `${name} 缺 meta.description`)
  }
  return `zh「${zh.meta.title}」/ en「${en.meta.title}」`
})

/* ───────────────────────── 只够用的假 DOM ───────────────────────── */

/**
 * 极简选择器引擎，只实现本插件与验证用到的那几种写法。
 * @param {any} node - 待匹配节点。
 * @param {string} compound - 单个复合选择器（无空格）。
 * @returns {boolean} 是否匹配。
 */
function matchesCompound(node, compound) {
  const parsed = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/.exec(compound)
  if (parsed === null) throw new Error(`verify 的迷你选择器没实现：${compound}`)
  const [, tag, rest] = parsed
  if (tag !== undefined && String(node.tagName).toUpperCase() !== tag.toUpperCase()) return false
  for (const part of rest.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part.startsWith('.')) {
      if (!node.classList.contains(part.slice(1))) return false
      continue
    }
    const inner = part.slice(1, -1)
    const eq = inner.indexOf('=')
    if (eq === -1) {
      if (!node.hasAttribute(inner)) return false
      continue
    }
    const name = inner.slice(0, eq)
    let value = inner.slice(eq + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (node.getAttribute(name) !== value) return false
  }
  return true
}

/**
 * 后代选择器查询（取第一个）。
 * @param {any} root - 查询根。
 * @param {string} selector - 选择器。
 * @returns {any} 命中的元素或 null。
 */
function querySelectorIn(root, selector) {
  const compounds = selector.trim().split(/\s+/)
  const last = compounds[compounds.length - 1]
  let found = null
  const walk = (node, ancestors) => {
    for (const child of node.children) {
      if (found !== null) return
      if (matchesCompound(child, last)) {
        let cursor = compounds.length - 2
        let index = ancestors.length - 1
        let ok = true
        while (cursor >= 0) {
          if (index < 0) {
            ok = false
            break
          }
          if (matchesCompound(ancestors[index], compounds[cursor])) cursor -= 1
          index -= 1
        }
        if (ok) found = child
      }
      walk(child, [...ancestors, child])
    }
  }
  walk(root, [])
  return found
}

/** 迷你 DOM 元素。 */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.attrs = new Map()
    this.children = []
    this.parentNode = null
    this.style = { display: '' }
    this.textContent = ''
    this.listeners = new Map()
  }

  get dataset() {
    const self = this
    return new Proxy(
      {},
      {
        get: (_, prop) => self.attrs.get(`data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
        set: (_, prop, value) => {
          self.attrs.set(`data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value))
          return true
        },
        has: (_, prop) => self.attrs.has(`data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
      },
    )
  }

  get className() {
    return this.attrs.get('class') ?? ''
  }

  set className(value) {
    this.attrs.set('class', String(value))
  }

  get classList() {
    const self = this
    return {
      contains: (name) => self.className.split(/\s+/).filter(Boolean).includes(name),
      add: (name) => {
        const set = new Set(self.className.split(/\s+/).filter(Boolean))
        set.add(name)
        self.className = [...set].join(' ')
      },
    }
  }

  get firstChild() {
    return this.children[0] ?? null
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value))
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }

  hasAttribute(name) {
    return this.attrs.has(name)
  }

  removeAttribute(name) {
    this.attrs.delete(name)
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  /** 从自己往上找第一个匹配的选择器（与真实 DOM 同义）。 */
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined && typeof node.tagName === 'string') {
      if (matchesCompound(node, selector)) return node
      node = node.parentNode
    }
    return null
  }

  appendChild(node) {
    node.parentNode?.removeChild(node)
    node.parentNode = this
    this.children.push(node)
    return node
  }

  insertBefore(node, reference) {
    if (reference === null || reference === undefined) return this.appendChild(node)
    node.parentNode?.removeChild(node)
    const index = this.children.indexOf(reference)
    assert(index >= 0, 'insertBefore 的参照节点不是本元素的子节点')
    this.children.splice(index, 0, node)
    node.parentNode = this
    return node
  }

  removeChild(node) {
    const index = this.children.indexOf(node)
    assert(index >= 0, 'removeChild 的节点不是本元素的子节点')
    this.children.splice(index, 1)
    node.parentNode = null
    return node
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  querySelector(selector) {
    return querySelectorIn(this, selector)
  }
}

/** 迷你 MutationObserver：只记录，等测试自己 trigger。 */
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
    this.disconnected = false
  }

  observe(target) {
    this.target = target
  }

  disconnect() {
    this.target = null
    this.disconnected = true
  }

  trigger(records) {
    if (this.target !== null) this.callback(records, this)
  }
}

/**
 * 造一个只够用的假 document（html > head/body）。
 * @returns {any} 假 document 与几个方便断言的口袋。
 */
function makeFakeDocument() {
  const doc = new FakeElement('#document')
  const html = new FakeElement('html')
  const head = new FakeElement('head')
  const body = new FakeElement('body')
  html.appendChild(head)
  html.appendChild(body)
  doc.appendChild(html)
  doc.documentElement = html
  doc.head = head
  doc.body = body
  doc.createElement = (tag) => new FakeElement(tag)
  doc.querySelector = (selector) => querySelectorIn(doc, selector)
  /** 造出来的观察者都会进这个数组，方便测试手动 trigger。 */
  const observers = []
  doc.defaultView = {
    requestAnimationFrame: (cb) => {
      cb()
      return 0
    },
    MutationObserver: class extends FakeMutationObserver {
      constructor(callback) {
        super(callback)
        observers.push(this)
      }
    },
  }
  return { doc, html, head, body, observers }
}

/**
 * 模拟一次点击：从节点自己往上冒泡，逐个调用注册的 click 监听器。
 * @param {any} node - 被点的节点。
 * @returns {any} 事件对象。
 */
function click(node) {
  const event = { type: 'click', target: node }
  let current = node
  while (current !== null && current !== undefined) {
    for (const listener of current.listeners?.get?.('click') ?? []) listener(event)
    current = current.parentNode
  }
  return event
}

/**
 * 在假 document 里搭出插件页：页面根 + 一个分组 + 该分组的卡片列表。
 * @param {any} fake - makeFakeDocument() 的返回值。
 * @param {{heading?: string, group?: string|null, packages?: string[], officialItems?: string[], omitList?: boolean, highlight?: string}} options - 搭法。
 *   `group: null` 表示页面还没渲染出任何分组（加载骨架屏）；`omitList` 表示分组在、列表没了；
 *   `highlight` 给那张卡打上官方的 `data-plugin-highlight`。
 * @returns {{panel: any, list: any}} 页面根与卡片列表（没有列表时为 null）。
 */
function buildPage(fake, options = {}) {
  const { heading = '插件', group = 'bundles', packages = [], officialItems = [], omitList = false, highlight } = options
  const panel = fake.doc.createElement('section')
  panel.setAttribute('data-plugin-panel', 'true')
  const title = fake.doc.createElement('h1')
  title.textContent = heading
  panel.appendChild(title)
  let list = null
  if (group !== null) {
    const section = fake.doc.createElement('section')
    section.setAttribute('data-plugin-scope', 'global')
    section.setAttribute('data-plugin-group', group)
    if (!omitList) {
      list = fake.doc.createElement('ul')
      list.className = 'ZVcBiW_cards'
      for (const name of packages) {
        const card = fake.doc.createElement('li')
        card.setAttribute('data-plugin-package', name)
        if (name === highlight) card.setAttribute('data-plugin-highlight', '')
        list.appendChild(card)
      }
      for (const id of officialItems) {
        const card = fake.doc.createElement('li')
        card.setAttribute('data-plugin-item', id)
        list.appendChild(card)
      }
      section.appendChild(list)
    }
    panel.appendChild(section)
  }
  fake.body.appendChild(panel)
  return { panel, list }
}

/* ───────────────────── 真的跑一遍 client.js ───────────────────── */

const clientSource = fs.readFileSync(path.join(HERE, 'client.js'), 'utf8')
let mod

check('client.js 可执行，工厂导出了 cordis 插件（同时等于语法检查）', () => {
  let captured = null
  const fakeWindow = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  // eslint-disable-next-line no-new-func
  new Function('window', clientSource)(fakeWindow)
  assert(captured !== null, '没有调用 window.__ModuleLoader__.load')
  assertEqual(captured.id, manifest.name, '模块 id 应等于包名')
  mod = captured.factory(() => {
    throw new Error('本包不应该 require 任何模块')
  })
  assert(typeof mod.apply === 'function', 'exports.apply 不是函数')
  assertEqual(mod.name, manifest.name, 'exports.name 应等于包名')
  assert(Array.isArray(mod.inject), 'exports.inject 必须是数组')
  assertEqual(mod.inject.length, 0, '本插件不需要任何服务，inject 应为空')
  assert(mod.__testing !== undefined, 'exports.__testing 没露出来')
  return `id=${captured.id}，inject=[]，类别 ${mod.__testing.CATEGORIES.length} 个 + ${mod.__testing.FALLBACK.zh}`
})

check('注入的 CSS 花括号平衡，度量与 token 抄的是官方那行 Tab', () => {
  const css = mod.__testing.CSS
  const open = (css.match(/\{/g) ?? []).length
  const close = (css.match(/\}/g) ?? []).length
  assert(open === close, `花括号不平衡：{ ${open} 个，} ${close} 个（一段坏 CSS 会静默失效）`)
  assertEqual(open, 11, '应当正好 11 条规则（Tab 行 / 条 / Tab / 激活色 / 下划线 / focus / 计数 + 补丁缩进 / 连接线 / 第二个起的连接线 / 小标签）')
  for (const fragment of [
    `li[${mod.__testing.TABBAR_ATTR}]`,
    'order: -1',
    'gap: 22px',
    'border-bottom: .5px solid var(--dsw-alias-border-l2)',
    'font-size: 13px',
    'line-height: 20px',
    'var(--dsw-alias-label-tertiary)',
    'var(--dsw-alias-label-primary)',
    '[data-active="true"]::after',
    'height: 2px',
    'var(--dsw-focus-ring-width)',
    'var(--dsw-alias-label-caption)',
    'tabular-nums',
    `li[${mod.__testing.CHILD_ATTR}]`,
    'content: var(--dsh-pg-badge)',
  ]) {
    assert(css.includes(fragment), `CSS 缺片段：${fragment}`)
  }
  return `${open} 条规则，含官方那行 Tab 的全部度量与 token`
})

/* ───────────────────────── Tab 行为（假 DOM） ───────────────────────── */

/**
 * 跑一轮：搭页面 → 起插件 → 给出断言助手。
 * @param {{packages?: string[], heading?: string, group?: string|null, officialItems?: string[], omitList?: boolean, highlight?: string, storage?: Array<[string, string]>, noStorage?: boolean}} options - 场景。
 * @returns {any} 现场。
 */
function scenario(options = {}) {
  const fake = makeFakeDocument()
  const page = buildPage(fake, options)
  const warnings = []
  const originalWarn = console.warn
  const originalDocument = globalThis.document
  const originalStorage = globalThis.localStorage
  const storage = new Map(options.storage ?? [])
  globalThis.document = fake.doc
  console.warn = (...args) => warnings.push(args.join(' '))
  if (options.noStorage === true) delete globalThis.localStorage
  else {
    globalThis.localStorage = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        storage.set(key, String(value))
      },
    }
  }
  let dispose
  try {
    dispose = mod.__testing.start(fake.doc)
  } finally {
    console.warn = originalWarn
    globalThis.document = originalDocument
  }
  // localStorage 得活到 dispose：点击是在 start() 之后发生的，存 Tab 靠它。
  const stop = () => {
    try {
      dispose()
    } finally {
      if (originalStorage === undefined) delete globalThis.localStorage
      else globalThis.localStorage = originalStorage
    }
  }
  const tabbar = () => page.list.children.filter((child) => child.hasAttribute(mod.__testing.TABBAR_ATTR))
  /** 当前那几个 Tab 按钮（Tab 行每一轮都是重建的，所以每次都要重新取）。 */
  const tabs = () => tabbar()[0]?.children[0]?.children ?? []
  const tab = (id) => tabs().find((button) => button.getAttribute(mod.__testing.TAB_ATTR) === id) ?? null
  const cards = () => page.list.children.filter((child) => child.getAttribute(mod.__testing.CARD_ATTR) !== null)
  const visible = () => cards().filter((card) => card.style.display !== 'none')
  const visibleNames = () => visible().map((card) => card.getAttribute(mod.__testing.CARD_ATTR))
  const rootAttr = (name) => fake.html.getAttribute(name)
  return { fake, storage, warnings, dispose: stop, tabbar, tabs, tab, cards, visible, visibleNames, rootAttr, ...page }
}

check('17 个真实已安装包 → 「全部 + 7 类」8 个 Tab，标签、计数、顺序、默认选中全对', () => {
  const live = scenario({ packages: KNOWN_INSTALLED })
  const { CATEGORIES, ALL_TAB, TAB_ATTR, ROOT_ATTR, ROOT_TAB_ATTR } = mod.__testing
  assertEqual(live.rootAttr(ROOT_ATTR), `active:${CATEGORIES.length}`, '诊断状态应为 active:7')
  assertEqual(live.rootAttr(ROOT_TAB_ATTR), ALL_TAB, '默认应停在「全部」')
  assertEqual(live.tabbar().length, 1, '应当只有一行 Tab')
  const tabs = live.tabs()
  assertEqual(tabs.length, CATEGORIES.length + 1, 'Tab 数应等于 1 + 类别数')
  assertEqual(tabs[0].getAttribute(TAB_ATTR), ALL_TAB, '第一个 Tab 应是「全部」')
  assertEqual(tabs[0].children[0].textContent, '全部', '第一个 Tab 的文字')
  assertEqual(tabs[0].children[1].textContent, String(KNOWN_INSTALLED.length), '「全部」的计数')
  assertEqual(tabs[0].getAttribute('aria-selected'), 'true', '默认选中的应是「全部」')
  assertDeepEqual(
    tabs.slice(1).map((button) => button.getAttribute(TAB_ATTR)),
    CATEGORIES.map((category) => category.id),
    '分类 Tab 的顺序应等于分类表顺序',
  )
  for (const [index, button] of tabs.slice(1).entries()) {
    const category = CATEGORIES[index]
    const expected = KNOWN_INSTALLED.filter((name) => mod.__testing.categoryOf(name).id === category.id)
    assertEqual(button.children[0].textContent, category.zh, `第 ${index + 2} 个 Tab 的文字`)
    assertEqual(button.children[1].textContent, String(expected.length), `「${category.zh}」Tab 的计数`)
    assertEqual(button.getAttribute('aria-selected'), 'false', `「${category.zh}」默认不该选中`)
  }
  assertEqual(live.visible().length, KNOWN_INSTALLED.length, '「全部」下每张卡都该看得见')
  live.dispose()
  return `8 个 Tab（全部 17 + 7 类），计数与分类表一致；默认全部`
})

check('补丁挂在父插件下面：排在父插件后一位、缩进标记、小标签；父插件不在时补丁照常单独显示', () => {
  const { PARENTS, CHILD_ATTR, PARENT_ATTR, CARD_ATTR, TAB_ATTR } = mod.__testing
  const live = scenario({ packages: KNOWN_INSTALLED })
  const byName = new Map(live.cards().map((card) => [card.getAttribute(CARD_ATTR), card]))
  const pairs = Object.entries(PARENTS).filter(([child, parent]) => byName.has(child) && byName.has(parent))
  assert(pairs.length === Object.keys(PARENTS).length, `已安装的 17 个包里，对照表的 ${Object.keys(PARENTS).length} 对应当都在（实际 ${pairs.length}）`)
  for (const [child, parent] of pairs) {
    const c = byName.get(child), p = byName.get(parent)
    assertEqual(c.getAttribute(CHILD_ATTR), '1', `${child} 应标成 ${parent} 的第 1 个补丁`)
    assertEqual(p.getAttribute(PARENT_ATTR), '1', `${parent} 应标成有 1 个补丁`)
    assertEqual(Number(c.style.order), Number(p.style.order) + 1, `${child} 应排在 ${parent} 后一位`)
    assertEqual(c.style['--dsh-pg-badge'], '"补丁"', `${child} 的小标签`)
    assertEqual(p.style['--dsh-pg-badge'], '"1 个补丁"', `${parent} 的小标签`)
    assertEqual(mod.__testing.categoryOf(child).id, mod.__testing.categoryOf(parent).id, `${child} 应与 ${parent} 同类`)
  }
  // 点「界面与外观」：皮肤修补和 Claude Code 风格一起在
  live.tabbar()[0].children[0].listeners.get('click')[0]({ target: live.tab('ui') })
  assert(live.visibleNames().includes('dsh-skin-fixes') && live.visibleNames().includes('dsh-claude-style'), '「界面与外观」里应同时有父插件和补丁')
  live.dispose()
  assert(live.cards().every((card) => !card.hasAttribute(CHILD_ATTR) && !card.hasAttribute(PARENT_ATTR) && !card.style.order), '卸载后补丁标记与排序都应摘干净')
  // 父插件没装：补丁不缩进、不标记
  const lonely = scenario({ packages: KNOWN_INSTALLED.filter((name) => name !== 'dsh-claude-style') })
  const skin = lonely.cards().find((card) => card.getAttribute(CARD_ATTR) === 'dsh-skin-fixes')
  assert(!skin.hasAttribute(CHILD_ATTR), '父插件不在时补丁不该缩进')
  lonely.dispose()
  return pairs.map(([child, parent]) => `${child} → ${parent}`).join('，')
})

check('点分类 Tab → 只剩该类；点「全部」全回来；点在内层 span 上也管用；选中记进 localStorage', () => {
  const live = scenario({ packages: KNOWN_INSTALLED })
  const { TAB_ATTR, ROOT_TAB_ATTR, STORAGE_KEY } = mod.__testing
  const expectedFor = (id) => KNOWN_INSTALLED.filter((name) => mod.__testing.categoryOf(name).id === id).sort()

  // 点「界面与外观」
  click(live.tab('ui'))
  assertEqual(live.rootAttr(ROOT_TAB_ATTR), 'ui', '选中应变成 ui')
  assertEqual(live.tab('ui').getAttribute('aria-selected'), 'true', 'ui 这个 Tab 应变成选中态')
  assertDeepEqual(live.visibleNames().sort(), expectedFor('ui'), '只剩界面与外观那几张卡')
  assertEqual(live.storage.get(STORAGE_KEY), 'ui', '选中应被记进 localStorage')

  // 点「模型与订阅」（只有 1 个）
  click(live.tab('model'))
  assertEqual(live.rootAttr(ROOT_TAB_ATTR), 'model', '选中应变成 model')
  assertDeepEqual(live.visibleNames(), ['dsh-plugin-subscriptions'], '只剩订阅账号接入')

  // 点「全部」，而且故意点在内层的 span 上，验证冒泡 + closest
  const allTab = live.tab('all')
  assertEqual(allTab.getAttribute(TAB_ATTR), 'all', '第一个 Tab 应是全部')
  click(allTab.children[0])
  assertEqual(live.rootAttr(ROOT_TAB_ATTR), 'all', '点内层 span 也该切回全部')
  assertEqual(live.visible().length, KNOWN_INSTALLED.length, '全部下每张卡都该看得见')

  // 点已经选中的那个 Tab：不该出乱子
  click(live.tab('all'))
  assertEqual(live.rootAttr(ROOT_TAB_ATTR), 'all', '重复点同一个 Tab 仍然停在全部')

  live.dispose()
  return 'ui → model → all 全对；内层 span 的点击也能冒泡到 Tab'
})

check('上次选中的 Tab 会被记住；没有 localStorage 也能正常跑', () => {
  const { STORAGE_KEY, ROOT_TAB_ATTR } = mod.__testing
  const remembered = scenario({ packages: KNOWN_INSTALLED, storage: [[STORAGE_KEY, 'market']] })
  assertEqual(remembered.rootAttr(ROOT_TAB_ATTR), 'market', '重开应按记住的 market 渲染')
  assertDeepEqual(remembered.visibleNames().sort(), ['dsh-market-sidebar', 'dshmarket'], '只剩市场与安装那两张')
  remembered.dispose()

  const noStorage = scenario({ packages: KNOWN_INSTALLED, noStorage: true })
  assertEqual(noStorage.rootAttr(ROOT_TAB_ATTR), 'all', '没有 localStorage 时应回落到全部')
  assertEqual(noStorage.visible().length, KNOWN_INSTALLED.length, '没有 localStorage 时也该全部可见')
  noStorage.dispose()
  return '记住的选择生效；存储不可用时安静回落'
})

check('官方要滚到被当前分类挡住的卡时：临时按「全部」渲染，但不改用户的记忆', () => {
  const { STORAGE_KEY, ROOT_TAB_ATTR } = mod.__testing
  const live = scenario({ packages: KNOWN_INSTALLED, storage: [[STORAGE_KEY, 'ui']], highlight: 'dsh-todo-bar' })
  assertEqual(live.rootAttr(ROOT_TAB_ATTR), 'all', '被挡住的那张卡要滚，就该临时按全部渲染')
  assertEqual(live.tab('ui').getAttribute('aria-selected'), 'false', '临时切换时 ui 那个 Tab 不该亮着')
  assertEqual(live.visible().length, KNOWN_INSTALLED.length, '临时全部：每张卡都看得见')
  assertEqual(live.storage.get(STORAGE_KEY), 'ui', '用户的记忆不该被改掉')
  live.dispose()

  // 同一张卡如果本来就在选中的分类里，就不用临时切换
  const sameCategory = scenario({ packages: KNOWN_INSTALLED, storage: [[STORAGE_KEY, 'workflow']], highlight: 'dsh-todo-bar' })
  assertEqual(sameCategory.rootAttr(ROOT_TAB_ATTR), 'workflow', '卡就在这一类里，应保持分类视图')
  assertEqual(sameCategory.tab('workflow').getAttribute('aria-selected'), 'true', 'workflow 那个 Tab 应亮着')
  sameCategory.dispose()
  return '高亮兜底只影响这一轮渲染，不动存储'
})

check('只分出一类时保持官方原样：不插 Tab、不过滤', () => {
  const live = scenario({ packages: ['dsh-todo-bar', 'dsh-story-turing', 'dsh-story-progress'] })
  assertEqual(live.rootAttr(mod.__testing.ROOT_ATTR), 'flat', '诊断状态应为 flat')
  assertEqual(live.tabbar().length, 0, '单类别不该插 Tab')
  for (const card of live.cards()) assertEqual(card.style.display, '', '单类别不该藏任何卡')
  live.dispose()
  return 'flat：三张卡全在「任务与工作流」里，页面原样'
})

check('契约破了：分组 id 改了 → renamed + 一条 warn；分组在但列表没了 → broken + 一条 warn', () => {
  const renamed = scenario({ group: 'installed', packages: ['dsh-todo-bar'] })
  assertEqual(renamed.rootAttr(mod.__testing.ROOT_ATTR), 'renamed', '诊断状态应为 renamed')
  assertEqual(renamed.tabbar().length, 0, '契约破了不该插 Tab')
  assertEqual(renamed.warnings.length, 1, '应当只 warn 一次')
  assert(renamed.warnings[0].includes('DOM 契约变了'), `warn 内容应点明契约变了：${renamed.warnings[0]}`)
  renamed.dispose()

  const broken = scenario({ omitList: true, packages: [] })
  assertEqual(broken.rootAttr(mod.__testing.ROOT_ATTR), 'broken', '诊断状态应为 broken')
  assertEqual(broken.warnings.length, 1, '应当只 warn 一次')
  broken.dispose()
  return 'renamed / broken 各一条 warn，且什么都不插'
})

check('正常情况一律安静：加载中（没有分组）与「只装了官方插件」都不报警', () => {
  const loading = scenario({ group: null })
  assertEqual(loading.rootAttr(mod.__testing.ROOT_ATTR), 'idle', '加载中应为 idle')
  assertEqual(loading.warnings.length, 0, '加载中不该 warn（骨架屏阶段本来就没有分组）')
  loading.dispose()

  const officialOnly = scenario({ group: 'official', officialItems: ['web-search'], heading: '插件' })
  assertEqual(officialOnly.rootAttr(mod.__testing.ROOT_ATTR), 'idle', '只有官方插件时应为 idle')
  assertEqual(officialOnly.warnings.length, 0, '没有第三方插件不该 warn（官方插件卡是 data-plugin-item，不是包卡片）')
  officialOnly.dispose()

  const empty = scenario({ packages: [] })
  assertEqual(empty.rootAttr(mod.__testing.ROOT_ATTR), 'flat', '分组在但没有卡片时应为 flat')
  assertEqual(empty.warnings.length, 0, '空列表不该 warn')
  empty.dispose()
  return 'idle / idle / flat，三处都零警告'
})

check('连跑三遍幂等：Tab 不叠加、过滤不变、DOM 顺序不动', () => {
  const live = scenario({ packages: KNOWN_INSTALLED })
  const snapshot = () => ({
    tabbar: live.tabbar().length,
    tabs: live.tabs().map((button) => `${button.getAttribute(mod.__testing.TAB_ATTR)}:${button.children[1].textContent}`),
    visible: live.visibleNames().sort(),
    order: live.cards().map((card) => card.getAttribute(mod.__testing.CARD_ATTR)),
  })
  const first = snapshot()
  click(live.tab('tools'))
  const filtered = snapshot()
  const options = { label: (entry) => (entry.category === null ? '全部' : entry.category.zh), selected: 'tools', onSelect: () => {} }
  for (let round = 0; round < 2; round += 1) mod.__testing.decorate(live.fake.doc, live.list, options)
  const second = snapshot()
  assertEqual(first.tabbar, 1, '一开始就该只有一行 Tab')
  assertDeepEqual(second.tabs, filtered.tabs, '重跑不该改变 Tab 与计数')
  assertDeepEqual(second.visible, filtered.visible, '重跑不该改变过滤结果')
  assertDeepEqual(second.order, first.order, '重跑不该动卡片的 DOM 顺序')
  assertEqual(second.tabbar, 1, 'Tab 行不该叠加')
  live.dispose()
  return '三遍之后仍是 1 行 Tab，过滤与顺序逐字节相同'
})

check('没点名的包落「其他」并排最后；英文界面用英文 Tab 名', () => {
  const live = scenario({ packages: ['dsh-better-sidebar', 'dsh-brands-new-thing'], heading: 'Plugins' })
  assertEqual(mod.__testing.categoryOf('dsh-brands-new-thing').id, 'other', '未知包名应落 other')
  const tabs = live.tabs()
  assertEqual(tabs.length, 3, '应有 3 个 Tab（All + Appearance & UI + Other）')
  assertEqual(tabs[0].children[0].textContent, 'All', '英文界面下第一个 Tab 应为 All')
  assertEqual(tabs[1].children[0].textContent, 'Appearance & UI', '英文界面下第一类应为英文名')
  assertEqual(tabs[2].children[0].textContent, 'Other', '英文界面下兜底名')
  click(live.tab('other'))
  assertDeepEqual(live.visibleNames(), ['dsh-brands-new-thing'], '「其他」里就是那个没点名的包')
  live.dispose()
  return 'other 排最后 + 英文取名'
})

check('观察者的「自己人」过滤：只插自己的 Tab 不会自触发，出现别人的节点才重跑', () => {
  const live = scenario({ packages: KNOWN_INSTALLED })
  const bar = live.tabbar()[0]
  const card = live.cards()[0]
  assertEqual(mod.__testing.touchesForeign([{ type: 'childList', addedNodes: [bar], removedNodes: [] }]), false, '自己的 Tab 行不算外部变更')
  assertEqual(mod.__testing.touchesForeign([{ type: 'childList', addedNodes: [card], removedNodes: [] }]), true, '官方新增卡片必须重跑')
  assertEqual(mod.__testing.touchesForeign([{ type: 'childList', addedNodes: [], removedNodes: [bar, card] }]), true, '官方移除卡片必须重跑')
  live.dispose()
  return '自触发被掐死，外部变更照常重跑'
})

check('disposer 把 Tab 行、过滤痕迹、样式标签、诊断属性全部摘干净', () => {
  const live = scenario({ packages: KNOWN_INSTALLED })
  click(live.tab('ui'))
  assertEqual(live.tabbar().length, 1, '先确认真的插上了')
  assertEqual(live.visible().length < KNOWN_INSTALLED.length, true, '先确认真的过滤了')
  live.dispose()
  assertEqual(live.tabbar().length, 0, 'Tab 行应摘干净')
  for (const card of live.cards()) assertEqual(card.style.display, '', '过滤痕迹应清掉')
  assertEqual(live.fake.head.children.length, 0, '样式标签应摘掉')
  assertEqual(live.rootAttr(mod.__testing.ROOT_ATTR), null, '诊断属性应摘掉')
  assertEqual(live.rootAttr(mod.__testing.ROOT_TAB_ATTR), null, 'Tab 诊断属性应摘掉')
  return '卸载 = 页面回到原样'
})

/* ───────────────────── 契约检查（对着官方源码） ───────────────────── */

/**
 * 从一个 asar 归档里读出某个文件（asar 头是 pickle 套 JSON，偏移自数据区起算）。
 * @param {string} archive - asar 路径。
 * @param {string} inner - 归档内路径。
 * @returns {string} 文件内容。
 */
function readFromAsar(archive, inner) {
  const buffer = fs.readFileSync(archive)
  const jsonSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
  const dataStart = 16 + jsonSize + ((8 - ((16 + jsonSize) % 8)) % 8)
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const current = prefix ? `${prefix}/${name}` : name
      if (entry.files) {
        const hit = walk(entry, current)
        if (hit !== null) return hit
        continue
      }
      if (current === inner) return { offset: Number(entry.offset), size: Number(entry.size) }
    }
    return null
  }
  const found = walk(header, '')
  assert(found !== null, `asar 里没有 ${inner}`)
  return buffer.subarray(dataStart + found.offset, dataStart + found.offset + found.size).toString('utf8')
}

/**
 * 对着官方 client.js 源码核契约，破了就抛。
 * @param {string} source - 官方 client.js 内容。
 * @returns {string} 通过时的一句话说明。
 */
function checkContract(source) {
  for (const fragment of ['data-plugin-panel', 'data-plugin-group', 'data-plugin-package', '"bundles"']) {
    assert(source.includes(fragment), `官方 client.js 里已经没有 ${fragment} —— 契约破了，本插件会静默不动`)
  }
  const cards = /\.(\w+_cards)\{[^}]*}/.exec(source)
  assert(cards !== null, '没找到卡片列表那条 CSS 规则')
  assert(cards[0].includes('flex-direction:column'), `卡片列表不再是 flex 竖排（${cards[0]}），Tab 行靠 order:-1 排在最前面的兜底会失效`)
  assert(source.includes(`${cards[1]}`), '卡片列表的 class 名没对上')
  return `契约钩子都在；卡片列表 .${cards[1]} 仍是 flex 竖排`
}

check('契约检查：官方 plugin-manager 里本插件依赖的钩子还在', () => {
  assert(fs.existsSync(APP_ASAR), `找不到 ${APP_ASAR}`)
  return checkContract(readFromAsar(APP_ASAR, MANAGER_CLIENT))
})

check('反向用例：契约检查对着被改坏的官方源码真的会报错（不是空转）', () => {
  const real = readFromAsar(APP_ASAR, MANAGER_CLIENT)
  // asar 读取本身先自证：拿另一个已知文件解析 JSON
  const packageJson = JSON.parse(readFromAsar(APP_ASAR, 'dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/package.json'))
  assertEqual(packageJson.name, '@deepseek-ai/dsh-client-ui-plugin-manager', 'asar 读取的偏移算错了')

  const cases = [
    ['分组 id 改了', real.replace('"bundles"', '"installed"')],
    ['卡片包名钩子没了', real.replaceAll('data-plugin-package', 'data-pkg')],
    ['页面根钩子没了', real.replaceAll('data-plugin-panel', 'data-panel')],
    ['卡片列表不再 flex 竖排', real.replace(/\.(\w+_cards)\{flex-direction:column;/, '.$1{flex-direction:row;')],
  ]
  const survived = []
  for (const [label, mutated] of cases) {
    let threw = false
    try {
      checkContract(mutated)
    } catch {
      threw = true
    }
    if (!threw) survived.push(label)
  }
  assertEqual(survived.length, 0, `这些改坏的情况居然没被抓到：${survived.join('、')}`)
  return `4 种改法全部被抓：${cases.map(([label]) => label).join('、')}`
})

/* ───────────────────── 覆盖检查（对着已装 profile） ───────────────────── */

check(`覆盖检查：${PROFILE} profile 里已安装的插件都分到了确定的类别`, () => {
  if (!fs.existsSync(PROFILE_MANIFEST)) return `跳过：没有 ${PROFILE_MANIFEST}`
  const profile = JSON.parse(fs.readFileSync(PROFILE_MANIFEST, 'utf8'))
  const deps = Object.keys(profile.dependencies ?? {}).filter((name) => !name.startsWith('@deepseek-ai/'))
  const known = KNOWN_INSTALLED.filter((name) => deps.includes(name))
  assertEqual(known.length, KNOWN_INSTALLED.length, `本脚本点名的已安装插件应都在 profile 依赖里（缺 ${KNOWN_INSTALLED.filter((n) => !deps.includes(n)).join('、')}）`)
  // 点名的包必须是写死在分类表里的精确匹配，而不是碰巧命中了关键词 —— 顺带抓包名拼错
  const { CATEGORIES } = mod.__testing
  const exact = new Set(CATEGORIES.flatMap((category) => category.packages))
  for (const name of KNOWN_INSTALLED) {
    assert(exact.has(name), `${name} 没有写死在分类表里（只有关键词兜底）`)
    assertEqual(mod.__testing.categoryOf(name).id === mod.__testing.FALLBACK.id, false, `${name} 落到了「其他」`)
  }
  const loose = deps.filter((name) => mod.__testing.categoryOf(name).id === mod.__testing.FALLBACK.id)
  return `${deps.length} 个依赖全部归类；${loose.length === 0 ? '无人落「其他」' : `落「其他」的是：${loose.join('、')}`}`
})

/* ───────────────────────────── 汇总 ───────────────────────────── */

const passed = results.filter((row) => row.ok).length
for (const row of results) {
  console.log(`${row.ok ? '✓' : '✗'} ${row.name}`)
  if (row.detail !== '') console.log(`    ${row.detail.replace(/\n/g, '\n    ')}`)
}
console.log(`\n${passed}/${results.length} 项通过`)
process.exit(passed === results.length ? 0 : 1)
