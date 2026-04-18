import type { FastifyInstance } from 'fastify'
import { captureSession, sendKeys } from '../tmux/service.js'

interface SubscribeMsg    { type: 'subscribe';      session: string }
interface InputMsg        { type: 'input';           keys: string }
interface SelectOptionMsg { type: 'select_option';  session: string; value: string }

type ClientMsg = SubscribeMsg | InputMsg | SelectOptionMsg

interface MenuOption {
  index: number
  label: string
}

/**
 * Detecta se o output tmux contém um menu interativo do Claude Code.
 * Reconhece padrões como:
 *   "  1. Nome da opção"
 *   "❯ 1 Nome da opção"
 *   "  ○ 1. Label"
 * e indicadores de navegação "Enter to select" / "↑/↓ to navigate"
 */
function parseInteractiveMenu(data: string): { options: MenuOption[] } | null {
  if (!data.includes('Enter to select') && !data.includes('↑/↓ to navigate')) return null

  const options: MenuOption[] = []
  const lines = data.split('\n')
  for (const line of lines) {
    const match = line.match(/^\s*[❯○◉]?\s*(\d+)[.)]\s+(.+?)\s*$/)
    if (match) {
      options.push({ index: parseInt(match[1], 10), label: match[2].trim() })
    }
  }
  return options.length > 0 ? { options } : null
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
              socket.send(JSON.stringify({ type: 'interactive_menu', session, options: menu.options }))
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
          // Envia o valor da opção selecionada para a sessão tmux
          sendKeys(msg.session, msg.value)
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
   * Inicia streaming automaticamente sem aguardar subscribe.
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
            socket.send(JSON.stringify({ type: 'output', session, data: output }))
          }
        } catch {
          // sessão pode ter fechado
        }
      }, 2000)

      socket.on('close', () => clearInterval(interval))
      socket.on('error', () => clearInterval(interval))
    }
  )
}
