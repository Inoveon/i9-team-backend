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

import { sendKeys, __setExecForTests, __resetExecForTests } from './service.js'

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

  it('texto sem \\n usa 1 execSync com send-keys + Enter', () => {
    sendKeys('my-session', 'hello world')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, `tmux send-keys -t "my-session" "hello world" Enter`)
  })

  it('texto com caractere especial não quebra o shell (JSON.stringify escapa)', () => {
    sendKeys('my-session', 'aspas " e dólar $ e back`tick')
    assert.equal(calls.length, 1)
    assert.match(calls[0].command, /^tmux send-keys -t "my-session" "aspas \\" e dólar .* Enter$/)
  })

  it('nome de sessão com espaço é envelopado com aspas', () => {
    sendKeys('sessao com espaco', 'oi')
    assert.equal(calls[0].command, `tmux send-keys -t "sessao com espaco" "oi" Enter`)
  })
})

describe('sendKeys — multilinha modo "keys" (default / vencedor do gate)', () => {
  beforeEach(() => {
    installSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })
  afterEach(() => uninstallSpy())

  it('duas linhas geram: -l linha1 + S-Enter + -l linha2 + Enter', () => {
    sendKeys('s', 'linha1\nlinha2')
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "linha1"`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" S-Enter`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" -l "linha2"`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Enter`)
  })

  it('três linhas geram 6 comandos na ordem correta', () => {
    sendKeys('s', 'a\nb\nc')
    assert.equal(calls.length, 6)
    assert.deepEqual(
      calls.map((c) => c.command),
      [
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
    // primeira, S-Enter, (vazia → skip -l), S-Enter, terceira, Enter
    assert.equal(calls.length, 5)
    assert.deepEqual(
      calls.map((c) => c.command),
      [
        `tmux send-keys -t "s" -l "primeira"`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" -l "terceira"`,
        `tmux send-keys -t "s" Enter`,
      ]
    )
  })

  it('EDGE CASE — texto contém nome de tecla ("Enter", "Up", "C-c"): -l preserva literal', () => {
    // Sem -l, tmux interpretaria "Enter" como tecla de submit e "Up" como seta pra cima.
    // Com -l (literal), tudo vira texto byte-a-byte.
    sendKeys('s', 'Enter no texto\nUp também\nC-c seguro')
    assert.equal(calls.length, 6)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "Enter no texto"`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" -l "Up também"`)
    assert.equal(calls[4].command, `tmux send-keys -t "s" -l "C-c seguro"`)
    // O Enter final (único SEM -l) submete a mensagem:
    assert.equal(calls[5].command, `tmux send-keys -t "s" Enter`)
  })

  it('EDGE CASE — texto com aspas, $ e ` no meio é escapado via JSON.stringify', () => {
    sendKeys('s', 'linha com "aspas"\noutra com $VAR e `cmd`')
    assert.equal(calls.length, 4)
    // JSON.stringify produz `"linha com \"aspas\""`
    assert.match(calls[0].command, /^tmux send-keys -t "s" -l "linha com \\"aspas\\""$/)
    assert.match(calls[2].command, /^tmux send-keys -t "s" -l "outra com/)
  })

  it('TMUX_MULTILINE_MODE=keys explícito funciona igual ao default', () => {
    process.env.TMUX_MULTILINE_MODE = 'keys'
    sendKeys('s', 'a\nb')
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "a"`)
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

  it('usa load-buffer + paste-buffer -p + Enter (3 comandos)', () => {
    sendKeys('s', 'a\nb\nc')
    assert.equal(calls.length, 3)
    assert.equal(calls[0].command, `tmux load-buffer -`)
    assert.equal(calls[0].input, 'a\nb\nc')
    assert.equal(calls[1].command, `tmux paste-buffer -t "s" -p`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" Enter`)
  })

  it('preserva newlines reais no buffer (não escapa)', () => {
    sendKeys('s', 'linha\ncom\nquebras')
    assert.equal(calls[0].input, 'linha\ncom\nquebras')
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

  it('substitui \\n por espaço e envia numa única chamada', () => {
    sendKeys('s', 'linha1\nlinha2\nlinha3')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, `tmux send-keys -t "s" "linha1 linha2 linha3" Enter`)
  })

  it('colapsa múltiplos \\n consecutivos', () => {
    sendKeys('s', 'a\n\n\nb')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, `tmux send-keys -t "s" "a b" Enter`)
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
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "a"`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" S-Enter`)
  })
})

describe('sendKeys — closePickerBefore (fix portal-fix-attachment-enter)', () => {
  beforeEach(() => {
    installSpy()
    delete process.env.TMUX_MULTILINE_MODE
  })
  afterEach(() => uninstallSpy())

  it('single-line + closePickerBefore=true: -l <texto> + Escape + sleep + Enter', () => {
    sendKeys('s', 'oi', { closePickerBefore: true })
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "oi"`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" Escape`)
    assert.equal(calls[2].command, `sleep 0.1`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Enter`)
  })

  it('multilinha keys + closePickerBefore=true: substitui o Enter final por Escape+Enter', () => {
    // Cenário real do bug: payload = "<texto>\n\n@<absPath>"
    sendKeys('s', 'texto\n\n@/tmp/x.png', { closePickerBefore: true })
    assert.equal(calls.length, 7)
    assert.deepEqual(
      calls.map((c) => c.command),
      [
        `tmux send-keys -t "s" -l "texto"`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" S-Enter`,
        `tmux send-keys -t "s" -l "@/tmp/x.png"`,
        `tmux send-keys -t "s" Escape`,
        `sleep 0.1`,
        `tmux send-keys -t "s" Enter`,
      ]
    )
  })

  it('multilinha paste + closePickerBefore=true: load-buffer + paste + Escape + sleep + Enter', () => {
    process.env.TMUX_MULTILINE_MODE = 'paste'
    sendKeys('s', 'a\nb', { closePickerBefore: true })
    assert.equal(calls.length, 5)
    assert.equal(calls[0].command, `tmux load-buffer -`)
    assert.equal(calls[1].command, `tmux paste-buffer -t "s" -p`)
    assert.equal(calls[2].command, `tmux send-keys -t "s" Escape`)
    assert.equal(calls[3].command, `sleep 0.1`)
    assert.equal(calls[4].command, `tmux send-keys -t "s" Enter`)
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('flat + closePickerBefore=true: -l <flat> + Escape + sleep + Enter', () => {
    process.env.TMUX_MULTILINE_MODE = 'flat'
    sendKeys('s', 'a\nb', { closePickerBefore: true })
    assert.equal(calls.length, 4)
    assert.equal(calls[0].command, `tmux send-keys -t "s" -l "a b"`)
    assert.equal(calls[1].command, `tmux send-keys -t "s" Escape`)
    assert.equal(calls[2].command, `sleep 0.1`)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Enter`)
    delete process.env.TMUX_MULTILINE_MODE
  })

  it('default (sem opts) preserva comportamento legado — sem Escape', () => {
    sendKeys('s', 'oi')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, `tmux send-keys -t "s" "oi" Enter`)
  })

  it('closePickerBefore=false explícito também preserva legado', () => {
    sendKeys('s', 'a\nb', { closePickerBefore: false })
    assert.equal(calls.length, 4)
    assert.equal(calls[3].command, `tmux send-keys -t "s" Enter`)
  })
})
