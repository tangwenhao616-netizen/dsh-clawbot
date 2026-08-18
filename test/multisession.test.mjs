/**
 * 多会话改造测试：映射迁移、斜杠命令（/new /list /use /model /rename /del /help）、
 * 多会话并发收集、per-user 串行派发。
 *
 * 运行：node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinChannel } from '../src/index.mjs'
import { migrateSessionMap } from '../src/creds.mjs'

const FROM = 'wechat-user-1@im.wechat'
const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeStore(initial = {}) {
  const saved = []
  return {
    saved,
    loadCredentials: () => null,
    loadSessionMap: () => migrateSessionMap(initial),
    loadBuf: () => '',
    saveBuf: () => {},
    saveSessionMap: (m) => saved.push(JSON.parse(JSON.stringify(m))),
    saveCredentials: () => {},
  }
}

/** 假 agents 注册表：create/resume 记录调用并返回假 agent/handle。 */
function makeAgents() {
  const live = new Map()
  const calls = []
  return {
    live,
    calls,
    get: (id) => live.get(id),
    create: async (opts) => {
      calls.push({ kind: 'create', opts })
      const agent = { id: opts.sessionId, options: opts.agentOptions ?? {}, followup: () => {}, session: { id: opts.sessionId } }
      live.set(agent.id, agent)
      return { agent, dispose: async () => { live.delete(agent.id) } }
    },
    resume: async (opts) => {
      calls.push({ kind: 'resume', opts })
      const agent = { id: opts.resumeSessionId, options: opts.agentOptions ?? {}, followup: () => {}, session: { id: opts.resumeSessionId } }
      live.set(agent.id, agent)
      return { agent, dispose: async () => { live.delete(agent.id) } }
    },
  }
}

function makeChannel({ store, agents, llm } = {}) {
  const cfg = { cwd: '/tmp', stateDir: '', replyMode: 'full', replyTimeoutMs: 60_000, maxChunk: 1500, sendIntervalMs: 0 }
  const ag = agents ?? makeAgents()
  const ctx = {
    on: () => {},
    logger: console,
    agents: ag,
    get: (name) => {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) }
      return undefined
    },
  }
  const ch = new WeixinChannel(ctx, cfg, store ?? makeStore())
  const sent = []
  ch.sendReply = async (to, contextToken, text) => { sent.push({ to, text }); return true }
  ch.sent = sent
  return { ch, ag }
}

/* ------------------------------ 映射迁移 ------------------------------ */

test('migrateSessionMap：旧版 1:1 映射自动升级为多会话结构', () => {
  const { map, migrated } = migrateSessionMap({ 'u@im.wechat': 'session-old-1' })
  assert.equal(migrated, true)
  assert.equal(map['u@im.wechat'].active, 'session-old-1')
  assert.equal(map['u@im.wechat'].sessions.length, 1)
  assert.equal(map['u@im.wechat'].sessions[0].id, 'session-old-1')
  assert.equal(map['u@im.wechat'].sessions[0].name, '默认')
  assert.equal(map['u@im.wechat'].sessions[0].provider, null)
})

test('migrateSessionMap：新格式原样保留，垃圾条目丢弃', () => {
  const good = { active: 's1', sessions: [{ id: 's1', name: '工作' }] }
  const { map, migrated } = migrateSessionMap({ a: good, b: 42 })
  assert.equal(migrated, true) // b 被丢弃算变更
  assert.deepEqual(map.a, good)
  assert.equal(map.b, undefined)
})

test('构造 channel 时旧格式映射被迁移并写回', () => {
  const store = makeStore({ 'u@im.wechat': 'session-legacy' })
  const { ch } = makeChannel({ store })
  assert.equal(ch.sessionMap['u@im.wechat'].active, 'session-legacy')
  assert.equal(store.saved.length, 1) // 迁移后立刻写回
})

/* ------------------------------ 命令 ------------------------------ */

test('/help 回复命令帮助', async () => {
  const { ch } = makeChannel()
  assert.equal(await ch.handleCommand(FROM, 'tok', '/help'), true)
  assert.match(ch.sent[0].text, /\/new/)
  assert.match(ch.sent[0].text, /\/model/)
})

