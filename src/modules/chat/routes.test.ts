import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { chatRoutes } from './routes.js'

const FAKE_MSG = {
  id: 'cuid-1',
  teamId: 'team-abc',
  agentId: null,
  role: 'user',
  content: 'Olá agente!',
  createdAt: new Date('2026-04-19T00:00:00Z'),
}

// Mock do service e ws para isolar de DB/WebSocket
vi.mock('./service.js', () => ({
  createMessage: async () => FAKE_MSG,
  listMessages:  async () => [FAKE_MSG],
}))
vi.mock('./ws.js', () => ({
  broadcastChatMessage: () => {},
}))

async function buildApp() {
  const app = Fastify()
  await app.register(jwt, { secret: 'test-secret' })
  await app.register(chatRoutes)
  return app
}

describe('chat routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })

  it('POST /chat/messages — cria mensagem válida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/messages',
      payload: { teamId: 'team-abc', role: 'user', content: 'Olá agente!' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe('cuid-1')
  })

  it('POST /chat/messages — rejeita role inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/messages',
      payload: { teamId: 'team-abc', role: 'invalid', content: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /chat/messages — rejeita content vazio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/messages',
      payload: { teamId: 'team-abc', role: 'user', content: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /chat/messages — retorna histórico', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chat/messages?teamId=team-abc',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toBe('Olá agente!')
  })

  it('GET /chat/messages — rejeita sem teamId', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat/messages' })
    expect(res.statusCode).toBe(400)
  })
})
