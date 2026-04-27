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
 * antes do submit. 0.1s foi suficiente em testes empíricos com CC v2.1.120.
 */
function sendEscapeAndEnter(s: string): void {
  execSync(`tmux send-keys -t ${s} Escape`)
  execSync(`sleep 0.1`)
  execSync(`tmux send-keys -t ${s} Enter`)
}

/** Envio single-line (sem `\n`). Mantém o comportamento anterior byte-a-byte. */
function sendKeysSingleLine(session: string, keys: string, closePickerBefore: boolean): void {
  const s = q(session)
  if (closePickerBefore) {
    if (keys.length > 0) execSync(`tmux send-keys -t ${s} -l ${q(keys)}`)
    sendEscapeAndEnter(s)
    return
  }
  execSync(`tmux send-keys -t ${s} ${q(keys)} Enter`)
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
function sendKeysMultilineKeys(session: string, keys: string, closePickerBefore: boolean): void {
  const s = q(session)
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
function sendKeysMultilinePaste(session: string, keys: string, closePickerBefore: boolean): void {
  const s = q(session)
  execSync(`tmux load-buffer -`, { input: keys })
  execSync(`tmux paste-buffer -t ${s} -p`)
  if (closePickerBefore) sendEscapeAndEnter(s)
  else execSync(`tmux send-keys -t ${s} Enter`)
}

/**
 * Envio multilinha flat — substitui `\n` por espaço. Degrada UX mas garante
 * compatibilidade em qualquer terminal.
 */
function sendKeysFlat(session: string, keys: string, closePickerBefore: boolean): void {
  const flat = keys.replace(/\n+/g, ' ').trim()
  const s = q(session)
  if (closePickerBefore) {
    if (flat.length > 0) execSync(`tmux send-keys -t ${s} -l ${q(flat)}`)
    sendEscapeAndEnter(s)
    return
  }
  execSync(`tmux send-keys -t ${s} ${q(flat)} Enter`)
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

  if (!keys.includes('\n')) {
    sendKeysSingleLine(session, keys, closePickerBefore)
    return
  }

  const mode = resolveMode()
  switch (mode) {
    case 'keys':
      sendKeysMultilineKeys(session, keys, closePickerBefore)
      return
    case 'paste':
      sendKeysMultilinePaste(session, keys, closePickerBefore)
      return
    case 'flat':
      sendKeysFlat(session, keys, closePickerBefore)
      return
  }
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
