import { execSync as realExecSync } from 'child_process'

const OPTS = { encoding: 'utf8' as const }

// Indireção de `execSync` para permitir mock em testes sem truques de ESM.
// Retorno é sempre string (execSync real retorna string quando encoding='utf8'
// é passado; nos call-sites sem encoding o retorno é ignorado, portanto
// casting estreito para string é seguro).
type ExecFn = (cmd: string, opts?: { input?: string; encoding?: 'utf8' }) => string
let execSync: ExecFn = ((cmd, opts) =>
  (realExecSync(cmd, opts as Parameters<typeof realExecSync>[1]) as unknown as string)) as ExecFn

/** @internal — usado por service.test.ts. NÃO usar em produção. */
export function __setExecForTests(fn: ExecFn): void {
  execSync = fn
}

/** @internal — restaura execSync real. */
export function __resetExecForTests(): void {
  execSync = ((cmd, opts) =>
    (realExecSync(cmd, opts as Parameters<typeof realExecSync>[1]) as unknown as string)) as ExecFn
}

export interface TmuxSession {
  name: string
  windows: number
  created: string
  attached: boolean
}

export function listSessions(): TmuxSession[] {
  try {
    const raw = execSync(
      "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'",
      OPTS
    ).trim()
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, windows, created, attached] = line.split('|')
        return {
          name,
          windows: Number(windows),
          created: new Date(Number(created) * 1000).toISOString(),
          attached: attached === '1',
        }
      })
  } catch {
    return []
  }
}

export function createSession(name: string): boolean {
  const exists = listSessions().some((s) => s.name === name)
  if (exists) return true
  try {
    execSync(`tmux new-session -d -s "${name}"`)
    return true
  } catch {
    return false
  }
}

