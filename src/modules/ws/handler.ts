import type { FastifyInstance } from 'fastify'
import { captureSession, sendKeys } from '../tmux/service.js'

interface SubscribeMsg { type: 'subscribe'; session: string }
interface InputMsg { type: 'input'; keys: string }

type ClientMsg = SubscribeMsg | InputMsg

export async function wsHandler(app: FastifyInstance) {
  /**
   * WebSocket genérico — protocolo de mensagens:
   *   cliente → { type: "subscribe", session: "nome" }
   *   server  → { type: "output", session: "nome", data: "..." }
   *   server  → { type: "error", message: "..." }
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