test('/new 创建会话并设为当前，名称取参数或自动编号', async () => {
  const { ch, ag } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 工作')
  const rec = ch.sessionMap[FROM]
  assert.equal(rec.sessions.length, 1)
  assert.equal(rec.sessions[0].name, '工作')
  assert.equal(rec.active, rec.sessions[0].id)
  assert.equal(ag.calls[0].kind, 'create')
  assert.match(ch.sent[0].text, /工作/)

  await ch.handleCommand(FROM, 'tok', '/new')
  assert.equal(ch.sessionMap[FROM].sessions.length, 2)
  assert.equal(ch.sessionMap[FROM].sessions[1].name, '会话 2')
  assert.equal(ch.sessionMap[FROM].active, ch.sessionMap[FROM].sessions[1].id)
})

test('/list 列出会话并标记当前', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  await ch.handleCommand(FROM, 'tok', '/new 乙')
  ch.sent.length = 0
  await ch.handleCommand(FROM, 'tok', '/list')
  const text = ch.sent[0].text
  assert.match(text, /1\. 甲/)
  assert.match(text, /✅ 2\. 乙/) // 后建的是当前
})

test('/use 切换会话，无效编号提示', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  await ch.handleCommand(FROM, 'tok', '/new 乙')
  const idA = ch.sessionMap[FROM].sessions[0].id
  await ch.handleCommand(FROM, 'tok', '/use 1')
  assert.equal(ch.sessionMap[FROM].active, idA)
  assert.match(ch.sent.at(-1).text, /甲/)

  await ch.handleCommand(FROM, 'tok', '/use 99')
  assert.match(ch.sent.at(-1).text, /编号无效/)
})

test('/model 无参列出模型；/model n 切换当前会话模型并写入映射', async () => {
  const llm = {
    listProviders: () => ['p1', 'p2'],
    listModels: async (p) => (p === 'p1' ? [{ id: 'm-a' }, { id: 'm-b' }] : ['m-c']),
  }
  const { ch } = makeChannel({ llm })
  await ch.handleCommand(FROM, 'tok', '/new 工作')
  ch.sent.length = 0

  await ch.handleCommand(FROM, 'tok', '/model')
  assert.match(ch.sent[0].text, /1\. p1\/m-a/)
  assert.match(ch.sent[0].text, /3\. p2\/m-c/)

  await ch.handleCommand(FROM, 'tok', '/model 2')
  const entry = ch.sessionMap[FROM].sessions[0]
  assert.equal(entry.provider, 'p1')
  assert.equal(entry.model, 'm-b')
  // live 会话的模型选择 ref 同步更新
  assert.deepEqual(ch.modelSelections.get(entry.id).current, { provider: 'p1', model: 'm-b' })
  assert.match(ch.sent.at(-1).text, /p1\/m-b/)

  // 列表里当前模型打 ✅
  ch.sent.length = 0
  await ch.handleCommand(FROM, 'tok', '/model')
  assert.match(ch.sent[0].text, /✅ 2\. p1\/m-b/)

  await ch.handleCommand(FROM, 'tok', '/model 99')
  assert.match(ch.sent.at(-1).text, /编号无效/)
})

test('/rename 重命名当前会话', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 旧名')
  await ch.handleCommand(FROM, 'tok', '/rename 新名')
  assert.equal(ch.sessionMap[FROM].sessions[0].name, '新名')
  assert.match(ch.sent.at(-1).text, /新名/)
})

test('/del 删除会话：dispose、映射移除、active 转移到下一个', async () => {
  const { ch, ag } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  await ch.handleCommand(FROM, 'tok', '/new 乙')
  const [a, b] = ch.sessionMap[FROM].sessions
  assert.equal(ag.live.has(b.id), true)

  await ch.handleCommand(FROM, 'tok', '/del 2') // 删当前（乙）
  assert.equal(ch.sessionMap[FROM].sessions.length, 1)
  assert.equal(ch.sessionMap[FROM].active, a.id)
  assert.equal(ag.live.has(b.id), false) // dispose 生效
  assert.match(ch.sent.at(-1).text, /已删除「乙」/)

  await ch.handleCommand(FROM, 'tok', '/del 1') // 删光 → 用户记录清除
  assert.equal(ch.sessionMap[FROM], undefined)
})

