/**
 * 状态存储测试：credentials.json 权限（review I4）与原子写（review S9）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../src/creds.mjs'

test('保存凭据以 0o600 写入且不残留临时文件（review I4/S9）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-creds-'))
  try {
    const store = createStore(dir)
    store.saveCredentials({ bot_token: 'secret-token', baseurl: 'https://ilinkai.weixin.qq.com' })

    const credFile = path.join(dir, 'credentials.json')
    assert.ok(fs.existsSync(credFile), '应生成 credentials.json')
    const mode = fs.statSync(credFile).mode & 0o777
    assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`)

    // 原子写完成后不应残留 .tmp 临时文件
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
