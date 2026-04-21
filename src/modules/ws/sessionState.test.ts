/**
 * sessionState.test.ts — valida o mecanismo 1-interval-por-sessão + fan-out
 * + dedup + ring buffer + replay.
 *
 * Não depende de Fastify, usa WebSocket mock com `send`/`ping`/`readyState`.
 * Monkey-patch em `tmux/service.captureSession` para controlar o output.
 */
import { describe, it, after, afterEach } from 'node:test'
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

// Faz 2 ticks passarem (2s cada + margem)
async function waitTicks(n = 2): Promise<void> {
  await sleep(2000 * n + 300)
}

describe('sessionState — fan-out com 1 interval por sessão', () => {
  after(() => {
    __resetCaptureForTests()
  })

  afterEach(() => {
    // garante cleanup entre cases
    for (const s of listActiveSessions()) {
      const ctx = getSessionStats(s)
      if (ctx) {
        // força remoção detachando sockets fantasma: impossível sem referência,
        // então só contamos com o próprio teste pra limpar.
      }
    }
  })

  it('2 sockets na mesma sessão recebem os MESMOS eventos (fan-out)', async () => {
    capturedOutput = `
⏺ Primeira resposta do agente
`.trim()
    const a = makeMockSocket()
    const b = makeMockSocket()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-A', a as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-A', b as any)

    // ambos recebem subscribed imediatamente
    assert.equal(a.received[0] && (a.received[0] as { type: string }).type, 'subscribed')
    assert.equal(b.received[0] && (b.received[0] as { type: string }).type, 'subscribed')

    await waitTicks(1)

    const aStream = a.received.filter((m) => (m as { type: string }).type === 'message_stream') as Array<{ events: unknown[] }>
    const bStream = b.received.filter((m) => (m as { type: string }).type === 'message_stream') as Array<{ events: unknown[] }>
    assert.ok(aStream.length >= 1, 'A deve ter recebido ao menos 1 message_stream')
    assert.ok(bStream.length >= 1, 'B deve ter recebido ao menos 1 message_stream')
    assert.deepEqual(aStream[0].events, bStream[0].events)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-A', a as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-A', b as any)
  })

  it('dedup: mesmo evento não é reemitido em ticks consecutivos', async () => {
    capturedOutput = `
⏺ Mensagem única que não deveria duplicar
`.trim()
    const s = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-B', s as any)

    // Espera 3 ticks com o MESMO output — se tivesse heartbeat o event iria 3x.
    await waitTicks(3)

    const streamMsgs = s.received.filter((m) => (m as { type: string }).type === 'message_stream') as Array<{ events: Array<{ type: string; content?: string; seq: number }> }>
    const claudeTexts = streamMsgs.flatMap((m) => m.events).filter((e) => e.type === 'claude_text')

    // Pode ter N streams (output mudou entre lastOutput vazio e primeiro tick),
    // mas só UM evento claude_text com esse conteúdo.
    const distinctContents = new Set(claudeTexts.map((e) => e.content))
    assert.equal(distinctContents.size, 1)
    assert.equal(claudeTexts.length, 1, 'evento idêntico não deve aparecer 2x')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-B', s as any)
  })

  it('replay: socket que reconecta com resumeFromSeq recebe só delta', async () => {
    capturedOutput = `
⏺ Primeira mensagem
`.trim()
    const s1 = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-C', s1 as any)
    await waitTicks(1)

    // Captura seq atual
    const stats1 = getSessionStats('sess-C')
    assert.ok(stats1)
    const seqAtDisconnect = stats1.seq
    assert.ok(seqAtDisconnect >= 1, `seq deve ter avançado, atual=${seqAtDisconnect}`)

    // Desconecta — sessão deve CONTINUAR viva se s1 era o único? Não, ela para.
    // Para simular reconexão sem perder buffer, precisamos outro socket ativo.
    // Então: conecta s2 pra manter ring buffer vivo, s1 se desconecta, s1 volta.
    const keepAlive = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-C', keepAlive as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-C', s1 as any)

    // Novo output gera novo evento
    capturedOutput = `
⏺ Primeira mensagem
⏺ Segunda mensagem nova
`.trim()
    await waitTicks(1)

    // s1 reconecta com resumeFromSeq = seqAtDisconnect → só deve receber seqAtDisconnect+1 em diante
    const s1b = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-C', s1b as any, seqAtDisconnect)

    const sub = s1b.received[0] as { type: string; reset: boolean; events: Array<{ seq: number; type: string }> }
    assert.equal(sub.type, 'subscribed')
    assert.equal(sub.reset, false, 'reconexão com seq válido NÃO deve forçar reset')
    assert.ok(sub.events.every((e) => e.seq > seqAtDisconnect), 'replay só deve conter seq > resumeFromSeq')
    assert.ok(sub.events.length >= 1, 'deve ter ao menos 1 evento novo no replay')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-C', keepAlive as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-C', s1b as any)
  })

  it('reset: cliente com seq 0 (novo) recebe reset:true + snapshot', async () => {
    capturedOutput = `
⏺ Alô mundo
`.trim()
    const s = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-D', s as any, 0)
    const sub = s.received[0] as { type: string; reset: boolean; headSeq: number; events: unknown[] }
    assert.equal(sub.type, 'subscribed')
    assert.equal(sub.reset, true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-D', s as any)
  })

  it('3 sessões simultâneas: cada uma com seu próprio nextSeq independente', async () => {
    capturedOutput = `
⏺ Conteúdo compartilhado (mas em sessões diferentes!)
`.trim()
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
    assert.ok(e.seq >= 1)
    assert.ok(f.seq >= 1)
    assert.ok(g.seq >= 1)
    // Cada sessão tem seu próprio ring — são independentes.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-E', s1 as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-F', s2 as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-G', s3 as any)
  })

  it('sessão para quando último socket desconecta', async () => {
    capturedOutput = `⏺ Olá`
    const s = makeMockSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachSocket('sess-H', s as any)
    assert.ok(listActiveSessions().includes('sess-H'))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachSocket('sess-H', s as any)
    assert.ok(!listActiveSessions().includes('sess-H'))
  })
})
