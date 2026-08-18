/**
 * 核心关联逻辑测试：不依赖真实微信，用合成 session 事件验证
 * pending 关联 → assistant/message 收集 → turn/end 结算 → sendReply。
 *
 * 运行：node --test（或 npm test）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { WeixinChannel, chunkText, registerPushTool } from '../src/index.mjs'
import { resolveWorkspaceDir } from '../src/creds.mjs'
import { normalizeInboundMessages, sniffImageMime, parseAesKey, downloadImageBytes } from '../src/ilink.mjs'

function makeStore() {
  return {
    loadCredentials: () => null,
    loadSessionMap: () => ({}),
    loadBuf: () => '',
    saveBuf: () => {},
    saveSessionMap: () => {},
    saveCredentials: () => {},
  }
}

function makeCtx() {
  return { on: () => {}, get: () => undefined, logger: console }
}

function makeChannel(config = {}) {
  const cfg = {
    cwd: '/tmp',
    stateDir: '',
    replyMode: 'full',
    replyTimeoutMs: 60_000,
    maxChunk: 1500,
    sendIntervalMs: 0,
    ...config,
  }
  const ch = new WeixinChannel(makeCtx(), cfg, makeStore())
  const sent = []
  ch.sendReply = async (to, contextToken, text) => { sent.push({ to, text }); return true }
  ch.sent = sent
  return ch
}

const FROM = 'wechat-user-1@im.wechat'
const SESSION = 'session-test-1'
const tick = () => new Promise((r) => setTimeout(r, 0))

test('整轮助手文本合并回复，并正确关联用户', async () => {
  const ch = makeChannel()
  const msgId = 'msg-1'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })

  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先查一下…' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '最终回复内容' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 1)
  assert.equal(ch.sent[0].to, FROM)
  assert.equal(ch.sent[0].text, '我先查一下…\n最终回复内容')
  assert.equal(ch.pending.has(msgId), false)
  assert.equal(ch.collectors.size, 0)
})

test('错误会话的事件不触发回复，也不清理 pending', async () => {
  const ch = makeChannel()
  const msgId = 'msg-2'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })

  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 2 } })
  ch.handleSessionEvent({ id: 'session-other' }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '不该发' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 0)
  assert.equal(ch.pending.has(msgId), true)
})

test('replyMode=last 只回最后一条助手文本', async () => {
  const ch = makeChannel({ replyMode: 'last' })
  const msgId = 'msg-3'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })

  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 3 } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '中间过程' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 3, step: 2, message: { content: [{ type: 'text', text: '结论' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 1)
  assert.equal(ch.sent[0].text, '结论')
})

test('长文本按 maxChunk 切分', () => {
  assert.deepEqual(chunkText('x'.repeat(1600), 1500), ['x'.repeat(1500), 'x'.repeat(100)])
  assert.deepEqual(chunkText('短文本', 1500), ['短文本'])
  // 在换行处切分：第一块在行边界干净结束，换行落在第二块开头
  const s = 'a'.repeat(800) + '\n' + 'b'.repeat(800)
  const parts = chunkText(s, 1500)
  assert.equal(parts.length, 2)
  assert.equal(parts[0], 'a'.repeat(800))
  assert.equal(parts[1].startsWith('\n'), true)
  // max<=0 保护
  assert.equal(chunkText('abc', 0).length, 1)
})

test('followup 同步抛错：清理 pending 并回错误提示', async () => {
  const ch = makeChannel()
  ch.getTypingTicket = async () => '' // 跳过 typing，避免网络
  ch.ensureAgentFor = async () => ({
    id: 'session-throw',
    followup() { throw new Error('boom') },
  })

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: 'hi', hasText: true })

  assert.equal(ch.sent.length, 1)
  assert.match(ch.sent[0].text, /处理失败/)
  assert.match(ch.sent[0].text, /boom/)
  assert.equal(ch.pending.size, 0)
})

test('push 主动推送：未登录时抛错', async () => {
  const ch = makeChannel()
  await assert.rejects(() => ch.push('u1@im.wechat', 'hi'), /未登录/)
})

test('push 主动推送：单用户与 all 广播', async () => {
  const ch = makeChannel()
  ch.creds = { bot_token: 'tok', baseurl: 'https://ilinkai.weixin.qq.com' }
  ch.sessionMap = { 'u1@im.wechat': 's1', 'u2@im.wechat': 's2' }

  const r1 = await ch.push('u1@im.wechat', '你好')
  assert.equal(r1.sent, 1)
  assert.deepEqual(r1.targets, ['u1@im.wechat'])
  assert.equal(ch.sent.length, 1)
  assert.equal(ch.sent[0].to, 'u1@im.wechat')
  assert.equal(ch.sent[0].text, '你好')

  ch.sent.length = 0
  const r2 = await ch.push('all', '广播')
  assert.equal(r2.sent, 2)
  assert.equal(ch.sent.length, 2)
})

test('resolveWorkspaceDir：空值回落到 stateDir/workspace，显式值用显式', () => {
  assert.equal(resolveWorkspaceDir('', '/tmp/state'), '/tmp/state/workspace')
  assert.equal(resolveWorkspaceDir('/custom/ws', '/tmp/state'), '/custom/ws')
})

test('超时后 turn/end 不重复发送（review I1）', async () => {
  const ch = makeChannel()
  let resolved = false
  // 模拟超时已发生：pending 已从 map 移除，collector 仍残留旧引用
  ch.collectors.set('msg-timeout', {
    sessionId: SESSION,
    turn: 9,
    msgId: 'msg-timeout',
    parts: ['迟到的完整回复'],
    pending: { from: FROM, contextToken: 'tok', resolve: () => { resolved = true }, timer: null },
  })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 9 } })
  await tick()

  assert.equal(ch.sent.length, 0) // 不重复发送完整回复
  assert.equal(resolved, true)    // 仍 resolve，避免 handleInbound 悬挂
  assert.equal(ch.collectors.size, 0)
})

test('turn/end 模型报错且无助手文本：图片不支持 → 回明确提示而非静默', async () => {
  const ch = makeChannel()
  const msgId = 'msg-err'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 7 } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'error', error: { message: 'pi-ai model "deepseek-v4-pro" does not support image input', code: 'UNSUPPORTED_CONTENT' } } } })
  await tick()
  assert.equal(ch.sent.length, 1)
  assert.match(ch.sent[0].text, /不支持看图/)
})

test('turn/end 一般错误且无助手文本：回错误信息', async () => {
  const ch = makeChannel()
  const msgId = 'msg-err2'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 8 } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 8, reason: { kind: 'error', error: { message: 'network down', code: 'E_NET' } } } })
  await tick()
  assert.equal(ch.sent.length, 1)
  assert.match(ch.sent[0].text, /network down/)
})

test('sendReply 分块之间也执行调速（review I2）', async () => {
  const ch = makeChannel({ sendIntervalMs: 40, maxChunk: 10 })
  const times = []
  ch.sendChunk = async () => { times.push(Date.now()) }
  ch.sendReply = WeixinChannel.prototype.sendReply // makeChannel 覆盖过，换回真实实现
  await ch.sendReply(FROM, undefined, 'x'.repeat(15)) // 切成 10 + 5 两块

  assert.equal(times.length, 2)
  assert.ok(times[1] - times[0] >= 30, `分块间隔应 ≥ sendIntervalMs，实际 ${times[1] - times[0]}ms`)
})

test('chunkText 不切开 emoji 代理对（review S4）', () => {
  const parts = chunkText('a'.repeat(4) + '😀' + 'a'.repeat(4), 5)
  assert.ok(parts.length >= 2)
  assert.equal(parts[0], 'aaaa') // 修复后 cut 退到 emoji 前，emoji 完整进入下一块
  for (const p of parts) {
    assert.doesNotMatch(p, /[\ud800-\udbff]$/, `以高位代理结尾（半个字符）：${JSON.stringify(p)}`)
    assert.doesNotMatch(p, /^[\udc00-\udfff]/, `以低位代理开头（半个字符）：${JSON.stringify(p)}`)
  }
})

test('normalizeInboundMessages：文本/非文本/空响应（review S10）', () => {
  assert.deepEqual(normalizeInboundMessages({}), [])
  assert.deepEqual(normalizeInboundMessages(null), [])
  const out = normalizeInboundMessages({
    msgs: [
      { from_user_id: 'u1', to_user_id: 'bot', context_token: 'c1', item_list: [{ type: 1, text_item: { text: '你好' } }] },
      { from_user_id: 'u2', to_user_id: 'bot', context_token: 'c2', item_list: [{ type: 3, text_item: {} }] },
      { from_user_id: '', item_list: [{ type: 1, text_item: { text: '无 from 忽略' } }] },
    ],
  })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { from: 'u1', to: 'bot', contextToken: 'c1', text: '你好', voiceText: '', hasText: true, image: null, nonTextTypes: [] })
  assert.deepEqual(out[1], { from: 'u2', to: 'bot', contextToken: 'c2', text: '', voiceText: '', hasText: false, image: null, nonTextTypes: [3] })
})

test('normalizeInboundMessages：语音转写（voice_item.text）直接进正文', () => {
  const out = normalizeInboundMessages({
    msgs: [{ from_user_id: 'u1', to_user_id: 'bot', context_token: 'c1', item_list: [{ type: 3, voice_item: { text: '明天天气怎么样' } }] }],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].voiceText, '明天天气怎么样')
  assert.equal(out[0].hasText, true)
  assert.equal(out[0].image, null)
})

test('normalizeInboundMessages：提取首张图片下载信息（aeskey hex → base64）', () => {
  const hex = '00112233445566778899aabbccddeeff'
  const out = normalizeInboundMessages({
    msgs: [{
      from_user_id: 'u1', to_user_id: 'bot', context_token: 'c1',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'eqp', full_url: '', aes_key: '' }, aeskey: hex } }],
    }],
  })
  assert.equal(out[0].image.encrypt_query_param, 'eqp')
  assert.equal(out[0].image.aesKey, Buffer.from(hex, 'hex').toString('base64'))
})

test('sniffImageMime：识别 JPEG/PNG/GIF/WEBP，未知回退 JPEG', () => {
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from([1, 2, 3])), 'image/jpeg')
})

test('parseAesKey：兼容 base64(16 字节) 与 base64(32 位 hex)', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  assert.deepEqual(parseAesKey(key.toString('base64')), key)
  assert.deepEqual(parseAesKey(Buffer.from(key.toString('hex'), 'ascii').toString('base64')), key)
  assert.throws(() => parseAesKey('!!!!'), /无法解析/)
})

test('downloadImageBytes：下载并 AES-128-ECB 解密', async () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const plain = Buffer.from('RIFFxxxxWEBPxxx') // 明文图片字节
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) })

  const out = await downloadImageBytes({ encryptQueryParam: 'abc', aesKey: key.toString('base64'), fetchImpl: fakeFetch })
  assert.deepEqual(out, plain)

  // 明文 CDN（无密钥）原样返回
  const fetchPlain = async () => ({ ok: true, arrayBuffer: async () => plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) })
  const out2 = await downloadImageBytes({ encryptQueryParam: 'abc', aesKey: '', fetchImpl: fetchPlain })
  assert.deepEqual(out2, plain)
})

test('handleInbound：语音转写直接作为正文', async () => {
  const ch = makeChannel()
  ch.getTypingTicket = async () => ''
  let got = null
  ch.ensureAgentFor = async () => ({ id: 'session-v', followup(u) { got = u; throw new Error('capture') } })

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '', voiceText: '明天几点', image: null })

  assert.ok(got)
  assert.equal(got.content.length, 1)
  assert.equal(got.content[0].type, 'text')
  assert.equal(got.content[0].text, '明天几点')
})

test('handleInbound：图片下载解密后注入 image 块（纯图无文字）', async () => {
  const ch = makeChannel()
  ch.getTypingTicket = async () => ''
  ch.supportsVision = async () => true
  const savedRef = { attachmentId: 'img-1', mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1 }
  ch.downloadImageBytes = async () => Buffer.from([0xff, 0xd8, 0xff, 0xdb])
  ch.ctx.attachments = {
    imageLimits: { maxImageBytes: 10 * 1024 * 1024 },
    saveImage: async (input) => { ch.lastSave = input; return savedRef },
  }
  let got = null
  ch.ensureAgentFor = async () => ({ id: 'session-img', followup(u) { got = u; throw new Error('capture') } })

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '', voiceText: '', image: { encrypt_query_param: 'x', full_url: '', aesKey: '' } })

  assert.ok(got)
  assert.equal(got.content.length, 1)
  assert.equal(got.content[0].type, 'image')
  assert.equal(got.content[0].attachment.attachmentId, 'img-1')
  assert.equal(ch.lastSave.mediaType, 'image/jpeg') // 嗅探出 JPEG
})

test('handleInbound：图片下载失败降级为提示文本，不崩溃', async () => {
  const ch = makeChannel()
  ch.getTypingTicket = async () => ''
  ch.supportsVision = async () => true
  ch.downloadImageBytes = async () => { throw new Error('cdn down') }
  ch.ctx.attachments = { imageLimits: {}, saveImage: async () => ({}) }
  let got = null
  ch.ensureAgentFor = async () => ({ id: 'session-fail', followup(u) { got = u; throw new Error('capture') } })

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '', voiceText: '', image: { encrypt_query_param: 'x' } })

  assert.ok(got)
  assert.equal(got.content[0].type, 'text')
  assert.equal(got.content[0].text, '[图片处理失败]')
})

test('handleInbound：模型不看图（纯图片）→ 直接友好提示，不注入图片不跑模型', async () => {
  const ch = makeChannel()
  ch.getTypingTicket = async () => ''
  ch.supportsVision = async () => false
  let followupCalled = false
  ch.downloadImageBytes = async () => { throw new Error('不应被调用') }
  ch.ensureAgentFor = async () => ({ id: 'session-novision', options: {}, followup() { followupCalled = true } })

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: '', voiceText: '', image: { encrypt_query_param: 'x' } })

  assert.equal(followupCalled, false) // 关键：不进模型，图片块不落会话历史 → 不污染后续轮次
  assert.equal(ch.sent.length, 1)
  assert.match(ch.sent[0].text, /不支持看图/)
})

test('supportsVision：无 llm / 纯文本模型 / 视觉模型 / 缓存', async () => {
  const ch = makeChannel()
  // makeCtx().get 返回 undefined → 无 llm 服务
  assert.equal(await ch.supportsVision({}), false)

  ch.ctx.get = (k) => {
    if (k === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
    if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) }
  }
  assert.equal(await ch.supportsVision({}), false) // 纯文本

  let calls = 0
  ch.ctx.get = (k) => {
    if (k === 'llm') return { resolveModelInfo: async () => { calls++; return { inputModalities: ['text', 'image'] } } }
    if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'anthropic', model: 'claude-vision' }) }
  }
  assert.equal(await ch.supportsVision({}), true)
  assert.equal(await ch.supportsVision({}), true) // 命中缓存，不再请求
  assert.equal(calls, 1)
})

test('resolveDefaultAgentOptions：解析默认模型，缺失则回退空对象', () => {
  const ch = makeChannel()
  // makeCtx().get 返回 undefined → 无 agentDefaultModel 服务
  assert.deepEqual(ch.resolveDefaultAgentOptions(), {})

  ch.ctx.get = (k) => {
    if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) }
  }
  assert.deepEqual(ch.resolveDefaultAgentOptions(), { provider: 'deepseek', model: 'deepseek-v4-pro' })

  // 缺 model 字段 → 回退空对象（否则 {{model}} 仍会空值报错）
  ch.ctx.get = (k) => (k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek' }) } : undefined)
  assert.deepEqual(ch.resolveDefaultAgentOptions(), {})
})

const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true // 高位代理后无低位 → 孤立
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true // 孤立低位代理
    }
  }
  return false
}

test('chunkText 极端 maxChunk + emoji：不拆代理对、不丢字、有限步终止（review 二轮 N1）', () => {
  const cases = [
    ['😀x', 1],
    ['😀x', 2],
    ['a😀b', 2],
    ['😀😀', 2],
    ['啦啦😀啦', 3],
  ]
  for (const [input, max] of cases) {
    const parts = chunkText(input, max)
    assert.equal(parts.join(''), input, `${JSON.stringify(input)} @max=${max} 丢字`)
    for (const p of parts) {
      assert.equal(hasLoneSurrogate(p), false, `块 ${JSON.stringify(p)} 含孤立代理 @max=${max}`)
    }
  }
})

test('paceSend 并发调用仍按 sendIntervalMs 串行（review S6）', async () => {
  const ch = makeChannel({ sendIntervalMs: 40 })
  const marks = []
  await Promise.all([
    ch.paceSend().then(() => marks.push(Date.now())),
    ch.paceSend().then(() => marks.push(Date.now())),
  ])
  assert.equal(marks.length, 2)
  assert.ok(marks[1] - marks[0] >= 30, `并发 paceSend 间隔应 ≥ sendIntervalMs，实际 ${marks[1] - marks[0]}ms`)
})

test('push 返回真实成功/失败计数（review S5）', async () => {
  const ch = makeChannel()
  ch.creds = { bot_token: 'tok', baseurl: 'https://ilinkai.weixin.qq.com' }
  ch.sessionMap = { 'u1@im.wechat': 's1', 'u2@im.wechat': 's2' }
  ch.sendReply = async () => false // 模拟发送全部失败
  const r = await ch.push('all', '你好')
  assert.equal(r.sent, 0)
  assert.equal(r.failed, 2)
  assert.deepEqual(r.targets, ['u1@im.wechat', 'u2@im.wechat'])
})

test('登录终态宽限后自动清理 login（review S3）', () => {
  const ch = makeChannel()
  ch.login = { status: 'confirmed', message: '登录成功！', qrUrl: 'https://x', startedAt: Date.now(), finishedAt: Date.now() }
  const v1 = ch.statusView().login
  assert.equal(v1.active, true)
  assert.equal(v1.status, 'confirmed')
  assert.equal(v1.hasQr, false) // 终态不再展示二维码，面板停止轮询 qr.svg
  assert.equal(ch.login !== null, true) // loginView 纯读：宽限内不清状态
  ch.login.finishedAt = Date.now() - 11_000 // 超过 LOGIN_DONE_GRACE_MS
  const v2 = ch.statusView().login // statusView 显式调用 pruneLogin 清理
  assert.equal(v2.active, false)
  assert.equal(ch.login, null)
})

test('stopTypingOnce 同一轮只停一次「正在输入」（观察 2 幂等）', () => {
  const ch = makeChannel()
  let stops = 0
  ch.stopTyping = () => { stops += 1 }
  const pend = { from: FROM, typingStopped: false }
  ch.stopTypingOnce(pend)
  ch.stopTypingOnce(pend)
  assert.equal(stops, 1)
})

test('composeSetup 为微信 agent 注入禁止反问的通道指令（修复卡住）', async () => {
  const ch = makeChannel() // makeCtx().get 返回 undefined → 无 agentPresets
  const setup = await ch.composeSetup()
  assert.equal(typeof setup, 'function')

  const sections = []
  await setup({ systemPrompt: { section: (s) => sections.push(s) } })

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'weixin:channel-instruction')
  assert.ok(sections[0].text.includes('ask_user_question'))
  assert.equal(typeof sections[0].order, 'number')
})

test('registerPushTool 注册 push_weixin：缺省发给会话所属用户，显式 all/指定 id 生效', async () => {
  const registered = []
  const calls = []
  const ctx = { tools: { register: (d) => { registered.push(d); return () => {} } } }
  const channel = {
    sessionMap: {
      'u1@im.wechat': { active: 'session-A', sessions: [{ id: 'session-A', name: 'A' }] },
      'u2@im.wechat': { active: 'session-B', sessions: [{ id: 'session-B', name: 'B' }] },
    },
    push: async (to, text) => { calls.push({ to, text }); return { sent: 1, failed: 0, targets: [to] } },
  }

  registerPushTool(ctx, channel)
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'push_weixin')
  assert.deepEqual(tool.parameters.required, ['text']) // text 必填，to 可省

  await tool.execute({ text: 'hi' }, { agent: { id: 'session-A' } })       // 缺省 → 会话所属用户
  await tool.execute({ to: 'all', text: 'hi2' }, { agent: { id: 'session-A' } }) // 广播
  await tool.execute({ to: 'u2@im.wechat', text: 'hi3' }, {})              // 显式指定

  assert.deepEqual(calls.map((c) => c.to), ['u1@im.wechat', 'all', 'u2@im.wechat'])
  assert.deepEqual(calls.map((c) => c.text), ['hi', 'hi2', 'hi3'])
})
