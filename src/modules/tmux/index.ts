import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process'

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, EXEC_OPTS).trim()
  } catch {
    return ''
  }
}

export interface TmuxSession {
  name: string
  windows: number
  created: string
  attached: boolean
}

/**
 * Lista todas as sessões tmux ativas.
 */
export function listSessions(): TmuxSession[] {
  const raw = exec("tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}' 2>/dev/null")
  if (!raw) return []

  return raw.split('\n').filter(Boolean).map((line) => {
    const [name, windows, created, attached] = line.split('|')
    return {
      name,
      windows: Number(windows),
      created: new Date(Number(created) * 1000).toISOString(),
      attached: attached === '1',
    }
  })
}

/**
 * Cria uma nova sessão tmux desanexada.
 */
export function createSession(name: string): boolean {
  const exists = listSessions().some((s) => s.name === name)
  if (exists) return true
  exec(`tmux new-session -d -s "${name}"`)
  return listSessions().some((s) => s.name === name)
}

/**
 * Destrói uma sessão tmux.
 */
export function destroySession(name: string): boolean {
  exec(`tmux kill-session -t "${name}" 2>/dev/null`)
  return !listSessions().some((s) => s.name === name)
}

/**
 * Envia teclas para uma sessão tmux.
 */
export function sendKeys(session: string, keys: string): boolean {
  exec(`tmux send-keys -t "${session}" ${JSON.stringify(keys)} Enter`)
  return true
}

/**
 * Captura o output atual de um pane tmux.
 */
export function capturePane(session: string, lines = 50): string {
  return exec(`tmux capture-pane -p -t "${session}" -S -${lines} 2>/dev/null`)
}
