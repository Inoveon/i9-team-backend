/**
 * sessionState.ts — Estado por sessão tmux com fan-out, ring buffer e dedup.
 *
 * Criado na Onda 1 (2026-04-21) para eliminar:
 *   - N setInterval paralelos (um por socket → passa a ser um por sessão)
 *   - Append cego de eventos no cliente (passa a ter seq monotônico + ring buffer)
 *   - Retransmissão do buffer inteiro a cada tick (passa a emitir só delta)
 *   - Heartbeat `tickCount % 5 === 0` de 10s (passa a ser WS ping nativo, no handler)
 *
 * Contrato público:
 *   attachSocket(session, socket, resumeFromSeq?) — anexa socket à sessão e envia replay
 *   detachSocket(session, socket)                 — desanexa (para a sessão se idle)
 *
 * Cada sessão ativa mantém:
 *   - setInterval(tick, 2s) UNICO
 *   - RingBuffer<RingEntry>(capacity=500) de eventos já emitidos
 *   - Map<hash, emittedAt> para dedup (TTL 120s)
 *   - Set<SubscribedSocket> para fan-out
 */
import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import { captureSession as realCapture } from '../tmux/service.js'
import { parseMessageStream, type MessageEvent } from './parseMessageStream.js'
import { parseInteractiveMenu, type ParseMenuResult } from './menuParser.js'

// Capture injetável — default usa tmux real. Tests chamam `__setCaptureForTests`
// para substituir por stub sem precisar mockar o módulo inteiro.
let captureSession: (session: string, lines?: number) => string = realCapture

/** @internal — usado por sessionState.test.ts. NÃO usar em produção. */
export function __setCaptureForTests(fn: (session: string, lines?: number) => string): void {
  captureSession = fn
}

/** @internal — restaura a captura real (cleanup de teste). */
export function __resetCaptureForTests(): void {
  captureSession = realCapture
}

// ────────────────────────────────────────────────────────────────────────────
// Configuração
// ────────────────────────────────────────────────────────────────────────────

/** Capacidade do ring buffer por sessão. ~2h de chat normal cabem. */
const RING_CAPACITY = 500

/** TTL de dedup por fingerprint. Depois disso, evento idêntico volta como novo. */
const FINGERPRINT_TTL_MS = 120_000

/** Janela de captura do tmux (linhas). Era 50 — subido para reduzir chance de */
/** evento sair da janela antes do dedup registrar. */
const CAPTURE_LINES = 2000

/** Intervalo entre ticks. Mantido em 2s para paridade com comportamento anterior. */
const TICK_INTERVAL_MS = 2000

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

/** Evento + seq monotônico + hash de dedup. Entra no ring buffer. */
interface RingEntry {
  seq: number
  hash: string
  event: MessageEvent
}

/** Evento serializado para o cliente inclui `seq` para que ele persista o cursor. */
type EventWithSeq = MessageEvent & { seq: number }

/** Frame enviado ao socket. Tipos espelham os que o cliente espera. */
type BroadcastFrame =
  | { type: 'output'; session: string; data: string; hasMenu: boolean }
  | { type: 'interactive_menu'; session: string; menuType: ParseMenuResult['type']; options: ParseMenuResult['options']; currentIndex: number }
  | { type: 'message_stream'; session: string; events: EventWithSeq[]; headSeq: number }
  | { type: 'subscribed'; session: string; reset: boolean; headSeq: number; events: EventWithSeq[] }

/** Um socket anexado, com lastSentSeq pra replay individualizado. */
interface SubscribedSocket {
  socket: WebSocket
  lastSentSeq: number
}

interface SessionContext {
  session: string
  interval: ReturnType<typeof setInterval>
  ring: RingBuffer<RingEntry>
  seen: Map<string, number> // hash → emittedAt
  nextSeq: number
  lastOutput: string
  sockets: Set<SubscribedSocket>
}

// ────────────────────────────────────────────────────────────────────────────
// Ring buffer — FIFO com limite fixo
// ────────────────────────────────────────────────────────────────────────────

class RingBuffer<T extends { seq: number }> {
  private data: T[] = []

  constructor(private readonly capacity: number) {}

  push(entry: T): void {
    this.data.push(entry)
    if (this.data.length > this.capacity) this.data.shift()
  }

