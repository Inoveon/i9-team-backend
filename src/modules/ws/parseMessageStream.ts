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

/** ⏺ Tool call: "⏺ NomeFerramenta(args...)" — só aceita ⏺ (tool_call nunca usa ●) */
const TOOL_CALL_RE = /^⏺\s+([A-Za-z_][A-Za-z0-9_]*)\((.*)$/

/**
 * Claude text: "⏺ texto livre" OU "● texto livre".
 * O Claude Code antigo usa ⏺ e o novo usa ● para respostas do assistant
 * (frases corridas, sem parênteses de tool). Ambos valem como texto livre.
 */
const CLAUDE_TEXT_RE = /^[⏺●]\s+(.+)$/

/** ⎿ Tool result: "  ⎿  conteúdo" */
const TOOL_RESULT_RE = /^\s{2}⎿\s{2}(.*)$/

/** ❯ User input */
const USER_INPUT_RE = /^❯\s+(.+)$/

/**
 * Menu interativo — heurística ESTRITA (pós-fix BUG #1, 2026-04-19).
 *
 * Problema resolvido: `●` é glifo ambíguo — é tanto bullet de claude_text
 * (CLAUDE_TEXT_RE) quanto título/bullet de menu. Isso fazia prosa comum do
 * orquestrador (`● Plano: 1. algo 2. outro`) ser classificada como menu.
 *
 * Regras:
 *   - Título: SÓ ☐/✔/✗ (glifos exclusivos de menu, nunca aparecem em prosa).
 *     `●` NÃO é mais aceito como título.
 *   - Opção numerada: SÓ `N.` (ponto). `N)` em prosa ("1) foo, 2) bar") NÃO
 *     é opção. Indent tolerante (\s*) porque menus reais do /model têm
 *     itens 2+ indentados sem chevron.
 *   - Opção bullet: SÓ `❯` (chevron de seleção). `●/○/◉/►` saíram.
 *   - Fallback de "linha indentada sem glifo" foi removido.
 */
const MENU_TITLE_RE = /^[☐✔✗]\s+(.+)$/
const MENU_OPTION_RE = /^\s*❯\s+(.+)$/
const MENU_NUMBERED_RE = /^\s*\d+\.\s+(.+)$/

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
    // Heurística ESTRITA (pós BUG #1, 2026-04-19). Exigências cumulativas:
    //   1. Header com glifo EXCLUSIVO de menu (☐/✔/✗). `●` NÃO conta mais,
    //      porque é ambíguo com CLAUDE_TEXT_RE e gerava falso-positivo em
    //      respostas em prosa do orquestrador.
    //   2. FOOTER presente nas próximas 15 linhas (Enter to confirm/select/…,
    //      Esc to cancel, ↑↓ to navigate).
    //   3. Pelo menos 2 opções com padrão ESTRITO — cada opção precisa de
    //      um marcador explícito:
    //        - `❯ conteúdo`   (chevron de seleção, possivelmente indentado), ou
    //        - `N. conteúdo`  (número com PONTO, possivelmente indentado).
    //      Linha "plaina" indentada SEM marcador NÃO é mais aceita como opção.
    //
    // Se qualquer condição falhar, cai pro resto do switch e a mesma linha
    // pode virar claude_text via CLAUDE_TEXT_RE (que matcha ⏺ ou ●).
    if (MENU_TITLE_RE.test(trimmed)) {
      const lookahead = lines.slice(i + 1, i + 16)
      const footerRelIdx = lookahead.findIndex((l) => MENU_FOOTER_RE.test(l))

      if (footerRelIdx !== -1) {
        const body = lookahead.slice(0, footerRelIdx)
        const options: string[] = []

        for (const ol of body) {
          if (ol.trim() === '') continue
          const numbered = ol.match(MENU_NUMBERED_RE)
          if (numbered) { options.push(numbered[1].trim()); continue }
          const bullet = ol.match(MENU_OPTION_RE)
          if (bullet)   { options.push(bullet[1].trim());   continue }
          // Linha sem ❯ nem N. — NÃO é opção. Ignorada silenciosamente.
        }

        if (options.length >= 2) {
          const titleMatch = trimmed.match(MENU_TITLE_RE)
          const title = titleMatch ? titleMatch[1].trim() : undefined
          events.push({ type: 'interactive_menu', options, ...(title ? { title } : {}) })
          i += 1 + footerRelIdx + 1 // header + body + footer
          continue
        }
      }
      // Não é menu real — segue adiante sem continue.
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
