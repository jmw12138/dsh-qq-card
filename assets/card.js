(function () {
  'use strict'
  if (window.__qqCardLoaded) return
  window.__qqCardLoaded = true

  var API = '/qq-card'
  var POLL_MS = 1200

  var state = {
    items: [],
    drafts: Object.create(null),
    signature: '',
    audio: null,
    announced: Object.create(null),
  }

  function diag(message) {
    try {
      fetch(API + '/diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message }),
      })
    } catch (_) {}
  }

  function el(tag, style, text) {
    var node = document.createElement(tag)
    if (style) node.style.cssText = style
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      if (!state.audio) state.audio = new Ctx()
      var audio = state.audio
      if (audio.state === 'suspended') audio.resume()
      var now = audio.currentTime
      var osc = audio.createOscillator()
      var gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now)
      osc.frequency.setValueAtTime(1180, now + 0.09)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24)
      osc.connect(gain)
      gain.connect(audio.destination)
      osc.start(now)
      osc.stop(now + 0.26)
    } catch (_) {}
  }

  function draftFor(item) {
    var draft = state.drafts[item.key]
    if (!draft) {
      draft = Object.create(null)
      state.drafts[item.key] = draft
    }
    return draft
  }

  function answerOf(draft, questionId) {
    var answer = draft[questionId]
    if (!answer) {
      answer = { selected: [], custom: '' }
      draft[questionId] = answer
    }
    return answer
  }

  function isAnswered(answer) {
    return (answer && answer.selected && answer.selected.length > 0) || Boolean(answer && answer.custom && answer.custom.trim())
  }

  function send(key, answers) {
    fetch(API + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, answers: answers }),
    })
      .then(function () {
        delete state.drafts[key]
        removeLocal(key)
      })
      .catch(function () {})
  }

  function sendDelegate(key) {
    fetch(API + '/delegate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key }),
    })
      .then(function () {
        delete state.drafts[key]
        removeLocal(key)
      })
      .catch(function () {})
  }

  function removeLocal(key) {
    state.items = state.items.filter(function (item) {
      return item.key !== key
    })
    state.signature = ''
    render()
  }

  function submitItem(item) {
    var draft = draftFor(item)
    var answers = []
    for (var i = 0; i < item.questions.length; i += 1) {
      var question = item.questions[i]
      var answer = answerOf(draft, question.id)
      var entry = { id: question.id, selected: [] }
      if (answer.custom && answer.custom.trim()) entry.custom = answer.custom.trim()
      else if (answer.selected && answer.selected.length) entry.selected = answer.selected.slice()
      answers.push(entry)
    }
    send(item.key, answers)
  }

  function submitSingle(item, question, label) {
    var draft = draftFor(item)
    var answer = answerOf(draft, question.id)
    answer.selected = [label]
    answer.custom = ''
    if (item.questions.length === 1) {
      send(item.key, [{ id: question.id, selected: [label] }])
      return
    }
    render()
  }

  var CARD_STYLE =
    'pointer-events:auto;box-sizing:border-box;width:100%;border-radius:12px;' +
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.28));' +
    'background:var(--dsw-alias-bg-elevated,#1c1f26);' +
    'box-shadow:0 10px 30px rgba(0,0,0,0.28);padding:12px 12px 10px;color:var(--dsw-alias-text-1,#e8eaf0);' +
    'font-family:inherit;font-size:13px;line-height:1.5;'

  var OPTION_STYLE =
    'display:block;width:100%;text-align:left;margin-top:6px;padding:7px 10px;border-radius:8px;cursor:pointer;' +
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.28));' +
    'background:var(--dsw-alias-bg-l2,transparent);color:inherit;font:inherit;'

  var OPTION_ACTIVE_STYLE =
    'display:block;width:100%;text-align:left;margin-top:6px;padding:7px 10px;border-radius:8px;cursor:pointer;' +
    'border:1px solid var(--dsw-alias-brand-primary,#2f6fed);' +
    'background:var(--dsw-alias-brand-primary,#2f6fed);color:#fff;font:inherit;'

  var SMALL_BTN =
    'margin-right:8px;padding:4px 9px;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;' +
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.3));background:transparent;color:inherit;'

  function buildCard(item) {
    var draft = draftFor(item)
    var card = el('div', CARD_STYLE)

    var head = el('div', 'display:flex;align-items:flex-start;gap:8px;margin-bottom:2px;')
    var titleWrap = el('div', 'flex:1;min-width:0;')
    titleWrap.appendChild(
      el(
        'div',
        'font-size:12px;opacity:0.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
        item.title ? '🐳 ' + item.title : '🐳 有新问题等你',
      ),
    )
    head.appendChild(titleWrap)
    var close = el('button', SMALL_BTN + 'margin-right:0;', '×')
    close.title = '在会话里回答'
    close.addEventListener('click', function () {
      sendDelegate(item.key)
    })
    head.appendChild(close)
    card.appendChild(head)

    item.questions.forEach(function (question, index) {
      var answer = answerOf(draft, question.id)
      var label = el('div', 'margin-top:8px;font-weight:600;')
      label.textContent = (item.questions.length > 1 ? index + 1 + '. ' : '') + question.text
      card.appendChild(label)

      if (question.options && question.options.length) {
        question.options.forEach(function (option) {
          var active = answer.selected.indexOf(option.label) >= 0
          var button = el('button', active ? OPTION_ACTIVE_STYLE : OPTION_STYLE)
          button.textContent = option.label
          if (option.description) {
            var desc = el('div', 'font-size:11px;opacity:0.66;font-weight:400;', option.description)
            button.appendChild(desc)
          }
          button.addEventListener('click', function () {
            if (question.multiSelect) {
              var at = answer.selected.indexOf(option.label)
              if (at >= 0) answer.selected.splice(at, 1)
              else answer.selected.push(option.label)
              render()
              return
            }
            submitSingle(item, question, option.label)
            if (item.questions.length > 1) render()
          })
          card.appendChild(button)
        })
      }

      var inputWrap = el('div', 'display:flex;gap:6px;margin-top:6px;')
      var input = el(
        'input',
        'flex:1;min-width:0;padding:6px 9px;border-radius:8px;font:inherit;font-size:12px;' +
          'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.3));background:transparent;color:inherit;',
      )
      input.type = 'text'
      input.placeholder = question.options && question.options.length ? '或者自己输入…' : '输入你的答案…'
      input.value = answer.custom || ''
      input.addEventListener('input', function () {
        answer.custom = input.value
        if (item.questions.length === 1) {
          var submit = card.querySelector('[data-role="submit"]')
          if (submit) submit.style.display = input.value.trim() ? 'inline-block' : 'none'
        }
      })
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return
        event.preventDefault()
        submitItem(item)
      })
      inputWrap.appendChild(input)
      card.appendChild(inputWrap)
    })

    var footer = el('div', 'display:flex;align-items:center;gap:2px;margin-top:10px;')

    var submit = el('button', SMALL_BTN, '提交')
    submit.setAttribute('data-role', 'submit')
    var allAnswered = item.questions.every(function (question) {
      return isAnswered(answerOf(draft, question.id))
    })
    var needsSubmit = item.questions.length > 1 || item.questions.some(function (question) {
      return question.multiSelect
    })
    if (needsSubmit) submit.style.display = allAnswered ? 'inline-block' : 'none'
    else submit.style.display = 'none'
    submit.addEventListener('click', function () {
      submitItem(item)
    })
    footer.appendChild(submit)

    var delegate = el('button', SMALL_BTN, '在会话里答')
    delegate.addEventListener('click', function () {
      sendDelegate(item.key)
    })
    footer.appendChild(delegate)

    var skip = el('button', SMALL_BTN, '跳过')
    skip.addEventListener('click', function () {
      send(
        item.key,
        item.questions.map(function (question) {
          return { id: question.id, selected: [] }
        }),
      )
    })
    footer.appendChild(skip)

    card.appendChild(footer)
    return card
  }

  var root = null

  function ensureRoot() {
    if (root && document.body && document.body.contains(root)) return root
    if (!document.body) return null
    root = document.createElement('div')
    root.id = 'qq-card-root'
    root.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147482100;display:flex;flex-direction:column;gap:10px;' +
      'width:340px;max-height:72vh;overflow-y:auto;pointer-events:none;'
    document.body.appendChild(root)
    return root
  }

  function render() {
    var host = ensureRoot()
    if (!host) return
    host.textContent = ''
    for (var i = 0; i < state.items.length; i += 1) {
      var card = buildCard(state.items[i])
      card.style.pointerEvents = 'auto'
      host.appendChild(card)
    }
    host.style.display = state.items.length ? 'flex' : 'none'
  }

  function update(items) {
    var signature = items
      .map(function (item) {
        return item.key
      })
      .join('|')
    var incoming = Object.create(null)
    items.forEach(function (item) {
      incoming[item.key] = true
      if (!state.announced[item.key]) {
        state.announced[item.key] = true
        beep()
      }
    })
    Object.keys(state.drafts).forEach(function (key) {
      if (!incoming[key]) delete state.drafts[key]
    })
    Object.keys(state.announced).forEach(function (key) {
      if (!incoming[key]) delete state.announced[key]
    })
    state.items = items
    if (signature !== state.signature) {
      state.signature = signature
      render()
    }
  }

  function poll() {
    fetch(API + '/pending.json', { cache: 'no-store' })
      .then(function (response) {
        return response.ok ? response.json() : null
      })
      .then(function (payload) {
        if (!payload || !payload.ok) return
        update(Array.isArray(payload.items) ? payload.items : [])
      })
      .catch(function () {})
  }

  diag('card.js 已加载')
  poll()
  setInterval(poll, POLL_MS)
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once)
    if (!state.audio) beepSoon()
  })
  function beepSoon() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx && !state.audio) state.audio = new Ctx()
    } catch (_) {}
  }
})()
