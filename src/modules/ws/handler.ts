import type { FastifyInstance } from 'fastify'
import { execSync } from 'child_process'
import { captureSession, sendKeys } from '../tmux/service.js'
import { parseMessageStream } from './parseMessageStream.js'
import { broadcastChatMessage } from '../chat/ws.js'
import { createMessage } from '../chat/service.js'

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

interface ParseResult {
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

function parseInteractiveMenu(raw: string): ParseResult | null {
  // Só analisa as últimas 20 linhas — menu ativo sempre está no final do output
  const data = raw.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, '')
  const allLines = data.split('\n')
  const lines = allLines.slice(-20)

  // Estratégia 1: bottom-up — achar o footer mais recente, depois subir para o header
  // Evita pegar menus de histórico anterior no output
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) { footerIdx = i; break }
  }

  // Footer obrigatório — sem footer não é menu interativo real
  if (footerIdx !== -1) {
    // Subir a partir do footer para achar o header mais próximo acima
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
      let tickCount = 0

      interval = setInterval(() => {
        try {
          const output = captureSession(session, 50)
          tickCount++
          const changed = output !== lastOutput
          // Sempre envia na primeira vez e a cada 5 ticks (10s) mesmo sem mudança
          if (changed || tickCount === 1 || tickCount % 5 === 0) {
            if (changed) lastOutput = output

            const menu = parseInteractiveMenu(output)
            console.log(`[ws] session=${session} menu=${menu ? `${menu.type}(${menu.options.length} opts): ${menu.options.map(o=>o.label).join(' | ')}` : 'null'}`)

            socket.send(JSON.stringify({ type: 'output', session, data: output, hasMenu: !!menu }))
            if (menu) {
              socket.send(JSON.stringify({ type: 'interactive_menu', session, menuType: menu.type, options: menu.options, currentIndex: menu.currentIndex }))
            }

            const streamEvents = parseMessageStream(output).filter(e => e.type !== 'interactive_menu')
            if (streamEvents.length > 0) {
              socket.send(JSON.stringify({ type: 'message_stream', session, events: streamEvents }))

              // Publica eventos relevantes no canal de chat do team (usando session como teamId)
              for (const evt of streamEvents) {
                if (evt.type === 'claude_text' || evt.type === 'user_input') {
                  const role = evt.type === 'claude_text' ? 'agent' : 'user'
                  createMessage({ teamId: session, role, content: evt.content })
                    .then(msg => broadcastChatMessage(session, msg))
                    .catch(() => { /* DB pode estar offline */ })
                }
              }
            }
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
      let tickCount = 0

      const interval = setInterval(() => {
        try {
          const output = captureSession(session, 50)
          tickCount++
          const changed = output !== lastOutput
          if (changed || tickCount === 1 || tickCount % 5 === 0) {
            if (changed) lastOutput = output

            const menu = parseInteractiveMenu(output)
            socket.send(JSON.stringify({ type: 'output', session, data: output, hasMenu: !!menu }))
            if (menu) {
              socket.send(JSON.stringify({ type: 'interactive_menu', session, menuType: menu.type, options: menu.options, currentIndex: menu.currentIndex }))
            }

            const streamEvents = parseMessageStream(output).filter(e => e.type !== 'interactive_menu')
            if (streamEvents.length > 0) {
              socket.send(JSON.stringify({ type: 'message_stream', session, events: streamEvents }))
            }
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

  /**
   * Debug endpoint — GET /debug/parse-stream?agent=session-name
   * Captura o output atual do agente e retorna os eventos parseados.
   */
  app.get<{ Querystring: { agent?: string } }>('/debug/parse-stream', async (request, reply) => {
    const agent = request.query.agent ?? ''
    if (!agent) {
      return reply.status(400).send({ error: 'Parâmetro ?agent= obrigatório' })
    }
    try {
      const raw = captureSession(agent, 50)
      const events = parseMessageStream(raw)
      return {
        agent,
        lines: raw.split('\n').length,
        eventCount: events.length,
        events,
        raw: raw.slice(0, 2000),
      }
    } catch (err) {
      return reply.status(500).send({ error: String(err) })
    }
  })
}