  /** Entradas com seq > `afterSeq`. */
  since(afterSeq: number): T[] {
    if (afterSeq <= 0) return [...this.data]
    return this.data.filter((e) => e.seq > afterSeq)
  }

  oldestSeq(): number {
    return this.data[0]?.seq ?? 0
  }

  latestSeq(): number {
    return this.data[this.data.length - 1]?.seq ?? 0
  }

  size(): number {
    return this.data.length
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Estado global
// ────────────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionContext>()

// ────────────────────────────────────────────────────────────────────────────
// Fingerprint de evento — estável através de ticks
// ────────────────────────────────────────────────────────────────────────────

/**
 * Gera um hash determinístico por evento. Dois eventos com mesmo hash são
 * tratados como o MESMO evento e suprimidos dentro de FINGERPRINT_TTL_MS.
 *
 * Importante: `thinking.duration` e `tool_call.id` mudam entre ticks e por isso
 * NÃO entram no hash. Apenas o conteúdo semântico entra.
 */
function fingerprint(event: MessageEvent): string {
  const parts: string[] = [event.type]

  switch (event.type) {
    case 'user_input':
    case 'claude_text':
    case 'tool_result':
    case 'system':
      parts.push(event.content)
      break
    case 'thinking':
      // Duration cresce a cada tick enquanto o agente pensa — ignorar aqui para
      // que "Pensando…" não vire N eventos distintos.
      parts.push(event.label)
      break
    case 'tool_call':
      parts.push(event.name, event.args)
      break
    case 'interactive_menu':
      parts.push(event.title ?? '', (event.options ?? []).join('|'))
      break
  }

  return createHash('sha1').update(parts.join('\x00')).digest('hex')
}

// ────────────────────────────────────────────────────────────────────────────
// Serialização segura para enviar
// ────────────────────────────────────────────────────────────────────────────

function send(sock: SubscribedSocket, frame: BroadcastFrame): void {
  try {
    sock.socket.send(JSON.stringify(frame))
  } catch {
    // socket pode estar fechando — ignora
  }
}

function broadcast(ctx: SessionContext, frame: BroadcastFrame): void {
  for (const sock of ctx.sockets) send(sock, frame)
}

// ────────────────────────────────────────────────────────────────────────────
// Tick — captura, parseia, deduplica, emite delta
// ────────────────────────────────────────────────────────────────────────────

function tick(ctx: SessionContext): void {
  try {
    const output = captureSession(ctx.session, CAPTURE_LINES)

    // Se o output não mudou, nada a fazer. Keep-alive é responsabilidade do
    // ping WS nativo (no handler), não deste tick.
    if (output === ctx.lastOutput) return
    ctx.lastOutput = output

    // 1) Snapshot do terminal cru — xterm.js redesenha a partir disso.
    const menu = parseInteractiveMenu(output)
    broadcast(ctx, { type: 'output', session: ctx.session, data: output, hasMenu: !!menu })
    if (menu) {
      broadcast(ctx, {
        type: 'interactive_menu',
        session: ctx.session,
        menuType: menu.type,
        options: menu.options,
        currentIndex: menu.currentIndex,
      })
    }

    // 2) Parse de eventos estruturados + dedup por fingerprint.
    const parsed = parseMessageStream(output).filter((e) => e.type !== 'interactive_menu')
    const now = Date.now()

    // Expira fingerprints antigos — permite que frase idêntica dita de novo
    // depois de FINGERPRINT_TTL_MS volte a ser emitida.
    for (const [h, t] of ctx.seen) {
      if (now - t > FINGERPRINT_TTL_MS) ctx.seen.delete(h)
    }

    const newEntries: RingEntry[] = []
    for (const ev of parsed) {
      const h = fingerprint(ev)
      if (ctx.seen.has(h)) continue
      ctx.seen.set(h, now)
      const entry: RingEntry = { seq: ctx.nextSeq++, hash: h, event: ev }
      ctx.ring.push(entry)
      newEntries.push(entry)
    }

    if (newEntries.length > 0) {
      const headSeq = ctx.ring.latestSeq()
      broadcast(ctx, {
        type: 'message_stream',
        session: ctx.session,
        events: newEntries.map((e) => ({ ...e.event, seq: e.seq })),
        headSeq,
      })
      for (const sock of ctx.sockets) {
        if (headSeq > sock.lastSentSeq) sock.lastSentSeq = headSeq
      }
    }
  } catch {
    // sessão pode ter morrido; próximos ticks também vão falhar até ser removida.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle de sessão
// ────────────────────────────────────────────────────────────────────────────

function startSession(session: string): SessionContext {
  const existing = sessions.get(session)
  if (existing) return existing

  const ctx: SessionContext = {
    session,
    interval: null as unknown as ReturnType<typeof setInterval>,
    ring: new RingBuffer<RingEntry>(RING_CAPACITY),
    seen: new Map(),
    nextSeq: 1,
    lastOutput: '',
    sockets: new Set(),
  }

  ctx.interval = setInterval(() => tick(ctx), TICK_INTERVAL_MS)
  sessions.set(session, ctx)
  console.log(`[sessionState] sessão '${session}' iniciada (tick ${TICK_INTERVAL_MS}ms, capture ${CAPTURE_LINES} linhas)`)
  return ctx
}

function stopSessionIfIdle(session: string): void {
  const ctx = sessions.get(session)
  if (!ctx) return
  if (ctx.sockets.size === 0) {
    clearInterval(ctx.interval)
    sessions.delete(session)
    console.log(`[sessionState] sessão '${session}' parada (sem sockets)`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────────

/**
 * Anexa um socket à sessão. Envia {type:"subscribed"} imediatamente com
 * `reset: boolean` + `headSeq` + `events` (replay).
 *
 * @param resumeFromSeq cursor do cliente. Omitir/0 → cliente novo, receberá
 * snapshot completo com `reset:true`. Se o gap for maior que a capacidade do
 * ring, também força `reset:true`.
 */
export function attachSocket(session: string, socket: WebSocket, resumeFromSeq = 0): void {
  const ctx = startSession(session)

  const sub: SubscribedSocket = { socket, lastSentSeq: 0 }
  ctx.sockets.add(sub)

  // Decidir reset vs replay incremental:
  //  - resumeFromSeq 0 → cliente novo → reset=true, replay=tudo que houver
  //  - resumeFromSeq < oldestSeq → cliente está atrás do buffer → reset=true
  //  - resumeFromSeq >= latestSeq → cliente em dia → reset=false, replay=[]
  //  - no meio → reset=false, replay=.since(resumeFromSeq)
  const oldest = ctx.ring.oldestSeq()
  const latest = ctx.ring.latestSeq()
  const reset = resumeFromSeq <= 0 || (oldest > 0 && resumeFromSeq < oldest)

  const replay = reset ? ctx.ring.since(0) : ctx.ring.since(resumeFromSeq)
  sub.lastSentSeq = replay.length > 0 ? replay[replay.length - 1].seq : resumeFromSeq

  send(sub, {
    type: 'subscribed',
    session,
    reset,
    headSeq: latest,
    events: replay.map((e) => ({ ...e.event, seq: e.seq })),
  })

  console.log(
    `[sessionState] socket anexado a '${session}' (resumeFromSeq=${resumeFromSeq}, reset=${reset}, ` +
    `replayCount=${replay.length}, ringSize=${ctx.ring.size()}, latestSeq=${latest}, totalSockets=${ctx.sockets.size})`
  )
}

/**
 * Desanexa um socket da sessão. Se não sobrar nenhum, o interval é parado e a
 * sessão é removida da memória.
 */
export function detachSocket(session: string, socket: WebSocket): void {
  const ctx = sessions.get(session)
  if (!ctx) return
  for (const sub of ctx.sockets) {
    if (sub.socket === socket) {
      ctx.sockets.delete(sub)
      break
    }
  }
  stopSessionIfIdle(session)
}

/** Introspecção (útil para testes/debug). */
export function getSessionStats(session: string): { seq: number; ringSize: number; sockets: number } | null {
  const ctx = sessions.get(session)
  if (!ctx) return null
  return { seq: ctx.nextSeq - 1, ringSize: ctx.ring.size(), sockets: ctx.sockets.size }
}

export function listActiveSessions(): string[] {
  return [...sessions.keys()]
}
