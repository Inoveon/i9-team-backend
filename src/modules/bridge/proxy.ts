import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'

const BRIDGE_BASE = 'http://localhost:7773'
const LOG_FILE = '/tmp/mqtt-bridge-service.log'
const SSE_TIMEOUT_MS = 300_000 // 5 minutes

async function fetchBridge(path: string): Promise<{ ok: boolean; data: unknown }> {
  try {
    const res = await fetch(`${BRIDGE_BASE}${path}`)
    const data = await res.json()
    return { ok: true, data }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return { ok: false, data: null }
    }
    throw err
  }
}

export async function bridgeProxy(app: FastifyInstance) {
  // GET /bridge/status
  app.get('/bridge/status', async (_request, reply) => {
    const { ok, data } = await fetchBridge('/api/status')
    if (!ok) {
      return reply.status(503).send({ connected: false, error: 'Bridge indisponível' })
    }
    return reply.send(data)
  })

  // GET /bridge/stats
  app.get('/bridge/stats', async (_request, reply) => {
    const { ok, data } = await fetchBridge('/api/stats')
    if (!ok) {
      return reply.status(503).send({ error: 'Bridge indisponível' })
    }
    return reply.send(data)
  })

  // GET /bridge/logs — SSE tail do log
  // EventSource não suporta headers customizados, então aceita token via query param ?token=
  app.get('/bridge/logs', {
    websocket: false,
    config: { skipAuth: true }, // auth manual abaixo
  }, async (
    request: FastifyRequest<{ Querystring: { token?: string } }>,
    reply: FastifyReply
  ) => {
    const authHeader = request.headers.authorization
    const queryToken = (request.query as { token?: string }).token
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryToken
    if (!rawToken) {
      return reply.status(401).send({ error: 'Token obrigatório' })
    }
    try {
      await request.jwtVerify()
    } catch {
      // jwtVerify lê o header — se veio via query, verificar manualmente
      try {
        app.jwt.verify(rawToken)
      } catch {
        return reply.status(401).send({ error: 'Token inválido' })
      }
    }
    const raw = reply.raw as ServerResponse

    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache')
    raw.setHeader('Connection', 'keep-alive')
    raw.setHeader('X-Accel-Buffering', 'no')
    raw.flushHeaders()

    const tail = spawn('tail', ['-f', '-n', '50', LOG_FILE])

    const timeout = setTimeout(() => {
      tail.kill()
      raw.end()
    }, SSE_TIMEOUT_MS)

    tail.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          raw.write(`data: ${line}\n\n`)
        }
      }
    })

    tail.stderr.on('data', (chunk: Buffer) => {
      raw.write(`data: [stderr] ${chunk.toString().trim()}\n\n`)
    })

    tail.on('close', () => {
      clearTimeout(timeout)
      raw.end()
    })

    request.raw.on('close', () => {
      clearTimeout(timeout)
      tail.kill()
    })

    // Prevent Fastify from sending its own response
    await new Promise<void>((resolve) => {
      raw.on('finish', resolve)
      raw.on('close', resolve)
    })
  })
}
