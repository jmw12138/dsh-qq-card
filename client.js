// Client module half: loaded by the Harness client module loader on page load.
// It only pulls in the card script; the card itself is served by the host half.
window.__ModuleLoader__.load({
  id: 'dsh-qq-card',
  factory() {
    return {
      inject: [],
      apply() {
        try {
          if (document.querySelector('script[data-qq-card]')) return
          const script = document.createElement('script')
          script.src = '/qq-card/card.js'
          script.defer = true
          script.setAttribute('data-qq-card', '1')
          script.onerror = () => {}
          const parent = document.body || document.head || document.documentElement
          if (parent) parent.appendChild(script)
        } catch (_) {}
      },
    }
  },
})
