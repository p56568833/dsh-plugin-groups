/**
 * dsh-plugin-groups 的浏览器半边：给插件页「已安装」那一组加**一行分类 Tab**。
 *
 * 效果
 * ----
 * 列表顶上多一行下划线式 Tab（就是设置页那种原生样子）：
 *
 *     全部 17 │ 界面与外观 6 │ 用量与账户 2 │ 模型与订阅 1 │ …
 *
 * 点哪个就只看哪一类；「全部」看全部。选中的那个记在浏览器里，下次打开还是它。
 * 计数值随安装/卸载实时变。**没有**一行一行的分类标题 —— 分类只由 Tab 承担。
 *
 * 只做显示层，一条都不碰别的
 * --------------------------
 * 不注册槽位、不改配置、不动任何其他插件的文件，也不改 DSH 代码。它做的全部事情是：
 * 在「已安装」的卡片列表顶上插一行自己的 Tab，按当前 Tab 给卡片设 `display:none`。
 * 关掉或卸载这个包，页面回到原样 —— 没有迁移、没有残留、没有备份要还原。
 *
 * 靠什么认人（契约）
 * ------------------
 * 对着官方 `@deepseek-ai/dsh-client-ui-plugin-manager`（app.asar 里那份）的 client.js 核过：
 *   · 页面根            `[data-plugin-panel]`
 *   · 「已安装」分组     `[data-plugin-group="bundles"]`（官方文案 `bundlesTitle`：已安装 / Installed）
 *   · 每个插件一张卡片   `li[data-plugin-package="npm 包名"]`，卡片列表是分组里的 `ul`
 *   · 卡片列表本身是     `.cards{display:flex;flex-direction:column}`
 * Tab 行插在 `ul` 的第一个子节点，并带 `order:-1`（flex 排序兜底），所以永远在卡片上面。
 * 这几个 `data-*` 是官方自己也在用的语义钩子（它拿 `data-plugin-package` 做「滚动到某个插件」），
 * 比 CSS module 的哈希类名（`ZVcBiW_*`，每次构建都变）稳得多；但它们是内部实现、不是文档承诺，
 * 所以同目录的 verify.mjs 会**从 app.asar 里读官方源码**做契约断言：DSH 一升级就能提前知道破了没有。
 * 契约找不到时这里什么都不做（只留一行 warn + 一个诊断属性），页面保持原样。
 *
 * Tab 的样子
 * ----------
 * 度量与 token 抄官方设置页那行 Tab（`PluginsSettingsSection.module.css` 的 `_tabs/_tab`）：
 * `border-bottom:.5px solid var(--dsw-alias-border-l2)`、`gap:22px`、13px/20px、
 * 激活态 2px 下划线 + `--dsw-alias-label-primary`、focus 用官方 focus ring。
 * 全部走 token，所以浅色、深色、Claude 皮肤都自动跟。
 *
 * 为什么按「包名」分类，不按显示标题
 * ----------------------------------
 * 标题会被「插件汉化」改写、还会跟着界面语言变；包名唯一、稳定、不受汉化与语言影响。
 * 表里点名了当前已安装的每一个包，新装的插件走关键词兜底，最后落「其他」，不会丢卡片。
 *
 * 手写的 loader 闭包工厂格式（没有打包器这一步），与 dsh-skin-fixes / dsh-market-sidebar 一致。
 *
 * @module dsh-plugin-groups/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-groups',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    // ══ 一、契约常量 ═══════════════════════════════════════════════════

    /** 插件页根节点。 */
    const PANEL_SELECTOR = '[data-plugin-panel]'
    /** 「已安装」分组（官方 group id 就是 bundles）。 */
    const GROUP_SELECTOR = '[data-plugin-group="bundles"]'
    /** 分组里的卡片列表。 */
    const LIST_SELECTOR = `${GROUP_SELECTOR} ul`
    /** 一张插件卡片；包名在 `data-plugin-package` 上。 */
    const CARD_ATTR = 'data-plugin-package'
    /** 官方给「刚刚要滚过去的那个插件」打的标记（安装完「立即启用」时会出现）。 */
    const HIGHLIGHT_ATTR = 'data-plugin-highlight'
    /** 任意分组；用来分辨「已安装那组被改名了」和「还没加载完 / 没有第三方插件」。 */
    const ANY_GROUP_SELECTOR = '[data-plugin-group]'

    /** 我们自己插的 Tab 行 / 单个 Tab 的标记（认自己人，幂等靠它）。 */
    const TABBAR_ATTR = 'data-dsh-pg-tabbar'
    const TAB_ATTR = 'data-dsh-pg-tab'
    /** 页面根上的诊断属性：idle / flat / active:N / broken / renamed。 */
    const ROOT_ATTR = 'data-dsh-plugin-groups'
    /** 页面根上的「当前生效的 Tab」。 */
    const ROOT_TAB_ATTR = 'data-dsh-plugin-groups-tab'
    /** 记住选中的 Tab（每个浏览器一份，跟官方记安装源同一个做法）。 */
    const STORAGE_KEY = 'dsh-plugin-groups/tab.v1'
    /** 注入样式用的标签标识。 */
    const STYLE_ID = 'dsh-plugin-groups/groups.css'
    /** 「全部」这个 Tab 的 id。 */
    const ALL_TAB = 'all'

    // ══ 二、分类表 ═════════════════════════════════════════════════════

    /**
     * 类别定义。**顺序就是 Tab 顺序**；`packages` 精确匹配包名，`keywords` 是给新装插件的兜底
     * （只匹配包名，不匹配会被汉化改写的显示标题）。
     */
    const CATEGORIES = [
      {
        id: 'ui',
        zh: '界面与外观',
        en: 'Appearance & UI',
        packages: ['dsh-better-sidebar', 'dsh-claude-style', 'dsh-skin-fixes', 'dsh-whale-splash', 'dsh-status-rotator', 'dsh-plugin-groups'],
        keywords: [/theme|skin|style|sidebar|status|splash|icon|font|visual|layout/],
      },
      {
        id: 'usage',
        zh: '用量与账户',
        en: 'Usage & account',
        packages: ['dsh-balance-widget', 'dsh-cost-balance'],
        keywords: [/balance|cost|usage|quota|billing|price|api-meter/],
      },
      {
        id: 'model',
        zh: '模型与订阅',
        en: 'Models & subscriptions',
        packages: ['dsh-plugin-subscriptions'],
        keywords: [/subscription|provider|model|llm|credential|api-key/],
      },
      {
        id: 'memory',
        zh: '记忆与上下文',
        en: 'Memory & context',
        packages: ['@modusensus/dsh-mneme'],
        keywords: [/mneme|memor|context|compact|recall/],
      },
      {
        id: 'tools',
        zh: '工具与能力',
        en: 'Tools & abilities',
        packages: ['dsh-image-gen', 'dsh-plugin-l10n-zh'],
        keywords: [/image|draw|vision|caption|l10n|locale|translat|skill/],
      },
      {
        id: 'workflow',
        zh: '任务与工作流',
        en: 'Tasks & workflow',
        packages: ['dsh-todo-bar', 'dsh-story-progress', 'dsh-story-turing'],
        keywords: [/todo|task|story|workflow|schedule|progress|ralph/],
      },
      {
        id: 'market',
        zh: '市场与安装',
        en: 'Market & install',
        packages: ['dshmarket', 'dsh-market-sidebar'],
        keywords: [/market|registry|install/],
      },
    ]

    /**
     * 补丁插件 → 它修的那个父插件（都是包名）。
     *
     * 补丁卡片会挂在父插件卡片正下方：往右缩进一格，左边一条细线连到父插件，名字后面一个「补丁」小标签；
     * 父插件名字后面标「N 个补丁」。补丁跟着父插件归类 —— 父插件在哪个 Tab，补丁就在哪个 Tab。
     * 父插件没装时，补丁照常单独显示，不缩进。
     *
     * 这张表是看各插件的说明手填的（目前没有任何机器可读的声明）：
     *   · dsh-skin-fixes     「给 dsh-claude-style 皮肤打的两个行为补丁」
     *   · dsh-story-progress 「商业故事写作模式：文笔迭代时显示实时进度」—— 显示的是 dsh-story-turing 的 story_loop
     *   · dsh-market-sidebar 「侧边栏加插件市场入口」—— 面板本体是 dshmarket 的 market.render()
     */
    const PARENTS = {
      'dsh-skin-fixes': 'dsh-claude-style',
      'dsh-story-progress': 'dsh-story-turing',
      'dsh-market-sidebar': 'dshmarket',
    }

    /** 我们给卡片打的标记：补丁卡片（值是它在父插件下的序号，从 1 起）/ 有补丁的父插件卡片（值是补丁数）。 */
    const CHILD_ATTR = 'data-dsh-pg-child'
    const PARENT_ATTR = 'data-dsh-pg-parent'

    /** 兜底类别：没点名也没命中关键词的插件都在这儿（永远排最后）。 */
    const FALLBACK = { id: 'other', zh: '其他', en: 'Other' }

    /** 能排成 Tab 的全部类别（正常 7 类 + 兜底）。 */
    const ALL_CATEGORIES = [...CATEGORIES, FALLBACK]

    /**
     * 一个包名归到哪个类别：先按包名精确查表，再按关键词兜底，最后「其他」。
     * @param {string} packageName - npm 包名（含 scope）。
     * @returns {{id: string, zh: string, en: string}} 命中的类别定义。
     */
    function categoryOf(packageName) {
      const name = String(packageName ?? '')
      // 补丁跟着父插件走（父插件在不在页面上都按父插件归类，免得同一个补丁一会儿在这个 Tab 一会儿在那个）
      if (Object.prototype.hasOwnProperty.call(PARENTS, name)) return categoryOf(PARENTS[name])
      for (const category of CATEGORIES) {
        if (category.packages.includes(name)) return category
      }
      for (const category of CATEGORIES) {
        for (const keyword of category.keywords) {
          if (keyword.test(name)) return category
        }
      }
      return FALLBACK
    }

    // ══ 三、语言：跟着页面自己走 ═══════════════════════════════════════

    /**
     * 页面当前是不是中文界面 —— 直接读它自己的大标题（「插件」/「Plugins」），
     * 比 navigator.language 准：DSH 的界面语言和系统语言可以不一致。
     * @param {Document} doc - 文档。
     * @param {Element|null} panel - 插件页根节点。
     * @returns {boolean} true 表示用中文 Tab 名。
     */
    function pageIsChinese(doc, panel) {
      const heading = panel?.querySelector?.('h1') ?? doc.querySelector?.(`${PANEL_SELECTOR} h1`)
      const text = heading?.textContent ?? ''
      return /[\u3400-\u9fff]/.test(text)
    }

    /**
     * 造一个「Tab → 显示名」的取名函数。
     * @param {Document} doc - 文档。
     * @param {Element|null} panel - 插件页根节点。
     * @returns {(entry: {id: string, category: object|null}) => string} 取名函数。
     */
    function labelPicker(doc, panel) {
      const chinese = pageIsChinese(doc, panel)
      return (entry) => {
        if (entry.category === null) return chinese ? '全部' : 'All'
        return chinese ? entry.category.zh : entry.category.en
      }
    }

    // ══ 四、选中状态（每个浏览器记一份） ═══════════════════════════════

    /**
     * 读上次选中的 Tab。
     * @returns {string} Tab id；读不到就是「全部」。
     */
    function loadSelection() {
      try {
        const saved = globalThis.localStorage?.getItem?.(STORAGE_KEY)
        return typeof saved === 'string' && saved !== '' ? saved : ALL_TAB
      } catch {
        return ALL_TAB
      }
    }

    /**
     * 记住选中的 Tab（存不了就算了，纯显示功能不该因此报错）。
     * @param {string} id - Tab id。
     * @returns {void} 无返回值。
     */
    function saveSelection(id) {
      try {
        globalThis.localStorage?.setItem?.(STORAGE_KEY, id)
      } catch {
        /* 隐私模式 / 存储被禁：忽略 */
      }
    }

    // ══ 五、Tab 与过滤 ═════════════════════════════════════════════════

    /**
     * 这个子节点是不是官方画的插件卡片。
     * @param {any} node - 待判断的节点。
     * @returns {boolean} true 表示卡片。
     */
    function isCard(node) {
      return typeof node?.getAttribute === 'function' && node.getAttribute(CARD_ATTR) !== null
    }

    /**
     * 写一条内联样式（真实 DOM 用 setProperty，能写自定义属性；测试里的假 DOM 退回直接赋值）。
     * 官方的卡片 `li` 没有 React 管的 style，所以在上面写内联样式不会和 React 打架。
     * @param {Element} element - 元素。
     * @param {string} property - CSS 属性名（`order` 或 `--xxx`）。
     * @param {string} value - 值；空串表示删掉。
     * @returns {void} 无返回值。
     */
    function setStyle(element, property, value) {
      const style = element?.style
      if (style === undefined || style === null) return
      if (typeof style.setProperty === 'function') {
        if (value === '') style.removeProperty(property)
        else style.setProperty(property, value)
      } else {
        style[property] = value
      }
    }

    /**
     * 补丁挂到父插件下面：用 flex 的 `order` 排位置（不挪 DOM，顺序仍归 React），并打上标记与小标签。
     * 普通卡片按原顺序占 `序号×10`，补丁占「父插件的位置 + 1、+ 2…」，所以紧跟在父插件后面。
     * @param {Element[]} cards - 官方画的插件卡片（DOM 顺序）。
     * @param {boolean} chinese - 中文界面。
     * @returns {number} 挂上去的补丁数。
     */
    function nest(cards, chinese) {
      const byName = new Map()
      cards.forEach((card, index) => {
        byName.set(card.getAttribute(CARD_ATTR), { card, index })
        setStyle(card, 'order', String(index * 10))
      })
      const childrenOf = new Map()
      for (const card of cards) {
        const parentName = PARENTS[card.getAttribute(CARD_ATTR)]
        if (parentName === undefined || !byName.has(parentName)) continue
        if (!childrenOf.has(parentName)) childrenOf.set(parentName, [])
        childrenOf.get(parentName).push(card)
      }
      let nested = 0
      for (const [parentName, children] of childrenOf) {
        const parent = byName.get(parentName)
        parent.card.setAttribute(PARENT_ATTR, String(children.length))
        setStyle(parent.card, '--dsh-pg-badge', JSON.stringify(chinese ? `${children.length} 个补丁` : `${children.length} patch${children.length > 1 ? 'es' : ''}`))
        children.forEach((child, k) => {
          child.setAttribute(CHILD_ATTR, String(k + 1))
          setStyle(child, 'order', String(parent.index * 10 + k + 1))
          setStyle(child, '--dsh-pg-badge', JSON.stringify(chinese ? '补丁' : 'Patch'))
          nested += 1
        })
      }
      return nested
    }

    /**
     * 摘掉自己上一次插的 Tab 行，并把卡片的过滤痕迹清干净（幂等的第一步）。
     * @param {Element} list - 分组里的卡片列表。
     * @returns {number} 摘掉了几行。
     */
    function clear(list) {
      let removed = 0
      for (const child of Array.from(list.children ?? [])) {
        if (child.hasAttribute?.(TABBAR_ATTR) === true) {
          child.parentNode?.removeChild(child)
          removed += 1
        } else if (isCard(child) && child.style !== undefined && child.style !== null) {
          child.style.display = ''
          setStyle(child, 'order', '')
          setStyle(child, '--dsh-pg-badge', '')
          child.removeAttribute?.(CHILD_ATTR)
          child.removeAttribute?.(PARENT_ATTR)
        }
      }
      return removed
    }

    /**
     * 按当前卡片算出这一行 Tab 该有哪几个、各多少。
     * 计数值取自卡片本身，所以安装/卸载后重跑一次就自动跟上了。
     * @param {Element[]} cards - 官方画的插件卡片。
     * @returns {Array<{id: string, category: object|null, count: number}>} Tab 条目；第一条永远是「全部」。
     */
    function tabEntries(cards) {
      const counts = new Map()
      for (const card of cards) {
        const id = categoryOf(card.getAttribute(CARD_ATTR)).id
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      const entries = [{ id: ALL_TAB, category: null, count: cards.length }]
      for (const category of ALL_CATEGORIES) {
        const count = counts.get(category.id)
        if (count !== undefined) entries.push({ id: category.id, category, count })
      }
      return entries
    }

    /**
     * 实际生效的选中项。
     *
     * 官方在「安装完立即启用」时会去滚到那张卡（`data-plugin-highlight`）。如果那张卡正好被
     * 当前分类挡住，就这一轮临时按「全部」渲染，别让用户对着一个滚不到的空位 ——
     * 但**不改**存下来的选择，用户下次点分类还是他自己的。
     *
     * @param {Element[]} cards - 卡片。
     * @param {string} selected - 存下来的选中项。
     * @returns {string} 这一轮生效的选中项。
     */
    function effectiveSelection(cards, selected) {
      if (selected === ALL_TAB) return ALL_TAB
      const target = cards.find((card) => card.hasAttribute?.(HIGHLIGHT_ATTR) === true)
      if (target === undefined) return selected
      return categoryOf(target.getAttribute(CARD_ATTR)).id === selected ? selected : ALL_TAB
    }

    /**
     * 造一行 Tab：下划线式，结构 `<li><div role="tablist"><button role="tab">名字 + 计数</button>…</div></li>`。
     * @param {Document} doc - 文档。
     * @param {Array<{id: string, category: object|null, count: number}>} entries - Tab 条目。
     * @param {string} selected - 生效的选中项。
     * @param {(entry: object) => string} label - 取名函数。
     * @param {(id: string) => void} onSelect - 点某个 Tab。
     * @returns {Element} Tab 行。
     */
    function buildTabbar(doc, entries, selected, label, onSelect) {
      const line = doc.createElement('li')
      line.setAttribute(TABBAR_ATTR, '')
      line.style.order = '-1'
      const strip = doc.createElement('div')
      strip.className = 'dsh-pg-tabs'
      strip.setAttribute('role', 'tablist')
      for (const entry of entries) {
        const button = doc.createElement('button')
        button.type = 'button'
        button.className = 'dsh-pg-tab'
        button.setAttribute(TAB_ATTR, entry.id)
        button.setAttribute('role', 'tab')
        button.setAttribute('data-active', entry.id === selected ? 'true' : 'false')
        button.setAttribute('aria-selected', entry.id === selected ? 'true' : 'false')
        const name = doc.createElement('span')
        name.textContent = label(entry)
        const count = doc.createElement('span')
        count.className = 'dsh-pg-count'
        count.textContent = String(entry.count)
        button.appendChild(name)
        button.appendChild(count)
        strip.appendChild(button)
      }
      strip.addEventListener('click', (event) => {
        const target = event?.target?.closest?.(`[${TAB_ATTR}]`) ?? null
        const id = target?.getAttribute?.(TAB_ATTR) ?? null
        if (id !== null && id !== selected) onSelect(id)
      })
      line.appendChild(strip)
      return line
    }

    /**
     * 一次完整的渲染：幂等 —— 先清掉自己上一轮的痕迹，再按当前卡片重打一遍。
     * @param {Document} doc - 文档（用来造 Tab 行）。
     * @param {Element} list - 分组里的卡片列表。
     * @param {{label: (entry: object) => string, selected: string, onSelect: (id: string) => void}} options - 取名函数、选中项、点选回调。
     * @returns {{cards: number, groups: number, active: boolean, selected: string}} 这一轮的结果。
     */
    function decorate(doc, list, options) {
      clear(list)
      const cards = []
      for (const child of Array.from(list.children ?? [])) {
        if (isCard(child)) cards.push(child)
      }
      if (cards.length === 0) return { cards: 0, groups: 0, active: false, selected: ALL_TAB }

      nest(cards, options.chinese !== false)
      const entries = tabEntries(cards)
      const groups = entries.length - 1

      // 只分出一类时纯属添乱：不插 Tab、不过滤，页面保持官方原样。
      if (groups <= 1) return { cards: cards.length, groups, active: false, selected: ALL_TAB }

      const selected = effectiveSelection(cards, options.selected)
      for (const card of cards) {
        const hidden = selected !== ALL_TAB && categoryOf(card.getAttribute(CARD_ATTR)).id !== selected
        card.style.display = hidden ? 'none' : ''
      }
      list.insertBefore(buildTabbar(doc, entries, selected, options.label, options.onSelect), list.firstChild ?? null)
      return { cards: cards.length, groups, active: true, selected }
    }

    // ══ 六、样式（度量与 token 抄自官方设置页那行 Tab，皮肤改了也跟着走） ══

    /**
     * Tab 行的样式：对着官方 `PluginsSettingsSection.module.css` 的 `_tabs / _tab /
     * _tab[data-active=true] / :focus-visible` 抄的，只多加一个计数。
     */
    const CSS = `
/* Tab 行本身：官方卡片列表是 flex column，这里 order:-1 保证永远在卡片上面。 */
[data-plugin-panel] [data-plugin-group="bundles"] ul > li[data-dsh-pg-tabbar] {
  order: -1 !important;
  display: block !important;
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}
/* 下划线式 Tab 条（官方 _tabs）。 */
[data-plugin-panel] .dsh-pg-tabs {
  display: flex;
  align-items: flex-end;
  gap: 22px;
  margin-top: 2px;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
/* 单个 Tab（官方 _tab）。 */
[data-plugin-panel] .dsh-pg-tab {
  position: relative;
  background: 0 0;
  border: 0;
  padding: 7px 1px 9px;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
[data-plugin-panel] .dsh-pg-tab:hover,
[data-plugin-panel] .dsh-pg-tab[data-active="true"] {
  color: var(--dsw-alias-label-primary);
}
/* 激活态的下划线（官方 _tab[data-active=true]:after）。 */
[data-plugin-panel] .dsh-pg-tab[data-active="true"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-label-primary);
}
[data-plugin-panel] .dsh-pg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
  border-radius: 2px;
  color: var(--dsw-alias-label-primary);
}
/* ── 补丁挂在父插件下面 ───────────────────────────────────────────
   官方卡片：.card 左右各 -8px 外边距，里面 .cardHead 内边距 8px、间距 14px，图标 48×48，卡片间距 2px。
   补丁卡片整张右移 40px；左边一条「└」细线从上一张卡图标底边（-10px）画到自己图标的中线（32px），
   竖线落在父插件图标的正中（父插件左边 +32px = 补丁左边 -8px）。第二个起的补丁把竖线往上接长一截。 */
[data-plugin-panel] [data-plugin-group="bundles"] li[data-dsh-pg-child] {
  position: relative;
  margin-left: 32px !important;
}
[data-plugin-panel] [data-plugin-group="bundles"] li[data-dsh-pg-child]::before {
  content: "";
  position: absolute;
  left: -8px;
  top: -10px;
  width: 15px;
  height: 42px;
  border-left: 1.5px solid var(--dsw-alias-border-l2);
  border-bottom: 1.5px solid var(--dsw-alias-border-l2);
  border-bottom-left-radius: 8px;
  pointer-events: none;
}
[data-plugin-panel] [data-plugin-group="bundles"] li[data-dsh-pg-child]:not([data-dsh-pg-child="1"])::before {
  top: -44px;
  height: 76px;
}
/* 名字后面的小标签：父插件「N 个补丁」、补丁「补丁」。文字由脚本写在卡片的 --dsh-pg-badge 上。 */
[data-plugin-panel] [data-plugin-group="bundles"] li:is([data-dsh-pg-child], [data-dsh-pg-parent]) [class*="_titleRow"]::after {
  content: var(--dsh-pg-badge);
  flex: none;
  padding: 0 6px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
/* Tab 上的计数：比 Tab 名小一号、次级色，数字等宽。 */
[data-plugin-panel] .dsh-pg-count {
  margin-left: 6px;
  color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
`

    /**
     * 装样式（复用同一个 style 标签），返回摘除函数。
     * @param {Document} doc - 文档。
     * @returns {() => void} 摘除函数。
     */
    function installStyles(doc) {
      if (doc === undefined || doc === null || doc.head === undefined || doc.head === null) return () => {}
      const existing = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      const tag = existing ?? doc.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-groups'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      if (existing === null) doc.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
      }
    }

    // ══ 七、守页 ═══════════════════════════════════════════════════════

    /** 每类异常只提醒一次，别把控制台刷满。 */
    const warned = new Set()

    /**
     * 写诊断属性，方便在 DevTools 里一眼看出活着没有、为什么没动手。
     * @param {Document} doc - 文档。
     * @param {string} value - idle / flat / active:N / broken / renamed。
     * @param {string|undefined} tab - 当前生效的 Tab id；没有就清掉。
     * @returns {void} 无返回值。
     */
    function setState(doc, value, tab) {
      doc.documentElement?.setAttribute?.(ROOT_ATTR, value)
      if (tab === undefined) doc.documentElement?.removeAttribute?.(ROOT_TAB_ATTR)
      else doc.documentElement?.setAttribute?.(ROOT_TAB_ATTR, tab)
    }

    /**
     * 看一眼当前页面是什么状态。
     *
     * 「没有 Tab 可插」有三种完全不同的原因，必须分开，否则会在正常的加载过程中乱报警告：
     *   · `idle`    —— 没分组（还在加载骨架屏，或只有官方插件、压根没有第三方插件），**正常**；
     *   · `broken`  —— 分组在、里面的列表没了，**契约破了**；
     *   · `renamed` —— 别的分组里躺着插件卡片、却没有 `bundles` 这一组，
     *                  说明官方把分组 id 改了，**契约破了**。
     * 判据是「有没有插件卡片」（官方插件卡是 `data-plugin-item`，不是 `data-plugin-package`），
     * 所以只会对真正的破坏报警，空列表 / 加载中一律安静。
     *
     * @param {Element} panel - 插件页根节点。
     * @returns {{state: string, list?: Element}} 状态；`list` 只在有列表时给出。
     */
    function inspect(panel) {
      const list = panel.querySelector(LIST_SELECTOR)
      if (list !== null) return { state: 'list', list }
      if (panel.querySelector(GROUP_SELECTOR) !== null) return { state: 'broken' }
      if (panel.querySelector(`${ANY_GROUP_SELECTOR} li[${CARD_ATTR}]`) !== null) return { state: 'renamed' }
      return { state: 'idle' }
    }

    /**
     * 只提醒一次；提醒里带上诊断属性和下一步该看什么。
     * @param {string} kind - broken / renamed。
     * @returns {void} 无返回值。
     */
    function warnOnce(kind) {
      if (warned.has(kind)) return
      warned.add(kind)
      console.warn(
        `[dsh-plugin-groups] 官方插件页的 DOM 契约变了（${kind}）：本次不做任何事，页面保持原样。` +
          `诊断见 <html ${ROOT_ATTR}="…">；跑本插件目录里的 verify.mjs 确认；契约真变了，退路是改用官方公开槽 settings.plugins.tab 另开一个分类标签页。`,
      )
    }

    /**
     * 这批 DOM 变更里有「不是我们自己插的 Tab 行」吗 —— 用来掐死自触发死循环。
     * @param {MutationRecord[]} records - 观察到的变更。
     * @returns {boolean} true 表示值得重跑一遍。
     */
    function touchesForeign(records) {
      for (const record of records) {
        if (record.type !== 'childList') return true
        const nodes = [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])]
        for (const node of nodes) {
          if (node === null || node === undefined) continue
          if (typeof node.hasAttribute === 'function' && node.hasAttribute(TABBAR_ATTR)) continue
          return true
        }
      }
      return false
    }

    /**
     * 起搏：装样式、立刻跑一遍、然后守着页面变化重跑。
     * @param {Document} doc - 文档。
     * @returns {() => void} 停止函数（摘样式、清痕迹）。
     */
    function start(doc) {
      if (doc === undefined || doc === null || typeof doc.querySelector !== 'function') return () => {}
      const styleDispose = installStyles(doc)

      /** 当前选中哪个 Tab（存浏览器里，跟官方记安装源同一个做法）。 */
      let selected = loadSelection()

      /** 跑一轮：找页面 → 判状态 → 有列表就铺 Tab 并过滤。 */
      const run = () => {
        const panel = doc.querySelector(PANEL_SELECTOR)
        if (panel === null) {
          setState(doc, 'idle')
          return
        }
        const found = inspect(panel)
        if (found.state === 'broken' || found.state === 'renamed') {
          setState(doc, found.state)
          warnOnce(found.state)
          return
        }
        if (found.state === 'idle') {
          setState(doc, 'idle')
          return
        }
        const report = decorate(doc, found.list, {
          label: labelPicker(doc, panel),
          chinese: pageIsChinese(doc, panel),
          selected,
          onSelect: (id) => {
            selected = id
            saveSelection(id)
            run()
          },
        })
        setState(doc, report.active ? `active:${report.groups}` : 'flat', report.active ? report.selected : undefined)
      }

      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        const raf = doc.defaultView?.requestAnimationFrame
        const tick = () => {
          scheduled = false
          try {
            run()
          } catch (error) {
            if (!warned.has('threw')) {
              warned.add('threw')
              console.warn('[dsh-plugin-groups] 铺 Tab 失败，已停手：', error)
            }
          }
        }
        if (typeof raf === 'function') raf(tick)
        else setTimeout(tick, 0)
      }

      const Observer = doc.defaultView?.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : null)
      /** 把观察者接上（body 还没出来时接不上，返回 null）。 */
      const attachObserver = () => {
        if (Observer === null || doc.body === undefined || doc.body === null) return null
        const instance = new Observer((records) => {
          if (touchesForeign(records)) schedule()
        })
        instance.observe(doc.body, { childList: true, subtree: true })
        return instance
      }
      let observer = attachObserver()
      if (observer === null && typeof doc.addEventListener === 'function') {
        // 极早期加载、body 还没出来：先跑一遍，等 DOM 就绪再把观察者补上，免得整页失效。
        doc.addEventListener(
          'DOMContentLoaded',
          () => {
            if (observer === null) observer = attachObserver()
            schedule()
          },
          { once: true },
        )
      }

      run()

      return () => {
        observer?.disconnect()
        styleDispose()
        const panel = doc.querySelector(PANEL_SELECTOR)
        const list = panel?.querySelector?.(LIST_SELECTOR) ?? null
        if (list !== null) clear(list)
        doc.documentElement?.removeAttribute?.(ROOT_ATTR)
        doc.documentElement?.removeAttribute?.(ROOT_TAB_ATTR)
      }
    }

    // ══ 八、入口 ═══════════════════════════════════════════════════════

    /** 不需要任何服务：只读 DOM、只写 DOM。 */
    exports.inject = []
    exports.name = 'dsh-plugin-groups'

    /**
     * @param {any} ctx - 浏览器端插件上下文。
     * @returns {void} 无返回值。
     */
    exports.apply = function apply(ctx) {
      if (typeof document === 'undefined' || document === null) return
      const boot = () => start(document)
      if (typeof ctx?.effect === 'function') ctx.effect(boot, 'dsh-plugin-groups: 插件页分类 Tab')
      else boot()
    }

    /** 离线验证用的钩子：把分类表与算法露出来，免得 verify.mjs 去正则抠源码。 */
    exports.__testing = {
      PARENTS,
      CHILD_ATTR,
      PARENT_ATTR,
      nest,
      ALL_CATEGORIES,
      ALL_TAB,
      CATEGORIES,
      CARD_ATTR,
      CSS,
      FALLBACK,
      GROUP_SELECTOR,
      LIST_SELECTOR,
      PANEL_SELECTOR,
      ROOT_ATTR,
      ROOT_TAB_ATTR,
      STORAGE_KEY,
      STYLE_ID,
      TAB_ATTR,
      TABBAR_ATTR,
      buildTabbar,
      categoryOf,
      clear,
      decorate,
      effectiveSelection,
      inspect,
      installStyles,
      loadSelection,
      pageIsChinese,
      saveSelection,
      start,
      tabEntries,
      touchesForeign,
    }

    return module.exports
  },
})
