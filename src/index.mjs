/**
 * dsh-weixin：微信 ClawBot (iLink) 通道插件（标准 cordis bundle 形态）。
 *
 * 数据流：
 *   iLink getupdates 长轮询收消息 → 按微信用户映射/创建 Harness 会话
 *   → agent.followup(userMessage) 原生注入
 *   → 订阅 session/event（user/message 按 id 关联 → assistant/message 收集
 *     → turn/end 结算）→ sendmessage 回微信（带 context_token）
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import * as ilink from './ilink.mjs'
import { createStore, resolveStateDir, resolveWorkspaceDir } from './creds.mjs'
import { registerPanel } from './panel.mjs'

export const name = 'dsh-weixin'
/** 硬依赖：面板需要 webServer；通道需要 agents（查找/创建/恢复代理）；tools 用于注册主动推送工具；attachments 用于收图（存图喂视觉模型）。agentPresets 为可选探测。 */
export const inject = ['webServer', 'agents', 'tools', 'attachments']

/** 可配置参数（默认值即 schema 默认，可在 cordis.yml 覆盖）。 */
export const Config = Schema.object({
  // 新会话的工作目录（绝对路径，决定会话持久化命名空间与文件工具根）；
  // 空 = 自动（stateDir/workspace，跨重启稳定）
  cwd: Schema.string().default(''),
  // 状态目录（凭证/会话映射/游标）；空 = 自动（$DSH_HOME/dsh-weixin 或 ~/.dsh/dsh-weixin）
  stateDir: Schema.string().default(''),
  // 回复风格：full 整轮文本 / last 只回最后一条
  replyMode: Schema.union(['full', 'last']).default('full'),
  // 单轮回复超时（毫秒）
  replyTimeoutMs: Schema.number().default(15 * 60_000),
  // 单条消息最大字符数（超出切分）
  maxChunk: Schema.number().default(1500),
  // 两条发送之间的最小间隔（毫秒，规避 iLink 限流）
  sendIntervalMs: Schema.number().default(2000),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 登录终态（confirmed/error/expired）后面板保留最终提示的时长，之后自动收起卡片（review S3）。 */
const LOGIN_DONE_GRACE_MS = 10_000

export function chunkText(text, max) {
  const limit = Math.max(1, Math.floor(max || 1500))
  const out = []
  let rest = text ?? ''
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    // 切点不得落在 UTF-16 代理对之间（emoji 占 2 码元）。优先左移一格，把整个字符留给
    // 下一块；若已顶到块首（如 maxChunk=1 且以 emoji 开头）无法左移，则右移一格把整个
    // 字符纳入本块——宁可本块超 1 码元，也不产出半个字符，并保证 rest 一定前进。
    if (cut > 0 && cut < rest.length) {
      const prev = rest.charCodeAt(cut - 1)
      const next = rest.charCodeAt(cut)
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        cut = cut - 1 > 0 ? cut - 1 : cut + 1
      }
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/** 等价 @deepseek-ai/dsh-llm 的 createUserMessage（避免依赖独立安装时版本漂移）。 */
function makeUserMessage(input) {
  return { ...input, role: 'user', id: `msg-${randomUUID()}` }
}

/** 微信用户 → Harness 会话的通道。一个插件实例含一个长轮询 loop 与若干按用户隔离的会话。 */
export class WeixinChannel {
  constructor(ctx, config, store) {
    this.ctx = ctx
    this.cfg = config
    this.store = store
    this.log = ctx.logger ?? console
    this.creds = store.loadCredentials()
    // 多会话映射：{ userId: { active, sessions: [{id, name, provider, model, createdAt, lastActiveAt}] } }
    const loaded = store.loadSessionMap()
    this.sessionMap = loaded.map ?? loaded
    if (loaded.migrated) {
      this.store.saveSessionMap(this.sessionMap)
      this.log.info?.('dsh-weixin: 会话映射已升级为多会话格式')
    }
    this.buf = store.loadBuf()
    this.botAgent = 'DeepSeek Harness Weixin Channel'
    this.typingTickets = new Map()
    this.turns = new Map() // sessionId -> current turn
    this.pending = new Map() // userMessage.id -> {from, contextToken, sessionId, resolve, timer}
    this.collectors = new Map() // userMessage.id -> { sessionId, turn, msgId, parts, pending }（多会话并发各自收集）
    this.handles = new Map() // sessionId -> AgentHandle（dispose 用）
    this.modelSelections = new Map() // sessionId -> ModelSelectionRef（每会话可变模型选择）
    this.userQueues = new Map() // userId -> Promise（同一用户的消息串行处理，不同用户并行）
    this.lastSendAt = 0
    this.sendQueue = Promise.resolve() // 发送调速队列（review S6）
    this.stopped = false
    this.monitorRunning = false
    this.monitorAbort = new AbortController()
    this.status = { baseUrl: null, lastEventAt: null, lastError: null, startedAt: Date.now() }
    this.logs = [] // ring buffer
    this.login = null // 面板登录流程状态
    this.downloadImageBytes = ilink.downloadImageBytes // 测试注入点（默认走 CDN 下载解密）
    this.visionCache = new Map() // `provider:model` -> boolean（模型是否支持图片输入）
    this.showTag = true // 回复末尾是否带当前会话标记（/tag on|off 切换）

    this.ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event))
    this.ctx.on('dispose', () => this.stop())

    if (this.creds?.bot_token) {
      this.startMonitor()
    } else {
      this.pushLog('未配置微信凭据，等待扫码登录（面板 /weixin 或 bin/login.mjs）')
    }
  }

  pushLog(line) {
    const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    this.logs.push(entry)
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300)
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async startMonitor() {
    const cred = this.creds
    cred.baseurl = cred.baseurl || ilink.DEFAULT_BASE_URL
    this.status.baseUrl = cred.baseurl
    this.monitorRunning = true
    // 本地捕获 controller：applyCredentials/clearCredentials 会替换 this.monitorAbort，
    // 当前循环必须持有旧引用，abort 旧 controller 才能停下本循环（否则会泄漏/重复轮询）。
    const aborter = this.monitorAbort
    this.pushLog('微信通道启动（iLink 长轮询）')
    try {
      await ilink.notifyStart({ baseUrl: cred.baseurl, token: cred.bot_token, botAgent: this.botAgent })
    } catch { /* 通知失败不阻塞 */ }

    let failures = 0
    while (!this.stopped && !aborter.signal.aborted) {
      try {
        const resp = await ilink.getUpdates({
          baseUrl: cred.baseurl, token: cred.bot_token, buf: this.buf, botAgent: this.botAgent,
          signal: aborter.signal,
        })
        if (this.stopped || aborter.signal.aborted) break
        failures = 0
        this.status.lastEventAt = Date.now()
        this.status.lastError = null
        if (typeof resp?.get_updates_buf === 'string' && resp.get_updates_buf) {
          this.buf = resp.get_updates_buf
          this.store.saveBuf(this.buf)
        }
        for (const msg of ilink.normalizeInboundMessages(resp)) {
          if (this.stopped || aborter.signal.aborted) break
          // 非阻塞派发：同一用户的消息经 per-user 队列串行（保序 + 防 ensureAgentFor 竞态），
          // 不同用户/不同会话的 turn 并行推进，不再整轮阻塞长轮询循环。
          this.dispatchInbound(msg)
        }
      } catch (err) {
        failures += 1
        this.status.lastError = err?.message ?? String(err)
        const wait = Math.min(1000 * failures, 15_000)
        this.pushLog(`长轮询异常（${failures}）：${err?.message ?? err}`)
        await sleep(wait)
      }
    }
  }

  /** 入站消息按用户排队派发（不 await；错误只记日志，不影响长轮询）。 */
  dispatchInbound(msg) {
    const userId = msg?.from ?? ''
    const prev = this.userQueues.get(userId) ?? Promise.resolve()
    const next = prev.then(() => this.handleInbound(msg)).catch((err) => {
      this.pushLog(`消息处理异常：${err?.message ?? err}`)
    })
    this.userQueues.set(userId, next)
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.monitorAbort.abort()
    this.monitorRunning = false
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.pushLog('微信通道已停止')
  }

  /** 登录成功后应用新凭证并重启监视循环。 */
  applyCredentials(cred) {
    this.creds = { ...cred, baseurl: cred.baseurl || ilink.DEFAULT_BASE_URL }
    this.store.saveCredentials(this.creds)
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = false
    this.startMonitor()
  }

  /** 登出：清凭证 + 下线通知 + 停监视。 */
  async clearCredentials() {
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = true
    this.creds = null
    this.store.saveCredentials(null)
    this.pushLog('已登出')
  }

  /* ------------------------------ 会话/代理 ------------------------------ */

  /** 内联实现 @deepseek-ai/dsh-agent 的 installModelSelection（30 行等价逻辑），
   *  避免 fork 后新增包依赖。把可变 ModelSelectionRef 挂到 agent 作用域的
   *  prompt 组装与请求路由上：切换模型在下一个 step 生效，会话历史保留。 */
  installModelSelection(agentCtx, selection) {
    const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = selection.current
      const assembled = await next()
      selection.assembled = selected
      if (selected === undefined) return assembled
      return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
    })
    const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inherited, ...rest } = resolved
      return { ...rest, provider: selected.provider, model: selected.model, ...selected.reasoningEffort === void 0 ? {} : { reasoningEffort: selected.reasoningEffort } }
    })
    return () => { disposeAssembly(); disposeRequest() }
  }

  /** 取（或创建）某会话的模型选择 ref。create/resume 时经 setup 闭包安装到 agent 作用域。 */
  modelSelectionFor(sessionId, entry) {
    let ref = this.modelSelections.get(sessionId)
    if (!ref) {
      ref = {
        current: entry?.provider && entry?.model ? { provider: entry.provider, model: entry.model } : undefined,
        assembled: undefined,
      }
      this.modelSelections.set(sessionId, ref)
    }
    return ref
  }

  async composeSetup(sessionId, entry) {
    const presets = this.ctx.get('agentPresets')
    const selection = sessionId ? this.modelSelectionFor(sessionId, entry) : null
    return async (agentCtx) => {
      // 每会话模型选择：ref.current 有值时覆盖 prompt 变量与实际请求路由
      if (selection) {
        try {
          this.installModelSelection(agentCtx, selection)
        } catch (err) {
          this.pushLog(`安装模型选择失败：${err?.message ?? err}`)
        }
      }
      // 通道指令：注册到 agent 作用域，只约束本微信会话、不污染网页端。
      // 关键：禁止 ask_user_question（它走网页 provider，微信端无法应答会卡住整轮）。
      try {
        agentCtx.systemPrompt.section({
          name: 'weixin:channel-instruction',
          order: 50,
          text: '你当前通过微信消息通道与用户交流，交流是异步、回合式的文字对话。'
            + '不要使用 ask_user_question 工具——它会在网页端阻塞等待回答，微信端无法响应会导致整轮卡住。'
            + '信息不足时：优先在回复正文里直接向用户反问，或采用合理默认值并简要说明你的假设。',
        })
      } catch (err) {
        this.pushLog(`注入通道指令失败：${err?.message ?? err}`)
      }
      if (!presets) return
      try {
        const resolved = await presets.resolve(undefined)
        if (resolved?.id) await presets.mount(agentCtx, resolved.id)
      } catch (err) {
        this.pushLog(`agentPresets 装配失败（用默认）：${err?.message ?? err}`)
      }
    }
  }

  /** 解析当前默认模型为 AgentOptions（provider + model）。harness 的人设里含 {{model}}/{{provider}} 模板变量，
   *  只有 agent.options 里显式给了模型才渲染得出来，否则首条消息就报「prompt variable has no value」。 */
  resolveDefaultAgentOptions() {
    try {
      const sel = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch (err) {
      this.pushLog(`解析默认模型失败：${err?.message ?? err}`)
    }
    return {}
  }

  /** 取用户记录；不存在则返回 null（不自动创建，创建走 createSessionFor）。 */
  userRecord(userId) {
    return this.sessionMap[userId] ?? null
  }

  /** 用户当前会话 entry；无记录时返回 null。 */
  activeEntry(userId) {
    const rec = this.userRecord(userId)
    if (!rec) return null
    return rec.sessions.find((s) => s.id === rec.active) ?? rec.sessions[0] ?? null
  }

  /** entry 记忆的模型 → AgentOptions；无记忆则回落全局默认模型。 */
  resolveAgentOptionsFor(entry) {
    if (entry?.provider && entry?.model) return { provider: entry.provider, model: entry.model }
    return this.resolveDefaultAgentOptions()
  }

  /** 为用户新建会话并设为当前。@returns {{agent, entry}} */
  async createSessionFor(userId, name) {
    const newId = `session-${randomUUID()}`
    const now = new Date().toISOString()
    const entry = {
      id: newId,
      name: name?.trim() || `会话 ${(this.sessionMap[userId]?.sessions.length ?? 0) + 1}`,
      provider: null,
      model: null,
      createdAt: now,
      lastActiveAt: now,
    }
    const { agent, dispose } = await this.ctx.agents.create({
      sessionId: newId,
      agentOptions: this.resolveAgentOptionsFor(entry),
      meta: { cwd: this.cfg.cwd },
      setup: await this.composeSetup(newId, entry),
    })
    this.handles.set(newId, { agent, dispose })
    const rec = this.sessionMap[userId] ?? { active: newId, sessions: [] }
    rec.sessions.push(entry)
    rec.active = newId
    this.sessionMap[userId] = rec
    this.store.saveSessionMap(this.sessionMap)
    this.pushLog(`为 ${userId.slice(0, 12)}… 新建会话 ${newId}（${entry.name}）`)
    return { agent, entry }
  }

  /** 加载指定 entry 对应的 agent：活着复用，否则从持久化恢复。 */
  async loadAgentFor(entry) {
    const live = this.ctx.agents.get(entry.id)
    if (live) return live
    const handle = await this.ctx.agents.resume({
      resumeSessionId: entry.id,
      agentOptions: this.resolveAgentOptionsFor(entry),
      setup: await this.composeSetup(entry.id, entry),
    })
    this.handles.set(entry.id, handle)
    this.pushLog(`恢复持久化会话 ${entry.id}（${entry.name}）`)
    return handle.agent
  }

  /** 微信用户 → 当前会话的代理。无记录则新建首个会话。 */
  async ensureAgentFor(userId) {
    let entry = this.activeEntry(userId)
    if (!entry) return (await this.createSessionFor(userId)).agent
    try {
      return await this.loadAgentFor(entry)
    } catch (err) {
      this.pushLog(`恢复会话 ${entry.id} 失败：${err?.message ?? err}，将新建`)
      return (await this.createSessionFor(userId)).agent
    }
  }

  /* ------------------------------ 斜杠命令 ------------------------------ */

  /** 命令帮助文本。 */
  helpText() {
    return [
      '📖 会话操作：',
      '/new [名称] — 新建会话并切换过去',
      '/list — 列出我的全部会话（或发「列表」）',
      '/2 — 快捷切换到 2 号会话',
      '#名称 内容 — 直接向指定会话说话（如 #工作 帮我写周报）',
      '/model — 列出可用模型（或发「模型」）',
      '/model <编号> — 给当前会话切换模型',
      '/rename <名称> — 重命名当前会话',
      '/del <编号> — 删除指定会话',
      '/tag on|off — 回复末尾是否带当前会话标记',
      '/help — 本帮助（或发「帮助」）',
      '直接发文字/语音即与当前会话对话。',
    ].join('\n')
  }

  /** 会话列表文本，当前会话打 ✅。 */
  sessionListText(userId) {
    const rec = this.userRecord(userId)
    if (!rec?.sessions.length) return '你还没有会话，发 /new 新建一个吧'
    const lines = rec.sessions.map((s, i) => {
      const mark = s.id === rec.active ? '✅ ' : ''
      const model = s.provider && s.model ? `${s.provider}/${s.model}` : '默认模型'
      return `${mark}${i + 1}. ${s.name}（${model}）`
    })
    return ['💬 我的会话：', ...lines, '', '发 /数字 快速切换；#名称 内容 直接向指定会话说话'].join('\n')
  }

  /** 拉取可用模型目录：[{provider, model}]，按 provider 分组摊平编号。 */
  async listAvailableModels() {
    const llm = this.ctx.get?.('llm')
    if (!llm) return []
    const out = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider)
        for (const m of models ?? []) {
          const id = typeof m === 'string' ? m : m?.id ?? m?.model
          if (id) out.push({ provider, model: id })
        }
      } catch (err) {
        this.pushLog(`列出 ${provider} 模型失败：${err?.message ?? err}`)
      }
    }
    return out
  }

  /** 模型列表文本，当前会话所用模型打 ✅。 */
  async modelListText(userId) {
    const models = await this.listAvailableModels()
    if (!models.length) return '暂时查不到可用模型（llm 服务不可用）'
    const entry = this.activeEntry(userId)
    const lines = models.map((m, i) => {
      const mark = entry?.provider === m.provider && entry?.model === m.model ? '✅ ' : ''
      return `${mark}${i + 1}. ${m.provider}/${m.model}`
    })
    return ['🧠 可用模型：', ...lines, '', '发 /model <编号> 给当前会话换模型'].join('\n')
  }

  /** 按编号或名称解析用户的会话 entry（/# 定向与快捷切换共用）。 */
  resolveSessionRef(userId, ref) {
    const rec = this.userRecord(userId)
    if (!rec?.sessions.length) return null
    const n = Number.parseInt(ref, 10)
    if (Number.isFinite(n) && String(n) === ref.trim()) return rec.sessions[n - 1] ?? null
    return rec.sessions.find((s) => s.name === ref.trim()) ?? null
  }

  /** 切换用户的当前会话（不落 agent，仅改映射）。 */
  switchActive(userId, entry) {
    const rec = this.userRecord(userId)
    if (!rec) return
    rec.active = entry.id
    entry.lastActiveAt = new Date().toISOString()
    this.store.saveSessionMap(this.sessionMap)
  }

  /** 回复末尾的会话标记（💬「名称」· provider/model）。showTag 为 false 时返回空串。 */
  sessionTagFor(sessionId) {
    if (!this.showTag) return ''
    for (const rec of Object.values(this.sessionMap)) {
      const s = rec.sessions?.find?.((x) => x.id === sessionId)
      if (s) {
        const model = s.provider && s.model ? `${s.provider}/${s.model}` : '默认模型'
        return `\n——💬「${s.name}」· ${model}`
      }
    }
    return ''
  }

  /**
   * 斜杠命令分发。命中命令则处理并回复，返回 true；
   * 未命中（如语音误转写出 /xxx）返回 false，调用方按普通消息继续处理。
   */
  async handleCommand(from, contextToken, text) {
    // 快捷切换：/2 等价 /use 2
    const quick = text.match(/^\/(\d{1,3})$/)
    if (quick) {
      const rec = this.userRecord(from)
      const entry = rec?.sessions[Number(quick[1]) - 1]
      if (!entry) {
        await this.sendReply(from, contextToken, `编号无效（共 ${rec?.sessions.length ?? 0} 个会话），发 /list 查看`)
        return true
      }
      this.switchActive(from, entry)
      const model = entry.provider && entry.model ? `${entry.provider}/${entry.model}` : '默认模型'
      await this.sendReply(from, contextToken, `🔀 已切换到「${entry.name}」（${model}），历史上下文都在`)
      return true
    }
    const m = text.match(/^\/([a-z]+)\s*([\s\S]*)$/i)
    if (!m) return false
    const cmd = m[1].toLowerCase()
    const arg = (m[2] ?? '').trim()

    switch (cmd) {
      case 'help':
        await this.sendReply(from, contextToken, this.helpText())
        return true

      case 'list':
        await this.sendReply(from, contextToken, this.sessionListText(from))
        return true

      case 'new': {
        try {
          const { entry } = await this.createSessionFor(from, arg)
          await this.sendReply(from, contextToken, `✨ 已新建并切换到「${entry.name}」，直接发消息开始对话吧`)
        } catch (err) {
          await this.sendReply(from, contextToken, `😵 新建会话失败：${err?.message ?? err}`)
        }
        return true
      }

      case 'use': {
        const rec = this.userRecord(from)
        const n = Number.parseInt(arg, 10)
        if (!rec?.sessions.length) {
          await this.sendReply(from, contextToken, '你还没有会话，发 /new 新建一个吧')
          return true
        }
        const entry = rec.sessions[n - 1]
        if (!entry) {
          await this.sendReply(from, contextToken, `编号无效（共 ${rec.sessions.length} 个会话），发 /list 查看`)
          return true
        }
        this.switchActive(from, entry)
        const model = entry.provider && entry.model ? `${entry.provider}/${entry.model}` : '默认模型'
        await this.sendReply(from, contextToken, `🔀 已切换到「${entry.name}」（${model}），历史上下文都在`)
        return true
      }

      case 'tag': {
        this.showTag = arg !== 'off'
        await this.sendReply(from, contextToken, this.showTag ? '🏷️ 回复末尾将显示当前会话标记' : '🏷️ 已关闭会话标记')
        return true
      }

      case 'model': {
        if (!arg) {
          await this.sendReply(from, contextToken, await this.modelListText(from))
          return true
        }
        const n = Number.parseInt(arg, 10)
        const models = await this.listAvailableModels()
        const picked = models[n - 1]
        if (!picked) {
          await this.sendReply(from, contextToken, `编号无效（共 ${models.length} 个模型），发 /model 查看`)
          return true
        }
        const rec = this.userRecord(from)
        const entry = this.activeEntry(from)
        if (!rec || !entry) {
          await this.sendReply(from, contextToken, '你还没有会话，发 /new 新建一个吧')
          return true
        }
        entry.provider = picked.provider
        entry.model = picked.model
        this.store.saveSessionMap(this.sessionMap)
        // live 会话：直接改模型选择 ref，下一 step 生效（不 dispose，历史不断）
        const ref = this.modelSelections.get(entry.id)
        if (ref) ref.current = { provider: picked.provider, model: picked.model }
        this.visionCache.clear() // 模型变了，视觉能力缓存作废
        await this.sendReply(from, contextToken, `🧠 当前会话「${entry.name}」已切换模型：${picked.provider}/${picked.model}\n（历史对话保留，从下一条消息起生效）`)
        return true
      }

      case 'rename': {
        const entry = this.activeEntry(from)
        if (!entry) {
          await this.sendReply(from, contextToken, '你还没有会话，发 /new 新建一个吧')
          return true
        }
        if (!arg) {
          await this.sendReply(from, contextToken, '用法：/rename <新名称>')
          return true
        }
        entry.name = arg
        this.store.saveSessionMap(this.sessionMap)
        // 同步到 harness 会话标题（web 端可见）；服务缺失时只改本地名
        try {
          const agent = this.ctx.agents.get(entry.id)
          const titles = this.ctx.get?.('sessionTitle')
          if (agent && titles?.rename) await titles.rename(agent.session, arg)
        } catch (err) {
          this.pushLog(`同步会话标题失败：${err?.message ?? err}`)
        }
        await this.sendReply(from, contextToken, `✏️ 当前会话已改名为「${arg}」`)
        return true
      }

      case 'del': {
        const rec = this.userRecord(from)
        const n = Number.parseInt(arg, 10)
        if (!rec?.sessions.length) {
          await this.sendReply(from, contextToken, '你还没有会话可删')
          return true
        }
        const idx = n - 1
        const entry = rec.sessions[idx]
        if (!entry) {
          await this.sendReply(from, contextToken, `编号无效（共 ${rec.sessions.length} 个会话），发 /list 查看`)
          return true
        }
        // 停掉 live agent 并清理本插件侧状态；harness 持久化数据保留（仅解除映射）
        try {
          const handle = this.handles.get(entry.id)
          if (handle) await handle.dispose()
        } catch (err) {
          this.pushLog(`dispose 会话 ${entry.id} 失败：${err?.message ?? err}`)
        }
        this.handles.delete(entry.id)
        this.modelSelections.delete(entry.id)
        rec.sessions.splice(idx, 1)
        if (rec.active === entry.id) rec.active = rec.sessions[0]?.id ?? null
        if (!rec.sessions.length) delete this.sessionMap[from]
        this.store.saveSessionMap(this.sessionMap)
        const next = this.activeEntry(from)
        const tail = next ? `已切到「${next.name}」` : '会话已清空，发 /new 新建'
        await this.sendReply(from, contextToken, `🗑️ 已删除「${entry.name}」。${tail}`)
        return true
      }

      default:
        return false // 未知命令不吞消息，按普通消息走模型
    }
  }

  /* ------------------------------ 入站处理 ------------------------------ */

  async handleInbound(msg) {
    const { from, to, contextToken } = msg
    if (!to?.endsWith('@im.bot')) return

    // 正文：文本优先，其次语音转写（P1：腾讯服务端已 ASR，无需本地识别）
    const bodyText = (msg.text || msg.voiceText || '').trim()
    const hasImage = !!msg.image
    if (!bodyText && !hasImage) {
      await this.sendReply(from, contextToken, '这个格式暂不支持（目前支持文字 / 图片 / 语音）🙏')
      return
    }
    this.pushLog(`收：${from.slice(0, 12)}… ${(bodyText || '[图片]').slice(0, 60)}`)

    // # 定向发言：#名称 内容 或 #2 内容——先切到目标会话再继续正常消息流。
    // 目标匹配不到会话时按普通消息处理（不误吞 # 开头的聊天内容）。
    if (bodyText.startsWith('#')) {
      const hm = bodyText.match(/^#(\S+)([\s\S]*)$/)
      const target = hm ? this.resolveSessionRef(from, hm[1]) : null
      if (target) {
        this.switchActive(from, target)
        const rest = (hm[2] ?? '').trim()
        if (!rest && !hasImage) {
          const model = target.provider && target.model ? `${target.provider}/${target.model}` : '默认模型'
          await this.sendReply(from, contextToken, `🔀 已切换到「${target.name}」（${model}）`)
          return
        }
        if (rest) {
          this.pushLog(`定向：${from.slice(0, 12)}… → 「${target.name}」`)
          // 递归走正常消息流（rest 已剥离 # 前缀；不会无限递归：命令/定向分支对 rest 重新判定）
          return this.handleInbound({ ...msg, text: rest, voiceText: undefined })
        }
      }
    }

    // 中文关键词快捷命令（全消息精确匹配，避免误伤正常聊天）
    const CN_CMD = { '列表': '/list', '会话列表': '/list', '帮助': '/help', '模型': '/model', '换模型': '/model' }
    if (CN_CMD[bodyText] && await this.handleCommand(from, contextToken, CN_CMD[bodyText])) return

    // 斜杠命令：/new /list /use /model /rename /del /help、/数字 快捷切换。
    // 命中则直接处理（不进模型、不发 typing）；未命中按普通消息继续。
    if (bodyText.startsWith('/') && await this.handleCommand(from, contextToken, bodyText)) return

    // 正在输入提示；发送失败视为 ticket 可能已失效，清缓存下次重建（review S12）
    const ticket = await this.getTypingTicket(from, contextToken)
    if (ticket) {
      await ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: from, typingTicket: ticket, status: 1, botAgent: this.botAgent })
        .catch(() => { this.typingTickets.delete(from) })
    }

    let agent
    try {
      agent = await this.ensureAgentFor(from)
    } catch (err) {
      await this.sendReply(from, contextToken, `😵 会话准备失败：${err?.message ?? err}`)
      return
    }

    // 图片：仅在模型确实支持视觉时注入 image 块。否则图片块会持久化进会话历史，
    // 导致后续每一轮都把图片重发给纯文本模型 → 每次都报错 → 整段会话「发什么都没反应」。
    let imageBlock = null
    if (hasImage) {
      if (await this.supportsVision(this.currentSelectionFor(agent))) {
        if (this.ctx.attachments) imageBlock = await this.resolveImageBlock(msg.image)
      } else if (!bodyText) {
        // 纯图片 + 模型不看图：不注入、不跑模型，直接友好提示，避免污染历史
        this.stopTypingOnce({ from, typingStopped: false })
        await this.sendReply(from, contextToken, '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述）')
        return
      }
      // 有文字 + 模型不看图：忽略图片，继续按纯文字处理
    }

    const content = []
    if (bodyText) content.push({ type: 'text', text: bodyText })
    if (imageBlock) content.push(imageBlock)

    const userMessage = makeUserMessage({
      content,
      source: { kind: 'plugin', plugin: 'dsh-weixin' },
    })

    await new Promise((resolve) => {
      const pend = { from, contextToken, sessionId: agent.id, resolve, timer: null, typingStopped: false }
      const timer = setTimeout(() => {
        this.pending.delete(userMessage.id)
        this.collectors.delete(userMessage.id)
        this.stopTypingOnce(pend)
        this.sendReply(from, contextToken, '⏰ 处理超时，请稍后再试').finally(resolve)
      }, this.cfg.replyTimeoutMs)
      pend.timer = timer
      this.pending.set(userMessage.id, pend)
      try {
        agent.followup(userMessage)
      } catch (err) {
        // followup 同步抛错（如代理已销毁）：清理 pending/timer 并回错误，避免挂起直到超时
        clearTimeout(timer)
        this.pending.delete(userMessage.id)
        this.pushLog(`followup 失败：${err?.message ?? err}`)
        this.stopTypingOnce(pend) // 同步失败也要取消「正在输入」，否则指示会一直挂着
        this.sendReply(from, contextToken, `😵 处理失败：${err?.message ?? err}`).finally(resolve)
      }
    })
  }

  /** 会话当前生效的模型选择：live ref 优先，其次 agent.options，再其次全局默认。
   *  供视觉检测等需要“当前模型”的场景使用。 */
  currentSelectionFor(agent) {
    const ref = agent?.id ? this.modelSelections.get(agent.id) : null
    if (ref?.current) return ref.current
    return agent?.options ?? {}
  }

  /**
   * 判断会话所用模型是否支持图片输入（保守：无法判断/查不到一律视为不支持）。
   * 结果按 `provider:model` 缓存，避免每张图都请求模型元数据。
   */
  async supportsVision(selection) {
    try {
      const llm = this.ctx.get?.('llm')
      const am = this.ctx.get?.('agentDefaultModel')
      if (!llm) return false
      const sel = am?.currentSelection?.() ?? {}
      const provider = selection?.provider || sel.provider
      const model = selection?.model || sel.model
      if (!provider || !model) return false
      const key = `${provider}:${model}`
      if (this.visionCache.has(key)) return this.visionCache.get(key)
      const info = await llm.resolveModelInfo(provider, model)
      const ok = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      this.visionCache.set(key, ok)
      return ok
    } catch {
      return false
    }
  }

  /** 把微信图片下载解密后存成 Harness 图片附件，返回 image 内容块；失败/超限降级为文本块。 */
  async resolveImageBlock(image) {
    const limits = this.ctx.attachments?.imageLimits
    const maxBytes = limits?.maxImageBytes ?? 0
    try {
      const bytes = await this.downloadImageBytes({
        encryptQueryParam: image.encrypt_query_param,
        fullUrl: image.full_url,
        aesKey: image.aesKey,
      })
      if (maxBytes && bytes.byteLength > maxBytes) {
        this.pushLog(`图片超限 ${bytes.byteLength}B > ${maxBytes}B，略过图片理解`)
        return { type: 'text', text: '[图片过大，未处理]' }
      }
      const attachment = await this.ctx.attachments.saveImage({
        data: bytes, // Buffer 即 Uint8Array
        mediaType: ilink.sniffImageMime(bytes),
      })
      return { type: 'image', attachment }
    } catch (err) {
      this.pushLog(`图片下载/解密/入库失败：${err?.message ?? err}`)
      return { type: 'text', text: '[图片处理失败]' }
    }
  }

  /** 取消「正在输入」指示（status=2），失败静默（review S12）。 */
  stopTyping(userId) {
    const ticket = this.typingTickets.get(userId)
    if (!this.creds?.bot_token || !ticket) return
    ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: userId, typingTicket: ticket, status: 2, botAgent: this.botAgent })
      .catch(() => {})
  }

  /** 幂等取消：同一轮只停一次「正在输入」，超时/同步失败/turn-end 多路共用，避免重复 status=2。 */
  stopTypingOnce(pend) {
    if (!pend || pend.typingStopped) return
    pend.typingStopped = true
    this.stopTyping(pend.from)
  }

  async getTypingTicket(userId, contextToken) {
    if (this.typingTickets.has(userId)) return this.typingTickets.get(userId)
    try {
      const resp = await ilink.getConfig({
        baseUrl: this.creds.baseurl, token: this.creds.bot_token,
        ilinkUserId: userId, contextToken, botAgent: this.botAgent,
      })
      const t = resp?.typing_ticket ?? ''
      this.typingTickets.set(userId, t)
      return t
    } catch {
      return ''
    }
  }

  /* ------------------------------ 事件→回复 ------------------------------ */

  handleSessionEvent(session, event) {
    const sessionId = session.id
    switch (event.type) {
      case 'turn/start':
        this.turns.set(sessionId, event.data?.turn)
        break
      case 'user/message': {
        const msgId = event.data?.id
        const pend = this.pending.get(msgId)
        if (pend) {
          this.collectors.set(msgId, { sessionId, turn: this.turns.get(sessionId), msgId, parts: [], pending: pend })
        }
        break
      }
      case 'assistant/message': {
        const c = this.collectorFor(sessionId, event.data?.turn)
        if (!c) break
        const blocks = event.data?.message?.content ?? []
        const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
        if (texts.length) {
          if (this.cfg.replyMode === 'last') c.parts.length = 0
          c.parts.push(texts.join('\n'))
        }
        break
      }
      case 'turn/end': {
        const c = this.collectorFor(sessionId, event.data?.turn)
        if (!c) break
        this.collectors.delete(c.msgId)
        const { pending, parts, msgId } = c
        // 已超时：pending 已被超时分支移除，说明「处理超时」已发出，勿重复发送完整回复（review I1）
        if (!this.pending.has(msgId)) {
          if (pending.timer) clearTimeout(pending.timer)
          this.stopTypingOnce(pending)
          pending.resolve()
          break
        }
        this.pending.delete(msgId)
        if (pending.timer) clearTimeout(pending.timer)
        const reply = parts.join('\n').trim()
        // 模型报错且无任何助手文本（如「模型不支持图片输入」）时，不再静默吞掉：
        // 给用户一个明确提示，避免像「图片发过去没反应」这种悬空体验。
        let outText = reply
        if (!outText && event.data?.reason?.kind === 'error') {
          const emsg = event.data.reason.error?.message ?? ''
          const ecode = event.data.reason.error?.code ?? ''
          outText = /image|UNSUPPORTED_CONTENT/i.test(`${emsg} ${ecode}`)
            ? '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述）'
            : `😵 处理失败：${emsg || '未知错误'}`
        }
        const send = outText
          ? this.sendReply(pending.from, pending.contextToken, outText + this.sessionTagFor(sessionId))
          : Promise.resolve()
        send.finally(() => {
          this.stopTypingOnce(pending) // 轮次结束取消输入指示（review S12）
          pending.resolve()
        })
        break
      }
      default:
        break
    }
  }

  /** 按 sessionId + turn 找到对应的消息收集器（多会话并发时各自独立）。 */
  collectorFor(sessionId, turn) {
    for (const c of this.collectors.values()) {
      if (c.sessionId === sessionId && c.turn === turn) return c
    }
    return null
  }

  /* ------------------------------ 发送 ------------------------------ */

  /** 调速排队：并发发送也按队列串行预约时间片，保证任意两次发送间隔 ≥ sendIntervalMs（review S6）。 */
  async paceSend() {
    const slot = this.sendQueue.then(async () => {
      const wait = this.lastSendAt + this.cfg.sendIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastSendAt = Date.now()
    })
    this.sendQueue = slot.catch(() => {}) // 单次失败不断链
    return slot
  }

  /** @returns {Promise<boolean>} 是否全部分块发送成功（review S5）。 */
  async sendReply(to, contextToken, text) {
    try {
      for (const piece of chunkText(text, this.cfg.maxChunk)) {
        await this.paceSend() // 每个分块发送前都调速（review I2）
        await this.sendChunk(to, contextToken, piece)
      }
      this.pushLog(`发：${to.slice(0, 12)}… ${text.slice(0, 60)}`)
      return true
    } catch (err) {
      this.pushLog(`发送失败：${err?.message ?? err}`)
      return false
    }
  }

  /** 发送单个分块；独立成方法便于测试打桩计时。 */
  async sendChunk(to, contextToken, piece) {
    await ilink.sendMessage({
      baseUrl: this.creds.baseurl, token: this.creds.bot_token,
      to, text: piece, contextToken, botAgent: this.botAgent,
      onWarn: (w) => this.pushLog(`发送 ${w}`),
    })
  }

  /**
   * 主动推送（无需入站 contextToken）。供 ctx.weixin 服务 / 面板 /weixin/send 路由调用。
   * @param {string} to 微信用户 id；'all' 广播给所有已建会话用户
   * @param {string} text 要发送的文本（超过 maxChunk 会自动切分）
   * @returns {Promise<{sent: number, failed: number, targets: string[]}>} sent/failed 为真实发送结果（而非目标数）
   */
  async push(to, text) {
    if (!this.creds?.bot_token) throw new Error('微信通道未登录，无法推送')
    const targets = to === 'all' ? Object.keys(this.sessionMap) : [to]
    if (targets.length === 0) throw new Error('没有可推送的目标用户')
    // sent/failed 为真实发送结果，而非目标数（review S5）
    let sent = 0
    let failed = 0
    for (const t of targets) {
      if (await this.sendReply(t, undefined, text)) sent += 1
      else failed += 1
    }
    const failNote = failed > 0 ? `（失败 ${failed}）` : ''
    this.pushLog(`主动推送完成：${text.slice(0, 40)} → 成功 ${sent}/${targets.length}${failNote}`)
    return { sent, failed, targets }
  }

  /* ------------------------------ 面板用状态 ------------------------------ */

  statusView() {
    this.pruneLogin() // 显式清理过期的登录终态：读路径本身无副作用（review S3 观察项）
    return {
      connected: this.monitorRunning && !!this.creds?.bot_token,
      loggedInAt: this.creds?.loggedInAt ?? null,
      baseUrl: this.creds?.baseurl ?? null,
      sessionMap: { ...this.sessionMap },
      lastEventAt: this.status.lastEventAt,
      lastError: this.status.lastError,
      login: this.loginView(),
    }
  }

  /** 登录卡片已到终态（confirmed/error/expired）并超过宽限期，就清空 login 状态（review S3）。 */
  pruneLogin(now = Date.now()) {
    const l = this.login
    if (l?.finishedAt && now - l.finishedAt > LOGIN_DONE_GRACE_MS) {
      this.login = null
    }
  }

  /** 纯读：登录卡片视图。不修改状态，清理由 pruneLogin 显式完成。 */
  loginView() {
    const l = this.login
    if (!l) return { active: false }
    return {
      active: true,
      status: l.status,
      hasQr: !!l.qrUrl && !l.finishedAt,
      message: l.message ?? '',
      startedAt: l.startedAt,
    }
  }
}