test('未知斜杠命令不吞消息（返回 false 走普通消息）', async () => {
  const { ch } = makeChannel()
  assert.equal(await ch.handleCommand(FROM, 'tok', '/今天天气如何'), false)
  assert.equal(ch.sent.length, 0)
})

/* ------------------------------ 多会话并发 ------------------------------ */

test('多会话并发：两个会话的回复各自收集、互不干扰', async () => {
  const { ch } = makeChannel()
  const mk = (msgId, sessionId) => ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId, resolve: () => {}, timer: null })
  mk('msg-1', 'session-A')
  mk('msg-2', 'session-B')

  ch.handleSessionEvent({ id: 'session-A' }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: 'session-B' }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: 'session-A' }, { type: 'user/message', data: { id: 'msg-1' } })
  ch.handleSessionEvent({ id: 'session-B' }, { type: 'user/message', data: { id: 'msg-2' } })
  // 交错到达：A 的中间消息、B 的完整回复、A 的最终回复
  ch.handleSessionEvent({ id: 'session-A' }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'A-中' }] } } })
  ch.handleSessionEvent({ id: 'session-B' }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'B-复' }] } } })
  ch.handleSessionEvent({ id: 'session-A' }, { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'A-终' }] } } })
  ch.handleSessionEvent({ id: 'session-B' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ch.handleSessionEvent({ id: 'session-A' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 2)
  const texts = ch.sent.map((s) => s.text).sort()
  assert.deepEqual(texts, ['A-中\nA-终', 'B-复'])
  assert.equal(ch.collectors.size, 0)
})

test('dispatchInbound：同一用户消息串行，异常不影响后续', async () => {
  const { ch } = makeChannel()
  const order = []
  ch.handleInbound = async (msg) => {
    if (msg.text === 'boom') throw new Error('炸')
    order.push(msg.text)
    await tick()
  }
  ch.dispatchInbound({ from: FROM, text: '一' })
  ch.dispatchInbound({ from: FROM, text: 'boom' })
  ch.dispatchInbound({ from: FROM, text: '三' })
  await tick(); await tick(); await tick(); await tick()
  assert.deepEqual(order, ['一', '三']) // 串行保序，异常被吞并继续
})

test('per-session 模型记忆：resume 时带映射里的模型', async () => {
  const { ch, ag } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 工作')
  const entry = ch.sessionMap[FROM].sessions[0]
  entry.provider = 'p-x'
  entry.model = 'm-x'
  ag.live.delete(entry.id) // 模拟未加载

  await ch.ensureAgentFor(FROM)
  const resumeCall = ag.calls.find((c) => c.kind === 'resume')
  assert.deepEqual(resumeCall.opts.agentOptions, { provider: 'p-x', model: 'm-x' })
})

/* ------------------------------ 快捷交互（/# 定向、中文关键词、会话标记） ------------------------------ */

test('/数字 快捷切换会话', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  await ch.handleCommand(FROM, 'tok', '/new 乙')
  const idA = ch.sessionMap[FROM].sessions[0].id

  assert.equal(await ch.handleCommand(FROM, 'tok', '/1'), true)
  assert.equal(ch.sessionMap[FROM].active, idA)
  assert.match(ch.sent.at(-1).text, /甲/)

  assert.equal(await ch.handleCommand(FROM, 'tok', '/99'), true)
  assert.match(ch.sent.at(-1).text, /编号无效/)
})

test('#名称 定向：仅切换（无内容时）', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  await ch.handleCommand(FROM, 'tok', '/new 乙')
  const idA = ch.sessionMap[FROM].sessions[0].id

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '#甲' })
  assert.equal(ch.sessionMap[FROM].active, idA)
  assert.match(ch.sent.at(-1).text, /已切换到「甲」/)
})

