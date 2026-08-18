/**
 * iLink Bot 协议客户端（微信 ClawBot 官方通道）。
 * 服务端：https://ilinkai.weixin.qq.com，纯 HTTP/JSON。
 * 协议细节对齐腾讯官方 @tencent-weixin/openclaw-weixin 开源包。
 */

import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6 // 对齐官方 2.4.6
const CHANNEL_VERSION = '2.4.6'
const DEFAULT_BOT_AGENT = 'DeepSeek Harness Weixin Channel'
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000

export class ILinkError extends Error {
  constructor(message, { ret, errmsg } = {}) {
    super(message)
    this.name = 'ILinkError'
    this.ret = ret
    this.errmsg = errmsg
  }
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders({ token }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function buildBaseInfo(botAgent) {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: (botAgent || DEFAULT_BOT_AGENT).slice(0, 200),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, signal }) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const controller = timeoutMs ? new AbortController() : undefined
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  // 组合外部中止信号（供 stop/登出打断长轮询）与超时信号
  const signals = [signal, controller?.signal].filter(Boolean)
  try {
    const res = await fetch(new URL(endpoint, base).toString(), {
      method: 'POST',
      headers: buildHeaders({ token }),
      body: JSON.stringify(body),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    })
    const raw = await res.text()
    if (!res.ok) throw new ILinkError(`${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
    return JSON.parse(raw)
  } catch (err) {
    if (err instanceof ILinkError) throw err
    // 长轮询超时/被外部中止都按「无新消息」返回；循环会检查 aborted 决定是否继续
    if (err?.name === 'AbortError' && timeoutMs === LONG_POLL_TIMEOUT_MS) {
      return { ret: 0, msgs: [], get_updates_buf: body?.get_updates_buf ?? '' }
    }
    throw err
  } finally {
    if (t) clearTimeout(t)
  }
}

async function apiGet({ baseUrl, endpoint, timeoutMs }) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const controller = timeoutMs ? new AbortController() : undefined
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const res = await fetch(new URL(endpoint, base).toString(), {
      method: 'GET',
      headers: {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      },
      ...(controller ? { signal: controller.signal } : {}),
    })
    const raw = await res.text()
    if (!res.ok) throw new ILinkError(`${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
    return JSON.parse(raw)
  } catch (err) {
    if (err instanceof ILinkError) throw err
    // 仅长轮询超时视为「尚无新状态」；网络/解析等真实错误抛给调用方，勿静默吞掉（review S7）
    if (err?.name === 'AbortError') return { status: 'wait' }
    throw err
  } finally {
    if (t) clearTimeout(t)
  }
}

/* ------------------------------ 登录 ------------------------------ */

export async function fetchQRCode({ baseUrl = DEFAULT_BASE_URL, botType = '3', localTokenList = [] } = {}) {
  const resp = await apiPost({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList },
    timeoutMs: API_TIMEOUT_MS,
  })
  if (resp.ret && resp.ret !== 0) {
    throw new ILinkError(`get_bot_qrcode ret=${resp.ret}`, { ret: resp.ret, errmsg: resp.errmsg })
  }
  return resp
}

export async function pollQRStatus({ baseUrl = DEFAULT_BASE_URL, qrcode, verifyCode, timeoutMs = LONG_POLL_TIMEOUT_MS }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  return apiGet({ baseUrl, endpoint, timeoutMs })
}

/* ------------------------------ 消息 ------------------------------ */

export async function getUpdates({ baseUrl, token, buf = '', timeoutMs = LONG_POLL_TIMEOUT_MS, botAgent, signal }) {
  return apiPost({
    baseUrl,
    endpoint: 'ilink/bot/getupdates',
    token,
    timeoutMs,
    signal,
    body: { get_updates_buf: buf, base_info: buildBaseInfo(botAgent) },
  })
}

/** 发送文本消息；带限流（ret=-2）指数退避重试。post/backoffBaseMs 为测试注入点（review S10）。 */
export async function sendMessage({
  baseUrl, token, to, text, contextToken, botAgent,
  maxAttempts = 5, onWarn,
  post = apiPost, backoffBaseMs = 1000,
}) {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: text ? [{ type: 1, text_item: { text } }] : [],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: buildBaseInfo(botAgent),
  }
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await post({
        baseUrl, endpoint: 'ilink/bot/sendmessage', token, timeoutMs: API_TIMEOUT_MS, body,
      })
      const ret = resp?.ret ?? 0
      const errmsg = resp?.errmsg ?? ''
      if (ret !== 0) {
        const rateLimited = ret === -2 || /rate/i.test(String(errmsg))
        lastErr = new ILinkError(`sendmessage ret=${ret} errmsg=${errmsg}`, { ret, errmsg })
        if (rateLimited && attempt < maxAttempts) {
          const wait = Math.min(2 ** attempt, 16) * backoffBaseMs
          onWarn?.(`限流（ret=${ret}），${wait / 1000}s 后重试`)
          await sleep(wait)
          continue
        }
        throw lastErr
      }
      return resp
    } catch (err) {
      if (err instanceof ILinkError) throw err
      lastErr = err
      if (attempt < maxAttempts) {
        const wait = Math.min(2 ** attempt, 16) * backoffBaseMs
        onWarn?.(`网络错误重试：${err?.message ?? err}`)
        await sleep(wait)
      }
    }
  }
  throw lastErr ?? new Error('sendMessage 重试耗尽')
}

