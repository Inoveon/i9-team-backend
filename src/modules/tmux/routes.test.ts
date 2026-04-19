import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { tmuxRoutes } from './routes.js'

// Mock do service para não precisar de tmux real
vi.mock('./service.js', () => ({
  listSessions:   () => ['session-a', 'session-b'],
  createSession:  (name: string) => name.length > 0,
  destroySession: (name: string) => name === 'session-a',
  sendKeys:       () => {},
  captureSession: () => 'output simulado',
}))

const SECRET = 'test-secret'

async function buildApp() {
  const app = Fastify()
  await app.register(jwt, { secret: SECRET })

  // Simula autenticação: decora request.user
  app.addHook('onRequest', async (req) => {
    ;(req as any).user = { sub: 'test' }
  })

  await app.register(tmuxRoutes)
  return app
}

describe('tmux routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })

  it('GET /tmux/sessions — lista sessões', async () => {
    const res = await app.inject({ method: 'GET', url: '/tmux/sessions' })
    expect(res.statusCode).toBe(200)
    expect(res.json().sessions).toEqual(['session-a', 'session-b'])
  })

  it('POST /tmux/sessions — cria sessão válida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tmux/sessions',
      payload: { name: 'nova-sessao' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().ok).toBe(true)
  })

  it('POST /tmux/sessions — rejeita nome vazio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tmux/sessions',
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE /tmux/sessions/:name — deleta sessão existente', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/tmux/sessions/session-a' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  it('DELETE /tmux/sessions/:name — 404 para sessão inexistente', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/tmux/sessions/nao-existe' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /tmux/capture/:session — retorna output', async () => {
    const res = await app.inject({ method: 'GET', url: '/tmux/capture/session-a' })
    expect(res.statusCode).toBe(200)
    expect(res.json().output).toBe('output simulado')
  })
})
