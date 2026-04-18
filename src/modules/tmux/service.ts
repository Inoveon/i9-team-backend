import { execSync } from 'child_process'

const OPTS = { encoding: 'utf8' as const }

export interface TmuxSession {
  name: string
  windows: number
  created: string
  attached: boolean
}

export function listSessions(): TmuxSession[] {
  try {
    const raw = execSync(
      "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'",
      OPTS
    ).trim()
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, windows, created, attached] = line.split('|')
        return {
          name,
          windows: Number(windows),
          created: new Date(Number(created) * 1000).toISOString(),
          attached: attached === '1',
        }
      })
  } catch {
    return []
  }
}

export function createSession(name: string): boolean {
  const exists = listSessions().some((s) => s.name === name)
  if (exists) return true
  try {
    execSync(`tmux new-session -d -s "${name}"`)
    return true
  } catch {
    return false
  }
}

export function destroySession(name: string): boolean {
  try {
    execSync(`tmux kill-session -t "${name}"`)
    return true
  } catch {
    return false
  }
}

export function sendKeys(session: string, keys: string): void {
  execSync(`tmux send-keys -t "${session}" ${JSON.stringify(keys)} Enter`)
}

/** @deprecated use sendKeys */
export function sendToSession(session: string, message: string): void {
  sendKeys(session, message)
}

export function captureSession(session: string, lines = 50): string {
  try {
    return execSync(`tmux capture-pane -t "${session}" -p -S -${lines}`, OPTS)
  } catch {
    return ''
  }
}