export async function getConfig({ baseUrl, token, ilinkUserId, contextToken, botAgent }) {
  return apiPost({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    token,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: buildBaseInfo(botAgent),
    },
  })
}

/** status: 1=开始输入 2=取消（TypingStatus）。 */
export async function sendTyping({ baseUrl, token, to, typingTicket, status, botAgent }) {
  return apiPost({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    token,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      ilink_user_id: to,
      ...(typingTicket ? { typing_ticket: typingTicket } : {}),
      status,
      base_info: buildBaseInfo(botAgent),
    },
  })
}

export async function notifyStart({ baseUrl, token, botAgent }) {
  return apiPost({
    baseUrl, endpoint: 'ilink/bot/msg/notifystart', token, timeoutMs: API_TIMEOUT_MS,
    body: { base_info: buildBaseInfo(botAgent) },
  })
}

export async function notifyStop({ baseUrl, token, botAgent }) {
  return apiPost({
    baseUrl, endpoint: 'ilink/bot/msg/notifystop', token, timeoutMs: API_TIMEOUT_MS,
    body: { base_info: buildBaseInfo(botAgent) },
  })
}

/* ------------------------------ 媒体（CDN 下载/解密） ------------------------------ */

/** 微信 CDN 域名（图片/语音/文件下载、上传），与 ilink 主站分离。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** attachment 服务只收这 4 种栅格图。 */
const VALID_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** 从字节头嗅探图片 MIME；未识别回退 image/jpeg（微信图片基本是 JPEG）。 */
export function sniffImageMime(buf) {
  if (buf?.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf?.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf?.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buf?.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

/** 解析 CDN 媒体 aes_key（两种编码：base64(16 字节) 或 base64(32 位 hex 字符串)）。 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64 ?? '', 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key 无法解析为 16 字节密钥（解码长度=${decoded.length}）`)
}

/** AES-128-ECB 解密（PKCS7，无 IV）。 */
export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * 下载并解密 CDN 图片，返回明文 Buffer（失败抛错）。
 * image = { encrypt_query_param, full_url, aesKey }；aesKey 为空表示明文 CDN。
 * fetchImpl 为测试注入点。
 */
export async function downloadImageBytes({ encryptQueryParam, fullUrl, aesKey, cdnBaseUrl = CDN_BASE_URL, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS }) {
  const url = fullUrl || `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam ?? '')}`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new ILinkError(`CDN 下载 HTTP ${res.status}`)
    const encrypted = Buffer.from(await res.arrayBuffer())
    if (!aesKey) return encrypted // 明文 CDN（无密钥）
    return decryptAesEcb(encrypted, parseAesKey(aesKey))
  } finally {
    clearTimeout(t)
  }
}

/** getupdates 响应 → 轻量入站消息列表。 */
export function normalizeInboundMessages(resp) {
  const out = []
  for (const raw of resp?.msgs ?? []) {
    const from = raw?.from_user_id
    const to = raw?.to_user_id
    const contextToken = raw?.context_token
    const items = Array.isArray(raw?.item_list) ? raw.item_list : []
    const texts = items
      .filter((it) => it?.type === 1 && it?.text_item?.text != null)
      .map((it) => String(it.text_item.text))
    // 语音：voice_item.text 是腾讯服务端转写结果，直接用（P1 收语音无需本地 ASR）
    const voiceTexts = items
      .filter((it) => it?.type === 3 && it?.voice_item?.text != null)
      .map((it) => String(it.voice_item.text))
    const nonTextTypes = items.filter((it) => it?.type !== 1).map((it) => it?.type)

    // 首张图片的下载信息（喂给 downloadImageBytes）。aeskey 可能是 hex（image_item.aeskey）或 base64（media.aes_key）。
    let image = null
    const imgItem = items.find((it) => it?.type === 2 && it?.image_item?.media)
    if (imgItem) {
      const m = imgItem.image_item.media
      const aeskeyHex = imgItem.image_item.aeskey
      image = {
        encrypt_query_param: m.encrypt_query_param ?? '',
        full_url: m.full_url ?? '',
        aesKey: aeskeyHex ? Buffer.from(aeskeyHex, 'hex').toString('base64') : (m.aes_key ?? ''),
      }
    }

    if (from && (texts.length > 0 || voiceTexts.length > 0 || nonTextTypes.length > 0)) {
      out.push({
        from, to, contextToken,
        text: texts.join('\n'),
        voiceText: voiceTexts.join('\n'),
        hasText: texts.length > 0 || voiceTexts.length > 0,
        image,
        nonTextTypes,
      })
    }
  }
  return out
}
