#!/usr/bin/env node
/**
 * remote-agent.js - remote control agent (runs on target machine)
 * Usage:
 *   node remote-agent.js --port 3788 --token mysecret
 *   node remote-agent.js --port 3788 --token mysecret --allow-dir D:\uploads
 * Endpoints:
 *   GET/POST /exec    execute command { command, token } or ?command=&token=
 *   GET/POST /upload  upload file { name, data(base64), dir, token }
 *   GET       /logs   view audit log (auth required) ?lines=50
 *   GET       /ping   health check
 *   GET       /info   system info
 * Audit: every exec/upload/denied attempt is appended to remote-agent-audit.log
 */

const http = require('node:http')
const { URL } = require('node:url')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const TOKEN = process.env.REMOTE_TOKEN || getArg('--token') || ''
const PORT = Number(getArg('--port') || process.env.REMOTE_PORT || 3788)
const ALLOW_DIR = getArg('--allow-dir') || process.env.REMOTE_DIR || ''
const AUDIT_FILE = path.join(__dirname, 'remote-agent-audit.log')

function getArg(name) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null
}

function auth(req) {
  // 安全（2026-09-13 修复）：未配置 token 时 fail-closed —— 受保护端点一律拒绝，
  // 而不是默认全开放。防止用户忘记设置 token 导致远程任意命令执行（RCE）。
  if (!TOKEN) return false
  const body = req.body || {}
  return body.token === TOKEN || req.headers['x-token'] === TOKEN
}

// 审计：每次 exec / upload / 拒绝尝试都追加写入审计文件（含时间、来源 IP、内容、结果）
// 安全：detail 中的明文 token 一律脱敏为 [REDACTED]，防止审计文件泄露凭据
function audit(req, action, detail, ok, extra) {
  try {
    const redacted = String(detail)
      .replace(/--token\s+[^\s"']+/gi, '--token [REDACTED]')
      .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]')
      .slice(0, 300)
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ip: (req.socket && req.socket.remoteAddress) || '',
      action,
      detail: redacted,
      ok: !!ok,
      ...(extra || {}),
    }) + '\n'
    fs.appendFileSync(AUDIT_FILE, line)
  } catch (e) { /* audit must never break serving */ }
}

function parseQueryUrl(url) {
  try {
    const u = new URL(url, 'http://localhost')
    const query = {}
    for (const [k, v] of u.searchParams) query[k] = v
    return { pathname: u.pathname, query }
  } catch (e) { return { pathname: url, query: {} } }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 100 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); return }
      data += chunk
    })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(new Error('Invalid JSON')) } })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  const json = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

function execCommand(command) {
  try {
    const out = execSync(command, { timeout: 60000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true })
    return { ok: true, stdout: out, stderr: '' }
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message, code: e.status }
  }
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    const { pathname, query } = parseQueryUrl(req.url)

    // GET/POST /exec?command=xxx&token=xxx
    if (pathname === '/exec' && (req.method === 'GET' || req.method === 'POST')) {
      let command, token
      if (req.method === 'GET') {
        command = query.command
        token = query.token
      } else {
        const body = await readBody(req)
        command = body.command
        token = body.token
      }
      if (!auth({ body: { token }, headers: req.headers })) { audit(req, 'denied', '/exec', false); return sendJson(res, 403, { error: 'Unauthorized' }) }
      if (!command) { return sendJson(res, 400, { error: 'Missing command' }) }
      console.log('[exec]', command.slice(0, 200))
      const result = execCommand(command)
      audit(req, 'exec', command, result.ok, { code: result.code || 0 })
      return sendJson(res, 200, result)
    }

    // POST /upload (body) or GET /upload?name=...&data=...&token=...
    if (pathname === '/upload' && (req.method === 'GET' || req.method === 'POST')) {
      let name, data, targetDir, token
      if (req.method === 'GET') {
        name = query.name; data = query.data; targetDir = query.dir; token = query.token
      } else {
        const body = await readBody(req)
        name = body.name; data = body.data; targetDir = body.dir; token = body.token
      }
      if (!auth({ body: { token }, headers: req.headers })) { audit(req, 'denied', '/upload', false); return sendJson(res, 403, { error: 'Unauthorized' }) }
      if (!name || !data) { return sendJson(res, 400, { error: 'Missing name or data' }) }
      targetDir = targetDir || ALLOW_DIR || os.tmpdir()
      // 安全：若设置了 allow-dir，强制上传目标必须在 allow-dir 内（请求 dir 不能绕过限制）
      if (ALLOW_DIR) {
        const relDir = path.relative(path.resolve(ALLOW_DIR), path.resolve(targetDir))
        if (relDir.startsWith('..') || path.isAbsolute(relDir)) {
          audit(req, 'denied', '/upload outside allow-dir: ' + targetDir, false)
          return sendJson(res, 403, { error: 'Outside allowed dir' })
        }
      }
      if (!fs.existsSync(targetDir)) { fs.mkdirSync(targetDir, { recursive: true }) }
      const filePath = path.join(targetDir, name)
      const resolved = path.resolve(filePath)
      // 路径穿越防护：用 path.relative 精确判定，杜绝 D:\bug2 / ..\ 前缀绕过
      const rel = path.relative(path.resolve(targetDir), resolved)
      if (rel.startsWith('..') || path.isAbsolute(rel)) { audit(req, 'denied', '/upload path traversal: ' + name, false); return sendJson(res, 403, { error: 'Path traversal denied' }) }
      fs.writeFileSync(resolved, Buffer.from(data, 'base64'))
      const size = Buffer.byteLength(data, 'base64')
      console.log('[upload]', resolved, `(${size} bytes)`)
      audit(req, 'upload', resolved + ' (' + size + ' bytes)', true)
      return sendJson(res, 200, { ok: true, path: resolved, size })
    }

    // GET /logs?lines=50 (auth required)
    if (pathname === '/logs' && req.method === 'GET') {
      if (!auth({ body: { token: query.token }, headers: req.headers })) { audit(req, 'denied', '/logs', false); return sendJson(res, 403, { error: 'Unauthorized' }) }
      const n = Math.min(parseInt(query.lines) || 50, 500)
      try {
        const data = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n)
        return sendJson(res, 200, { ok: true, lines: data })
      } catch (e) { return sendJson(res, 200, { ok: true, lines: [] }) }
    }

    // GET /ping
    if (pathname === '/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, time: Date.now() })
    }

    // GET /info
    if (pathname === '/info' && req.method === 'GET') {
      const ifaces = os.networkInterfaces()
      const ips = []
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
        }
      }
      return sendJson(res, 200, {
        ok: true, hostname: os.hostname(), platform: os.platform(),
        nodeVersion: process.version, ips, cwd: process.cwd(),
        tokenConfigured: !!TOKEN, allowDir: ALLOW_DIR,
      })
    }

    sendJson(res, 404, { error: 'Unknown endpoint' })
  } catch (e) {
    sendJson(res, 500, { error: e.message })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Remote Agent running on http://0.0.0.0:${PORT}`)
  console.log(`Token: ${TOKEN ? 'configured' : 'NOT SET — /exec /upload /logs DISABLED (fail-closed). 必须用 --token 或 REMOTE_TOKEN 启动才能执行命令'}`)
  console.log(`Allow dir: ${ALLOW_DIR || 'not set (use body.dir)'}`)
  console.log(`Audit file: ${AUDIT_FILE}`)
  console.log('')
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`LAN IP: http://${iface.address}:${PORT}`)
      }
    }
  }
  console.log('')
})
