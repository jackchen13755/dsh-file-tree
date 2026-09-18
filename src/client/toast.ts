/**
 * A one-line floating notice for jumps that happen OUTSIDE this plugin's panel
 * (the product's preview tab has no notice area this plugin can write into).
 *
 * Deliberately framework-free: it only appends one positioned element and
 * fades it out, so it cannot interfere with the product's React trees.
 */

let host: HTMLElement | undefined
let timer: number | undefined

/**
 * Show (or replace) the floating notice.
 * @param text - the message.
 * @param kind - `error` paints it red.
 */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  if (host === undefined || !host.isConnected) {
    host = document.createElement('div')
    host.setAttribute('data-dsh-file-tree-toast', '')
    Object.assign(host.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      zIndex: '2147483000',
      maxWidth: '400px',
      padding: '8px 12px',
      borderRadius: '8px',
      fontSize: '12px',
      lineHeight: '1.5',
      whiteSpace: 'pre-wrap',
      boxShadow: '0 6px 24px rgba(0,0,0,.35)',
      pointerEvents: 'none',
      transition: 'opacity .2s ease',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    } satisfies Partial<CSSStyleDeclaration>)
    document.body.appendChild(host)
  }
  host.textContent = text
  host.style.background = kind === 'error' ? 'rgba(120,30,30,.95)' : 'rgba(28,32,38,.95)'
  host.style.color = kind === 'error' ? '#ffd7d3' : '#e6e6e6'
  host.style.opacity = '1'
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    if (host !== undefined) host.style.opacity = '0'
  }, 2600)
}
