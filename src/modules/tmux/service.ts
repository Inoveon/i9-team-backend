import { execSync } from 'child_process'

export function listSessions(): string[] {
  try {
    const output = execSync("tmux ls -F '#{session_name}'", { encoding: 'utf8' })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function sendToSession(session: string, message: string): void {
  const escaped = message.replace(/"/g, '\\"')
  execSync(`tmux send-keys -t "${session}" "${escaped}" Enter`)
}

export function captureSession(session: string, lines = 50): string {
  try {
    const output = execSync(`tmux capture-pane -t "${session}" -p | tail -${lines}`, {
      encoding: 'utf8',
    })
    return output
  } catch {
    return ''
  }
}
