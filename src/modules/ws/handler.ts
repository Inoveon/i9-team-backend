import type { FastifyInstance } from 'fastify'
import { execSync } from 'child_process'
import { captureSession, sendKeys } from '../tmux/service.js'

/**
 * Navega no TUI do Claude Code até o índice desejado (1-based) e confirma.
 * Claude Code usa setas ↑/↓ para navegar — não aceita número digitado.
 * @param currentIndex índice atual do cursor no TUI (detectado pelo ❯)
 */
function selectMenuOption(session: string, targetIndex: number, currentIndex = 1): void {
  const delta = targetIndex - currentIndex
  const key = delta >= 0 ? 'Down' : 'Up'
  const presses = Math.abs(delta)
  for (let i = 0; i < presses; i++) {
    execSync(`tmux send-keys -t ${JSON.stringify(session)} ${key}`)
  }
  execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`)
}

interface SubscribeMsg    { type: 'subscribe';      session: string }
interface InputMsg        { type: 'input';           keys: string }
interface SelectOptionMsg { type: 'select_option';  session: string; value: string; currentIndex?: number }

type ClientMsg = SubscribeMsg | InputMsg | SelectOptionMsg

interface MenuOption {
  index: number
  label: string
  current?: boolean
}

// Linha que marca o INÍCIO de um menu interativo do Claude Code
// Padrões: "Select model", "? 1. Option", "Como deseja..?", ou qualquer linha terminada com ?
const MENU_HEADER_RE = /(\?|Select|Choose|Pick|Como|Qual|O que|Deseja|Prefere|Quer)\b/i

// Linhas de navegação/rodapé que NÃO são opções — encerram o bloco de opções
const NAV_LINE_RE = /Enter to (select|confirm)|Esc to (exit|cancel)|↑|↓|←|→|to adjust|to navigate|Use arrow|Type something/i

/**
 * Detecta se o output tmux contém um menu interativo do Claude Code e extrai as opções.
 *
 * Estratégia:
 *  1. Procurar por QUALQUER linha que contenha uma pergunta (tem ?) ou palavras-chave (Select, Choose, Como, etc)
 *  2. A partir daí, coletar linhas que sejam opções numeradas (1. 2. 3.) ou bullets (❯, ○, ◉)
 *  3. Parar ao encontrar navegação (rodapé), linha vazia ou prompt (❯)
 *
 * Opções reconhecidas:
 *  - "  1. Label"  /  "❯ 1. Label"  /  "○ 2) Label"
 *  - "❯ Label"     /  "○ Label"   (bullet sem número — índice sequencial)
 */
function parseInteractiveMenu(data: string): { options: MenuOption[]; currentIndex: number } | null {
  const lines = data.split('\n')

  // Fase 1 — localizar a pergunta/cabeçalho do menu
  // Procura por: "?" ou palavras-chave (Select, Choose, Como, Qual, O que, etc)
  let menuStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip linhas vazias e linhas que já têm opções (numeradas/bullet)
    if (line.trim() === '' || /^\s*[0-9❯○◉►●]/.test(line)) continue

    if (MENU_HEADER_RE.test(line)) {
      menuStart = i
      break
    }
  }
  if (menuStart === -1) return null

  // Fase 2 — coletar opções a partir da linha seguinte
  const options: MenuOption[] = []
  let autoIndex = 1
  let foundAny = false
  let currentIndex = 1

  for (let i = menuStart + 1; i < lines.length; i++) {
    const line = lines[i]

    // Parar ao atingir rodapé de navegação
    if (NAV_LINE_RE.test(line)) break

    // Parar em linha vazia DEPOIS de já ter coletado opções
    if (foundAny && line.trim() === '') break

    // Parar ao atingir o cursor (❯) do prompt — fim das opções
    if (foundAny && /^\s*❯\s*$/.test(line)) break

    // Strip ANSI antes de processar
    const cleanLine = line.replace(/\x1b\[[0-9;]*[mGKHF]/g, '')
    const isCurrent = /^\s*❯/.test(cleanLine)

    // Opção numerada: "  1. Label" / "❯ 1. Label" / "○ 2) Label"
    const numbered = line.match(/^\s*[❯○◉►]?\s*(\d+)[.)]\s+(.+?)\s*$/)
    if (numbered) {
      const label = numbered[2].replace(/\x1b\[[0-9;]*m/g, '').trim()
      if (label && label.length > 0) {
        const idx = parseInt(numbered[1], 10)
        options.push({ index: idx, label, current: isCurrent })
        if (isCurrent) currentIndex = idx
        foundAny = true
      }
      continue
    }

    // Opção bullet sem número: "❯ Label" / "○ Label"
    const bullet = line.match(/^\s*[❯○◉►●]\s+(.+?)\s*$/)
    if (bullet) {
      const label = bullet[1].replace(/\x1b\[[0-9;]*m/g, '').trim()
      if (label && label.length > 0) {
        const idx = autoIndex++
        options.push({ index: idx, label, current: isCurrent })
        if (isCurrent) currentIndex = idx
        foundAny = true
      }
    }
  }

  return options.length > 0 ? { options, currentIndex } : null
}

export async function wsHandler(app: FastifyInstance) {
  /**
   * WebSocket genérico — protocolo de mensagens:
   *   cliente → { type: "subscribe",     session: "nome" }
   *   cliente → { type: "input",         keys: "texto" }
   *   cliente → { type: "select_option", session: "nome", value: "1" }
   *   server  → { type: "output",        session, data }
   *   server  → { type: "interactive_menu", session, options: [{index, label}] }
   *   server  → { type: "subscribed",    session }
   *   server  → { type: "error",         message }
   */
  app.get('/ws', { websocket: true }, (socket) => {
    let interval: ReturnType<typeof setInterval> | null = null
    let lastOutput = ''

    function startStreaming(session: string) {
      if (interval) clearInterval(interval)
      lastOutput = ''

      interval = setInterval(() => {
        try {
          const output = captureSession(session, 50)
          if (output !== lastOutput) {
            lastOutput = output

            // Detectar menu interativo antes de emitir output
            const menu = parseInteractiveMenu(output)
            if (menu) {
              socket.send(JSON.stringify({ type: 'interactive_menu', session, options: menu.options, currentIndex: menu.currentIndex }))
            }

            // Sempre emite o output completo também
            socket.send(JSON.stringify({ type: 'output', session, data: output }))
          }
        } catch {
          // sessão pode ter fechado
        }
      }, 2000)
    }

    let currentSession = ''

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMsg

        if (msg.type === 'subscribe' && msg.session) {
          currentSession = msg.session
          startStreaming(msg.session)
          socket.send(JSON.stringify({ type: 'subscribed', session: msg.session }))

        } else if (msg.type === 'input' && msg.keys && currentSession) {
          sendKeys(currentSession, msg.keys)

        } else if (msg.type === 'select_option' && msg.session && msg.value) {
          // Claude Code TUI: navegar com setas relativas até o índice + Enter
          const idx = parseInt(msg.value, 10)
          const cur = (msg as SelectOptionMsg).currentIndex ?? 1
          if (!isNaN(idx)) {
            selectMenuOption(msg.session, idx, cur)
          }
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Mensagem inválida' }))
      }
    })

    socket.on('close', () => { if (interval) clearInterval(interval) })
    socket.on('error', () => { if (interval) clearInterval(interval) })
  })

  /**
   * WebSocket por URL — compatibilidade: /ws/:session
   * Inicia streaming automaticamente + aceita input/select_option do cliente.
   */
  app.get<{ Params: { session: string } }>(
    '/ws/:session',
    { websocket: true },
    (socket, request) => {
      const { session } = request.params
      let lastOutput = ''

      const interval = setInterval(() => {
        try {
          const output = captureSession(session, 50)
          if (output !== lastOutput) {
            lastOutput = output

            const menu = parseInteractiveMenu(output)
            if (menu) {
              socket.send(JSON.stringify({ type: 'interactive_menu', session, options: menu.options, currentIndex: menu.currentIndex }))
            }

            socket.send(JSON.stringify({ type: 'output', session, data: output }))
          }
        } catch {
          // sessão pode ter fechado
        }
      }, 2000)

      // Handler de mensagens do cliente — necessário para input e select_option
      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as ClientMsg
          console.log(`[ws/:session] msg recebida type=${msg.type} session=${session}`)

          if (msg.type === 'input' && msg.keys) {
            console.log(`[ws/:session] sendKeys session=${session} keys=${JSON.stringify(msg.keys)}`)
            sendKeys(session, msg.keys)

          } else if (msg.type === 'select_option' && msg.value) {
            const target = (msg as SelectOptionMsg).session || session
            console.log(`[ws/:session] select_option target=${target} value=${msg.value}`)
            sendKeys(target, msg.value)
          }
        } catch (err) {
          console.error('[ws/:session] erro ao processar mensagem:', err)
          socket.send(JSON.stringify({ type: 'error', message: 'Mensagem inválida' }))
        }
      })

      socket.on('close', () => clearInterval(interval))
      socket.on('error', () => clearInterval(interval))
    }
  )
}
