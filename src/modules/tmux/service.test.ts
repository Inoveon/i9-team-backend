/**
 * service.test.ts — Valida o `sendKeys` multilinha (Issue #2 / Onda 4).
 *
 * Usa `__setExecForTests` / `__resetExecForTests` para substituir o execSync
 * real por um spy que captura os comandos tmux emitidos.
 *
 * NÃO executa tmux real.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { sendKeys, isOverlayOpen, getInputBarText, __setExecForTests, __resetExecForTests } from './service.js'

interface Call { command: string; input?: string }
let calls: Call[]

function installSpy(): void {
  calls = []
  __setExecForTests((cmd: string, opts?: { input?: string }) => {
    calls.push({ command: cmd, input: opts?.input })
    return ''
  })
}

function uninstallSpy(): void {
  __resetExecForTests()
}

describe('sendKeys — fast-path single-line', () => {
  beforeEach(() => {
    installSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })
  afterEach(() => uninstallSpy())

  it('texto sem \\n usa: C-u + -l <texto> + Enter (3 execSync — Ctrl-U pré-digit)', () => {
    sendKeys('my-session', 'hello world')
    assert.equal(calls.length, 3)
    assert.equal(calls[0].command, `tmux send-keys -t "my-session" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "my-session" -l "hello world"`)
    assert.equal(calls[2].command, `tmux send-keys -t "my-session" Enter`)
  })

  it('texto com caractere especial não quebra o shell (JSON.stringify escapa)', () => {
    sendKeys('my-session', 'aspas " e dólar $ e back`tick')
    assert.equal(calls.length, 3)
    assert.equal(calls[0].command, `tmux send-keys -t "my-session" C-u`)
    assert.match(calls[1].command, /^tmux send-keys -t "my-session" -l "aspas \\" e dólar /)
    assert.equal(calls[2].command, `tmux send-keys -t "my-session" Enter`)
  })

  it('nome de sessão com espaço é envelopado com aspas', () => {
    sendKeys('sessao com espaco', 'oi')
    assert.equal(calls[0].command, `tmux send-keys -t "sessao com espaco" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "sessao com espaco" -l "oi"`)
    assert.equal(calls[2].command, `tmux send-keys -t "sessao com espaco" Enter`)
  })

  it('skipClear: true → pula o C-u inicial (preserva input pré-existente)', () => {
    sendKeys('s', 'oi', { skipClear: true })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "oi"`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" Enter`)
  })
})

describe('sendKeys — multilinha modo "keys" (default / vencedor do gate)', () => {
  beforeEach(() => {
    installSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })
  afterEach(() => uninstallSpy())

  it('duas linhas geram: C-u + -l linha1 + S-Enter + -l linha2 + Enter', () => {
    sendKeys('s', 'linha1\nlinha2')
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "linha1"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" S-Enter`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" -l "linha2"`)
    assert.equal(calls[4].command, `tmux send-keys -t "s" Enter`)
  })

  it('três linhas geram 7 comandos na ordem correta (C-u + 6 originais)', () => {
    sendKeys('s', 'a\nb\nc')
    assert.equal(calls.length, 7)
    assert.deepEqual(
      calls.map((c) => c.command),
      [
        `tmux send-keys -t "s" C-u`,
        `tmux send-keys -t "s" -l "a"`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" -l "b"`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" -l "c"`,
        `tmux send-keys -t "s" Enter`,
      ]
    )
  })

  it('linha vazia intermediária emite apenas S-Enter (pula -l "")', () => {
    sendKeys('s', 'primeira\n\nterceira')
    // C-u, primeira, S-Enter, (vazia → skip -l), S-Enter, terceira, Enter
    assert.equal(calls.length, 6)
    assert.deepEqual(
      calls.map((c) => c.command),
      [
        `tmux send-keys -t "s" C-u`,
        `tmux send-keys -t "s" -l "primeira"`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" -l "terceira"`,
        `tmux send-keys -t "s" Enter`,
      ]
    )
  })

  it('EDGE CASE — texto contém nome de tecla ("Enter", "Up", "C-c"): -l preserva literal', () => {
    sendKeys('s', 'Enter no texto\nUp também\nC-c seguro')
    assert.equal(calls.length, 7)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "Enter no texto"`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" -l "Up também"`)
    assert.equal(calls[5].command, `tmux send-keys -t "s" -l "C-c seguro"`)
    // O Enter final (único SEM -l) submete a mensagem:
    assert.equal(calls[6].command, `tmux send-keys -t "s" Enter`)
  })

  it('EDGE CASE — texto com aspas, $ e ` no meio é escapado via JSON.stringify', () => {
    sendKeys('s', 'linha com "aspas"\noutra com $VAR e `cmd`')
    assert.equal(calls.length, 5)
    // calls[0]=C-u, calls[1]=-l "linha com \"aspas\""
    assert.match(calls[1].command, /^tmux send-keys -t "s" -l "linha com \\"aspas\\""$/)
    assert.match(calls[3].command, /^tmux send-keys -t "s" -l "outra com/)
  })

  it('TMUX_MULTILINE_MODE=keys explícito funciona igual ao default', () => {
    process.env.TMUX_MULTILINE_MODE = 'keys'
    sendKeys('s', 'a\nb')
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "a"`)
  })

  it('skipClear: true → 4 comandos (sem C-u inicial)', () => {
    sendKeys('s', 'a\nb', { skipClear: true })
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "a"`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Enter`)
  })
})

describe('sendKeys — multilinha modo "paste" (fallback bracketed paste)', () => {
  beforeEach(() => {
    installSpy()
    process.env.TMUX_MULTILINE_MODE = 'paste'
  })
  afterEach(() => {
    uninstallSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('usa C-u + load-buffer + paste-buffer -p + Enter (4 comandos)', () => {
    sendKeys('s', 'a\nb\nc')
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux load-buffer -`)
    assert.equal(calls[1].input, 'a\nb\nc')
    assert.equal(calls[2].command, `tmux paste-buffer -t "s" -p`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Enter`)
  })

  it('preserva newlines reais no buffer (não escapa)', () => {
    sendKeys('s', 'linha\ncom\nquebras')
    // calls[0]=C-u, calls[1]=load-buffer
    assert.equal(calls[1].input, 'linha\ncom\nquebras')
  })
})

describe('sendKeys — multilinha modo "flat" (degradação)', () => {
  beforeEach(() => {
    installSpy()
    process.env.TMUX_MULTILINE_MODE = 'flat'
  })
  afterEach(() => {
    uninstallSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('substitui \\n por espaço e envia: C-u + -l <flat> + Enter', () => {
    sendKeys('s', 'linha1\nlinha2\nlinha3')
    assert.equal(calls.length, 3)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "linha1 linha2 linha3"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" Enter`)
  })

  it('colapsa múltiplos \\n consecutivos', () => {
    sendKeys('s', 'a\n\n\nb')
    assert.equal(calls.length, 3)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "a b"`)
  })
})

describe('sendKeys — modo inválido cai no default "keys"', () => {
  beforeEach(() => {
    installSpy()
    process.env.TMUX_MULTILINE_MODE = 'banana'
  })
  afterEach(() => {
    uninstallSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('modo desconhecido = keys', () => {
    sendKeys('s', 'a\nb')
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "a"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" S-Enter`)
  })
})

describe('sendKeys — closePickerBefore (fix portal-fix-attachment-enter)', () => {
  beforeEach(() => {
    installSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })
  afterEach(() => uninstallSpy())

  it('single-line + closePickerBefore=true: C-u + -l <texto> + Escape + sleep + Enter (5 cmds)', () => {
    sendKeys('s', 'oi', { closePickerBefore: true })
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "oi"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" Escape`)
    assert.equal(calls[3].command, `sleep 0.2`)
    assert.equal(calls[4].command, `tmux send-keys -t "s" Enter`)
  })

  it('multilinha keys + closePickerBefore=true: cenário real do bug com C-u + Escape+Enter', () => {
    sendKeys('s', 'texto\n\n@/tmp/x.png', { closePickerBefore: true })
    assert.equal(calls.length, 8)
    assert.deepEqual(
      calls.map((c) => c.command),
      [
        `tmux send-keys -t "s" C-u`,
        `tmux send-keys -t "s" -l "texto"`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" -l "@/tmp/x.png"`,
        `tmux send-keys -t "s" Escape`,
        `sleep 0.2`,
        `tmux send-keys -t "s" Enter`,
      ]
    )
  })

  it('multilinha paste + closePickerBefore=true: C-u + load-buffer + paste + Escape + sleep + Enter', () => {
    process.env.TMUX_MULTILINE_MODE = 'paste'
    sendKeys('s', 'a\nb', { closePickerBefore: true })
    assert.equal(calls.length, 6)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux load-buffer -`)
    assert.equal(calls[2].command, `tmux paste-buffer -t "s" -p`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Escape`)
    assert.equal(calls[4].command, `sleep 0.2`)
    assert.equal(calls[5].command, `tmux send-keys -t "s" Enter`)
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('flat + closePickerBefore=true: C-u + -l <flat> + Escape + sleep + Enter', () => {
    process.env.TMUX_MULTILINE_MODE = 'flat'
    sendKeys('s', 'a\nb', { closePickerBefore: true })
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "a b"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" Escape`)
    assert.equal(calls[3].command, `sleep 0.2`)
    assert.equal(calls[4].command, `tmux send-keys -t "s" Enter`)
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('default (sem opts) usa C-u + -l + Enter', () => {
    sendKeys('s', 'oi')
    assert.equal(calls.length, 3)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" -l "oi"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" Enter`)
  })

  it('closePickerBefore=false explícito também usa C-u + Enter direto', () => {
    sendKeys('s', 'a\nb', { closePickerBefore: false })
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux send-keys -t "s" C-u`)
    assert.equal(calls[4].command, `tmux send-keys -t "s" Enter`)
  })
})

describe('isOverlayOpen — detecção via capture-pane (fix portal-fix-anexo-capture-pane-v1)', () => {
  beforeEach(() => installSpy())
  afterEach(() => uninstallSpy())

  function mockCapture(out: string): void {
    __setExecForTests((cmd: string) => {
      if (cmd.startsWith('tmux capture-pane')) return out
      return ''
    })
  }

  it('estado idle limpo (só footer "⏵⏵ bypass permissions on") → false', () => {
    mockCapture(`
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(isOverlayOpen('s'), false)
  })

  it('estado idle pós-conversa (com banner Welcome) → false', () => {
    mockCapture(`
╭─── Claude Code v2.1.120 ────────────────╮
│                  Welcome back Lee!       │
│                       /tmp                │
╰─────────────────────────────────────────╯
❯ oi
● Oi! Em que posso ajudar?
✻ Churned for 2s
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(isOverlayOpen('s'), false)
  })

  it('processando (esc to interrupt) → false', () => {
    mockCapture(`
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt
`)
    assert.equal(isOverlayOpen('s'), false)
  })

  it('file picker do `@<path>` → true (file_picker)', () => {
    mockCapture(`
────────────────────────────────────────
❯ @/tmp/i9-team-uploads/abc/def
────────────────────────────────────────
/tmp/i9-team-uploads/abc/def-0824-4b69-babe-40867f…
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('slash picker do `/cmd` → true (slash_picker)', () => {
    mockCapture(`
────────────────────────────────────────
❯ /
────────────────────────────────────────
/team-protocol                Protocolo de trabalho v4 para teams tmux.
/commit                       Fluxo completo de commit com review automático.
/loop                         Run a prompt or slash command on a recurring interval.
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('menu de seleção com "Enter to confirm" → true (menu_footer_enter)', () => {
    mockCapture(`
 Quick safety check: Is this a project you trust?
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('navegação de lista com "↑↓ to navigate" → true (menu_footer_arrows)', () => {
    mockCapture(`
 Selecione um agente:
 ❯ team-orchestrator
   team-dev-backend
   team-dev-frontend
 ↑↓ to navigate · Enter to select
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('autocomplete hint "Press Tab to complete" → true (autocomplete_hint)', () => {
    mockCapture(`
❯ git checko
 Press Tab to complete
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('marcador "Selected:" pós-picker → true (selected_marker)', () => {
    mockCapture(`
Selected: /tmp/i9-team-uploads/abc.png
❯
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('lista numerada Yes/No (trust dialog) → true (yesno_list)', () => {
    mockCapture(`
 Trust this folder?
 ❯ 1. Yes
   2. No
`)
    assert.equal(isOverlayOpen('s'), true)
  })

  it('path absoluto NO BANNER (header /tmp/...) NÃO confunde com overlay → false', () => {
    // O cabeçalho do welcome tem `/tmp/...` mas dentro de aspas/em coluna do banner.
    // O regex file_picker exige `…` no fim, então não dispara.
    mockCapture(`
│                        /tmp                        │
╰─────────────────────────────────────────────────────╯
❯
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(isOverlayOpen('s'), false)
  })

  it('captura falha (tmux off) → false (conservador)', () => {
    __setExecForTests(() => { throw new Error('no server running') })
    assert.equal(isOverlayOpen('s'), false)
  })
})

describe('getInputBarText — detecção de input pendurado (fix portal-investigate-enter-real-logs)', () => {
  beforeEach(() => installSpy())
  afterEach(() => uninstallSpy())

  function mockCapture(out: string): void {
    __setExecForTests((cmd: string) => {
      if (cmd.startsWith('tmux capture-pane')) return out
      return ''
    })
  }

  it('input bar vazia → string vazia (submit OK)', () => {
    mockCapture(`
✻ Baked for 3s
────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(getInputBarText('s'), '')
  })

  it('input bar com texto pendurado → retorna texto (submit FALHOU)', () => {
    mockCapture(`
✻ Worked for 5s
────────────────────────────────────────────────────────────────────
❯ Esse é mais um exemplo, enviei pelo portal e não deu o enter.
────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(getInputBarText('s'), 'Esse é mais um exemplo, enviei pelo portal e não deu o enter.')
  })

  it('input bar com path pendurado (cenário do bug real do user) → retorna texto', () => {
    mockCapture(`
✻ Worked for 32s
────────────────────────────────────────────────────────────────────
❯ @/tmp/i9-team-uploads/cmo5orcrf000041lxg0gtbfq8/20e4307d-36ef.png
────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    const text = getInputBarText('s')
    assert.ok(text.startsWith('@/tmp/'))
    assert.ok(text.includes('.png'))
  })

  it('histórico tem MUITAS linhas com `❯` (mensagens submetidas) — só pega a entre os últimos separadores', () => {
    mockCapture(`
❯ mensagem antiga 1
● Resposta 1
❯ mensagem antiga 2
● Resposta 2
✻ Baked for 1s
────────────────────────────────────────────────────────────────────
❯ texto novo pendurado
────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(getInputBarText('s'), 'texto novo pendurado')
  })

  it('captura falha → string vazia', () => {
    __setExecForTests(() => { throw new Error('no server running') })
    assert.equal(getInputBarText('s'), '')
  })

  it('sem separadores no pane (ex: shell normal) → string vazia', () => {
    mockCapture(`ubuntu@host:~$ ls
foo bar
ubuntu@host:~$ `)
    assert.equal(getInputBarText('s'), '')
  })

  it('hint "Press up to edit queued messages" → string vazia (NÃO é falha de submit)', () => {
    // CC TUI mostra esse hint na input bar quando enfileirou mensagens.
    // É UI do próprio agente, não texto que falhou em submeter.
    mockCapture(`
✻ Worked for 5s
────────────────────────────────────────────────────────────────────
❯ Press up to edit queued messages
────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    assert.equal(getInputBarText('s'), '')
  })

  it('hint "Type a message" → string vazia', () => {
    mockCapture(`
────────────────────────────────────────────────────────────────────
❯ Type a message
────────────────────────────────────────────────────────────────────
`)
    assert.equal(getInputBarText('s'), '')
  })
})
