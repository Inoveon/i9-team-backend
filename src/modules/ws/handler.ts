/**
 * handler.ts — WebSocket handler do chat.
 *
 * Refatorado na Onda 1 (2026-04-21):
 *   - Delega captura/fan-out para `sessionState.ts` (1 interval por sessão).
 *   - Protocolo `subscribed` agora inclui `reset`, `headSeq`, replay de eventos.
 *   - Cliente pode mandar `{type:"subscribe", session, resumeFromSeq}` para
 *     replay incremental sem perder histórico ao reconectar.
 *   - Heartbeat de 10s removido; keep-alive é WS ping nativo a cada 30s.
 *   - `/ws/:session` mantido por compatibilidade, mas marcado como deprecated.
 */
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { execSync } from 'node:child_process'
import { sendKeys } from '../tmux/service.js'
import { parseMessageStream } from './parseMessageStream.js'
import { captureSession } from '../tmux/service.js'
import { selectMenuOption } from './menuParser.js'
import { attachSocket, detachSocket } from './sessionState.js'

/** Ping WS nativo a cada 30s — mantém conexão viva atrás de NAT/proxy. */
const PING_INTERVAL_MS = 30_000

interface SubscribeMsg    { type: 'subscribe';     session: string; resumeFromSeq?: number }
interface InputMsg        { type: 'input';          keys: string }
interface SelectOptionMsg { type: 'select_option'; session: string; value: string; currentIndex?: number }
interface ResizeMsg        { type: 'resize';        cols: number; rows: number }

type ClientMsg = SubscribeMsg | InputMsg | SelectOptionMsg | ResizeMsg

/**
 * Anexa keep-alive ping ao socket. Retorna o timer para cleanup.
 * O ping é frame de controle WS nativo — ws.ping() envia OPCODE 0x9 e o cliente
 * responde com PONG (OPCODE 0xA) automaticamente, sem código no app.
 */
function startPing(socket: WebSocket): NodeJS.Timeout {
  return setInterval(() => {
    try {
      if (socket.readyState === socket.OPEN) socket.ping()
    } catch {
      // socket fechando
    }
  }, PING_INTERVAL_MS)
}

export async function wsHandler(app: FastifyInstance) {
  /**
   * WebSocket canônico — protocolo de mensagens:
   *   cliente → { type: "subscribe",     session: string, resumeFromSeq?: number }
   *   cliente → { type: "input",         keys: string }
   *   cliente → { type: "select_option", session: string, value: string, currentIndex?: number }
   *   server  → { type: "subscribed",    session, reset, headSeq, events }
   *   server  → { type: "output",        session, data, hasMenu }
   *   server  → { type: "interactive_menu", session, menuType, options, currentIndex }
   *   server  → { type: "message_stream",  session, events, headSeq }
   *   server  → { type: "error",         message }
   */
  app.get('/ws', { websocket: true }, (socket) => {
    let currentSession = ''
    const pingTimer = startPing(socket)

    socket.on('message', (raw: Buffer | string) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Mensagem inválida (JSON)' }))
        return
      }

      if (msg.type === 'subscribe' && msg.session) {
        // Trocar de sessão: desanexa da anterior (se houver) e anexa à nova.
        if (currentSession && currentSession !== msg.session) {
          detachSocket(currentSession, socket)
        }
        currentSession = msg.session
        attachSocket(msg.session, socket, msg.resumeFromSeq ?? 0)
        return
      }

      if (msg.type === 'input' && msg.keys && currentSession) {
        console.log(`[ws] sendKeys session=${currentSession} bytes=${msg.keys.length}`)
        sendKeys(currentSession, msg.keys)
        return
      }

      if (msg.type === 'select_option' && msg.session && msg.value) {
        const idx = parseInt(msg.value, 10)
        const cur = (msg as SelectOptionMsg).currentIndex ?? 1
        if (!isNaN(idx)) selectMenuOption(msg.session, idx, cur)
        return
      }

      if (msg.type === 'resize' && currentSession) {
        const { cols, rows } = msg as ResizeMsg
        try {

          execSync(`tmux resize-window -t ${currentSession} -x ${cols} -y ${rows}`, { stdio: 'ignore' })
        } catch { /* sessão pode não existir */ }
        return
      }

      socket.send(JSON.stringify({ type: 'error', message: 'Mensagem não reconhecida' }))
    })

    socket.on('close', () => {
      clearInterval(pingTimer)
      if (currentSession) detachSocket(currentSession, socket)
    })
    socket.on('error', () => {
      clearInterval(pingTimer)
      if (currentSession) detachSocket(currentSession, socket)
    })
  })

  /**
   * `/ws/:session` — DEPRECATED. Mantido por compatibilidade; delega ao mesmo
   * `sessionState` do endpoint canônico `/ws`. Remover em release seguinte.
   *
   * Diferença: não aceita `resumeFromSeq` via subscribe (o session vem da URL),
   * então sempre faz replay completo com `reset:true`.
   */
  app.get<{ Params: { session: string } }>(
    '/ws/:session',
    { websocket: true },
    (socket, request) => {
      const { session } = request.params
      console.warn(`[ws] DEPRECATED /ws/:session acessado (session=${session}). Use /ws com {type:"subscribe"}.`)

      const pingTimer = startPing(socket)
      attachSocket(session, socket, 0)

      socket.on('message', (raw: Buffer | string) => {
        let msg: ClientMsg
        try {
          msg = JSON.parse(raw.toString()) as ClientMsg
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Mensagem inválida (JSON)' }))
          return
        }

        if (msg.type === 'input' && msg.keys) {
          console.log(`[ws/:session] sendKeys session=${session} bytes=${msg.keys.length}`)
          sendKeys(session, msg.keys)
          return
        }

        if (msg.type === 'select_option' && msg.value) {
          const target = (msg as SelectOptionMsg).session || session
          const idx = parseInt(msg.value, 10)
          const cur = (msg as SelectOptionMsg).currentIndex ?? 1
          if (!isNaN(idx)) selectMenuOption(target, idx, cur)
        }
      })

      socket.on('close', () => {
        clearInterval(pingTimer)
        detachSocket(session, socket)
      })
      socket.on('error', () => {
        clearInterval(pingTimer)
        detachSocket(session, socket)
      })
    }
  )

  /**
   * Debug — GET /debug/parse-stream?agent=session-name
   * Inalterado: captura o output atual e retorna eventos parseados crus.
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
