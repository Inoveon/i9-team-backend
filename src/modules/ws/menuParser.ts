/**
 * menuParser.ts — Extraído de handler.ts na Onda 1.
 *
 * Detecta menus interativos do Claude Code TUI a partir do output do tmux,
 * e implementa navegação relativa (setas + Enter) para selecionar opções.
 */
import { execSync } from 'node:child_process'

export interface MenuOption {
  index: number
  label: string
  current?: boolean
}

export interface ParseMenuResult {
  type: 'numbered' | 'bullet' | 'mcp' | 'inline'
  options: MenuOption[]
  currentIndex: number
}

const FOOTER_RE = /(Enter to (confirm|select|cancel)|Esc to (exit|cancel)|↑.{0,3}↓ to (navigate|select)|↑↓ to (navigate|select))/i
const INLINE_OPTIONS_RE = /(\d+:\s*\w+\s+){2,}/

function isMcpOption(line: string): boolean {
  return /^ {4}\S/.test(line) && /·\s*(✔|✘|△)/.test(line)
}
function isMcpCursor(line: string): boolean {
  return /^( {2})?❯ /.test(line)
}

/**
 * Navega no TUI do Claude Code até o índice desejado (1-based) e confirma.
 * Claude Code usa setas ↑/↓ para navegar — não aceita número digitado.
 */
export function selectMenuOption(session: string, targetIndex: number, currentIndex = 1): void {
  const delta = targetIndex - currentIndex
  const key = delta >= 0 ? 'Down' : 'Up'
  const presses = Math.abs(delta)
  for (let i = 0; i < presses; i++) {
    execSync(`tmux send-keys -t ${JSON.stringify(session)} ${key}`)
  }
  execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`)
}

export function parseInteractiveMenu(raw: string): ParseMenuResult | null {
  // Só analisa as últimas 20 linhas — menu ativo sempre está no final do output
  const data = raw.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, '')
  const allLines = data.split('\n')
  const lines = allLines.slice(-20)

  // Estratégia 1: bottom-up — achar o footer mais recente, depois subir para o header
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) { footerIdx = i; break }
  }

  if (footerIdx !== -1) {
    let start = -1
    for (let i = footerIdx - 1; i >= 0; i--) {
      const line = lines[i]
      const isHeader =
        (/[?●☐]/.test(line) && !/^\s*\?(\s+for\b|$)/.test(line)) ||
        /^\s*(Select|Choose|Pick|Manage|Set|How|Selecione|Escolha|Qual|Como)\b/i.test(line)
      if (isHeader) { start = i; break }
    }
    if (start === -1) start = 0

    // MCP-style primeiro: cursor indent=2 + opções indent=4 com status
    const mcpOptions: MenuOption[] = []
    let mcpAutoIndex = 1
    let mcpCurrentIndex = 1
    for (let i = start + 1; i < footerIdx; i++) {
      const l = lines[i]
      if (isMcpCursor(l)) {
        const label = l.replace(/^ {2}❯ /, '').trim()
        if (label) { mcpOptions.push({ index: mcpAutoIndex, label, current: true }); mcpCurrentIndex = mcpAutoIndex++ }
      } else if (isMcpOption(l)) {
        mcpOptions.push({ index: mcpAutoIndex++, label: l.trim() })
      }
    }
    if (mcpOptions.length > 1) {
      return { type: 'mcp', options: mcpOptions, currentIndex: mcpCurrentIndex }
    }

    // Numbered/bullet
    const options: MenuOption[] = []
    let autoIndex = 1
    let currentIndex = 1

    for (let i = start + 1; i < footerIdx; i++) {
      const l = lines[i]
      const isCurrent = /^\s*❯/.test(l)

      const numbered = l.match(/^\s*[❯○◉►]?\s*(\d+)[.)]\s+(.+?)\s*$/)
      if (numbered && !l.includes('│') && !l.includes('├') && !l.includes('└')) {
        const label = numbered[2].trim()
        if (label && !/←.*→|→.*←/.test(label)) {
          const idx = parseInt(numbered[1], 10)
          options.push({ index: idx, label, current: isCurrent })
          if (isCurrent) currentIndex = idx
        }
        continue
      }

      const bullet = l.match(/^\s*[❯○◉►●]\s+(.+?)\s*$/)
      if (bullet) {
        const label = bullet[1].trim()
        if (label && !/←.*→|→.*←/.test(label)) {
          const idx = autoIndex++
          options.push({ index: idx, label, current: isCurrent })
          if (isCurrent) currentIndex = idx
        }
      }
    }

    if (options.length > 0) {
      const type = options.some(o => o.index > 1) ? 'numbered' : 'bullet'
      return { type, options, currentIndex }
    }
  }

  // Estratégia 2: inline rating ("1: Bad  2: Fine  3: Good")
  for (let i = 0; i < lines.length; i++) {
    if (!INLINE_OPTIONS_RE.test(lines[i])) continue
    const prevLine = i > 0 ? lines[i - 1] : ''
    if (!prevLine.trim() || !/[?●]/.test(prevLine)) continue

    const options: MenuOption[] = []
    const matches = lines[i].matchAll(/(\d+):\s*(\w+)/g)
    for (const m of matches) {
      options.push({ index: parseInt(m[1], 10), label: m[2].trim() })
    }
    if (options.length >= 2) {
      return { type: 'inline', options, currentIndex: options[0].index }
    }
  }

  return null
}