export function apply(ctx, config) {
  const stateDir = resolveStateDir(config.stateDir)
  const cwd = resolveWorkspaceDir(config.cwd, stateDir)
  const store = createStore(stateDir)
  const channel = new WeixinChannel(ctx, { ...config, cwd }, store)
  registerPanel(ctx, channel)
  // 对外暴露主动推送能力：其它插件 inject ['weixin'] 后用 ctx.weixin.push / sendAll
  ctx.provide('weixin', {
    push: (to, text) => channel.push(to, text),
    sendAll: (text) => channel.push('all', text),
    status: () => channel.statusView(),
    sessions: () => ({ ...channel.sessionMap }),
  })
  registerPushTool(ctx, channel)
}

/** 注册 push_weixin 主动推送工具：把 channel.push 暴露给任意 agent（含 DSH schedule 定时触发回合）。 */
export function registerPushTool(ctx, channel) {
  return ctx.tools.register({
    name: 'push_weixin',
    description: '主动发送一条文本消息到微信。to 为微信用户 id；"all" = 广播给所有已建会话用户；省略 = 发给触发本工具的会话所属微信用户。适合定时任务、告警等主动触达场景。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '微信用户 id（如 user@im.wechat）；"all" 广播所有已建会话；省略 = 触发本工具的会话所属用户' },
        text: { type: 'string', description: '要发送的文本（超过 maxChunk 自动切分）' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'number' },
          failed: { type: 'number' },
          targets: { type: 'array', items: { type: 'string' } },
        },
        required: ['sent', 'failed', 'targets'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `微信推送结果：成功 ${value?.sent ?? 0}，失败 ${value?.failed ?? 0}（目标 ${value?.targets?.length ?? 0}）`,
      }],
    },
    async execute(args, exec) {
      const explicit = args.to && String(args.to).trim()
      let to = explicit || null
      if (!to) {
        // 缺省时优先发给触发本工具的会话所属微信用户（schedule 到点醒来正好对应该用户），否则广播
        const sid = exec?.agent?.id
        // 多会话结构：命中任一「当前会话」为该 sessionId 的用户
        const owner = sid ? Object.keys(channel.sessionMap).find((u) => channel.sessionMap[u]?.active === sid) : undefined
        to = owner || 'all'
      }
      return channel.push(to, String(args.text ?? ''))
    },
  })
}