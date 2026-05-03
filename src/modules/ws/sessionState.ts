/**
 * sessionState.ts — Estado por sessão tmux com fan-out de output bruto.
 *
 * Histórico:
 *   - Onda 1 (2026-04-21): introduziu 1 interval por sessão + ring buffer +
 *     dedup + seq monotônico para alimentar a aba "Chat" do AgentView via
 *     evento `message_stream` (parseMessageStream).
 *   - Cleanup portal-backend-cleanup-v1 (2026-04-27): a aba "Chat" foi
 *     descontinuada — o frontend passou a renderizar SOMENTE output bruto
 *     em xterm.js + menu interativo (parseInteractiveMenu / menuParser).
 *     Portanto o fan-out aqui SÓ emite `output` + `interactive_menu`.
 *     parseMessageStream segue existindo, mas é usado APENAS pelo endpoint
 *     debug `GET /debug/parse-stream` (handler.ts) — não no path principal.
 *
 * Contrato público:
 *   attachSocket(session, socket, resumeFromSeq?) — anexa socket à sessão e
 *     envia frame `subscribed` imediatamente seguido de um `output` snapshot.
 *     `resumeFromSeq` é aceito por compatibilidade com clientes antigos, mas
 *     ignorado: como xterm.js redesenha a partir do snapshot, não há buffer
 *     de eventos pra "resumir".
 *   detachSocket(session, socket) — desanexa (para a sessão se idle)
 *
 * Cada sessão ativa mantém:
 *   - setInterval(tick, 2s) UNICO
 *   - lastOutput (string) para suprimir broadcast quando nada mudou
 *   - Set<SubscribedSocket> para fan-out
 */
import type { WebSocket } from 'ws'
import { captureSession as realCapture } from '../tmux/service.js'
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

/** Janela de captura do tmux (linhas). 2000 cobre histórico extenso. */
const CAPTURE_LINES = 2000

/** Intervalo entre ticks. Mantido em 2s para paridade com comportamento anterior. */
const TICK_INTERVAL_MS = 2000

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

/** Frame enviado ao socket. Tipos espelham os que o cliente espera. */
type BroadcastFrame =
  | { type: 'output'; session: string; data: string; hasMenu: boolean }
  | { type: 'interactive_menu'; session: string; menuType: ParseMenuResult['type']; options: ParseMenuResult['options']; currentIndex: number }
  | { type: 'subscribed'; session: string; reset: boolean; headSeq: number; events: never[] }

interface SubscribedSocket {
  socket: WebSocket
}

interface SessionContext {
  session: string
  interval: ReturnType<typeof setInterval>
  lastOutput: string
  sockets: Set<SubscribedSocket>
}

// ────────────────────────────────────────────────────────────────────────────
// Estado global
// ────────────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionContext>()

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
// Tick — captura, broadcast de snapshot + menu interativo (se houver)
// ────────────────────────────────────────────────────────────────────────────

function tick(ctx: SessionContext): void {
  try {
    const output = captureSession(ctx.session, CAPTURE_LINES)

    // Se o output não mudou, nada a fazer. Keep-alive é responsabilidade do
    // ping WS nativo (no handler), não deste tick.
    if (output === ctx.lastOutput) return
    ctx.lastOutput = output

    // Snapshot do terminal cru — xterm.js redesenha a partir disso.
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
 * Anexa um socket à sessão. Envia `subscribed` (compat) e, se já houver output
 * capturado, envia também um `output` snapshot imediato pra o cliente novo
 * pintar a tela sem esperar 2s pelo próximo tick.
 *
 * @param resumeFromSeq aceito por compatibilidade com clientes antigos —
 *   IGNORADO. xterm.js renderiza do snapshot bruto, então não há buffer de
 *   eventos pra retomar. Sempre `reset:true`, `headSeq:0`, `events:[]`.
 */
export function attachSocket(session: string, socket: WebSocket, resumeFromSeq = 0): void {
  void resumeFromSeq // explicitly unused — kept for API compat
  const ctx = startSession(session)

  const sub: SubscribedSocket = { socket }
  ctx.sockets.add(sub)

  // 1) frame `subscribed` (compat) — sem replay de eventos
  send(sub, { type: 'subscribed', session, reset: true, headSeq: 0, events: [] })

  // 2) snapshot imediato — se a sessão já tem output capturado, mandamos pro
  //    cliente novo pintar antes do próximo tick. Tira a percepção de delay
  //    inicial sem precisar reativar dedup/ring.
  if (ctx.lastOutput.length > 0) {
    const menu = parseInteractiveMenu(ctx.lastOutput)
    send(sub, { type: 'output', session, data: ctx.lastOutput, hasMenu: !!menu })
    if (menu) {
      send(sub, {
        type: 'interactive_menu',
        session,
        menuType: menu.type,
        options: menu.options,
        currentIndex: menu.currentIndex,
      })
    }
  }

  console.log(
    `[sessionState] socket anexado a '${session}' (totalSockets=${ctx.sockets.size}, hasSnapshot=${ctx.lastOutput.length > 0})`
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
  // seq/ringSize zerados — o ring buffer foi removido no cleanup v1.
  // Mantidos no shape para compat com possíveis consumidores externos.
  return { seq: 0, ringSize: 0, sockets: ctx.sockets.size }
}

export function listActiveSessions(): string[] {
  return [...sessions.keys()]
}
