/**
 * Testes do parseMessageStream
 * Execução: npx tsx --test src/modules/ws/parseMessageStream.test.ts
 * (ou via vitest se configurado)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMessageStream } from './parseMessageStream.js'

// ─── user_input ──────────────────────────────────────────────────────────────

test('detecta user_input simples', () => {
  const events = parseMessageStream('❯ git status')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'user_input')
  assert.equal((events[0] as { type: 'user_input'; content: string }).content, 'git status')
})

// ─── tool_call ───────────────────────────────────────────────────────────────

test('detecta tool_call Bash simples', () => {
  const events = parseMessageStream('⏺ Bash(git status)')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'tool_call')
  const e = events[0] as { type: 'tool_call'; name: string; args: string }
  assert.equal(e.name, 'Bash')
  assert.equal(e.args, 'git status')
})

test('detecta tool_call Read', () => {
  const events = parseMessageStream('⏺ Read(src/index.ts)')
  const e = events[0] as { type: 'tool_call'; name: string; args: string }
  assert.equal(e.name, 'Read')
  assert.equal(e.args, 'src/index.ts')
})

test('detecta tool_call Write com args multi-linha', () => {
  const raw = `⏺ Write(/tmp/test.ts
  content: "hello world"
)`
  const events = parseMessageStream(raw)
  assert.ok(events.some(e => e.type === 'tool_call' && (e as { name: string }).name === 'Write'))
})

// ─── tool_result ─────────────────────────────────────────────────────────────

test('detecta tool_result simples', () => {
  const raw = `⏺ Bash(git status)
  ⎿  On branch main
  ⎿  nothing to commit`
  const events = parseMessageStream(raw)
  const result = events.find(e => e.type === 'tool_result') as { type: 'tool_result'; id: string; content: string } | undefined
  assert.ok(result, 'deve ter tool_result')
  assert.match(result!.content, /On branch main/)
  assert.match(result!.content, /nothing to commit/)
})

test('tool_result correlaciona com tool_call', () => {
  const raw = `⏺ Bash(ls)
  ⎿  index.ts`
  const events = parseMessageStream(raw)
  const call   = events.find(e => e.type === 'tool_call')   as { id: string } | undefined
  const result = events.find(e => e.type === 'tool_result') as { id: string } | undefined
  assert.ok(call && result)
  assert.equal(call.id, result.id)
})

// ─── thinking ────────────────────────────────────────────────────────────────

test('detecta thinking com duração', () => {
  const events = parseMessageStream('✻ Cogitated for 12s')
  const e = events[0] as { type: 'thinking'; label: string; duration?: string }
  assert.equal(e.type, 'thinking')
  assert.ok(e.label.length > 0)
  assert.equal(e.duration, '12s')
})

test('detecta thinking sem duração', () => {
  const events = parseMessageStream('✶ Puzzling...')
  assert.equal(events[0].type, 'thinking')
})

test('detecta variantes de spinner (✽)', () => {
  const events = parseMessageStream('✽ Brewing...')
  assert.equal(events[0].type, 'thinking')
})

// ─── claude_text ─────────────────────────────────────────────────────────────

test('detecta claude_text livre', () => {
  const events = parseMessageStream('⏺ Tudo atualizado! Repositório limpo.')
  const e = events[0] as { type: 'claude_text'; content: string }
  assert.equal(e.type, 'claude_text')
  assert.match(e.content, /Tudo atualizado/)
})

test('detecta claude_text com markdown inline', () => {
  const raw = `⏺ Aqui está o resumo:
  **Arquivo** modificado com sucesso.`
  const events = parseMessageStream(raw)
  const e = events.find(e => e.type === 'claude_text') as { content: string } | undefined
  assert.ok(e)
  assert.match(e!.content, /Aqui está/)
})

test('preserva tabela markdown no claude_text', () => {
  const raw = `⏺ Resultado:
  | Arquivo | Status |
  |---------|--------|
  | index.ts | ✅ OK |`
  const events = parseMessageStream(raw)
  const e = events.find(e => e.type === 'claude_text') as { content: string } | undefined
  assert.ok(e)
  assert.match(e!.content, /Arquivo/)
})

// ─── system ──────────────────────────────────────────────────────────────────

test('detecta system Crunched', () => {
  const events = parseMessageStream('Crunched for 5s')
  assert.equal(events[0].type, 'system')
})

test('detecta system Auto-saved', () => {
  const events = parseMessageStream('Auto-saved.')
  assert.equal(events[0].type, 'system')
})

// ─── interactive_menu ────────────────────────────────────────────────────────

test('detecta menu interativo com ☐ e opções numeradas', () => {
  const raw = `☐ Confirmar deploy
❯ 1. Sim
  2. Não
Enter to confirm`
  const events = parseMessageStream(raw)
  const menu = events.find(e => e.type === 'interactive_menu') as { options: string[]; title?: string } | undefined
  assert.ok(menu, 'deve ter interactive_menu')
  assert.ok(menu!.options.includes('Sim') || menu!.options.some(o => o.includes('Sim')))
  assert.ok(menu!.title?.includes('Confirmar'))
})

test('detecta menu /model com ❯ + N. indentado (caso real Claude Code)', () => {
  // Formato típico do menu /model: header ☐, 1ª opção com ❯, demais com N.
  // indentado. Reescrito após BUG #1 — não depende mais do fallback "linha
  // plaina indentada sem glifo".
  const raw = `☐ Selecione o modelo
❯ 1. claude-opus-4-5
  2. claude-sonnet-4-5
Enter to select`
  const events = parseMessageStream(raw)
  const menu = events.find(e => e.type === 'interactive_menu') as { options: string[]; title?: string } | undefined
  assert.ok(menu, 'deve ter interactive_menu')
  assert.ok(menu!.options.length >= 2)
  assert.ok(menu!.options.some(o => o.includes('opus')))
  assert.ok(menu!.options.some(o => o.includes('sonnet')))
})

// ─── não-regressão BUG #1: prosa do orquestrador NÃO vira menu ─────────────

test('BUG#1: "● Vou executar 3 etapas: 1. clonar 2. instalar" vira claude_text', () => {
  const raw = '● Vou executar 3 etapas: 1. clonar 2. instalar 3. testar.'
  const events = parseMessageStream(raw)
  assert.ok(!events.some(e => e.type === 'interactive_menu'), 'NÃO deve virar menu')
  assert.ok(events.some(e => e.type === 'claude_text'), 'deve virar claude_text')
})

test('BUG#1: "● Plano: 1) clonar 2) instalar" (parêntese) NÃO vira menu', () => {
  // Parêntese em "1)" não é mais aceito em MENU_NUMBERED_RE (só ponto).
  // Além disso, `●` não é mais título de menu — então o bloco nem é avaliado.
  const raw = `● Plano:
  1) clonar repo
  2) instalar deps
Enter to confirm`
  const events = parseMessageStream(raw)
  assert.ok(!events.some(e => e.type === 'interactive_menu'), 'NÃO deve virar menu')
  assert.ok(events.some(e => e.type === 'claude_text'), 'deve ter claude_text do ● header')
})

test('BUG#1: "● título... 1. opção 2. opção + Enter to confirm" NÃO vira menu', () => {
  // Caso clássico que quebrava: header ●, opções N. legítimas, footer em prosa.
  // Com ● fora de MENU_TITLE_RE, o bloco de menu sequer é avaliado.
  const raw = `● Plano resumido:
  1. Ler teams.json
  2. Validar schema
  3. Rodar sync
Confirma? Enter to confirm no chat.`
  const events = parseMessageStream(raw)
  assert.ok(!events.some(e => e.type === 'interactive_menu'), 'NÃO deve virar menu')
  const text = events.find(e => e.type === 'claude_text') as { content: string } | undefined
  assert.ok(text, 'deve ter claude_text')
})

// ─── ruído filtrado ───────────────────────────────────────────────────────────

test('filtra linha ... +N lines', () => {
  const events = parseMessageStream('... +5 lines (ctrl+o to expand)')
  assert.equal(events.length, 0)
})

test('filtra [Image #N]', () => {
  const events = parseMessageStream('[Image #1] (↑ to select)')
  assert.equal(events.length, 0)
})

test('filtra linha de separação ─────', () => {
  const events = parseMessageStream('─────────────────────────────────')
  assert.equal(events.length, 0)
})

test('filtra ANSI codes', () => {
  const events = parseMessageStream('\x1b[32m⏺\x1b[0m Bash(echo ok)')
  assert.ok(events.some(e => e.type === 'tool_call'))
})

// ─── output misto realístico ─────────────────────────────────────────────────

test('parseia bloco misto realístico', () => {
  const raw = `❯ git status

⏺ Bash(git status)
  ⎿  On branch main
     nothing to commit

⏺ Tudo atualizado! Aqui está o resumo:

| Arquivo | Status |
|---------|--------|
| index.ts | ✅ OK |

✻ Cogitated for 12s

☐ Confirmar deploy
❯ 1. Sim
  2. Não
Enter to confirm`

  const events = parseMessageStream(raw)
  const types = events.map(e => e.type)

  assert.ok(types.includes('user_input'), 'deve ter user_input')
  assert.ok(types.includes('tool_call'), 'deve ter tool_call')
  assert.ok(types.includes('tool_result'), 'deve ter tool_result')
  assert.ok(types.includes('claude_text'), 'deve ter claude_text')
  assert.ok(types.includes('thinking'), 'deve ter thinking')
  assert.ok(types.includes('interactive_menu'), 'deve ter interactive_menu')
})
