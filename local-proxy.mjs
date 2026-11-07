// local-proxy.mjs — run this on YOUR machine, not on the server.
//
// dsh 0.2.2-rc.1 only accepts an OAuth callback on a loopback HTTP origin
// (http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port>).
// A server-side reverse proxy cannot change window.location.origin, so the
// browser must literally open a loopback URL. This script listens there and
// forwards everything to the remote dsh gate, including the WebSocket.
//
// Usage:
//   node local-proxy.mjs <upstream-url> [local-port]
//
// Examples:
//   node local-proxy.mjs http://203.0.113.10:3080
//   node local-proxy.mjs https://xxxx.monkeycode-ai.online 13080
//
// Then open http://127.0.0.1:13080 in the browser and sign in as usual.
//
// Self-signed upstream certificate only:
//   LOCAL_PROXY_INSECURE=1 node local-proxy.mjs https://...
import http from 'node:http'
import https from 'node:https'

const upstreamUrl = process.argv[2]
const localPort = Number(process.argv[3] || 13080)

if (!upstreamUrl || !Number.isInteger(localPort) || localPort <= 0) {
  console.error('usage: node local-proxy.mjs <upstream-url> [local-port]')
  process.exit(2)
}

const upstream = new URL(upstreamUrl)
if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
  console.error('upstream-url must start with http:// or https://')
  process.exit(2)
}

const isTls = upstream.protocol === 'https:'
const transport = isTls ? https : http
const basePath = upstream.pathname.replace(/\/+$/, '')
const localOrigin = `http://127.0.0.1:${localPort}`

function joinPath(url) {
  const path = url.startsWith('/') ? url : `/${url}`
  return basePath ? basePath + path : path
}

function stripBase(pathname) {
  if (!basePath) return pathname
  if (pathname === basePath) return '/'
  if (pathname.startsWith(basePath + '/')) return pathname.slice(basePath.length)
  return pathname
}

// Cookies from the upstream may be scoped to its domain and marked Secure.
// The browser is on plain HTTP loopback, so drop those two attributes.
function rewriteSetCookie(value) {
  return value.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure\b/gi, '')
}

// Absolute redirects back to the upstream origin must point at the local proxy.
function rewriteLocation(value) {
  try {
    const url = new URL(value)
    if (url.origin === upstream.origin) {
      return localOrigin + stripBase(url.pathname) + url.search + url.hash
    }
  } catch {}
  return value
}

function requestHeaders(req) {
  const headers = { ...req.headers }
  headers.host = upstream.host
  if (headers.origin) headers.origin = upstream.origin
  if (headers.referer) {
    headers.referer = headers.referer.replace(localOrigin, upstream.origin)
  }
  return headers
}

function responseHeaders(res) {
  const headers = { ...res.headers }
  if (headers.location) headers.location = rewriteLocation(headers.location)
  if (headers['set-cookie']) {
    headers['set-cookie'] = [].concat(headers['set-cookie']).map(rewriteSetCookie)
  }
  return headers
}

function rawResponseHead(res) {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`]
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i]
    let value = res.rawHeaders[i + 1]
    const lower = name.toLowerCase()
    if (lower === 'location') value = rewriteLocation(value)
    if (lower === 'set-cookie') value = rewriteSetCookie(value)
    lines.push(`${name}: ${value}`)
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

function upstreamOptions(req) {
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (isTls ? 443 : 80),
    method: req.method,
    path: joinPath(req.url || '/'),
    headers: requestHeaders(req),
    rejectUnauthorized: process.env.LOCAL_PROXY_INSECURE !== '1',
  }
}

const server = http.createServer((req, res) => {
  const up = transport.request(upstreamOptions(req), (upRes) => {
    res.writeHead(upRes.statusCode || 502, responseHeaders(upRes))
    upRes.pipe(res)
    upRes.on('error', () => res.destroy())
  })
  up.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`local-proxy: upstream error: ${error.message}\n`)
    } else {
      res.destroy()
    }
  })
  req.pipe(up)
  req.on('error', () => up.destroy())
})

server.on('upgrade', (req, socket, head) => {
  const up = transport.request(upstreamOptions(req))
  up.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(rawResponseHead(upRes))
    if (upHead?.length) socket.write(upHead)
    if (head?.length) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    upSocket.on('error', () => socket.destroy())
    socket.on('error', () => upSocket.destroy())
  })
  up.on('response', (upRes) => {
    socket.write(rawResponseHead(upRes))
    upRes.pipe(socket)
    upRes.on('error', () => socket.destroy())
  })
  up.on('error', () => socket.destroy())
  up.end()
})

server.on('error', (error) => {
  console.error(`local-proxy: ${error.message}`)
  process.exit(1)
})

server.listen(localPort, '127.0.0.1', () => {
  console.log(`local-proxy: ${localOrigin} -> ${upstream.origin}${basePath}`)
  console.log('local-proxy: open the loopback URL above, not the public address')
})
