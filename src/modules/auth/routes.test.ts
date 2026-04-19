import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { authPlugin } from './plugin.js'

const SECRET = 'test-secret'

async function buildApp() {
  const app = Fastify()
  await app.register(jwt, { secret: SECRET })
  await app.register(authPlugin)
  return app
}

describe('POST /auth/login', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })

  it('retorna token com credenciais válidas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        username: process.env.APP_USER ?? 'admin',
        password: process.env.APP_PASSWORD ?? 'i9team',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('access_token')
    expect(typeof body.access_token).toBe('string')
  })

  it('retorna 401 com credenciais inválidas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'wrong', password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('retorna 400 sem body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })
})
