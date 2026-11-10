/**
 * TREK MCP settings page — Client half of the `@local/trek-mcp` bundle.
 *
 * A Settings section with the three inputs the Host broker needs: MCP endpoint,
 * client id and client secret (plus an optional token URL). Saves go to the
 * Host at /api/trek-mcp/config, which persists them into this plugin's row and
 * restarts the broker; "Test connection" asks the Host to mint a token without
 * saving. The secret is write-only: the Host never returns it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-trek-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this page. */
    const NS = 'trek-mcp'

    const zh = {
      navLabel: 'TREK MCP',
      title: 'TREK MCP 连接',
      subtitle: '填写 TREK 的 MCP 端点、客户端 ID 和密钥；保存后自动换取短效 token 并重建连接。',
      endpoint: 'MCP 端点',
      endpointHint: '例如 http://127.0.0.1:3000/mcp 或 https://trek.example.com/mcp',
      clientId: '客户端 ID',
      clientIdHint: 'TREK → 设置 → 集成 → MCP 配置 → OAuth 2.1 客户端里的 UUID',
      clientSecret: '客户端密钥',
      clientSecretHint: '留空表示保留已保存的密钥',
      savedSecret: '已保存（不回显），留空保持不变',
      noSecret: '尚未配置密钥',
      secretFromEnv: '密钥来自环境变量 TREK_MCP_CLIENT_SECRET',
      tokenUrl: 'Token URL（可选）',
      tokenUrlHint: '留空时自动使用端点同源的 /oauth/token',
      save: '保存并重连',
      test: '测试连接',
      saving: '正在保存…',
      testing: '正在测试…',
      saved: '已保存；MCP 连接正在重建，几秒后自动刷新状态。',
      testOk: '连接成功，已获取访问 token。',
      loadFailed: '加载配置失败',
      proxy: '本地代理',
      note: '密钥只写入服务器端 profile 配置，保存后页面不再回显；保存会短暂重建 MCP 连接。',
    }

    const en = {
      navLabel: 'TREK MCP',
      title: 'TREK MCP connection',
      subtitle:
        'Enter the MCP endpoint, client ID and client secret. Saving mints a short-lived token and rebuilds the connection.',
      endpoint: 'MCP endpoint',
      endpointHint: 'e.g. http://127.0.0.1:3000/mcp or https://trek.example.com/mcp',
      clientId: 'Client ID',
      clientIdHint: 'The UUID under TREK → Settings → Integrations → MCP → OAuth 2.1 Clients',
      clientSecret: 'Client secret',
      clientSecretHint: 'Leave empty to keep the saved secret',
      savedSecret: 'Saved (not shown) — leave empty to keep it',
      noSecret: 'No secret configured yet',
      secretFromEnv: 'Secret comes from TREK_MCP_CLIENT_SECRET',
      tokenUrl: 'Token URL (optional)',
      tokenUrlHint: 'Defaults to /oauth/token on the endpoint origin',
      save: 'Save and reconnect',
      test: 'Test connection',
      saving: 'Saving…',
      testing: 'Testing…',
      saved: 'Saved. The MCP connection is rebuilding; status refreshes in a moment.',
      testOk: 'Connection OK — access token obtained.',
      loadFailed: 'Failed to load the configuration',
      proxy: 'Local proxy',
      note: 'The secret is written to the server-side profile config only and never returned to this page. Saving briefly rebuilds the MCP connection.',
    }

    /** Locale face captured by apply(); the page renders after activation. */
    let localeFace = undefined

    const CSS = `
.dsh-tm { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
.dsh-tm h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-tm .dsh-tm-sub { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.dsh-tm .dsh-tm-section { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.dsh-tm .dsh-tm-field { display: flex; flex-direction: column; gap: 5px; }
.dsh-tm .dsh-tm-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-tm input {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
}
.dsh-tm input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-tm .dsh-tm-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.dsh-tm button {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}
.dsh-tm button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-tm button:disabled { opacity: 0.55; cursor: default; }
.dsh-tm button.primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-bg-base));
  font-weight: 600;
}
.dsh-tm button.primary:hover:not(:disabled) { filter: brightness(0.94); }
.dsh-tm .dsh-tm-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; word-break: break-all; }
.dsh-tm .dsh-tm-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsh-tm .dsh-tm-status { border-radius: 8px; padding: 9px 12px; font-size: 13px; line-height: 1.5; border: 1px solid var(--dsw-alias-border-l1); }
.dsh-tm .dsh-tm-status.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsh-tm .dsh-tm-status.error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsh-tm .dsh-tm-status.info { color: var(--dsw-alias-label-secondary); }
`

    /** Tiny same-origin API helper that surfaces the server's error field. */
    async function api(path, options = {}) {
      const response = await fetch(`/api/trek-mcp${path}`, {
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        method: options.method ?? 'GET',
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
      })
      let value
      try {
        value = await response.json()
      } catch {
        value = undefined
      }
      if (!response.ok) throw new Error(value?.error ?? `${response.status} ${response.statusText}`)
      return value
    }

    /** The settings page. */
    function TrekMcpSettings() {
      const t = localeFace?.bind?.(NS) ?? ((key) => key)
      const [form, setForm] = React.useState({
        endpoint: '',
        tokenUrl: '',
        clientId: '',
        clientSecret: '',
        scope: '',
      })
      const [meta, setMeta] = React.useState(undefined)
      const [status, setStatus] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)

      const update = (key) => (event) => {
        const value = event.target.value
        setForm((previous) => ({ ...previous, [key]: value }))
      }

      const load = React.useCallback(async () => {
        const next = await api('/config')
        setMeta(next)
        setForm({
          endpoint: next.endpoint ?? '',
          tokenUrl: next.tokenUrl ?? '',
          clientId: next.clientId ?? '',
          clientSecret: '',
          scope: next.scope ?? '',
        })
      }, [])

      React.useEffect(() => {
        let cancelled = false
        load().catch((error) => {
          if (!cancelled) setStatus({ kind: 'error', text: `${t('loadFailed')}: ${error.message}` })
        })
        return () => {
          cancelled = true
        }
        // Load once on mount; `t` is a per-render binding and must not re-trigger this.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const body = () => ({
        endpoint: form.endpoint,
        tokenUrl: form.tokenUrl,
        clientId: form.clientId,
        clientSecret: form.clientSecret,
        scope: form.scope,
      })

      const save = async () => {
        setBusy('save')
        setStatus({ kind: 'info', text: t('saving') })
        try {
          await api('/config', { method: 'PUT', body: body() })
          setStatus({ kind: 'ok', text: t('saved') })
          setForm((previous) => ({ ...previous, clientSecret: '' }))
          // The row restarts with the new credentials; re-read once it is back.
          setTimeout(() => {
            load().catch(() => {})
          }, 1800)
        } catch (error) {
          setStatus({ kind: 'error', text: error.message })
        } finally {
          setBusy(undefined)
        }
      }

      const test = async () => {
        setBusy('test')
        setStatus({ kind: 'info', text: t('testing') })
        try {
          const result = await api('/test', { method: 'POST', body: body() })
          setStatus({ kind: 'ok', text: `${t('testOk')} ${result.expiresIn}s` })
        } catch (error) {
          setStatus({ kind: 'error', text: error.message })
        } finally {
          setBusy(undefined)
        }
      }

      const field = (label, key, options = {}) =>
        h(
          'label',
          { className: 'dsh-tm-field', key },
          h('span', { className: 'dsh-tm-label' }, label),
          h('input', {
            ...options,
            value: form[key] ?? '',
            onChange: update(key),
            disabled: busy !== undefined,
            spellCheck: false,
            autoComplete: 'off',
          }),
        )

      const secretPlaceholder = meta?.secretFromEnv
        ? t('secretFromEnv')
        : meta?.hasSecret
          ? t('savedSecret')
          : t('noSecret')

      return h(
        'div',
        { className: 'dsh-tm' },
        h('div', null, h('h2', null, t('title')), h('p', { className: 'dsh-tm-sub' }, t('subtitle'))),
        status ? h('div', { className: `dsh-tm-status ${status.kind}` }, status.text) : null,
        h(
          'div',
          { className: 'dsh-tm-section' },
          field(t('endpoint'), 'endpoint', { type: 'url', placeholder: t('endpointHint') }),
          field(t('clientId'), 'clientId', { type: 'text', placeholder: '00000000-0000-0000-0000-000000000000' }),
          field(t('clientSecret'), 'clientSecret', { type: 'password', placeholder: secretPlaceholder }),
          field(t('tokenUrl'), 'tokenUrl', { type: 'url', placeholder: t('tokenUrlHint') }),
          h(
            'div',
            { className: 'dsh-tm-row' },
            h(
              'button',
              { className: 'primary', disabled: busy !== undefined, onClick: save },
              busy === 'save' ? t('saving') : t('save'),
            ),
            h('button', { disabled: busy !== undefined, onClick: test }, busy === 'test' ? t('testing') : t('test')),
            meta ? h('span', { className: 'dsh-tm-meta' }, `${t('proxy')}: ${meta.mcpUrl}`) : null,
          ),
          h('p', { className: 'dsh-tm-note' }, t('note')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => {
            const element = document.createElement('style')
            element.dataset.dshTrekMcp = '1'
            element.textContent = CSS
            document.head.appendChild(element)
            return () => element.remove()
          },
          'trek-mcp: styles',
        )
        localeFace = ctx.locale
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'trek-mcp: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'trek-mcp',
              order: 61,
              label: () => t('navLabel'),
            },
            TrekMcpSettings,
          ),
        )
      },
    }
  },
})
