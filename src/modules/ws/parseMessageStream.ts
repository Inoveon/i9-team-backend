/**
 * parseMessageStream — Parser de output tmux do Claude Code
 *
 * Converte o texto raw capturado do tmux em eventos estruturados JSON,
 * emitidos via WebSocket como `message_stream`.
 */

export type MessageEvent =
  | { type: 'user_input';       content: string }
  | { type: 'claude_text';      content: string }
  | { type: 'tool_call';        name: string; args: string; id: string }
  | { type: 'tool_result';      id: string; content: string }
  | { type: 'thinking';         label: string; duration?: string }
  | { type: 'system';           content: string }
  | { type: 'interactive_menu'; options: string[]; title?: string }

// ────────────────────────────────────────────────────────────────────────────
// Constantes de detecção
// ────────────────────────────────────────────────────────────────────────────

/** ANSI escape codes — removidos antes de qualquer parse */
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFJA-Za-z]/g

/** Linhas de ruído que devem ser descartadas */
const NOISE_PATTERNS = [
  /^\.\.\. \+\d+ lines? \(ctrl\+o to expand\)/i,
  /^\[Image #\d+\]/i,
  /^Press Ctrl-C again to exit/i,
  /^Resume this session with:/i,
  /^claude --resume/i,
  /^esc to interrupt/i,
  /^\d+% until auto-compact/i,
  /^─{3,}$/,
  /^━{3,}$/,
]

/** Spinner chars usados pelo Claude Code para thinking */
const THINKING_SPINNERS = /^[✻✶✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓◌◍◎⣾⣽⣻⢿⡿⣟⣯⣷]\s+/

/** Verbo de thinking na linha */
const THINKING_VERB_RE = /^[✻✶✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓◌◍◎⣾⣽⣻⢿⡿⣟⣯⣷]\s+(.+?)(\s+for\s+(\d+s))?$/

/** ⏺ Tool call: "⏺ NomeFerramenta(args...)" */
const TOOL_CALL_RE = /^⏺\s+([A-Za-z_][A-Za-z0-9_]*)\((.*)$/

/** ⏺ Claude text: "⏺ texto livre" (sem parênteses de ferramenta) */
const CLAUDE_TEXT_RE = /^⏺\s+(.+)$/

/** ⎿ Tool result: "  ⎿  conteúdo" */
const TOOL_RESULT_RE = /^\s{2}⎿\s{2}(.*)$/

/** ❯ User input */
const USER_INPUT_RE = /^❯\s+(.+)$/

/** Menu interativo: linha com ☐ ou ● (título) seguida de opções */
const MENU_TITLE_RE = /^[☐●✔✗]\s+(.+)$/
const MENU_OPTION_RE = /^\s*[❯○◉►●]\s+(.+)$/
const MENU_NUMBERED_RE = /^\s*[❯○◉►]?\s*\d+[.)]\s+(.+)$/

/** Linhas que indicam fim de menu (footer de navegação) */
const MENU_FOOTER_RE = /(Enter to (confirm|select|cancel)|Esc to (exit|cancel)|↑.{0,3}↓ to (navigate|select))/i

/** Linhas de sistema (timings, separadores semânticos) */
const SYSTEM_PATTERNS = [
  /^Crunched for \d+s/i,
  /^Auto-saved\./i,
  /^Compacting conversation/i,
  /^\[Compacted\]/i,
  /^Tokens used:/i,
  /^Cost:/i,
]

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line))
}

function isSystem(line: string): boolean {
  return SYSTEM_PATTERNS.some((re) => re.test(line))
}

// Gera um ID determinístico simples para correlacionar tool_call / tool_result
let _seq = 0
function nextId(): string {
  return `t${++_seq}`
}

// ────────────────────────────────────────────────────────────────────────────
// Parser principal
// ────────────────────────────────────────────────────────────────────────────

