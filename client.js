/**
 * Browser half of the update guard.
 *
 * The Desktop shell owns the update control and the download it starts, so this
 * module gates that one action instead of replacing it: a capturing click
 * listener recognises the shell's available-update control, asks the Host which
 * installed plugins declare support for the target release, and shows one
 * confirmation dialog in the frame overlay. Confirming calls the shell's own
 * update entry point, so the ordinary download flow continues unchanged.
 *
 * Only the Desktop application exposes the update bridge; ordinary browser
 * pages produce no dialog and no listener work beyond one click check.
 */

window.__ModuleLoader__.load({
  id: '@palpitation6/dsh-update-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'update-guard'
    const REPORT_URL = '/api/dsh-update-guard/report'
    const FETCH_TIMEOUT_MS = 6000
    const SELF_MARKER = 'data-dsh-update-guard'

    /**
     * Shipped translations of the shell's available-update label. The settings
     * locale namespace is consulted first at click time; these keep the
     * interception working when that namespace is absent or already unloaded.
     */
    const AVAILABLE_LABELS = [
      '新版本', 'Update', '更新', 'Actualizar', 'Mise à jour', 'Aktualisieren', 'Обновить', 'Atualizar',
    ]

    const zh = {
      title: '更新前检查插件兼容性',
      target: '目标版本：{version}',
      checking: '正在检查已安装插件…',
      checkingShort: '正在检查…',
      checkingHint: '结果只用于这次确认，不会改动任何插件。',
      summaryOk: '已安装的插件都声明支持这个版本',
      summaryNone: '没有需要检查的第三方插件',
      summaryAllDisabled: '已安装的第三方插件都已停用',
      summaryMixed: '{declared} 个插件声明支持这个版本，{unspecified} 个未声明 DSH 版本要求',
      summaryWarn: '{count} 个插件声明不支持 {version}',
      summaryWarnOne: '1 个插件声明不支持 {version}',
      summaryWarnDisabled: '只有 {count} 个已停用的插件声明不支持 {version}',
      summaryWarnDisabledOne: '只有 1 个已停用的插件声明不支持 {version}',
      summaryWarnDetail: '更新后 DSH 会拒绝加载这些插件，直到它们发布兼容版本。',
      summaryWarnDisabledDetail: '已停用的插件不会加载，因此不影响这次更新。',
      summaryUnknown: '{count} 个插件的兼容性无法检查',
      summaryUnknownOne: '1 个插件的兼容性无法检查',
      summaryUnknownDetail: '读取不到这些插件的版本信息，因此它们没有被计入不兼容名单。',
      summaryErrorCheck: '无法检查插件兼容性',
      summaryErrorCheckTimeout: '后台服务没有在时限内响应。',
      summaryErrorUnreachable: '后台检查接口不可用，插件可能尚未就绪。',
      summaryErrorServer: '后台返回了错误。',
      summaryErrorInvalid: '后台返回的检查结果无法识别。',
      summaryErrorCheckHint: '更新仍可继续，但不会提示不兼容的插件。',
      summaryErrorOpen: '无法开始更新',
      summaryErrorOpenDetail: '更新流程没有启动。可以重试，或稍后再从更新按钮重新开始。',
      checkedCount: '已检查 {count} 个已安装插件',
      checkedCountOne: '已检查 1 个已安装插件',
      statusCompatible: '兼容',
      statusIncompatible: '不兼容',
      statusUnspecified: '未声明版本要求',
      statusUnknown: '未检查',
      noteManifestMissing: '读取不到 package.json',
      requires: '要求 {range}，新版本不满足',
      more: '另有 {count} 项要求',
      disabled: '已停用',
      showAll: '显示全部插件（{count}）',
      hideAll: '收起列表',
      confirm: '更新到 {version}',
      anyway: '仍然更新',
      retry: '重试',
      cancel: '取消',
    }

    const en = {
      title: 'Check plugin compatibility before updating',
      target: 'Target version: {version}',
      checking: 'Checking installed plugins…',
      checkingShort: 'Checking…',
      checkingHint: 'The result only drives this confirmation; no plugin is changed.',
      summaryOk: 'Every installed plugin declares support for this version',
      summaryNone: 'No third-party plugins need checking',
      summaryAllDisabled: 'Every installed third-party plugin is disabled',
      summaryMixed: '{declared} plugins declare support for this version; {unspecified} declare no DSH requirement',
      summaryWarn: '{count} plugins declare no support for {version}',
      summaryWarnOne: '1 plugin declares no support for {version}',
      summaryWarnDisabled: 'Only {count} disabled plugins declare no support for {version}',
      summaryWarnDisabledOne: 'Only 1 disabled plugin declares no support for {version}',
      summaryWarnDetail: 'DSH refuses to load them after the update until they publish a compatible version.',
      summaryWarnDisabledDetail: 'Disabled plugins never load, so this update is unaffected.',
      summaryUnknown: '{count} plugins could not be checked',
      summaryUnknownOne: '1 plugin could not be checked',
      summaryUnknownDetail: 'Their version information could not be read, so they are not counted as conflicts.',
      summaryErrorCheck: 'Plugin compatibility could not be checked',
      summaryErrorCheckTimeout: 'The Host did not answer in time.',
      summaryErrorUnreachable: 'The Host check route is unavailable; the plugin may not be ready yet.',
      summaryErrorServer: 'The Host returned an error.',
      summaryErrorInvalid: 'The Host returned a result this plugin cannot read.',
      summaryErrorCheckHint: 'The update can still continue, but conflicts will not be listed.',
      summaryErrorOpen: 'The update could not be started',
      summaryErrorOpenDetail: 'The update flow did not start. Retry, or choose the update control again later.',
      checkedCount: '{count} installed plugins checked',
      checkedCountOne: '1 installed plugin checked',
      statusCompatible: 'Compatible',
      statusIncompatible: 'Incompatible',
      statusUnspecified: 'No version requirement',
      statusUnknown: 'Not checked',
      noteManifestMissing: 'Manifest unreadable',
      requires: 'Needs {range}; this release does not satisfy it',
      more: 'and {count} more requirements',
      disabled: 'Disabled',
      showAll: 'Show all plugins ({count})',
      hideAll: 'Collapse list',
      confirm: 'Update to {version}',
      anyway: 'Update anyway',
      retry: 'Retry',
      cancel: 'Cancel',
    }

    const STYLE = `
.duc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;pointer-events:none}
.duc-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));backdrop-filter:var(--dsw-mask-blur,none);pointer-events:auto}
.duc-panel{position:relative;z-index:1;display:flex;flex-direction:column;gap:14px;box-sizing:border-box;width:480px;max-width:calc(100vw - 48px);max-height:calc(100vh - 96px);padding:20px;border-radius:var(--dsw-radius-panel,16px);border:1px solid var(--dsw-alias-border-l1,transparent);background:var(--dsw-alias-bg-overlay,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.24));pointer-events:auto}
.duc-panel:focus{outline:none}
.duc-head{display:flex;flex-direction:column;gap:4px}
.duc-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.duc-target{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,GrayText);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.duc-body{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:auto}
.duc-summary{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08))}
.duc-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,currentColor)}
.duc-summary[data-tone="ok"] .duc-dot{background:var(--dsw-alias-state-success-primary,currentColor)}
.duc-summary[data-tone="warn"] .duc-dot{background:var(--dsw-alias-state-warn-primary,currentColor)}
.duc-summary[data-tone="error"] .duc-dot{background:var(--dsw-alias-state-error-primary,currentColor)}
.duc-summary-text{display:flex;flex-direction:column;gap:2px;font-size:13px;line-height:20px;min-width:0}
.duc-summary-title{font-weight:500}
.duc-summary-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,GrayText)}
.duc-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.duc-item{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.duc-item-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px;line-height:18px}
.duc-item-name{font-weight:500;overflow-wrap:anywhere}
.duc-item-version{color:var(--dsw-alias-label-secondary,GrayText);font-variant-numeric:tabular-nums}
.duc-tag,.duc-status{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));color:var(--dsw-alias-label-secondary,GrayText)}
.duc-status[data-status="incompatible"]{color:var(--dsw-alias-state-warn-primary,currentColor);border-color:currentColor}
.duc-status[data-status="compatible"]{color:var(--dsw-alias-state-success-primary,currentColor);border-color:currentColor}
.duc-item-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,GrayText);overflow-wrap:anywhere}
.duc-toggle{align-self:flex-start;padding:0;border:none;background:none;color:var(--dsw-alias-brand-primary,currentColor);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.duc-toggle:hover{text-decoration:underline}
.duc-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:2px;border-radius:4px}
.duc-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.duc-button{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.duc-button:hover:not([disabled]){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08))}
.duc-button[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary,#2563eb);color:#fff}
.duc-button[data-variant="warn"]{border-color:var(--dsw-alias-state-warn-primary,#b26b00);color:var(--dsw-alias-state-warn-primary,#b26b00);background:transparent}
.duc-button[data-variant="warn"]:hover:not([disabled]){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08))}
.duc-button[disabled]{opacity:.5;cursor:default}
.duc-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:2px}
`

    /**
     * Report failure reason to the sentence that explains it.
     */
    const ERROR_DETAIL_KEYS = {
      timeout: 'summaryErrorCheckTimeout',
      invalid: 'summaryErrorInvalid',
      server: 'summaryErrorServer',
      unreachable: 'summaryErrorUnreachable',
    }

    /**
     * Create a minimal observable snapshot store for the dialog state.
     * @param {{ request: object | null }} initial - initial snapshot
     * @returns {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void }}
     *   the store the renderer binds as a hook source
     */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          if (Object.is(state, next)) return
          state = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * @param {object} ctx - client plugin context
     * @returns {Set<string>} accessible labels of the available-update control
     */
    function availableLabels(ctx) {
      const labels = new Set(AVAILABLE_LABELS)
      try {
        const translate = ctx.locale.bind('settings')
        const value = translate('desktop.update.available')
        if (typeof value === 'string' && value !== '' && value !== 'desktop.update.available') labels.add(value)
      } catch {
        // The settings namespace is not mounted; the shipped labels still apply.
      }
      return labels
    }

    /**
     * @param {string} base - a counted locale key
     * @param {number} count - the counted value
     * @returns {string} the singular key when the count is one
     */
    function counted(base, count) {
      return count === 1 ? `${base}One` : base
    }

    /**
     * @param {{ status: string }} entry - one report row
     * @returns {string} the locale key describing its status
     */
    function statusKey(entry) {
      switch (entry.status) {
        case 'compatible':
          return 'statusCompatible'
        case 'incompatible':
          return 'statusIncompatible'
        case 'unknown':
          return 'statusUnknown'
        default:
          return 'statusUnspecified'
      }
    }

    /**
     * @param {Function} t - translator of this plugin's namespace
     * @param {object} entry - one report row
     * @param {boolean} all - whether to show every unmet requirement
     * @returns {string} the unmet requirements, shortened when collapsed
     */
    function unmetText(t, entry, all) {
      if (entry.unmet === undefined || entry.unmet === null) return ''
      const unmet = Object.entries(entry.unmet)
      const shown = (all ? unmet : unmet.slice(0, 2))
        .map(([key, range]) => (key === 'engines.dsh' ? t('requires', { range }) : `${key}: ${range}`))
      const rest = unmet.length - shown.length
      return rest > 0 ? `${shown.join('; ')} ${t('more', { count: rest })}` : shown.join('; ')
    }

    /**
     * Read a validation flag for the report shape.
     * @param {unknown} value - parsed response body
     * @returns {boolean} whether the body is a compatibility report
     */
    function isReport(value) {
      if (value === null || typeof value !== 'object') return false
      if (typeof value.targetVersion !== 'string' || !Array.isArray(value.plugins)) return false
      const counts = value.counts
      if (counts === null || typeof counts !== 'object') return false
      return ['total', 'compatible', 'incompatible', 'unspecified', 'unknown']
        .every((key) => typeof counts[key] === 'number')
    }

    /**
     * One compatibility row.
     * @param {{ t: Function, entry: object, all: boolean }} props - translator, row, and detail level
     * @returns {object} the row element
     */
    function Row({ t, entry, all }) {
      const meta = entry.status === 'incompatible'
        ? unmetText(t, entry, all)
        : entry.status === 'unknown'
          ? t('noteManifestMissing')
          : ''
      return h(
        'li',
        { className: 'duc-item' },
        h(
          'div',
          { className: 'duc-item-head' },
          h('span', { className: 'duc-item-name' }, entry.name),
          entry.version === undefined ? null : h('span', { className: 'duc-item-version' }, entry.version),
          entry.enabled === false ? h('span', { className: 'duc-tag' }, t('disabled')) : null,
          h('span', { className: 'duc-status', 'data-status': entry.status }, t(statusKey(entry))),
        ),
        meta === '' ? null : h('div', { className: 'duc-item-meta' }, meta),
      )
    }

    /**
     * The confirmation dialog.
     * @param {{ t: Function, useGuard: Function, confirm: Function, cancel: Function, retry: Function }} props
     *   the injected face
     * @returns {object | null} the overlay, or null while closed
     */
    function GuardDialog({ t, useGuard, confirm, cancel, retry }) {
      const useDialogState = typeof useGuard === 'function' ? useGuard : () => null
      const request = useDialogState((state) => (state === null || state === undefined ? null : state.request))
      const [expanded, setExpanded] = React.useState(false)
      const panel = React.useRef(null)
      const restore = React.useRef(null)
      const titleId = React.useId()
      const summaryId = React.useId()
      const listId = React.useId()
      const open = request !== null && typeof request === 'object'
      const dismiss = typeof cancel === 'function' ? cancel : () => {}
      const accept = typeof confirm === 'function' ? confirm : dismiss
      const again = typeof retry === 'function' ? retry : dismiss
      const status = open ? String(request.status) : 'closed'
      const stage = open ? String(request.stage ?? 'check') : 'check'

      React.useEffect(() => {
        if (!open) return undefined
        setExpanded(false)
        restore.current = document.activeElement
        if (panel.current !== null) panel.current.focus()
        return () => {
          const target = restore.current
          restore.current = null
          if (target instanceof HTMLElement && target.isConnected) target.focus()
        }
      }, [open])

      React.useEffect(() => {
        if (!open || status === 'loading') return
        const node = panel.current
        if (node === null || document.activeElement !== node) return
        const target = node.querySelector('[data-initial-focus]')
        if (target instanceof HTMLElement) target.focus()
      }, [open, status, stage])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          dismiss()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [open, dismiss])

      if (!open) return null

      const report = request.report
      const ready = status === 'ready'
      const rawPlugins = ready && report !== null && typeof report === 'object' && Array.isArray(report.plugins)
        ? report.plugins
        : []
      const plugins = rawPlugins.filter((entry) => entry !== null && typeof entry === 'object')
      const enabledPlugins = plugins.filter((entry) => entry.enabled !== false)
      const conflicts = plugins.filter((entry) => entry.status === 'incompatible')
      const activeConflicts = conflicts.filter((entry) => entry.enabled !== false)
      const unverified = enabledPlugins.filter((entry) => entry.status === 'unknown')
      const declared = enabledPlugins.filter((entry) => entry.status === 'compatible').length
      const unspecified = enabledPlugins.filter((entry) => entry.status === 'unspecified').length
      const targetVersion = ready && report !== null && typeof report === 'object' && typeof report.targetVersion === 'string'
        ? report.targetVersion
        : request.version

      const tone = status === 'error'
        ? 'error'
        : status === 'loading'
          ? 'idle'
          : activeConflicts.length > 0 || unverified.length > 0
            ? 'warn'
            : 'ok'

      const headline = status === 'loading'
        ? t('checking')
        : status === 'error'
          ? t(stage === 'open' ? 'summaryErrorOpen' : 'summaryErrorCheck')
          : activeConflicts.length > 0
            ? t(counted('summaryWarn', activeConflicts.length), { count: activeConflicts.length, version: targetVersion })
            : unverified.length > 0
              ? t(counted('summaryUnknown', unverified.length), { count: unverified.length })
              : plugins.length === 0
                ? t('summaryNone')
                : enabledPlugins.length === 0
                  ? t('summaryAllDisabled')
                  : conflicts.length > 0
                    ? t(counted('summaryWarnDisabled', conflicts.length), { count: conflicts.length, version: targetVersion })
                    : unspecified > 0 && declared !== enabledPlugins.length
                      ? t('summaryMixed', { declared, unspecified })
                      : t('summaryOk')
      const detail = status === 'loading'
        ? t('checkingHint')
        : status === 'error'
          ? stage === 'open'
            ? t('summaryErrorOpenDetail')
            : `${t(ERROR_DETAIL_KEYS[String(request.reason ?? '')] ?? 'summaryErrorUnreachable')} ${t('summaryErrorCheckHint')}`
          : activeConflicts.length > 0
            ? t('summaryWarnDetail')
            : unverified.length > 0
              ? t('summaryUnknownDetail')
              : conflicts.length > 0
                ? t('summaryWarnDisabledDetail')
                : plugins.length === 0 || enabledPlugins.length === 0
                  ? null
                  : t(counted('checkedCount', enabledPlugins.length), { count: enabledPlugins.length })

      const conflicted = activeConflicts.length > 0 || unverified.length > 0
      const risky = conflicted
      const actions = []

      actions.push(h(
        'button',
        {
          key: 'cancel',
          type: 'button',
          className: 'duc-button',
          'data-initial-focus': risky || status === 'error' || status === 'loading' ? '' : undefined,
          onClick: dismiss,
        },
        t('cancel'),
      ))

      if (status === 'error') {
        actions.push(h(
          'button',
          { key: 'retry', type: 'button', className: 'duc-button', onClick: again },
          t('retry'),
        ))
      }

      if (status !== 'error' || stage === 'check') {
        actions.push(h(
          'button',
          {
            key: 'primary',
            type: 'button',
            className: 'duc-button',
            'data-variant': risky || status === 'error' ? 'warn' : 'primary',
            'data-initial-focus': risky || status === 'error' || status === 'loading' ? undefined : '',
            disabled: status === 'loading',
            onClick: accept,
          },
          status === 'loading' || status === 'error'
            ? (status === 'error' ? t('anyway') : t('checkingShort'))
            : risky
              ? t('anyway')
              : t('confirm', { version: request.version }),
        ))
      }

      const visible = !ready
        ? []
        : expanded
          ? plugins
          : plugins.filter((entry) => entry.status === 'incompatible' || entry.status === 'unknown')

      return h(
        'div',
        {
          className: 'duc-overlay',
          'data-dsh-update-guard': '',
          onKeyDown: (event) => {
            if (event.key !== 'Tab' || panel.current === null) return
            const buttons = [...panel.current.querySelectorAll('button:not([disabled])')]
            if (buttons.length === 0) return
            const first = buttons[0]
            const last = buttons[buttons.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          },
        },
        h('style', { key: 'style' }, STYLE),
        h('div', { key: 'mask', className: 'duc-mask', 'aria-hidden': 'true', onClick: dismiss }),
        h(
          'div',
          {
            key: 'panel',
            ref: panel,
            className: 'duc-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            'aria-describedby': summaryId,
            tabIndex: -1,
          },
          h(
            'div',
            { className: 'duc-head' },
            h('h2', { className: 'duc-title', id: titleId }, t('title')),
            h('div', { className: 'duc-target' }, t('target', { version: request.version })),
          ),
          h(
            'div',
            { className: 'duc-body' },
            h(
              'div',
              {
                className: 'duc-summary',
                'data-tone': tone,
                id: summaryId,
                role: 'status',
                'aria-live': 'polite',
                'aria-busy': status === 'loading' ? 'true' : 'false',
              },
              h('span', { className: 'duc-dot', 'aria-hidden': 'true' }),
              h(
                'div',
                { className: 'duc-summary-text' },
                h('div', { className: 'duc-summary-title' }, headline),
                detail === null ? null : h('div', { className: 'duc-summary-detail' }, detail),
              ),
            ),
            ready && plugins.length > 0 && (expanded || plugins.length > visible.length)
              ? h(
                'button',
                {
                  type: 'button',
                  className: 'duc-toggle',
                  'aria-expanded': expanded ? 'true' : 'false',
                  'aria-controls': listId,
                  onClick: () => setExpanded(!expanded),
                },
                expanded ? t('hideAll') : t('showAll', { count: plugins.length }),
              )
              : null,
            visible.length === 0
              ? null
              : h(
                'ul',
                { className: 'duc-list', id: listId },
                visible.map((entry) => h(Row, { key: `${entry.name}`, t, entry, all: expanded })),
              ),
          ),
          h('div', { className: 'duc-actions' }, actions),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Gate the Desktop update control on plugin compatibility.
       * @param {object} ctx - client plugin context
       */
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'update-guard: dictionaries',
        )

        const carrier = globalThis.dshDesktop
        const bridge = carrier !== null && typeof carrier === 'object' && carrier.protocolVersion === 1
          ? carrier.updates
          : undefined
        const store = createStore({ request: null })
        let presentation
        let disposed = false
        let pending

        const close = () => {
          if (pending !== undefined) {
            pending.abort()
            pending = undefined
          }
          if (store.getSnapshot().request !== null) store.set({ request: null })
        }

        /**
         * Continue the shell's own update flow after the user accepts it.
         * @param {string} version - version the dialog spoke for
         */
        const continueUpdate = (version) => {
          if (bridge === undefined || typeof bridge.open !== 'function') {
            close()
            return
          }
          let opened
          try {
            opened = bridge.open()
          } catch {
            store.set({ request: { version, status: 'error', stage: 'open', reason: 'open-failed' } })
            return
          }
          close()
          Promise.resolve(opened).catch(() => {
            if (disposed) return
            store.set({ request: { version, status: 'error', stage: 'open', reason: 'open-failed' } })
          })
        }

        /**
         * Ask the Host for the compatibility report of one target release.
         * @param {string} version - release the update would install
         */
        const check = (version) => {
          if (pending !== undefined) pending.abort()
          const controller = new AbortController()
          pending = controller
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
          store.set({ request: { version, status: 'loading' } })
          fetch(`${REPORT_URL}?version=${encodeURIComponent(version)}`, {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          })
            .then(async (response) => {
              if (!response.ok) {
                const kind = response.status === 404 ? 'unreachable' : 'server'
                throw Object.assign(new Error(`HTTP ${response.status}`), { reason: kind })
              }
              let body
              try {
                body = await response.json()
              } catch {
                throw Object.assign(new Error('invalid body'), { reason: 'invalid' })
              }
              if (!isReport(body)) throw Object.assign(new Error('invalid report'), { reason: 'invalid' })
              return body
            })
            .then((report) => {
              if (disposed || pending !== controller) return
              pending = undefined
              store.set({ request: { version, status: 'ready', report } })
            })
            .catch((error) => {
              if (disposed || pending !== controller) return
              pending = undefined
              const reason = error !== null && typeof error === 'object' && error.name === 'AbortError'
                ? 'timeout'
                : error !== null && typeof error === 'object' && typeof error.reason === 'string'
                  ? error.reason
                  : 'unreachable'
              store.set({ request: { version, status: 'error', stage: 'check', reason } })
            })
            .finally(() => {
              clearTimeout(timer)
            })
        }

        const retry = () => {
          const request = store.getSnapshot().request
          if (request === null || typeof request !== 'object') return
          if (request.status === 'error' && request.stage === 'open') continueUpdate(request.version)
          else check(request.version)
        }

        const confirm = () => {
          const request = store.getSnapshot().request
          if (request === null || typeof request !== 'object') return
          if (request.status === 'loading') return
          continueUpdate(request.version)
        }

        ctx.effect(() => {
          const onClick = (event) => {
            if (disposed) return
            const state = presentation
            if (state === null || typeof state !== 'object') return
            if (state.phase !== 'available' || typeof state.version !== 'string' || state.version === '') return
            if (state.configurationError !== undefined) return
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest(`[${SELF_MARKER}]`) !== null) return
            const button = target.closest('button')
            if (button === null) return
            if (button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled')) return
            const label = button.getAttribute('aria-label')
            if (label === null || !availableLabels(ctx).has(label)) return
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            if (store.getSnapshot().request === null) check(state.version)
          }
          window.addEventListener('click', onClick, true)
          return () => {
            disposed = true
            window.removeEventListener('click', onClick, true)
            close()
          }
        }, 'update-guard: desktop update control')

        ctx.effect(() => {
          if (bridge === undefined) return () => {}
          let unregister
          if (typeof bridge.subscribe === 'function') {
            unregister = bridge.subscribe((next) => {
              presentation = next
            })
          }
          if (typeof bridge.status === 'function') {
            Promise.resolve()
              .then(() => bridge.status())
              .then((next) => {
                if (presentation === undefined) presentation = next
              })
              .catch(() => {})
          }
          return () => {
            if (typeof unregister === 'function') unregister()
          }
        }, 'update-guard: update presentation')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'update-guard',
          order: 1000,
          locale: NS,
          inject: () => ({
            hooks: { guard: store },
            confirm,
            retry,
            cancel: close,
          }),
        }, GuardDialog))
      },
    }
  },
})
