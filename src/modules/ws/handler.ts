import type { FastifyInstance } from 'fastify'
import { captureSession } from '../tmux/service.js'

export async function wsHandler(app: FastifyInstance) {
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
            socket.send(JSON.stringify({ session, output, ts: Date.now() }))
          }
        } catch {
          // session may have closed
        }
      }, 2000)

      socket.on('close', () => {
        clearInterval(interval)
      })

      socket.on('error', () => {
        clearInterval(interval)
      })
    }
  )
}