export function parseMessageStream(rawText: string): MessageEvent[] {
  const events: MessageEvent[] = []
  const lines = rawText.split('\n').map(stripAnsi)

  let i = 0
  // ID do tool_call mais recente para correlacionar com o tool_result seguinte
  let lastToolId = ''

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // ── Descarta ruído ───────────────────────────────────────────────────────
    if (trimmed === '' || isNoise(trimmed)) { i++; continue }

    // ── Sistema ─────────────────────────────────────────────────────────────
    if (isSystem(trimmed)) {
      events.push({ type: 'system', content: trimmed })
      i++; continue
    }

    // ── Thinking spinner ─────────────────────────────────────────────────────
    if (THINKING_SPINNERS.test(trimmed)) {
      const m = trimmed.match(THINKING_VERB_RE)
      const label = m ? m[1].trim() : trimmed.replace(THINKING_SPINNERS, '').trim()
      const duration = m?.[3]
      events.push({ type: 'thinking', label, ...(duration ? { duration } : {}) })
      i++; continue
    }

    // ── Menu interativo ──────────────────────────────────────────────────────
    // Detecta bloco: título (☐/●) + opções + footer
    if (MENU_TITLE_RE.test(trimmed)) {
      const titleMatch = trimmed.match(MENU_TITLE_RE)
      const title = titleMatch ? titleMatch[1].trim() : undefined
      const options: string[] = []
      i++
      while (i < lines.length) {
        const ol = lines[i].trim()
        if (MENU_FOOTER_RE.test(ol)) { i++; break }
        if (ol === '') { i++; continue }
        const numbered = lines[i].match(MENU_NUMBERED_RE)
        const bullet   = lines[i].match(MENU_OPTION_RE)
        // Linha indentada sem bullet também é opção dentro de um bloco de menu
        const indented = /^\s{2,}(\S.*)$/.exec(lines[i])
        if (numbered) options.push(numbered[1].trim())
        else if (bullet) options.push(bullet[1].trim())
        else if (indented && !MENU_FOOTER_RE.test(ol)) options.push(indented[1].trim())
        i++
      }
      if (options.length > 0) {
        events.push({ type: 'interactive_menu', options, ...(title ? { title } : {}) })
      }
      continue
    }

    // ── Tool result: "  ⎿  conteúdo" ────────────────────────────────────────
    if (TOOL_RESULT_RE.test(line)) {
      const resultLines: string[] = []
      while (i < lines.length && TOOL_RESULT_RE.test(lines[i])) {
        const m = lines[i].match(TOOL_RESULT_RE)
        if (m) resultLines.push(m[1])
        i++
      }
      events.push({ type: 'tool_result', id: lastToolId, content: resultLines.join('\n') })
      continue
    }

    // ── Tool call: "⏺ NomeFerramenta(args...)" ───────────────────────────────
    const toolMatch = line.match(TOOL_CALL_RE)
    if (toolMatch) {
      const name = toolMatch[1]
      // args podem se estender por múltiplas linhas até fechar o parêntese
      let argsRaw = toolMatch[2]
      i++
      // Caso args multi-linha (raro mas possível em tool_call com JSON longo)
      let depth = (argsRaw.match(/\(/g) || []).length - (argsRaw.match(/\)/g) || []).length + 1
      while (depth > 0 && i < lines.length) {
        const next = lines[i]
        argsRaw += '\n' + next
        depth += (next.match(/\(/g) || []).length - (next.match(/\)/g) || []).length
        i++
      }
      // Remove o parêntese de fechamento final
      const args = argsRaw.replace(/\)\s*$/, '').trim()
      const id = nextId()
      lastToolId = id
      events.push({ type: 'tool_call', name, args, id })
      continue
    }

    // ── Claude text: "⏺ texto livre" ────────────────────────────────────────
    const claudeTextMatch = line.match(CLAUDE_TEXT_RE)
    if (claudeTextMatch) {
      // Acumula linhas de continuação (indentadas ou sequência de ⏺)
      const textLines: string[] = [claudeTextMatch[1]]
      i++
      while (i < lines.length) {
        const next = lines[i]
        // Continuação: linha indentada ou linha vazia que ainda faz parte do bloco
        if (/^\s{2,}/.test(next) && !TOOL_RESULT_RE.test(next)) {
          textLines.push(next.trim())
          i++
        } else {
          break
        }
      }
      events.push({ type: 'claude_text', content: textLines.join('\n') })
      continue
    }

    // ── User input: "❯ texto" ────────────────────────────────────────────────
    const userMatch = line.match(USER_INPUT_RE)
    if (userMatch) {
      events.push({ type: 'user_input', content: userMatch[1].trim() })
      i++; continue
    }

    // ── Linha não reconhecida — descarta silenciosamente ─────────────────────
    i++
  }

  return events
}
