/**
 * sessionState.test.ts — valida fan-out de output bruto pós-cleanup v1.
 *
 * Histórico: a versão anterior validava ring buffer + dedup + replay de
 * `message_stream`. No cleanup portal-backend-cleanup-v1 (2026-04-27) o
 * fan-out foi reduzido a `output` + `interactive_menu`, então estes testes
 * foram simplificados pra refletir o contrato novo.
 *
 * Não depende de Fastify, usa WebSocket mock com `send`/`ping`/`readyState`.
 * Monkey-patch em `tmux/service.captureSession` para controlar o output.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  attachSocket,
  detachSocket,
  getSessionStats,
  listActiveSessions,
  __setCaptureForTests,
  __resetCaptureForTests,
} from './sessionState.js'

let capturedOutput = ''
__setCaptureForTests(() => capturedOutput)

function makeMockSocket(): EventEmitter & {
  send: (data: string) => void
  ping: () => void
  readyState: number
  OPEN: number
  received: unknown[]
  pings: number
} {
  const ee = new EventEmitter() as EventEmitter & {
    send: (data: string) => void
    ping: () => void
    readyState: number
    OPEN: number
    received: unknown[]
    pings: number
  }
  ee.received = []
  ee.pings = 0
  ee.readyState = 1
  ee.OPEN = 1
  ee.send = (data: string) => { ee.received.push(JSON.parse(data)) }
  ee.ping = () => { ee.pings += 1 }
  return ee
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Faz N ticks passarem (2s cada + margem)
async function waitTicks(n = 2): Promise<void> {
  await sleep(2000 * n + 300)
}

describe('sessionState — fan-out de output bruto (cleanup v1)', () => {
  after(() => {
    __resetCaptureForTests()
  })

  it('attachSocket envia frame "subscribed" imediato (events: [], reset: true)', () => {
    capturedOutput = ''
    const s = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-sub', s as any)

    const sub = s.received[0] as { type: string; reset: boolean; headSeq: number; events: unknown[] }
    assert.equal(sub.type, 'subscribed')
    assert.equal(sub.reset, true)
    assert.equal(sub.headSeq, 0)
    assert.deepEqual(sub.events, [])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-sub', s as any)
  })

  it('2 sockets na mesma sessão recebem o MESMO frame "output" (fan-out)', async () => {
    capturedOutput = '⏺ Primeira resposta do agente'
    const a = makeMockSocket()
    const b = makeMockSocket()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-A', a as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-A', b as any)

    await waitTicks(1)

    const aOuts = a.received.filter((m) => (m as { type: string }).type === 'output') as Array<{ data: string }>
    const bOuts = b.received.filter((m) => (m as { type: string }).type === 'output') as Array<{ data: string }>
    assert.ok(aOuts.length >= 1, 'A deve ter recebido ao menos 1 output')
    assert.ok(bOuts.length >= 1, 'B deve ter recebido ao menos 1 output')
    assert.equal(aOuts[0].data, bOuts[0].data, 'fan-out: ambos veem o mesmo data')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-A', a as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-A', b as any)
  })

  it('output idêntico em ticks consecutivos NÃO é re-broadcast', async () => {
    capturedOutput = '⏺ Mensagem única que não deveria duplicar'
    const s = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-B', s as any)

    // Espera 3 ticks com o MESMO output
    await waitTicks(3)

    const outputs = s.received.filter((m) => (m as { type: string }).type === 'output') as Array<{ data: string }>
    // O lastOutput muda de '' → conteúdo no primeiro tick, depois fica idêntico → 1 broadcast só.
    assert.equal(outputs.length, 1, 'output idêntico não deve ser reemitido')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-B', s as any)
  })

  it('socket novo recebe snapshot do lastOutput sem esperar próximo tick', async () => {
    capturedOutput = '⏺ Conteúdo já capturado'
    const first = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-snap', first as any)
    await waitTicks(1)

    // segundo socket entra → deve receber subscribed + output snapshot imediato
    const second = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-snap', second as any)

    const types = second.received.map((m) => (m as { type: string }).type)
    assert.equal(types[0], 'subscribed', 'primeiro frame: subscribed')
    assert.equal(types[1], 'output', 'segundo frame: output snapshot imediato')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-snap', first as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-snap', second as any)
  })

  it('3 sessões simultâneas: cada uma com seu próprio contexto', async () => {
    capturedOutput = '⏺ Conteúdo compartilhado (mas em sessões diferentes!)'
    const s1 = makeMockSocket()
    const s2 = makeMockSocket()
    const s3 = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-E', s1 as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-F', s2 as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-G', s3 as any)

    await waitTicks(1)

    const e = getSessionStats('sess-E')
    const f = getSessionStats('sess-F')
    const g = getSessionStats('sess-G')
    assert.ok(e && f && g)
    assert.equal(e.sockets, 1)
    assert.equal(f.sockets, 1)
    assert.equal(g.sockets, 1)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-E', s1 as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-F', s2 as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-G', s3 as any)
  })

  it('sessão para quando último socket desconecta', () => {
    capturedOutput = '⏺ Olá'
    const s = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-H', s as any)
    assert.ok(listActiveSessions().includes('sess-H'))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-H', s as any)
    assert.ok(!listActiveSessions().includes('sess-H'))
  })
})