test('#编号 内容 定向发言：切到目标会话并把内容送入该会话', async () => {
  const { ch, ag } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  await ch.handleCommand(FROM, 'tok', '/new 乙')
  const idA = ch.sessionMap[FROM].sessions[0].id

  const followed = []
  const ch2 = ch
  // 打桩：followup 记录消息去哪个 agent，并立即 resolve 让 handleInbound 返回
  for (const agent of ag.live.values()) {
    agent.followup = function (m) { followed.push(this.id); const p = ch2.pending.get(m.id); p?.resolve() }
  }
  ch2.getTypingTicket = async () => '' // 跳过 typing 网络调用
  await ch2.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: `#1 你好甲` })
  assert.equal(ch2.sessionMap[FROM].active, idA)
  assert.deepEqual(followed, [idA]) // 消息进了 1 号会话
  // pending 里记录的是 1 号会话
  const pend = [...ch2.pending.values()][0]
  assert.equal(pend.sessionId, idA)
  pend.resolve() // 收尾，避免悬挂
})

test('# 后匹配不到会话时按普通消息处理（不误吞）', async () => {
  const { ch, ag } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  ch.getTypingTicket = async () => ''
  const followed = []
  for (const agent of ag.live.values()) agent.followup = function (m) { followed.push(this.id); const p = ch.pending.get(m.id); p?.resolve() }
  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '#不存在的话题 你好' })
  assert.equal(followed.length, 1) // 整条按普通消息进了当前会话
  const pend = [...ch.pending.values()][0]
  pend?.resolve()
})

test('中文关键词：「列表」「帮助」「模型」精确匹配触发命令', async () => {
  const llm = { listProviders: () => ['p1'], listModels: async () => [{ id: 'm-a' }] }
  const { ch } = makeChannel({ llm })
  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '帮助' })
  assert.match(ch.sent.at(-1).text, /\/new/)
  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '列表' })
  assert.match(ch.sent.at(-1).text, /我的会话|还没有会话/)
  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '模型' })
  assert.match(ch.sent.at(-1).text, /可用模型/)
})

test('中文关键词只精确匹配，非精确按普通消息走', async () => {
  const { ch } = makeChannel({ replyTimeoutMs: 50 })
  await ch.handleCommand(FROM, 'tok', '/new 甲')
  ch.getTypingTicket = async () => ''
  ch.dispatchInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '帮我看看列表怎么办' })
  await sleep(120)
  const text = ch.sent.map((s) => s.text).join('\n')
  assert.doesNotMatch(text, /我的会话/)
  assert.doesNotMatch(text, /可用模型/)
})

test('回复末尾带会话标记，/tag off 可关闭', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 工作')
  const entry = ch.sessionMap[FROM].sessions[0]
  entry.provider = 'kimi-coding'
  entry.model = 'k3'

  assert.equal(ch.sessionTagFor(entry.id), '\n——💬「工作」· kimi-coding/k3')
  await ch.handleCommand(FROM, 'tok', '/tag off')
  assert.equal(ch.sessionTagFor(entry.id), '')
  await ch.handleCommand(FROM, 'tok', '/tag on')
  assert.match(ch.sessionTagFor(entry.id), /工作/)
})

test('turn/end 回复拼上会话标记', async () => {
  const { ch } = makeChannel()
  await ch.handleCommand(FROM, 'tok', '/new 工作')
  const entry = ch.sessionMap[FROM].sessions[0]
  ch.pending.set('msg-t', { from: FROM, contextToken: 'tok', sessionId: entry.id, resolve: () => {}, timer: null })
  ch.handleSessionEvent({ id: entry.id }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: entry.id }, { type: 'user/message', data: { id: 'msg-t' } })
  ch.handleSessionEvent({ id: entry.id }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好' }] } } })
  ch.handleSessionEvent({ id: entry.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.match(ch.sent.at(-1).text, /你好\n——💬「工作」· 默认模型/)
})
