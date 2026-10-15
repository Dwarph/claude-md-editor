// Finds the running daemon (or starts one) and calls its HTTP API. Shared by
// the MCP server and the CLI so both always talk to the same process.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_FILE, LOG_FILE, ROOT_DIR, STATE_DIR, VERSION } from './paths.js'

const SPAWN_LOCK = join(STATE_DIR, 'spawn.lock')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readDaemonFile() {
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function runningDaemon() {
  const info = readDaemonFile()
  if (!info) return null
  const status = await health(info.port)
  return status?.ok ? status : null
}

function startDetached() {
  mkdirSync(STATE_DIR, { recursive: true })
  const log = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [join(ROOT_DIR, 'server', 'daemon-main.js')], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  })
  child.unref()
  closeSync(log)
}

let cachedPort = null

/** Port of a daemon running this package's version, starting one if needed. */
export async function ensureDaemon() {
  if (cachedPort && (await health(cachedPort))?.version === VERSION) return cachedPort
  let status = await runningDaemon()
  if (status && status.version !== VERSION) {
    // An older build is running (e.g. after an update): replace it.
    await fetch(`http://127.0.0.1:${status.port}/api/shutdown`, { method: 'POST' }).catch(() => {})
    await sleep(300)
    status = null
  }
  if (!status) {
    let haveLock = false
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      closeSync(openSync(SPAWN_LOCK, 'wx'))
      haveLock = true
    } catch {
      // Someone else is starting it; clear a lock left by a crashed starter.
      if (existsSync(SPAWN_LOCK) && Date.now() - statSync(SPAWN_LOCK).mtimeMs > 15_000) rmSync(SPAWN_LOCK, { force: true })
    }
    if (haveLock) startDetached()
    try {
      for (let i = 0; i < 100 && !status; i++) {
        await sleep(150)
        status = await runningDaemon()
      }
    } finally {
      if (haveLock) rmSync(SPAWN_LOCK, { force: true })
    }
    if (!status) throw new Error(`The editor server didn't start. See ${LOG_FILE}.`)
  }
  cachedPort = status.port
  return status.port
}

/** POST to the daemon's API; throws the daemon's error message on failure. */
export async function api(path, body = {}, init = {}) {
  const port = await ensureDaemon()
  const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: init.method === 'GET' ? undefined : JSON.stringify(body),
    signal: init.signal,
  })
  if (res.status === 204) return null
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}
