import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../config.js'

// ────────────────────────────────────────────────────────────────────────────
// Tipos legacy (mantidos por compat com o shape histórico de teams.json que
// algum caller antigo pode esperar). start/stop NÃO dependem mais disso — eles
// delegam para `~/.claude/scripts/team.sh`.
// ────────────────────────────────────────────────────────────────────────────

interface TeamAgent {
  name: string
  session: string
}

interface TeamConfig {
  name: string
  agents: TeamAgent[]
  startScript?: string
  stopScript?: string
}

interface TeamsJson {
  [project: string]: {
    [team: string]: TeamConfig
  }
}

/**
 * Lê o teams.json bruto. Mantido por compat — o arquivo real hoje tem o shape
 * `{version, projects:[…]}` (ver `team.sh`), então o valor retornado aqui pode
 * não bater com `TeamsJson`. Use apenas para exposição crua via `/legacy/teams`
 * e `/teams/config`. NÃO use para decisões lógicas.
 */
export function loadTeamsConfig(): TeamsJson {
  if (!existsSync(config.teamsJsonPath)) {
    return {}
  }
  const raw = readFileSync(config.teamsJsonPath, 'utf8')
  return JSON.parse(raw) as TeamsJson
}

// ────────────────────────────────────────────────────────────────────────────
// start/stop — delegam para ~/.claude/scripts/team.sh
// ────────────────────────────────────────────────────────────────────────────

/**
 * Caminho oficial do orquestrador de teams. O script aceita:
 *   team.sh start <projeto> <team>  → cria sessões tmux + injeta /team-protocol
 *   team.sh stop  <projeto> <team>  → mata sessões tmux do prefixo
 */
const TEAM_SCRIPT = join(homedir(), '.claude', 'scripts', 'team.sh')

export interface TeamActionResult {
  ok: boolean
  message: string
  stdout?: string
  stderr?: string
  /** true quando o script indicou que projeto/team não existe no teams.json */
  notFound?: boolean
  /** exit code do processo (null se timeout/erro de spawn) */
  code?: number | null
}

function runTeamScript(
  action: 'start' | 'stop',
  project: string,
  team: string
): TeamActionResult {
  if (!existsSync(TEAM_SCRIPT)) {
    return {
      ok: false,
      message: `Script não encontrado: ${TEAM_SCRIPT}`,
    }
  }

  const r = spawnSync('bash', [TEAM_SCRIPT, action, project, team], {
    encoding: 'utf8',
    timeout: 30_000,
  })

  // Erro de spawn (timeout, ENOENT do bash, etc.)
  if (r.error) {
    return {
      ok: false,
      message: r.error.message,
      stderr: String(r.error),
      code: null,
    }
  }

  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''

  if (r.status === 0) {
    return {
      ok: true,
      message: `Team ${project}/${team} ${action === 'start' ? 'iniciado' : 'encerrado'}`,
      stdout,
      stderr,
      code: 0,
    }
  }

  // exit != 0 — distinguir "não encontrado" de outras falhas
  const notFound = /não encontrado|not found/i.test(`${stdout}\n${stderr}`)
  return {
    ok: false,
    notFound,
    message: notFound
      ? `Team ${project}/${team} não encontrado no teams.json`
      : `team.sh ${action} falhou (exit ${r.status})`,
    stdout,
    stderr,
    code: r.status,
  }
}

export function startTeam(project: string, team: string): TeamActionResult {
  return runTeamScript('start', project, team)
}

export function stopTeam(project: string, team: string): TeamActionResult {
  return runTeamScript('stop', project, team)
}
