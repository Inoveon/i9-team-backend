import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { ChatMessageData } from './service.js'

/**
 * Registry de conexões WebSocket por teamId.
 * Permite broadcast de mensagens a todos os clientes de um team.
 */
const clients = new Map<string, Set<WebSocket>>()

export function registerChatClient(teamId: string, socket: WebSocket): void {
  if (!clients.has(teamId)) clients.set(teamId, new Set())
  clients.get(teamId)!.add(socket)
}

export function unregisterChatClient(teamId: string, socket: WebSocket): void {
  clients.get(teamId)?.delete(socket)
  if (clients.get(teamId)?.size === 0) clients.delete(teamId)
}

export function broadcastChatMessage(teamId: string, message: ChatMessageData): void {
  const sockets = clients.get(teamId)
  if (!sockets || sockets.size === 0) return

  const payload = JSON.stringify({ type: 'chat_message', data: message })
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload)
    }
  }
}

export async function chatWsHandler(app: FastifyInstance): Promise<void> {
  /**
   * WebSocket de chat por team: GET /ws/chat/:teamId
   * Protocolo:
   *   server → { type: 'chat_message', data: ChatMessageData }
   *   server → { type: 'connected', teamId }
   */
  app.get<{ Params: { teamId: string } }>(
    '/ws/chat/:teamId',
    { websocket: true },
    (socket, request) => {
      const { teamId } = request.params

      registerChatClient(teamId, socket)
      socket.send(JSON.stringify({ type: 'connected', teamId }))

      socket.on('close', () => unregisterChatClient(teamId, socket))
      socket.on('error', () => unregisterChatClient(teamId, socket))
    }
  )
}
