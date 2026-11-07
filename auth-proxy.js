#!/usr/bin/env node
/**
 * dsh-auth-proxy — minimal password gate in front of the dsh web server.
 *
 * Built into the image (default on, env DSH_AUTH=1). dsh itself binds only
 * 127.0.0.1:DSH_INTERNAL_PORT; this gate binds 0.0.0.0:PORT and forwards to
 * it, so nothing else on the network can reach dsh.
 *
 * Flow:
 *   - No password registered yet -> every request is redirected to /register;
 *     POST /register stores a scrypt(password, salt) hash in
 *     DSH_AUTH_DIR/password.json (persisted on the volume).
 *   - Afterwards /login verifies the password and issues an HMAC-signed
 *     session cookie (30 days, HttpOnly, SameSite=Lax).
 *   - Everything else requires a valid cookie: browser navigations are
 *     redirected to /login, API/asset requests get 401.
 *   - With DSH_MANUAL_OAUTH=1 the account login uses a loopback redirect_uri
 *     that the browser cannot reach; /oauth/manual (behind the same password
 *     gate) accepts the failed callback URL and relays it to dsh server-side.
 *   - Authenticated traffic is proxied to dsh with the Host header rewritten
 *     to loopback and the Origin header stripped, so dsh's own browser-trust
 *     fence passes without any DSH_TRUSTED_HOSTS configuration.
 *
 * Reset: delete DSH_AUTH_DIR (e.g. /data/auth) and the next visit shows the
 * registration page again.
 *
 * Zero dependencies: node:http + node:crypto only.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PUBLIC_PORT = Number(process.env.PORT || 3080)
const INTERNAL_PORT = Number(process.env.DSH_INTERNAL_PORT || 3081)
const AUTH_DIR = process.env.DSH_AUTH_DIR || '/data/auth'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const MIN_PASSWORD = 8
const MAX_LOGIN_FAILS = 10
const LOCKOUT_MS = 5 * 60 * 1000
// DSH_AUTH=0 keeps the gate as the public listener (dsh 0.2.2+ rejects
// wildcard binds) but forwards every request without a password.
const AUTH_DISABLED = process.env.DSH_AUTH === '0'
// The DeepSeek Platform only accepts a loopback redirect_uri. With
// DSH_MANUAL_OAUTH=1 the build patch forces non-loopback callers to
// http://127.0.0.1:DSH_INTERNAL_PORT; the browser cannot reach that URL, so
// the gate exposes /oauth/manual to relay the pasted callback server-side.
const MANUAL_OAUTH = process.env.DSH_MANUAL_OAUTH === '1'

// dsh 0.2.2+ prints a per-process launch token and only mints its browser
// cookie for a GET / carrying that token. The entrypoint captures the token
// from the dsh log and hands it to the gate; the gate injects it on the first
// authenticated page load, then dsh's own dsh-auth-* cookie takes over.
const LAUNCH_TOKEN = process.env.DSH_LAUNCH_TOKEN || ''
const DSH_COOKIE_PREFIX = 'dsh-auth-'

function dshCookieNames(cookieHeader) {
  return (cookieHeader || '')
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter((name) => name.startsWith(DSH_COOKIE_PREFIX))
}

function hasDshCookie(req) {
  return dshCookieNames(req.headers.cookie).length > 0
}

function upstreamPath(req) {
  if (!LAUNCH_TOKEN || req.method !== 'GET' || hasDshCookie(req)) return req.url
  const url = new URL(req.url, 'http://local')
  if (url.pathname !== '/') return req.url
  url.searchParams.set('token', LAUNCH_TOKEN)
  return url.pathname + url.search
}

const passwordFile = path.join(AUTH_DIR, 'password.json')
const secretFile = path.join(AUTH_DIR, 'secret')

fs.mkdirSync(AUTH_DIR, { recursive: true })

let secret
if (!AUTH_DISABLED) {
  try {
    secret = fs.readFileSync(secretFile)
  } catch {
    secret = crypto.randomBytes(32)
    fs.writeFileSync(secretFile, secret, { mode: 0o600 })
  }
}

const hasPassword = () => fs.existsSync(passwordFile)

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return dflt }
}

function verifyPasswordSync(password, record) {
  try {
    const expected = crypto.scryptSync(password, Buffer.from(record.salt, 'hex'), 64)
    return crypto.timingSafeEqual(expected, Buffer.from(record.hash, 'hex'))
  } catch { return false }
}

// Password managed by the operator via env (recommended for RainYun): the
// password lives in the deployment spec, not only on the volume, so a volume
// wipe/recreation cannot reset access back to the registration page. When set,
// the gate (re)creates the password file from it at startup.
if (!AUTH_DISABLED && process.env.DSH_AUTH_PASSWORD) {
  const pw = process.env.DSH_AUTH_PASSWORD
  if (pw.length < MIN_PASSWORD) {
    console.error(`[auth] FATAL: DSH_AUTH_PASSWORD is shorter than ${MIN_PASSWORD} characters`)
    process.exit(1)
  }
  const record = readJson(passwordFile, null)
  if (record && verifyPasswordSync(pw, record)) {
    console.log('[auth] password file matches DSH_AUTH_PASSWORD')
  } else {
    const salt = crypto.randomBytes(16)
    const hash = crypto.scryptSync(pw, salt, 64)
    fs.writeFileSync(passwordFile, JSON.stringify({
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      created: new Date().toISOString(),
      source: 'env',
    }, null, 2), { mode: 0o600 })
    console.log(record
      ? '[auth] password file was missing/mismatched — recreated from DSH_AUTH_PASSWORD'
      : '[auth] password created from DSH_AUTH_PASSWORD (registration page disabled)')
  }
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

async function verifyPassword(password, record) {
  try {
    const expected = await scryptHash(password, Buffer.from(record.salt, 'hex'))
    return crypto.timingSafeEqual(expected, Buffer.from(record.hash, 'hex'))
  } catch { return false }
}

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url')
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function verifySession(value) {
  if (!value) return false
  const dot = value.indexOf('.')
  if (dot <= 0) return false
  const payload = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof p.exp === 'number' && p.exp > Date.now()
  } catch { return false }
}

function cookieSession(req) {
  const m = /(?:^|;\s*)dsh_session=([^;]+)/.exec(req.headers.cookie || '')
  if (!m) return false
  try {
    return verifySession(decodeURIComponent(m[1]))
  } catch {
    return false // malformed cookie must never crash the gate
  }
}

// ---- trivial per-IP rate limit for /login ----
const fails = new Map()
function rateAllowed(ip) {
  const r = fails.get(ip)
  if (!r) return true
  if (r.until > Date.now()) return false
  fails.delete(ip)
  return true
}
function rateFail(ip) {
  const r = fails.get(ip) || { n: 0, until: 0 }
  r.n += 1
  if (r.n >= MAX_LOGIN_FAILS) { r.until = Date.now() + LOCKOUT_MS; r.n = 0 }
  fails.set(ip, r)
}
function rateOk(ip) { fails.delete(ip) }

// ---- tiny inline pages ----
const base = (title, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:32px;width:320px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
h2{margin:0 0 6px;font-size:18px}p.note{margin:0 0 20px;color:#8b93a1;font-size:13px;line-height:1.6}
input{width:100%;box-sizing:border-box;padding:10px 12px;margin:6px 0 14px;border:1px solid #2c3340;border-radius:8px;background:#10131a;color:#e6e8eb;font-size:14px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#4f7cff;color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#3f66d9}.err{color:#ff6b6b;font-size:13px;margin:0 0 12px}
</style></head><body><div class="card">${body}</div></body></html>`

const registerPage = (err = '') => base('设置访问密码', `
<h2>首次使用：设置访问密码</h2>
<p class="note">此实例尚未设置密码。请设置一个至少 ${MIN_PASSWORD} 位的密码，之后访问都需要登录。</p>
${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/register">
  <input type="password" name="password" placeholder="设置密码（至少 ${MIN_PASSWORD} 位）" minlength="${MIN_PASSWORD}" required autofocus>
  <input type="password" name="confirm" placeholder="确认密码" minlength="${MIN_PASSWORD}" required>
  <button type="submit">创建密码</button>
</form>`)

const loginPage = (err = '') => base('登录', `
<h2>登录</h2>
<p class="note">请输入访问密码。</p>
${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/login">
  <input type="password" name="password" placeholder="密码" required autofocus>
  <button type="submit">登录</button>
</form>`)

function sendHtml(res, code, html) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---- manual OAuth callback bridge (DSH_MANUAL_OAUTH=1) ----
// The Platform redirects to http://127.0.0.1:DSH_INTERNAL_PORT/oauth/callback,
// which only exists inside the container. The user copies that failed URL from
// the login popup's address bar; the gate validates it and performs the
// callback against dsh's loopback listener on the user's behalf.
const manualPage = (err = '') => base('完成账号登录', `
<h2>完成账号登录</h2>
<p class="note">在账号登录弹窗中完成授权后，浏览器会跳转到 <code>127.0.0.1</code> 并提示无法访问。复制地址栏中的完整 URL（包含 code 和 state），粘贴到下面完成登录。</p>
${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/oauth/manual">
  <input type="url" name="callback" placeholder="http://127.0.0.1:3081/oauth/callback?code=...&amp;state=..." required autofocus>
  <button type="submit">完成登录</button>
</form>
<p class="note" style="margin-top:16px;margin-bottom:0"><a href="/" style="color:#8ab4ff">返回应用</a></p>`)

const manualDonePage = () => base('登录完成', `
<h2>登录完成</h2>
<p class="note">DeepSeek 账号已登录。关闭账号登录弹窗，返回应用即可。</p>
<p style="margin:20px 0 0"><a href="/" style="color:#8ab4ff">返回应用</a></p>`)

function parseManualCallback(value) {
  let url
  try { url = new URL(value) } catch { return { error: '无法解析这个 URL' } }
  if (url.protocol !== 'http:') return { error: '只接受 http:// 本机回调地址' }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return { error: '回调地址必须是本机 loopback（127.0.0.1 / localhost / [::1]）' }
  }
  if (!url.port) return { error: '回调地址缺少端口' }
  if (url.pathname !== '/oauth/callback') return { error: '回调地址路径必须是 /oauth/callback' }
  const codes = url.searchParams.getAll('code')
  const states = url.searchParams.getAll('state')
  if (codes.length !== 1 || states.length !== 1) return { error: '回调地址必须恰好包含一个 code 和一个 state' }
  const code = codes[0]
  const state = states[0]
  if (!code || !state) return { error: '回调地址缺少 code 或 state' }
  if (code.length > 4096 || state.length > 512) return { error: '回调参数过长' }
  return { code, state }
}

function relayManualCallback(code, state) {
  return new Promise((resolve) => {
    const path = `/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
    const headers = {
      host: `127.0.0.1:${INTERNAL_PORT}`,
      accept: 'text/html',
      'cache-control': 'no-cache',
    }
    const req = http.request({ host: '127.0.0.1', port: INTERNAL_PORT, path, method: 'GET', headers }, (ures) => {
      ures.resume()
      ures.on('end', () => resolve({ status: ures.statusCode || 0, location: ures.headers.location || '' }))
    })
    req.on('error', () => resolve({ status: 0, location: '' }))
    req.setTimeout(60000, () => {
      req.destroy()
      resolve({ status: 0, location: '' })
    })
    req.end()
  })
}

// ---- forward authenticated traffic to dsh (loopback, Host rewritten) ----
function forward(req, res) {
  const headers = { ...req.headers }
  headers.host = `127.0.0.1:${INTERNAL_PORT}`
  delete headers.origin // dsh fence compares Origin to Host; rewritten Host is loopback
  const url = new URL(req.url, 'http://local')
  const up = http.request({
    host: '127.0.0.1', port: INTERNAL_PORT, path: upstreamPath(req), method: req.method, headers,
  }, (ures) => {
    // A dsh-auth-* cookie from a previous dsh process fails signature checks
    // after a restart. Clear it and let the browser retry, so the gate can
    // inject the new launch token instead of looping on 401.
    if (req.method === 'GET' && url.pathname === '/' && ures.statusCode === 401 && hasDshCookie(req)) {
      const clears = dshCookieNames(req.headers.cookie)
        .map((name) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
      res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'set-cookie': clears })
      ures.resume()
      res.end()
      return
    }
    res.writeHead(ures.statusCode, ures.headers)
    ures.pipe(res)
  })
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('bad gateway')
  })
  req.pipe(up)
}

const server = http.createServer(async (req, res) => {
  const pathname = (new URL(req.url, 'http://local')).pathname
  const ip = req.socket.remoteAddress || '?'

  if (AUTH_DISABLED) {
    forward(req, res)
    return
  }

  if (!hasPassword()) {
    if (pathname === '/register') {
      if (req.method === 'POST') {
        let params
        try {
          params = new URLSearchParams(await readBody(req))
        } catch { return sendHtml(res, 400, registerPage('请求无效')) }
        const pw = params.get('password') || ''
        const cf = params.get('confirm') || ''
        if (pw.length < MIN_PASSWORD) return sendHtml(res, 400, registerPage(`密码至少 ${MIN_PASSWORD} 位`))
        if (pw !== cf) return sendHtml(res, 400, registerPage('两次输入的密码不一致'))
        const salt = crypto.randomBytes(16)
        const hash = await scryptHash(pw, salt)
        fs.writeFileSync(passwordFile, JSON.stringify({
          salt: salt.toString('hex'), hash: hash.toString('hex'), created: new Date().toISOString(),
        }, null, 2), { mode: 0o600 })
        console.log('[auth] password registered (restart-safe, stored on volume)')
        res.writeHead(302, { location: '/login' })
        return res.end()
      }
      return sendHtml(res, 200, registerPage())
    }
    res.writeHead(302, { location: '/register' })
    return res.end()
  }

  if (pathname === '/login') {
    if (req.method === 'POST') {
      if (!rateAllowed(ip)) return sendHtml(res, 429, loginPage('尝试过于频繁，请 5 分钟后再试'))
      let params
      try { params = new URLSearchParams(await readBody(req)) } catch { return sendHtml(res, 400, loginPage('请求无效')) }
      const record = readJson(passwordFile, null)
      const ok = !!record && await verifyPassword(params.get('password') || '', record)
      if (!ok) {
        rateFail(ip)
        return sendHtml(res, 401, loginPage('密码错误'))
      }
      rateOk(ip)
      const maxAge = Math.floor(SESSION_TTL_MS / 1000)
      res.writeHead(302, {
        location: '/',
        'set-cookie': `dsh_session=${signSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      })
      return res.end()
    }
    return sendHtml(res, 200, loginPage())
  }

  if (pathname === '/logout') {
    res.writeHead(302, { location: '/login', 'set-cookie': 'dsh_session=; Path=/; HttpOnly; Max-Age=0' })
    return res.end()
  }

  if (!cookieSession(req)) {
    const accept = req.headers.accept || ''
    if (accept.includes('text/html')) {
      res.writeHead(302, { location: '/login' })
      res.end()
    } else {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
    }
    return
  }

  if (pathname === '/oauth/manual') {
    if (!MANUAL_OAUTH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('manual OAuth bridge is disabled; set DSH_MANUAL_OAUTH=1 and restart')
      return
    }
    if (req.method !== 'POST') return sendHtml(res, 200, manualPage())
    let params
    try { params = new URLSearchParams(await readBody(req)) } catch { return sendHtml(res, 400, manualPage('请求无效')) }
    const parsed = parseManualCallback(params.get('callback') || '')
    if (parsed.error) return sendHtml(res, 400, manualPage(parsed.error))
    const result = await relayManualCallback(parsed.code, parsed.state)
    console.log(`[auth] manual oauth relay status=${result.status}`)
    if (result.status === 302 && result.location.includes('/dsh/authorized')) {
      return sendHtml(res, 200, manualDonePage())
    }
    if (result.status === 400) return sendHtml(res, 400, manualPage('回调 URL 无效或已过期，请返回应用重新发起登录'))
    if (result.status === 410) return sendHtml(res, 410, manualPage('该登录请求已完成或已过期，请返回应用重新发起登录'))
    if (result.status === 404) return sendHtml(res, 400, manualPage('没有进行中的登录请求。请先在应用中点击账号登录，再粘贴回调 URL'))
    if (result.status === 401 || result.status === 302) {
      return sendHtml(res, 502, manualPage('回调未完成：内部服务要求重新认证或返回了重定向。请刷新应用页面后重试'))
    }
    if (result.status === 0) return sendHtml(res, 502, manualPage('无法连接内部 dsh 服务，请检查容器日志'))
    return sendHtml(res, 502, manualPage('登录失败，请返回应用重新发起登录（code 可能已过期或已被使用）'))
  }

  forward(req, res)
})

// WebSocket/upgrade forwarding (same gate + Host rewrite)
server.on('upgrade', (req, socket) => {
  if (!AUTH_DISABLED && !cookieSession(req)) { socket.destroy(); return }
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` }
  delete headers.origin
  const up = http.request({ host: '127.0.0.1', port: INTERNAL_PORT, path: req.url, headers, method: req.method })
  const relayResponse = (ures) => {
    const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage || ''}`]
    for (let i = 0; i < ures.rawHeaders.length; i += 2) {
      lines.push(`${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    return lines
  }
  up.on('upgrade', (ures, usock, head) => {
    relayResponse(ures)
    if (head && head.length) usock.unshift(head)
    usock.pipe(socket)
    socket.pipe(usock)
    usock.on('error', () => socket.destroy())
    socket.on('error', () => usock.destroy())
  })
  up.on('response', (ures) => {
    relayResponse(ures)
    ures.pipe(socket)
    ures.on('error', () => socket.destroy())
  })
  up.on('error', () => socket.destroy())
  up.end()
})

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`[auth] gate listening on 0.0.0.0:${PUBLIC_PORT} -> 127.0.0.1:${INTERNAL_PORT}`)
  if (AUTH_DISABLED) {
    console.log('[auth] authentication disabled (DSH_AUTH=0); gate is a pass-through proxy')
  } else {
    console.log(hasPassword()
      ? '[auth] password already set; /login required'
      : '[auth] no password yet; first visit will ask to register one')
  }
})
