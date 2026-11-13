/**
 * session-organizer — host half
 *
 * A resident (persistent) dsh web profile plugin that organizes sessions:
 *   - scan: cluster same-topic sessions (project-name primary key, title-prefix
 *     secondary, content-token overlap fallback), flag stale (>30d inactive,
 *     not live) and meaningless (no content / no assistant reply) sessions;
 *   - archive: archive one or many sessions (workspaceRegistry.archiveSession);
 *   - merge: synthesize one clean transcript-level session from several source
 *     sessions (one turn/start → per-source user/message + assistant/message →
 *     turn/end), optionally archiving the sources;
 *   - cleanup: batch archive; peek: read a session's title + first user message.
 *
 * The model tool `session_organizer` is registered globally through the host
 * `tools` service (via @deepseek-ai/dsh-tools defineTool), so every agent can
 * call it. The client half (lib/client.js) talks to this host half over the
 * fenced /session-organizer/api JSON API — NOT through harness.handle/host.call,
 * which are session-plugin primitives unavailable to a resident bundle.
 *
 * All services reached here are host-plane rows of dsh-base: sessionQuery
 * (@deepseek-ai/dsh-session-query), workspaceRegistry, sessions
 * (@deepseek-ai/dsh-session), tools (@deepseek-ai/dsh-tools), webServer.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'session-organizer'

const APP_PREFIX = '/session-organizer/api'
const MAX_BODY_BYTES = 2 * 1024 * 1024

// ── HTTP helpers (fence + JSON body/response), ported from chicheng-cron ───

class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(payload)
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const hosts = Array.isArray(trustedHosts) ? trustedHosts : []
  const trusted = hosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return entryUrl.hostname === hostUrl.hostname && (entryUrl.port === '' || entryUrl.port === hostUrl.port)
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── core organizer logic (ported verbatim from dynamic plugin pkg-13) ───────

function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + ' '
  }
  return out.trim()
}

function tokens(text) {
  const set = new Set()
  const s = String(text || '')
  const latin = s.match(/[A-Za-z0-9_]{3,}/g)
  if (latin) for (const w of latin) set.add('L:' + w.toLowerCase())
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g)
  if (cjk) for (const w of cjk) {
    for (let i = 0; i + 2 <= w.length; i++) set.add('C:' + w.slice(i, i + 2))
  }
  return set
}

function countEvents(evts) {
  const c = { total: evts.length, user: 0, assistant: 0, tool: 0, error: 0 }
  for (const e of evts) {
    if (e.type === 'user/message') c.user++
    else if (e.type === 'assistant/message') c.assistant++
    else if (e.type === 'tool/call') c.tool++
    else if (e.type === 'turn/end' && e.data && e.data.reason && e.data.reason.kind === 'error') c.error++
  }
  return c
}

function firstUserText(evts) {
  for (const e of evts) {
    if (e.type === 'user/message' && e.data) {
      const t = textOf(e.data.content)
      if (t) return t.slice(0, 400)
    }
  }
  return ''
}

function topicText(evts, title, origin) {
  const parts = []
  if (title) parts.push(title)
  if (origin) parts.push(origin)
  let userN = 0, asstN = 0
  for (const e of evts) {
    if (userN >= 3 && asstN >= 2) break
    if (e.type === 'user/message' && userN < 3 && e.data) {
      const t = textOf(e.data.content)
      if (t) { parts.push(t.slice(0, 300)); userN++ }
    } else if (e.type === 'assistant/message' && asstN < 2 && e.data && e.data.message) {
      const t = textOf(e.data.message.content)
      if (t) { parts.push(t.slice(0, 200)); asstN++ }
    }
  }
  return parts.join(' ')
}

function titleKey(title) {
  const s = String(title || '').trim().replace(/[\[\]【】()（）:：\-_]/g, ' ').toLowerCase()
  return s.slice(0, 12)
}

// 从内容中提取项目名（cron 样板里的“你是 X 项目”），允许项目名含空格
function extractProject(topic) {
  const s = String(topic || '')
  const m1 = s.match(/你是\s*([^，。、；：\n（(]{2,80}?)\s*[（(][^）)]{0,120}[）)]\s*项目/)
  if (m1) return m1[1].trim()
  const m2 = s.match(/你是\s*([^，。、；：\n（(]{2,80}?)\s*项目/)
  if (m2) return m2[1].trim()
  const m3 = s.match(/([^，。、；：()（）\n]{2,40})项目/)
  if (m3) return m3[1].trim()
  return ''
}

export function apply(ctx) {
  ctx.inject(['webServer', 'tools', 'sessionQuery', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'sessionProjectionCache'], (scoped) => {
    const server = scoped.webServer
    const sessionQuery = scoped.sessionQuery
    const workspaceRegistry = scoped.workspaceRegistry
    const sessions = scoped.sessions
    const sessionPersistence = scoped.sessionPersistence
    const sessionProjectionCache = scoped.sessionProjectionCache
    const tools = scoped.tools

    const STALE_MS = 30 * 24 * 3600 * 1000

    async function readFullEvents(id) {
      try {
        const snap = await sessionQuery.readSession(id)
        if (snap && Array.isArray(snap.events)) return snap.events
      } catch (e) {}
      try {
        const recs = await sessionQuery.listEvents(id)
        if (Array.isArray(recs)) return recs
      } catch (e) {}
      return []
    }

    async function buildScan() {
      const records = await sessionQuery.listSessions()
      const ids = records.map((r) => r.header.id)
      let archivedIds = new Set()
      try {
        const st = workspaceRegistry.requireState()
        if (st && Array.isArray(st.archivedSessionIds)) archivedIds = new Set(st.archivedSessionIds)
      } catch (e) {}
      const titleById = new Map()
      try {
        const obs = await sessionQuery.readTitleSnapshots(ids)
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i]
          const snap = o && o.status === 'fulfilled' ? o.value : (o && o.title ? o : null)
          if (snap && snap.title && snap.title.title) titleById.set(ids[i], snap.title.title)
        }
      } catch (e) {}

      const now = Date.now()
      const items = []
      for (const rec of records) {
        const id = rec.header.id
        const evts = await readFullEvents(id)
        const counts = countEvents(evts)
        const lastActive = evts.length ? evts[evts.length - 1].time : rec.header.createdAt
        const firstUser = firstUserText(evts)
        const title = titleById.get(id) || ''
        const origin = rec.header.origin || null
        const topic = topicText(evts, title, origin)
        items.push({
          id, title, createdAt: rec.header.createdAt, lastActive,
          live: !!rec.live, persisted: !!rec.persisted, origin,
          archived: archivedIds.has(id),
          firstUser, counts, topic,
          project: extractProject(topic),
        })
      }

      const stale = items.filter((it) => !it.live && (now - it.lastActive) > STALE_MS)

      // 先聚类（含聚类内会话集合），再过滤无实质内容，避免已聚类会话被重复标记
      const clusterable = items.filter((it) => it.origin !== 'subagent')
      const parent = new Map()
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
      const tok = new Map()
      const tkey = new Map()
      const proj = new Map()
      for (const it of clusterable) { parent.set(it.id, it.id); tok.set(it.id, tokens(it.topic)); tkey.set(it.id, titleKey(it.title)); proj.set(it.id, it.project) }
      const idList = clusterable.map((it) => it.id)
      for (let i = 0; i < idList.length; i++) for (let j = i + 1; j < idList.length; j++) {
        const a = tok.get(idList[i]), b = tok.get(idList[j])
        const pA = proj.get(idList[i]), pB = proj.get(idList[j])
        // 项目名相同 → 直接同组
        if (pA && pB && pA === pB) { union(idList[i], idList[j]); continue }
        // 项目名不同 → 明确不同项目，禁止用兜底并组（避免 cron 样板 token 跨项目桥接）
        if (pA && pB && pA !== pB) continue
        // 次键：标题前缀相同
        const tkA = tkey.get(idList[i]), tkB = tkey.get(idList[j])
        const sameTitle = tkA.length >= 4 && tkA === tkB
        if (sameTitle) { union(idList[i], idList[j]); continue }
        // 兜底：内容 token 重叠
        let shared = 0
        for (const t of a) { if (b.has(t)) shared++ }
        const unionN = a.size + b.size - shared
        const jac = unionN ? shared / unionN : 0
        if (shared >= 3 && jac >= 0.2) union(idList[i], idList[j])
      }
      const groups = new Map()
      for (const it of clusterable) {
        const r = find(it.id)
        if (!groups.has(r)) groups.set(r, [])
        groups.get(r).push(it)
      }
      const clusters = []
      const clusteredIds = new Set()
      for (const members of groups.values()) {
        if (members.length < 2) continue
        members.sort((a, b) => b.lastActive - a.lastActive)
        const primary = members[0]
        const label = primary.project || primary.title || primary.firstUser.slice(0, 24) || ('会话 ' + primary.id)
        for (const m of members) clusteredIds.add(m.id)
        clusters.push({
          key: primary.id, label,
          members: members.map((m) => ({ id: m.id, title: m.title, createdAt: m.createdAt, lastActive: m.lastActive, live: m.live, archived: m.archived, counts: m.counts, firstUser: m.firstUser.slice(0, 120), project: m.project })),
        })
      }

      // 无实质内容：排除已聚类会话（有真实内容）
      const meaningless = items.filter((it) =>
        !clusteredIds.has(it.id) &&
        (it.counts.total === 0 || it.counts.assistant === 0 || (it.counts.user === 0 && !it.title)))

      return {
        scannedAt: now, total: items.length, archivedCount: archivedIds.size,
        stale: stale.map((m) => ({ id: m.id, title: m.title, lastActive: m.lastActive, live: m.live, archived: m.archived, counts: m.counts, firstUser: m.firstUser.slice(0, 120) })),
        meaningless: meaningless.map((m) => ({ id: m.id, title: m.title, lastActive: m.lastActive, live: m.live, archived: m.archived, counts: m.counts, firstUser: m.firstUser.slice(0, 120) })),
        clusters,
      }
    }

    async function archiveMany(sessionIds) {
      const done = [], failed = []
      for (const id of sessionIds) {
        try { await workspaceRegistry.archiveSession(id); done.push(id) }
        catch (e) { failed.push({ id, error: e && e.message ? e.message : String(e) }) }
      }
      return { done, failed }
    }

    function buildMessage(id, role, text, source) {
      return { role, id, content: [{ type: 'text', text }], source }
    }

    // Mint a `session-<n>` id that collides with NEITHER a persisted artifact
    // NOR a live session. The SessionStore's own counter restarts at 0 every
    // boot, so a fresh process mints `session-1`/`session-2` again even though
    // previous merges already persisted those ids — the resulting live session
    // then fails to flush (createCore rejects "already has a persisted log")
    // and its stale live copy poisons every later sessionQuery.listSessions()
    // reconciliation (SESSION_QUERY_SOURCE_CONFLICT). Enumerating the used ids
    // directly from persistence + the live store sidesteps the mint collision.
    async function mintMergeSessionId() {
      const used = new Set()
      try {
        const persisted = await sessionPersistence.list()
        for (const header of persisted) used.add(header.id)
      } catch (e) {}
      for (const s of sessions.list()) used.add(s.id)
      let n = 1
      while (used.has(`session-${n}`)) n++
      return `session-${n}`
    }

    async function mergeSessions(sessionIds, archiveSource, targetId) {
      const parts = []
      for (const id of sessionIds) {
        let title = ''
        try { const o = await sessionQuery.readTitleSnapshot(id); if (o && o.title && o.title.title) title = o.title.title } catch (e) {}
        const evts = await readFullEvents(id)
        const userTxt = firstUserText(evts)
        let lastAssistant = ''
        for (let i = evts.length - 1; i >= 0; i--) {
          const e = evts[i]
          if (e.type === 'assistant/message' && e.data && e.data.message) {
            lastAssistant = textOf(e.data.message.content).slice(0, 400)
            break
          }
        }
        parts.push({ id, title: title || userTxt.slice(0, 30) || id, user: userTxt.slice(0, 300), assistant: lastAssistant })
      }

      // Build a structurally-valid transcript: one turn per merged part, turn
      // numbering starting at 1 (real dsh turns are 1-based; the persistence
      // migration rejects turn/end with turn < 1 as a malformed pre-react-loop
      // shape, which would make the merged session unreadable via strict reads).
      const transcript = []
      let msgIdx = 0
      let turn = 0
      for (const p of parts) {
        turn++
        const head = '【合并 ' + p.title + '】' + (p.user ? '\n' + p.user : '')
        transcript.push({ type: 'turn/start', time: Date.now(), data: { turn } })
        transcript.push({ type: 'user/message', time: Date.now(), data: buildMessage('merge-u-' + (++msgIdx), 'user', head, { kind: 'user' }), surfaceOp: 'append' })
        transcript.push({ type: 'assistant/message', time: Date.now(), data: { turn, step: 0, message: buildMessage('merge-a-' + (++msgIdx), 'assistant', p.assistant || '（该会话无助手回复）', { kind: 'model', provider: 'merged', model: 'merged' }) }, surfaceOp: 'append' })
        transcript.push({ type: 'turn/end', time: Date.now(), data: { turn, reason: { kind: 'completed' } } })
      }

      // Merge INTO an existing session when a target is chosen: append the
      // transcript as fresh turns continuing the target's seq, so the merged
      // content lands inside the chosen conversation instead of a new one.
      if (targetId) {
        if (sessionIds.includes(targetId)) {
          throw new Error('目标会话不能是待合并会话之一')
        }
        if (sessions.get(targetId) !== undefined) {
          throw new Error('目标会话当前是活动会话，无法合并进去（请先关闭该会话）')
        }
        const current = await sessionPersistence.readFrom(targetId, 0)
        const events = current.events
        let seq = 0
        for (const e of events) seq = Math.max(seq, e.seq + 1)
        const lastTurn = events.reduce((m, e) => {
          if (e.type === 'turn/start' && typeof e.data?.turn === 'number') return Math.max(m, e.data.turn)
          return m
        }, 0)
        const appendEvents = []
        for (const ev of transcript) {
          appendEvents.push({ ...ev, seq: seq++ })
        }
        // Rewrite turn numbers continuing from the target's last turn, and fix
        // per-turn numbering inside the appended transcript.
        let baseTurn = lastTurn
        let curTurn = 0
        for (const ev of appendEvents) {
          if (ev.type === 'turn/start') {
            curTurn++
            ev.data = { ...ev.data, turn: baseTurn + curTurn }
          } else if (ev.type === 'turn/end') {
            ev.data = { ...ev.data, turn: baseTurn + curTurn }
          }
        }
        await sessionPersistence.append(targetId, appendEvents)
        return { mergedId: targetId, parts, archived: { done: [], failed: [] } }
      }

      const mergedId = await mintMergeSessionId()
      let seq = 0
      const seed = transcript.map((ev) => ({ ...ev, seq: seq++ }))
      const merged = sessions.create(mergedId, {
        meta: { parentSession: parts[0] ? parts[0].id : undefined, origin: 'subagent' },
        seed,
      })
      try { await sessions.flush(merged) } catch (e) {}

      let archived = { done: [], failed: [] }
      if (archiveSource) archived = await archiveMany(sessionIds)
      return { mergedId: merged.id, parts, archived }
    }

    async function peekSessions(ids) {
      const peeks = []
      for (const id of ids) {
        let title = '', evts = []
        try { const o = await sessionQuery.readTitleSnapshot(id); if (o && o.title && o.title.title) title = o.title.title } catch (e) {}
        evts = await readFullEvents(id)
        peeks.push({ id, title, firstUser: firstUserText(evts).slice(0, 200), counts: countEvents(evts) })
      }
      return peeks
    }

    // ── fenced JSON API: POST /session-organizer/api/<method> ──────────────
    const fence = (req) => {
      let hosts = []
      try {
        hosts = scoped.webRuntime?.trustedHosts ?? []
      } catch {
        // webRuntime may be absent (0.2.x removed the service) or uninjectable;
        // a getter that throws on uninjected access must degrade to empty.
        hosts = []
      }
      try {
        return isTrustedApiRequest(req, hosts)
      } catch {
        return false
      }
    }

    async function dispatch(method, payload) {
      switch (method) {
        case 'scan':
          return { report: await buildScan() }
        case 'archive':
        case 'cleanup': {
          const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds : []
          return await archiveMany(ids)
        }
        case 'merge': {
          const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds : []
          if (!ids.length) throw new ApiError('bad-request', 'no sessions to merge')
          const targetId = typeof payload?.targetId === 'string' && payload.targetId ? payload.targetId : undefined
          const r = await mergeSessions(ids, !!payload?.archiveSource, targetId)
          return { mergedId: r.mergedId, parts: r.parts.length, archived: r.archived }
        }
        case 'targets': {
          // List mergeable target sessions (persisted, not live) for the UI dropdown.
          const ids = new Set()
          for (const h of await sessionPersistence.list()) ids.add(h.id)
          for (const s of sessions.list()) ids.delete(s.id)
          const targets = []
          for (const id of ids) {
            try {
              const o = await sessionQuery.readTitleSnapshot(id)
              const title = (o && o.title && o.title.title) ? o.title.title : id
              targets.push({ id, title })
            } catch (e) { targets.push({ id, title: id }) }
          }
          targets.sort((a, b) => a.title.localeCompare(b.title))
          return { targets }
        }
        case 'peek': {
          const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds : []
          return { peeks: await peekSessions(ids) }
        }
        default:
          throw new ApiError('not-found', `unknown session-organizer API method "${method}"`, 404)
      }
    }

    scoped.effect(() => server.register({
      kind: 'prefix',
      path: APP_PREFIX,
      handler: async (req, res) => {
        if (!fence(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://session-organizer.invalid').pathname
        const method = pathname.startsWith(APP_PREFIX + '/') ? pathname.slice(APP_PREFIX.length + 1) : undefined
        if (method === undefined || method === '' || method.includes('/')) {
          writeError(res, new ApiError('not-found', 'unknown session-organizer API method', 404))
          return
        }
        try {
          const payload = await readJsonBody(req)
          writeOk(res, await dispatch(method, payload))
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'session-organizer: /session-organizer/api routes')

    // ── model tool: session_organizer (global, via host tools service) ─────
    const toolDef = defineTool({
      name: 'session_organizer',
      description: '智能整理会话：扫描并聚类同主题会话、识别长期未用/无实质内容会话、归档或合并。action=scan 扫描；action=archive 归档指定 sessionIds；action=merge 合并指定 sessionIds（archiveSource=true 时归档原会话）；action=cleanup 批量归档；action=peek 查看指定会话详情。',
      parameters: {
        action: { type: 'string', required: true, description: '操作：scan | archive | merge | cleanup | peek | refix' },
        sessionIds: { type: 'array', items: { type: 'string' }, description: '目标会话 id 列表（archive/merge/cleanup/peek/refix 用）' },
        archiveSource: { type: 'boolean', description: 'merge 时是否同时归档源会话' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: function (args, value) {
          const v = value || {}
          const out = []
          if (v.report) {
            const rep = v.report
            out.push({ type: 'text', text: '扫描完成：共 ' + rep.total + ' 个会话；长期未用 ' + (rep.stale ? rep.stale.length : 0) + '；无实质内容 ' + (rep.meaningless ? rep.meaningless.length : 0) + '；同主题分组 ' + (rep.clusters ? rep.clusters.length : 0) })
            if (rep.clusters && rep.clusters.length) {
              for (const c of rep.clusters) {
                out.push({ type: 'text', text: '【同主题】' + c.label + '（' + c.members.length + ' 个）' })
                for (const m of c.members) {
                  out.push({ type: 'text', text: '  - ' + m.id + '  ' + (m.title || m.project || '(无标题)') })
                }
              }
            }
            if (rep.stale && rep.stale.length) {
              out.push({ type: 'text', text: '【长期未用】' })
              for (const m of rep.stale) out.push({ type: 'text', text: '  - ' + m.id + '  ' + (m.title || '(无标题)') })
            }
            if (rep.meaningless && rep.meaningless.length) {
              out.push({ type: 'text', text: '【无实质内容】' })
              for (const m of rep.meaningless) out.push({ type: 'text', text: '  - ' + m.id + '  ' + (m.title || '(无标题)') })
            }
            return out
          }
          if (v.peeks && v.peeks.length) {
            for (const p of v.peeks) {
              out.push({ type: 'text', text: '会话 ' + p.id + '  标题：' + (p.title || '(无标题)') + '  首条：' + (p.firstUser || '(空)') })
            }
            return out
          }
          if (v.mergedId) return [{ type: 'text', text: '已合并为会话 ' + v.mergedId + '；归档源 ' + ((v.archived && v.archived.done) ? v.archived.done.length : 0) + ' 个' }]
          if (v.done && v.failed) {
            // refix / unarchive results carry {done:[{id,...}], failed:[{id,error}]}
            const label = v.label || '操作'
            const text = label + '成功 ' + v.done.length + ' 个' + ((v.failed.length) ? ('；失败 ' + v.failed.length) : '')
            if (v.failed.length) out.push({ type: 'text', text: text + '（' + v.failed.map((f) => f.id + ': ' + f.error).join('; ') + '）' })
            else out.push({ type: 'text', text: text })
            return out
          }
          if (v.done) return [{ type: 'text', text: '已归档 ' + v.done.length + ' 个会话' + ((v.failed && v.failed.length) ? ('；失败 ' + v.failed.length) : '') }]
          return [{ type: 'text', text: JSON.stringify(v) }]
        },
      },
      execute: async function (args) {
        const action = args && args.action
        if (action === 'scan') {
          try { return { ok: true, report: await buildScan() } }
          catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) } }
        }
        if (action === 'refix') {
          // Re-seed the projection cache for one cold session: coldSnapshot reads
          // the log tail, refolds, and durably writes back the corrected rows so
          // the sidebar shows its title (and other projection values).
          const ids = args && Array.isArray(args.sessionIds) ? args.sessionIds : []
          if (!ids.length) return { ok: false, error: 'no session ids given' }
          if (!sessionProjectionCache || !sessionProjectionCache.coldSnapshot) return { ok: false, error: 'sessionProjectionCache unavailable' }
          const done = []
          const failed = []
          for (const id of ids) {
            try {
              const snap = await sessionProjectionCache.coldSnapshot(id)
              done.push({ id, asOfSeq: snap ? snap.asOfSeq : null })
            } catch (e) { failed.push({ id, error: e && e.message ? e.message : String(e) }) }
          }
          return { ok: true, done, failed, label: '缓存修复（refix）' }
        }
        if (action === 'unarchive') {
          // Remove sessions from the archived set (workspaceRegistry has no
          // unarchive RPC, so call the service directly).
          const ids = args && Array.isArray(args.sessionIds) ? args.sessionIds : []
          if (!ids.length) return { ok: false, error: 'no session ids given' }
          const done = []
          const failed = []
          for (const id of ids) {
            try {
              const state = workspaceRegistry.requireState()
              if (state.archivedSessionIds.includes(id)) {
                await workspaceRegistry.setState({
                  ...state,
                  archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id)
                })
                done.push(id)
              } else done.push(id)
            } catch (e) { failed.push({ id, error: e && e.message ? e.message : String(e) }) }
          }
          return { ok: true, done, failed, label: '恢复归档（unarchive）' }
        }
        const ids = args && Array.isArray(args.sessionIds) ? args.sessionIds : []
        if (action === 'peek') {
          try { return { ok: true, peeks: await peekSessions(ids) } }
          catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) } }
        }
        if (action === 'merge') {
          if (!ids.length) return { ok: false, error: 'no sessions to merge' }
          try {
            const r = await mergeSessions(ids, !!(args && args.archiveSource))
            return { ok: true, mergedId: r.mergedId, parts: r.parts.length, archived: r.archived }
          } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) } }
        }
        try { return { ok: true, ...(await archiveMany(ids)) } }
        catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) } }
      },
    })
    scoped.effect(() => tools.register(toolDef), 'session-organizer: session_organizer tool')
  }, 'session-organizer: services')
}