export function destroySession(name: string): boolean {
  try {
    execSync(`tmux kill-session -t "${name}"`)
    return true
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────────
// sendKeys — envio com suporte a multilinha (Onda 4 / Issue #2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Modos de envio multilinha. Controlado por `TMUX_MULTILINE_MODE`.
 *
 *  - `keys`  (default, vencedor do gate empírico 2026-04-21):
 *      split por `\n` → `send-keys -l <linha>` + `S-Enter` entre linhas +
 *      `Enter` final. Shift+Enter é interpretado pelo Claude Code TUI como
 *      nova linha dentro do input. Mais portável; não depende de bracketed
 *      paste do terminal alvo.
 *
 *  - `paste`: `load-buffer` + `paste-buffer -p` + `Enter`. Usa bracketed
 *      paste (sequência ESC[200~ ... ESC[201~). 3 execSync total
 *      independente do número de linhas. Fallback caso S-Enter deixe de
 *      funcionar em versão futura do CC.
 *
 *  - `flat`: substitui `\n` por espaço e envia como linha única. Degradação
 *      consciente para terminais muito antigos.
 */
export type MultilineMode = 'keys' | 'paste' | 'flat'

function resolveMode(): MultilineMode {
  const env = (process.env.TMUX_MULTILINE_MODE ?? '').toLowerCase()
  if (env === 'paste' || env === 'flat' || env === 'keys') return env
  return 'keys'
}

function q(s: string): string {
  return JSON.stringify(s)
}

/**
 * Fecha autocomplete/file-picker do CC TUI antes do Enter final, quando
 * solicitado pelo caller (ex: payload com `@<absPath>` que dispara o file
 * picker do Claude Code). Veja `SendKeysOptions.closePickerBefore`.
 *
 * Sem o `Escape`, o Enter pode ser absorvido pelo picker — a mensagem fica
 * pendurada no input e o próximo input do usuário também é desviado.
 *
 * O pequeno sleep entre Escape e Enter dá tempo da UI processar o close
 * antes do submit. Subido de 0.1s → 0.2s no
 * portal-investigate-enter-intermittent (margem extra de timing — alguns
 * estados do CC TUI demoram mais que 100ms pra fechar overlay quando há
 * animação/pensamento em curso).
 */
function sendEscapeAndEnter(s: string): void {
  execSync(`tmux send-keys -t ${s} Escape`)
  execSync(`sleep 0.2`)
  execSync(`tmux send-keys -t ${s} Enter`)
}

/**
 * Limpa qualquer texto pendurado no input bar do CC TUI (Ctrl-U = kill-line
 * no readline). Aplicado antes de cada `sendKeys` exceto se caller pedir
 * `skipClear: true` (ex: cenário onde o user está digitando direto e a
 * última request foi puro ECHO).
 *
 * Fix portal-context-endpoint-and-enter-escalation (2026-04-27): elimina
 * o cenário em que texto pendurado de um Enter falhado anteriormente era
 * concatenado com o payload novo, causando submit unificado.
 */
function clearInputBuffer(s: string): void {
  execSync(`tmux send-keys -t ${s} C-u`)
}

/** Envio single-line (sem `\n`). Mantém o comportamento anterior byte-a-byte. */
function sendKeysSingleLine(session: string, keys: string, closePickerBefore: boolean, skipClear: boolean): void {
  const s = q(session)
  if (!skipClear) clearInputBuffer(s)
  if (closePickerBefore) {
    if (keys.length > 0) execSync(`tmux send-keys -t ${s} -l ${q(keys)}`)
    sendEscapeAndEnter(s)
    return
  }
  // Não pode usar a forma "send-keys SESSION TEXTO Enter" porque tmux pode
  // tentar interpretar tokens dentro de TEXTO como nomes de tecla. Usamos
  // -l (literal) + Enter separado pra garantir submit confiável.
  if (keys.length > 0) execSync(`tmux send-keys -t ${s} -l ${q(keys)}`)
  execSync(`tmux send-keys -t ${s} Enter`)
}

/**
 * Envio multilinha via Estratégia A — vencedora do gate empírico.
 *
 * Para cada linha:
 *   1. `tmux send-keys -t SESSION -l <linha>` (literal — não interpreta nome
 *      de tecla dentro do texto, ex.: "Enter", "Up", "C-c").
 *   2. Entre linhas: `tmux send-keys -t SESSION S-Enter` (Shift+Enter =
 *      newline no CC TUI, NÃO submete).
 *   3. Ao final: `tmux send-keys -t SESSION Enter` (submete).
 *
 * Linhas vazias são tratadas emitindo apenas o `S-Enter` (pula `-l` com
 * string vazia, que tmux rejeita).
 */
function sendKeysMultilineKeys(session: string, keys: string, closePickerBefore: boolean, skipClear: boolean): void {
  const s = q(session)
  if (!skipClear) clearInputBuffer(s)
  const lines = keys.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 0) {
      execSync(`tmux send-keys -t ${s} -l ${q(line)}`)
    }
    if (i < lines.length - 1) {
      execSync(`tmux send-keys -t ${s} S-Enter`)
    }
  }
  if (closePickerBefore) sendEscapeAndEnter(s)
  else execSync(`tmux send-keys -t ${s} Enter`)
}

/**
 * Envio multilinha via Estratégia D — fallback bracketed paste.
 * Preserva newlines como LF reais dentro de ESC[200~...ESC[201~.
 */
function sendKeysMultilinePaste(session: string, keys: string, closePickerBefore: boolean, skipClear: boolean): void {
  const s = q(session)
  if (!skipClear) clearInputBuffer(s)
  execSync(`tmux load-buffer -`, { input: keys })
  execSync(`tmux paste-buffer -t ${s} -p`)
  if (closePickerBefore) sendEscapeAndEnter(s)
  else execSync(`tmux send-keys -t ${s} Enter`)
}

/**
 * Envio multilinha flat — substitui `\n` por espaço. Degrada UX mas garante
 * compatibilidade em qualquer terminal.
 */
function sendKeysFlat(session: string, keys: string, closePickerBefore: boolean, skipClear: boolean): void {
  const flat = keys.replace(/\n+/g, ' ').trim()
  const s = q(session)
  if (!skipClear) clearInputBuffer(s)
  if (closePickerBefore) {
    if (flat.length > 0) execSync(`tmux send-keys -t ${s} -l ${q(flat)}`)
    sendEscapeAndEnter(s)
    return
  }
  if (flat.length > 0) execSync(`tmux send-keys -t ${s} -l ${q(flat)}`)
  execSync(`tmux send-keys -t ${s} Enter`)
}

export interface SendKeysOptions {
  /**
   * Quando `true`, envia `Escape` antes do `Enter` final pra fechar
   * autocompletes/file-pickers do CC TUI (notavelmente o que abre ao digitar
   * `@<absPath>`). Se o picker estiver aberto, o Enter sem Escape antes é
   * absorvido pelo widget — a mensagem fica pendurada no input.
   *
   * Default `false`: preserva comportamento legado de TODOS os callers
   * existentes (ws/handler input do terminal cru, menus interativos, etc).
   * Caller que envia anexos `@<path>` (ex: `teams/prisma-routes.ts` na rota
   * POST /teams/:id/message) deve passar `true`.
   *
   * Fix: portal-fix-attachment-enter (2026-04-27).
   */
  closePickerBefore?: boolean

  /**
   * Quando `true`, NÃO envia `Ctrl-U` antes do payload pra limpar o input.
   *
   * Default `false`: send envia Ctrl-U ANTES de digitar pra garantir que
   * texto pendurado de Enter falhado anteriormente não seja concatenado
   * com o novo payload (cenário do bug intermitente reportado pelo user).
   *
   * Use `skipClear: true` apenas quando o caller PRECISA preservar input
   * pré-existente — ex: WS handler de keystroke do user (que não tem essa
   * variante de chamada hoje, mas é o caso teórico).
   *
   * Fix: portal-context-endpoint-and-enter-escalation (2026-04-27).
   */
  skipClear?: boolean
}

/**
 * Envia `keys` para a sessão tmux e pressiona Enter ao final.
 * Suporta multilinha quando `keys` contém `\n` (ver `TMUX_MULTILINE_MODE`).
 *
 * Fast-path: texto sem `\n` sempre usa uma única chamada execSync,
 * independente do modo configurado (exceto quando `closePickerBefore=true`,
 * que sempre usa `-l` + `Escape` + `Enter`).
 */
export function sendKeys(session: string, keys: string, opts: SendKeysOptions = {}): void {
  const closePickerBefore = !!opts.closePickerBefore
  const skipClear = !!opts.skipClear

  if (!keys.includes('\n')) {
    sendKeysSingleLine(session, keys, closePickerBefore, skipClear)
    return
  }

  const mode = resolveMode()
  switch (mode) {
    case 'keys':
      sendKeysMultilineKeys(session, keys, closePickerBefore, skipClear)
      return
    case 'paste':
      sendKeysMultilinePaste(session, keys, closePickerBefore, skipClear)
      return
    case 'flat':
      sendKeysFlat(session, keys, closePickerBefore, skipClear)
      return
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Detecção de overlay aberto (file picker, slash picker, menu, dialog)
// Fix portal-fix-anexo-capture-pane-v1 (2026-04-27)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Marcadores empíricos de overlay aberto no Claude Code TUI v2.1.x.
 * Cada regex foi validada contra capture-pane real:
 *   - state vazio idle → 0 matches (sem falso positivo)
 *   - file-picker `@<path>` → match em `OVERLAY_FILE_PICKER`
 *   - slash-picker `/cmd` → match em `OVERLAY_SLASH_PICKER`
 *   - menus com Yes/No → match em `OVERLAY_MENU_FOOTER`
 *
 * IMPORTANTE: `capture-pane -p` (sem `-e`) já faz strip ANSI, então as regex
 * trabalham com texto limpo.
 */
const OVERLAY_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // File picker do `@<absPath>` — linha SOLO começando com `/` e terminando com `…`
  // Ex: "/tmp/i9-team-uploads/.../3ab241ee-0824-4b69-babe-40867f…"
  { name: 'file_picker', re: /^\/[\w/.\-]+\s*…\s*$/m },

  // Slash command picker — linha SOLO começando com `/<cmd>` + 2+ espaços + descrição
  // Ex: "/team-protocol                Protocolo de trabalho v4..."
  // Excluído por design: paths absolutos (têm `/` no meio, não só nome de comando)
  { name: 'slash_picker', re: /^\/[a-z][\w-]*\s{2,}\S/m },

  // Footers de menu/dialog com "Enter to ..."
  // Ex: "Enter to confirm · Esc to cancel"
  { name: 'menu_footer_enter', re: /Enter to (confirm|select|cancel|toggle|submit)/i },

  // Footers com "↑↓ to ..." (navegação de lista)
  { name: 'menu_footer_arrows', re: /↑.{0,5}↓\s+to\s+(navigate|select|move|toggle|cycle)/i },

  // Hints de autocomplete "Press Tab/Enter to select/complete"
  { name: 'autocomplete_hint', re: /Press\s+(?:Tab|Enter)\s+to\s+(?:select|confirm|complete|accept)/i },

  // Confirmação de seleção pós-picker
  { name: 'selected_marker', re: /(?:✔\s*selected|file\s+selected|Selected:\s)/i },

  // Lista numerada Yes/No típica do trust dialog do CC
  // Ex: "❯ 1. Yes, I trust this folder\n  2. No, exit"
  { name: 'yesno_list', re: /^\s*(?:❯\s+)?\d+\.\s+(?:Yes|No|Sim|N[ãa]o)\b/im },
]

/**
 * Detecta se o CC TUI da sessão `session` está com algum overlay aberto que
 * vai absorver o próximo `Enter` (file picker, slash picker, menu, dialog).
 *
 * Quando true, callers devem passar `closePickerBefore: true` ao `sendKeys`
 * pra fechar o overlay antes de submeter (`Escape + sleep 0.1 + Enter`).
 *
 * Heurística: captura as últimas 25 linhas do pane via `tmux capture-pane -p`
 * (sem ANSI) e procura marcadores específicos de overlay. As regex foram
 * calibradas contra capture-pane real do CC v2.1.120 — NÃO matcham nada em
 * estado idle normal (footer `⏵⏵ bypass permissions on...`).
 *
 * Em caso de erro (sessão morta, tmux off), retorna `false` (conservador —
 * o caller cai no Enter direto, que era o comportamento antes deste fix).
 */
export function isOverlayOpen(session: string): boolean {
  try {
    const out = execSync(`tmux capture-pane -t ${q(session)} -p -S -25`, OPTS)
    for (const { re } of OVERLAY_PATTERNS) {
      if (re.test(out)) return true
    }
    return false
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mutex async por sessão + instrumentação
// Fix portal-investigate-enter-intermittent (2026-04-27)
//
// Motivação: Fastify request handlers async podem ser concorrentes.
// Embora `sendKeys` (sync) não intercale execSyncs entre si, o **CC TUI**
// tem render assíncrono — entre o Enter final de uma chamada e a próxima
// chamada de `isOverlayOpen`, o `capture-pane` pode retornar estado
// RESIDUAL (ainda não atualizado pelo CC). Isso causa decisões erradas de
// `closePickerBefore` em requests seguintes.
//
// Defesas implementadas:
//   1. Fila por sessão — sendKeys de uma sessão sempre roda serializado
//   2. Settle wait pós-send — 150ms entre Enter e fim da promise pra dar
//      tempo do CC TUI atualizar antes do próximo capture-pane
//   3. Captura before/after + log estruturado com correlationId pra
//      reprodução do user (intermitente)
// ────────────────────────────────────────────────────────────────────────────

/** Fila global de sendKeys por sessionName. Última promise pendente. */
const sessionLocks = new Map<string, Promise<unknown>>()

/**
 * Settle wait pós-Enter — 500ms cobre a janela de render do CC TUI v2.1.x.
 * Subido de 150ms → 500ms no portal-context-endpoint-and-enter-escalation
 * (2026-04-27): margem maior pra CC TUI processar Enter completo, especialmente
 * sob carga ou animação. Configurável via SENDKEYS_SETTLE_WAIT_MS.
 */
const SETTLE_AFTER_SEND_MS = parseInt(process.env.SENDKEYS_SETTLE_WAIT_MS ?? '500', 10)

/** Settle wait extra após o retry (Escape+sleep+Enter de recuperação). */
const SETTLE_AFTER_RETRY_MS = 300

/**
 * Auto-retry quando detectarmos input pendurado após send. Default: ativado.
 * Pode ser desligado via `SENDKEYS_AUTO_RETRY=0` se causar problema.
 */
function isAutoRetryEnabled(): boolean {
  return process.env.SENDKEYS_AUTO_RETRY !== '0'
}

interface SendKeysReport {
  correlationId: string
  session: string
  keysLength: number
  closePickerBefore: boolean
  overlayBefore: boolean
  overlayAfter: boolean
  /** Texto pendurado na input bar do CC TUI após o send (vazio = submit OK). */
  inputPendingAfter: string
  /** Se houve retry automático (Escape+sleep+Enter extra) e se resolveu. */
  retryApplied: boolean
  retryResolved: boolean
  /**
   * Se a última cartada (Ctrl-U pra LIMPAR input pendurado) foi acionada
   * porque os retries não conseguiram submeter. Quando true, o conteúdo
   * pendurado foi DESCARTADO — o texto novo do user já foi submetido.
   */
  bufferCleared: boolean
  durationMs: number
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function tail(text: string, n = 3): string {
  return text.split('\n').slice(-n).join(' | ').slice(0, 200)
}

/**
 * Extrai o texto presente na input bar do CC TUI.
 *
 * Heurística: a input bar é a linha começando com "❯ " que aparece ENTRE
 * 2 separadores `─{30,}` no fim do pane. Se a linha for "❯ " (vazio após
 * o cursor), o submit foi bem-sucedido. Se houver TEXTO após "❯ ",
 * significa que o último Enter NÃO submeteu — texto ficou pendurado.
 *
 * Esta detecção é o sinal MAIS CONFIÁVEL de submit-falhou (mais que
 * `isOverlayOpen`), porque texto pendurado pós-Escape NÃO é overlay e
 * NÃO matchava nas regex de OVERLAY_PATTERNS.
 *
 * Fix portal-investigate-enter-real-logs (2026-04-27): root cause do bug
 * intermitente do user — Enter pós-Escape em payload `@<absPath>` às
 * vezes é absorvido (timing frágil), deixando texto+path no input. A
 * próxima request entrega texto novo + Enter que submete TUDO acumulado.
 *
 * Retorna string vazia se: input vazio, capture falha, ou heurística não
 * encontra a input bar (sessão fora do CC TUI).
 */
/**
 * Hints internos do CC TUI que aparecem na input bar quando o agente está
 * enfileirando mensagens ou em estados especiais. NÃO contam como "input
 * pendurado" — são UI do próprio CC, não texto que falhou em submeter.
 */
const INPUT_BAR_HINTS = [
  /^Press up to edit queued messages/i,
  /^Press up to/i,                       // catch-all "Press up to ..."
  /^Press [↑↓] to/i,
  /^Type a message/i,
]

export function getInputBarText(session: string): string {
  try {
    const out = execSync(`tmux capture-pane -t ${q(session)} -p -S -10`, OPTS)
    const lines = out.split('\n')
    // Busca de baixo pra cima: linha do prompt PRECEDIDA por separador.
    for (let i = lines.length - 1; i >= 1; i--) {
      const cur = lines[i]
      const prev = lines[i - 1]
      if (/^\s*─{30,}/.test(prev) && cur.startsWith('❯ ')) {
        // remove "❯ " (2 chars) e trim direito (o cursor [7m [0m vira whitespace)
        const text = cur.slice(2).trimEnd()
        // Hints do CC TUI ("Press up to edit queued messages") NÃO contam
        // como input pendurado — é UI do próprio agente, não falha de submit.
        if (INPUT_BAR_HINTS.some((re) => re.test(text))) return ''
        return text
      }
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Versão SERIALIZADA + INSTRUMENTADA de `sendKeys`. Garante que múltiplas
 * chamadas concorrentes pra MESMA sessão executem em FILA (uma de cada vez)
 * e dá tempo do CC TUI atualizar entre elas (settle wait).
 *
 * Use sempre que o caller for um handler async que pode disputar a sessão
 * com outras requests (ex: rota POST /teams/:id/message do Portal).
 *
 * Para callers single-shot (ex: WS handler com keystroke do user), use o
 * `sendKeys` síncrono direto — não há concorrência relevante.
 */
export async function sendKeysSerialized(
  session: string,
  keys: string,
  opts: SendKeysOptions = {}
): Promise<SendKeysReport> {
  const previous = sessionLocks.get(session) ?? Promise.resolve()

  const task = previous.then(async () => {
    const correlationId = shortId()
    const startTs = Date.now()

    // Estado ANTES — usado pra decidir closePickerBefore se caller não passou
    let overlayBefore = false
    try {
      overlayBefore = isOverlayOpen(session)
    } catch {
      // ignora
    }
    const closePickerBefore = !!opts.closePickerBefore

    let paneBeforeTail = ''
    try {
      paneBeforeTail = tail(execSync(`tmux capture-pane -t ${q(session)} -p -S -5`, OPTS))
    } catch {
      // ignora
    }

    console.log(
      '[sendKeysSerialized][start]',
      JSON.stringify({
        correlationId,
        session,
        keysLength: keys.length,
        keysPreview: keys.slice(0, 80),
        closePickerBefore,
        overlayBefore,
        paneBeforeTail,
      })
    )

    // Send sync (bloqueia até último Enter)
    sendKeys(session, keys, { closePickerBefore })

    // Settle wait — dá tempo do CC TUI processar o Enter antes da próxima
    // request capturar pane. Sem isso, capture-pane pode mostrar estado
    // antigo (render lag do CC TUI durante "Thinking…", "Pollinating…").
    await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_SEND_MS))

    let overlayAfter = false
    let paneAfterTail = ''
    let inputPendingAfter = ''
    try {
      overlayAfter = isOverlayOpen(session)
      paneAfterTail = tail(execSync(`tmux capture-pane -t ${q(session)} -p -S -5`, OPTS))
      inputPendingAfter = getInputBarText(session)
    } catch {
      // ignora
    }

    // ── RETRY automático: input pendurado = Enter foi absorvido ──────────
    // Fix portal-investigate-enter-real-logs (2026-04-27).
    //
    // Quando `inputPendingAfter` tem conteúdo (texto não-vazio na input bar),
    // o Enter que mandamos NÃO submeteu — provavelmente foi absorvido pelo
    // file picker do `@<absPath>` antes do Escape conseguir fechá-lo, ou
    // por timing frágil em transição de overlay → idle.
    //
    // Sem retry, a próxima request POST /message vai digitar por cima do
    // texto pendurado e o Enter dela submete TUDO acumulado como uma única
    // mensagem (cenário do user reportado em 2026-04-27 19:22).
    let retryApplied = false
    let retryResolved = false
    let bufferCleared = false
    if (inputPendingAfter.length > 0 && isAutoRetryEnabled()) {
      retryApplied = true
      console.log(
        '[sendKeysSerialized][retry-immediate]',
        JSON.stringify({
          correlationId,
          inputPendingPreview: inputPendingAfter.slice(0, 80),
          inputPendingLength: inputPendingAfter.length,
        })
      )
      try {
        const s = q(session)

        // ── 1ª cartada: Escape + sleep 0.4 + Enter ─────────────────────
        // Fecha qualquer overlay residual e submete o texto que ficou.
        execSync(`tmux send-keys -t ${s} Escape`)
        execSync(`sleep 0.4`)
        execSync(`tmux send-keys -t ${s} Enter`)
        await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_RETRY_MS))
        let inputAfterRetry = getInputBarText(session)

        // ── 2ª cartada (se ainda pendurado): Ctrl-U pra LIMPAR ─────────
        // Última cartada — conteúdo pendurado é descartado. Próxima request
        // entra num input limpo. Trade-off aceitável: melhor descartar
        // mensagem velha do que ter acúmulo crescente.
        if (inputAfterRetry.length > 0) {
          console.log(
            '[sendKeysSerialized][retry-clear]',
            JSON.stringify({
              correlationId,
              stillPending: inputAfterRetry.slice(0, 80),
            })
          )
          execSync(`tmux send-keys -t ${s} C-u`)
          await new Promise((resolve) => setTimeout(resolve, 100))
          inputAfterRetry = getInputBarText(session)
          bufferCleared = true
        }

        retryResolved = inputAfterRetry.length === 0
        // Atualiza captures pós-retry pra log
        try {
          overlayAfter = isOverlayOpen(session)
          paneAfterTail = tail(execSync(`tmux capture-pane -t ${q(session)} -p -S -5`, OPTS))
          inputPendingAfter = inputAfterRetry
        } catch {
          // ignora
        }
      } catch (err) {
        console.error('[sendKeysSerialized][retry][error]', { correlationId, err: String(err) })
      }
    }

    const report: SendKeysReport = {
      correlationId,
      session,
      keysLength: keys.length,
      closePickerBefore,
      overlayBefore,
      overlayAfter,
      inputPendingAfter,
      retryApplied,
      retryResolved,
      bufferCleared,
      durationMs: Date.now() - startTs,
    }

    // suspicious agora considera também `inputPendingAfter` (sinal mais forte
    // que `overlayAfter`, que tinha falso negativo após Escape).
    const suspicious = inputPendingAfter.length > 0 || overlayAfter

    console.log(
      '[sendKeysSerialized][end]',
      JSON.stringify({
        ...report,
        paneAfterTail,
        suspicious,
      })
    )

    return report
  })

  // Atualiza o lock — próxima chamada pra esta session aguarda esta task
  sessionLocks.set(
    session,
    task.catch(() => undefined)
  )
  return task
}

// ────────────────────────────────────────────────────────────────────────────
// Teclas nomeadas (Up, Down, Enter, Escape, C-c, etc) — sem buffer/retry
// Fix portal-ws-key-event (2026-04-27)
//
// Para navegação manual via Portal (botões ⬆ ⬇ ⏎ ⎋) e Terminal Mode. Não
// passa pelo `sendKeys` normal (que faz Ctrl-U/mutex/retry/settle), pois
// teclas nomeadas são instantâneas — não há "texto pendurado" que possa
// acumular, e a resposta precisa ser imediata pra UI fluida.
// ────────────────────────────────────────────────────────────────────────────

/** Teclas nomeadas básicas aceitas em `key_event`. */
const VALID_KEY_NAMES = new Set([
  'Up', 'Down', 'Left', 'Right',
  'Enter', 'Escape', 'Tab', 'Space',
  'BSpace', 'BTab', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
])

/**
 * Modificadores tmux: `C-` (Ctrl), `M-` (Meta/Alt), `S-` (Shift), em qualquer
 * combinação, seguidos de um caractere alfanumérico ou nome especial.
 *
 * Exemplos válidos: `C-c`, `M-x`, `S-Tab`, `C-M-z`, `C-Up`, `S-F5`.
 */
const MODIFIER_KEY_RE =
  /^[CMS](-[CMS])*-([a-zA-Z0-9]|Up|Down|Left|Right|Enter|Escape|Tab|Space|BSpace|F\d{1,2})$/

/**
 * Valida que `key` é uma tecla nomeada do tmux suportada (whitelist).
 *
 * Segurança: previne shell injection — sem isso, um caller poderia mandar
 * `key: "Enter; rm -rf /"` e o `execSync` rodaria o comando inteiro.
 */
export function isValidKeyName(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false
  return VALID_KEY_NAMES.has(key) || MODIFIER_KEY_RE.test(key)
}

/**
 * Envia tecla nomeada (Up, Down, Enter, Escape, C-c, etc) DIRETO via tmux,
 * SEM buffer/Ctrl-U/retry. Pra navegação manual via Portal e Terminal Mode.
 *
 * Lança Error se `key` não passar na whitelist.
 */
export function sendKeyEvent(session: string, key: string): void {
  if (!isValidKeyName(key)) {
    throw new Error(`Tecla inválida: ${JSON.stringify(key)}`)
  }
  // `key` já foi whitelistado contra o regex acima — seguro inserir literal.
  execSync(`tmux send-keys -t ${q(session)} ${key}`)
}

/** @deprecated use sendKeys */
export function sendToSession(session: string, message: string): void {
  sendKeys(session, message)
}

export function captureSession(session: string, lines = 50): string {
  try {
    return execSync(`tmux capture-pane -t "${session}" -p -S -${lines}`, OPTS)
  } catch {
    return ''
  }
}
