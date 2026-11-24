import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const API = '/qq-card'
const CARD_JS = '/qq-card/card.js'
/** 无人作答就交给官方界面，免得模型对着空气干等。 */
const AUTO_DELEGATE_MS = 10 * 60 * 1000

const LOG_FILE = path.join(os.homedir(), '.dsh', 'qq-card-diag.log')

function diag(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {}
}

// 桌面端（Electron）唯一生效的注入通道：结构化的内联 script 行。
// 不能用 script-src 行（加载失败会 reject 整个 boot），所以自己建 <script src> 并吞掉 onerror。
const ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + CARD_JS + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

const CARD_JS_PATH = new URL('./assets/card.js', import.meta.url)

function questionText(question) {
  const raw = question || {}
  for (const key of ['question', 'title', 'header', 'text', 'prompt']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return '需要你回答'
}

function questionOptions(question) {
  const options = Array.isArray(question?.options) ? question.options : []
  return options
    .map((option) => {
      if (typeof option === 'string') return { label: option }
      if (!option || typeof option !== 'object') return null
      const label = option.label ?? option.value ?? option.text
      if (typeof label !== 'string' || !label) return null
      const item = { label }
      if (typeof option.description === 'string' && option.description) item.description = option.description
      return item
    })
    .filter(Boolean)
}

function normalizeQuestions(questions) {
  const list = Array.isArray(questions) ? questions : []
  return list.map((question, index) => ({
    id: String(question?.id ?? `q${index + 1}`),
    text: questionText(question),
    multiSelect: Boolean(question?.multiSelect),
    options: questionOptions(question),
    intent: question?.intent && typeof question.intent === 'object' ? question.intent : undefined,
  }))
}

function sessionTitleOf(ctx, agent) {
  try {
    const session = agent?.session
    if (!session) return ''
    const service = ctx.get('sessionTitle')
    const snapshot = service?.get?.(session)
    const title = snapshot?.title ?? snapshot?.text
    if (typeof title === 'string' && title.trim()) return title.trim()
  } catch {}
  try {
    const id = agent?.session?.id
    if (typeof id === 'string' && id) return id.slice(0, 8)
  } catch {}
  return ''
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      raw += chunk
      if (raw.length > 512 * 1024) tooBig = true
    })
    req.on('end', () => {
      if (tooBig) return resolve(null)
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 只放行本机来源，避免别的站点顺手读走挂起的问题。 */
function fence(req, res) {
  let hostname = ''
  try {
    hostname = new URL(String(req.headers?.origin || '')).hostname
  } catch {}
  if (hostname && !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    sendJson(res, 403, { ok: false, error: 'bad-origin' })
    return false
  }
  const addr = req.socket?.remoteAddress || ''
  if (addr && !/^(::ffff:)?(127\.0\.0\.1|::1)$/.test(addr)) {
    sendJson(res, 403, { ok: false, error: 'not-local' })
    return false
  }
  return true
}

export default {
  name: 'qq-card',

  // 注意：这里**不能**写对象级 inject（会把 apply 推迟到服务就绪之后，
  // 而桌面端的注入表是宿主启动时一次性收集的，行会永远进不了表）。
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    })

    // ① 结构化注入行（桌面端唯一通道）
    try {
      disposers.push(
        root.on('webserver/index-inject', (table) => {
          try {
            if (!Array.isArray(table)) return
            for (const row of table) {
              if (!row) continue
              if (typeof row.text === 'string' && row.text.includes(CARD_JS)) return
              if (row.src === CARD_JS) return
            }
            table.push({ kind: 'script', placement: 'body', text: ROW_TEXT })
            diag('index-inject: 已推入 card.js 行')
          } catch (error) {
            diag(`index-inject 推行失败: ${error?.message ?? error}`)
          }
        }),
      )
    } catch (error) {
      diag(`index-inject 订阅失败: ${error?.message ?? error}`)
    }

    // ② 其余逻辑等 webServer 就绪
    root.inject(['webServer'], (ctx) => {
      const pending = new Map()
      let seq = 0
      // 页面里必须有活着的卡片在轮询才敢接管这道题；否则宁可交还官方界面，
      // 免得「宿主抢了题、页面上没有卡片」→ 模型白等十分钟。
      let lastPollAt = 0
      const CLIENT_ALIVE_MS = 20000

      const respond = (key, answers) => {
        const entry = pending.get(key)
        if (!entry) return { ok: false, error: 'unknown-key' }
        pending.delete(key)
        clearTimeout(entry.timer)
        diag(`answer ${key} -> ${JSON.stringify(answers)}`)
        try {
          entry.resolve({ answers })
        } catch (error) {
          diag(`answer resolve 失败: ${error?.message ?? error}`)
        }
        return { ok: true }
      }

      const delegate = (key, reason) => {
        const entry = pending.get(key)
        if (!entry) return { ok: false, error: 'unknown-key' }
        pending.delete(key)
        clearTimeout(entry.timer)
        diag(`delegate ${key} reason=${reason}`)
        try {
          const fallback = entry.next
          entry.resolve(typeof fallback === 'function' ? fallback() : undefined)
        } catch (error) {
          diag(`delegate 失败: ${error?.message ?? error}`)
          try {
            entry.reject(error)
          } catch {}
        }
        return { ok: true }
      }

      const intercept = (agent, request, next) => {
        const questions = normalizeQuestions(request?.questions)
        if (!questions.length) {
          return typeof next === 'function' ? next() : { answers: [] }
        }
        const callId = request?.wait?.callId ?? request?.callId
        const sessionId = String(agent?.session?.id ?? '')
        if (Date.now() - lastPollAt > CLIENT_ALIVE_MS) {
          diag('skip: 页面上没有活着的卡片，交还官方界面')
          return typeof next === 'function' ? next() : { answers: [] }
        }
        const key = callId ? `${sessionId || 'agent'}:${callId}` : `k${++seq}`
        if (pending.has(key)) pending.delete(key)

        return new Promise((resolve, reject) => {
          const entry = {
            key,
            questions,
            sessionId,
            callId: callId ? String(callId) : undefined,
            title: sessionTitleOf(ctx, agent),
            ts: Date.now(),
            resolve,
            reject,
            next,
          }
          entry.timer = setTimeout(() => delegate(key, 'auto-timeout'), AUTO_DELEGATE_MS)
          pending.set(key, entry)
          diag(`intercept ${key} questions=${questions.length} session=${sessionId || '-'}`)

          const signal = request?.signal
          if (signal && typeof signal.addEventListener === 'function') {
            try {
              signal.addEventListener(
                'abort',
                () => {
                  if (pending.get(key) !== entry) return
                  pending.delete(key)
                  clearTimeout(entry.timer)
                  diag(`abort ${key}`)
                  reject(new Error('ask_user_question was aborted before the user answered'))
                },
                { once: true },
              )
            } catch {}
          }
        })
      }

      const attach = (agent) => {
        if (!agent || typeof agent.ctx?.on !== 'function') {
          diag('agent/created: agent 没有 ctx.on，跳过')
          return () => {}
        }
        const handler = (...args) => {
          const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
          const first = args[0]
          const request = Array.isArray(first) ? first[0] : first
          try {
            return intercept(agent, request, next)
          } catch (error) {
            diag(`intercept 异常: ${error?.message ?? error}`)
            return typeof next === 'function' ? next() : { answers: [] }
          }
        }
        let dispose = () => {}
        try {
          dispose = agent.ctx.on('user-questions/request', handler, { prepend: true }) || (() => {})
          diag(`agent 挂上抢答器 session=${agent?.session?.id ?? '-'}`)
        } catch (error) {
          diag(`agent.ctx.on 失败: ${error?.message ?? error}`)
        }
        return () => {
          try {
            dispose()
          } catch {}
        }
      }

      const detachers = new Map()
      try {
        disposers.push(
          ctx.on('agent/created', ({ agent }) => {
            const detach = attach(agent)
            try {
              detachers.set(agent, detach)
            } catch {}
          }),
        )
      } catch (error) {
        diag(`agent/created 订阅失败: ${error?.message ?? error}`)
      }
      try {
        disposers.push(
          ctx.on('agent/disposed', ({ agent }) => {
            const detach = detachers.get(agent)
            if (detach) {
              detach()
              detachers.delete(agent)
            }
          }),
        )
      } catch (error) {
        diag(`agent/disposed 订阅失败: ${error?.message ?? error}`)
      }

      const route = (path, handler) =>
        ctx.webServer.register({ kind: 'exact', path, handler })

      disposers.push(
        route(CARD_JS, (req, res) => {
          try {
            const body = fs.readFileSync(CARD_JS_PATH, 'utf8')
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(body)
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(`card.js 读取失败: ${error?.message ?? error}`)
          }
        }),
      )

      disposers.push(
        route(`${API}/pending.json`, (req, res) => {
          if (!fence(req, res)) return
          lastPollAt = Date.now()
          const items = []
          for (const entry of pending.values()) {
            items.push({
              key: entry.key,
              title: entry.title,
              sessionId: entry.sessionId,
              ts: entry.ts,
              questions: entry.questions,
            })
          }
          sendJson(res, 200, { ok: true, items })
        }),
      )

      disposers.push(
        route(`${API}/answer`, async (req, res) => {
          if (!fence(req, res)) return
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' })
          const body = await readBody(req)
          if (!body || typeof body.key !== 'string') return sendJson(res, 400, { ok: false, error: 'bad-body' })
          const answers = Array.isArray(body.answers)
            ? body.answers
                .filter((answer) => answer && typeof answer === 'object')
                .map((answer) => {
                  const item = { id: String(answer.id ?? ''), selected: [] }
                  if (Array.isArray(answer.selected)) {
                    item.selected = answer.selected.filter((value) => typeof value === 'string' && value)
                  }
                  if (typeof answer.custom === 'string' && answer.custom.trim()) item.custom = answer.custom
                  return item
                })
            : []
          sendJson(res, 200, respond(body.key, answers))
        }),
      )

      disposers.push(
        route(`${API}/delegate`, async (req, res) => {
          if (!fence(req, res)) return
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' })
          const body = await readBody(req)
          if (!body || typeof body.key !== 'string') return sendJson(res, 400, { ok: false, error: 'bad-body' })
          sendJson(res, 200, delegate(body.key, 'user-request'))
        }),
      )

      disposers.push(
        route(`${API}/diag`, async (req, res) => {
          if (!fence(req, res)) return
          const body = await readBody(req)
          diag(`[client] ${typeof body?.message === 'string' ? body.message : JSON.stringify(body)}`)
          sendJson(res, 200, { ok: true })
        }),
      )

      diag(`apply: 路由已注册（pending=${pending.size}）`)
    })
  },
}
