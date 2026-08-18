/**
 * bin/login.mjs 导入冒烟测试（防 C1 回归）。
 *
 * 背景：bin/login.mjs 曾用相对 './src/...' 导入，解析成 bin/src/...（不存在），
 * CLI 登录启动即 ERR_MODULE_NOT_FOUND；npm test（node --test）不覆盖 bin/，
 * 导致坏 bin 被 prepublishOnly 放行发布到 npm。
 *
 * 做法：spawn 真实 bin 干跑（给个临时 stateDir），断言：
 *   1) 输出不包含模块解析错误（ERR_MODULE_NOT_FOUND / Cannot find module）；
 *   2) 输出包含 main() 启动的提示行，证明「导入成功且真正跑到了业务逻辑」。
 * 网络阶段（向 iLink 取二维码）允许失败——超时则强杀，不影响判定。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'login.mjs')

test('bin/login.mjs 导入可用且能启动（无 MODULE_NOT_FOUND）', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-weixin-bin-'))

  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, stateDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ out, timedOut: true })
    }, 2000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve({ out, timedOut: false }) })
  })

  try {
    // 关键：模块解析不能失败
    assert.doesNotMatch(run.out, /ERR_MODULE_NOT_FOUND|Cannot find module/, `输出里出现了模块解析错误：\n${run.out}`)
    // 证明导入成功、main() 真正启动（此句在 main 内、网络请求之前打印）
    assert.match(run.out, /正在向腾讯 iLink 服务器申请登录二维码/, `未看到 main() 启动提示：\n${run.out}`)
  } finally {
    await rm(stateDir, { recursive: true, force: true }) // 清理临时状态目录
  }
})
