#!/usr/bin/env node
/**
 * dsh-weixin 扫码登录（CLI 备选；首选在面板 http://<host>/weixin 登录）。
 * 手机端前置：微信「设置 → 插件 → ClawBot」（iOS ≥ 8.0.70；安卓灰度中）。
 * 凭据写入状态目录（默认 $DSH_HOME/dsh-weixin/credentials.json），插件重启后自动读取。
 *
 * 用法：node bin/login.mjs [stateDir]
 */

import readline from 'node:readline'
import qrcode from 'qrcode-generator'
import * as ilink from '../src/ilink.mjs'
import { createStore, resolveStateDir } from '../src/creds.mjs'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_QR_REFRESH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readLineFromStdin(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()) })
  })
}

/** 用 qrcode-generator 的矩阵画终端二维码（半块字符，含静区）。 */
function renderQr(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const QZ = 2
  const dark = (r, c) => r >= QZ && r < n + QZ && c >= QZ && c < n + QZ && qr.isDark(r - QZ, c - QZ)
  const lines = []
  for (let r = QZ - 1; r < n + QZ; r += 2) {
    let line = ''
    for (let c = QZ - 1; c < n + QZ; c++) {
      const top = dark(r, c)
      const bot = dark(r + 1, c)
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

async function main() {
  const stateDir = resolveStateDir(process.argv[2] ?? '')
  const store = createStore(stateDir)
  const existing = store.loadCredentials()
  const localTokenList = existing?.bot_token ? [existing.bot_token] : []
  console.log(`\n🔑 正在向腾讯 iLink 服务器申请登录二维码（状态目录 ${store.dir}）…`)

  let apiBaseUrl = ilink.DEFAULT_BASE_URL
  let qr = await ilink.fetchQRCode({ localTokenList })
  let qrcodeValue = qr?.qrcode
  let qrUrl = qr?.qrcode_img_content
  if (!qrcodeValue || !qrUrl) throw new Error(`get_bot_qrcode 响应缺少字段：${JSON.stringify(qr).slice(0, 300)}`)

  console.log('\n📱 请用手机微信扫描下方二维码（微信 → 设置 → 插件 → ClawBot）：\n')
  console.log(renderQr(qrUrl))
  console.log(`\n若二维码无法显示，可打开链接：${qrUrl}`)

  const startedAt = Date.now()
  let pendingVerifyCode
  let qrRefreshCount = 0
  let scannedPrinted = false
  console.log('\n⏳ 等待扫码确认（5 分钟内有效）…')

  let pollFailures = 0
  for (;;) {
    if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
      console.error('❌ 超时未完成登录，请重新运行 node bin/login.mjs')
      process.exit(1)
    }
    let status
    try {
      status = await ilink.pollQRStatus({ baseUrl: apiBaseUrl, qrcode: qrcodeValue, verifyCode: pendingVerifyCode })
      pollFailures = 0
    } catch (err) {
      // 瞬时网络错误容忍：连续 3 次才终止，避免一次抖动废掉整个登录（review 二轮 N2）
      pollFailures += 1
      if (pollFailures >= 3) throw err
      console.warn(`⚠️ 轮询瞬时错误（${pollFailures}/3）：${err?.message ?? err}，稍后重试…`)
      await sleep(1000 * pollFailures)
      continue
    }
    switch (status.status) {
      case 'wait':
        break
      case 'scaned':
        if (pendingVerifyCode) pendingVerifyCode = undefined
        if (!scannedPrinted) { console.log('\n🟡 已扫码，正在验证…'); scannedPrinted = true }
        break
      case 'need_verifycode': {
        const prompt = pendingVerifyCode
          ? '❌ 输入不匹配，请重新输入手机微信显示的数字：'
          : '🔢 手机微信上显示了数字验证码，请在此输入：'
        pendingVerifyCode = await readLineFromStdin(prompt)
        continue
      }
      case 'expired': {
        qrRefreshCount += 1
        if (qrRefreshCount > MAX_QR_REFRESH) { console.error('❌ 二维码多次过期'); process.exit(1) }
        console.log(`\n🔄 二维码过期，刷新（${qrRefreshCount}/${MAX_QR_REFRESH}）…`)
        qr = await ilink.fetchQRCode({ localTokenList })
        qrcodeValue = qr?.qrcode; qrUrl = qr?.qrcode_img_content
        console.log(renderQr(qrUrl))
        pendingVerifyCode = undefined; scannedPrinted = false
        break
      }
      case 'verify_code_blocked': {
        pendingVerifyCode = undefined
        console.warn('⛔ 验证码多次错误，刷新二维码')
        qrRefreshCount += 1
        if (qrRefreshCount > MAX_QR_REFRESH) { console.error('❌ 多次失败'); process.exit(1) }
        qr = await ilink.fetchQRCode({ localTokenList })
        qrcodeValue = qr?.qrcode; qrUrl = qr?.qrcode_img_content
        console.log(renderQr(qrUrl))
        scannedPrinted = false
        break
      }
      case 'binded_redirect':
        if (existing?.bot_token) {
          console.log('\n✅ 该微信已绑定，沿用现有凭据（重启 dsh web 后插件自动生效）')
          return
        }
        qrRefreshCount += 1
        if (qrRefreshCount > MAX_QR_REFRESH) { console.error('❌ 该微信已绑定其它机器人，无法获取新凭据'); process.exit(1) }
        console.log(`\n🔄 该微信已绑定其它机器人，刷新二维码（${qrRefreshCount}/${MAX_QR_REFRESH}）…`)
        qr = await ilink.fetchQRCode({ localTokenList })
        qrcodeValue = qr?.qrcode; qrUrl = qr?.qrcode_img_content
        console.log(renderQr(qrUrl))
        pendingVerifyCode = undefined; scannedPrinted = false
        break
      case 'scaned_but_redirect':
        if (status.redirect_host) {
          apiBaseUrl = `https://${status.redirect_host}`
          console.log(`\n🔄 服务器要求切换轮询节点：${status.redirect_host}`)
        }
        break
      case 'confirmed': {
        const token = status.bot_token ?? status.token
        const baseurl = status.baseurl ?? apiBaseUrl
        if (!token) { console.error('❌ 确认响应缺少 bot_token'); process.exit(1) }
        store.saveCredentials({
          bot_token: token, baseurl,
          ilink_bot_id: status.ilink_bot_id, ilink_user_id: status.ilink_user_id,
          loggedInAt: Date.now(),
        })
        console.log(`\n🎉 登录成功！凭据已保存：${store.dir}/credentials.json`)
        console.log('   重启 dsh web 后插件自动生效；或直接在面板 /weixin 操作。')
        return
      }
      default:
        console.log(`   当前状态：${status.status}`)
        break
    }
    await sleep(1000)
  }
}

main().catch((err) => {
  console.error('❌ 登录失败：', err?.message ?? err)
  process.exit(1)
})