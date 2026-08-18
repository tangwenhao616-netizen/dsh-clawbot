/**
 * 插件状态存储：凭证（bot_token/baseurl）、微信用户→会话映射、getupdates 游标。
 * 状态目录由 Config.stateDir 决定；默认落在 $DSH_HOME/dsh-weixin/（无则 ~/.dsh/dsh-weixin/）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 解析状态目录：优先 Config.stateDir，其次 $DSH_HOME，最后 ~/.dsh。 */
export function resolveStateDir(configStateDir) {
  if (configStateDir && String(configStateDir).trim()) return path.resolve(String(configStateDir).trim())
  const home = process.env.DSH_HOME?.trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-weixin')
}

/** 解析 agent 工作目录（会话命名空间 + 文件工具根）。Config.cwd 为空时取 stateDir/workspace，保证跨重启稳定。 */
export function resolveWorkspaceDir(configCwd, stateDir) {
  if (configCwd && String(configCwd).trim()) return path.resolve(String(configCwd).trim())
  return path.join(path.resolve(stateDir), 'workspace')
}

function loadJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return def
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 原子写 + 0600 权限：先写临时文件再 rename，避免中途崩溃留下半截文件；
  // 0o600 防止 bot_token 等凭据对同机其它用户可读（review I4、S9）
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * 会话映射多会话格式迁移：
 *   旧版 { userId: "session-xxx" }
 *   新版 { userId: { active, sessions: [{ id, name, provider, model, createdAt, lastActiveAt }] } }
 * provider/model 为该会话记忆的模型选择；null 表示跟随默认/会话日志。
 */
export function migrateSessionMap(raw) {
  const out = {}
  let changed = false
  for (const [userId, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') {
      changed = true
      const now = new Date().toISOString()
      out[userId] = {
        active: value,
        sessions: [{ id: value, name: '默认', provider: null, model: null, createdAt: now, lastActiveAt: now }],
      }
    } else if (value && Array.isArray(value.sessions)) {
      out[userId] = value
    } else {
      changed = true // 无法识别的条目直接丢弃，避免污染新格式
    }
  }
  return { map: out, migrated: changed }
}

/** 以 stateDir 为根创建状态存储。 */
export function createStore(stateDir) {
  const dir = path.resolve(stateDir)
  const credFile = path.join(dir, 'credentials.json')
  const sessionMapFile = path.join(dir, 'session-map.json')
  const bufFile = path.join(dir, 'updates-buf.json')

  return {
    dir,
    loadCredentials: () => loadJson(credFile, null),
    saveCredentials: (cred) => saveJson(credFile, cred),
    // 加载时自动把旧版 1:1 映射升级为多会话结构（migrated 为 true 时调用方应立刻写回）
    loadSessionMap: () => migrateSessionMap(loadJson(sessionMapFile, {})),
    saveSessionMap: (map) => saveJson(sessionMapFile, map),
    loadBuf: () => {
      const d = loadJson(bufFile, null)
      return typeof d?.buf === 'string' ? d.buf : ''
    },
    saveBuf: (buf) => saveJson(bufFile, { buf, savedAt: Date.now() }),
  }
}