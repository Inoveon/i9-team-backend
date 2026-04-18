import type { FastifyInstance } from 'fastify'
import { loadTeamsConfig, startTeam, stopTeam } from './service.js'

export async function teamsRoutes(app: FastifyInstance) {
  // GET /legacy/teams — lista teams do arquivo teams.json
  app.get('/legacy/teams', async () => {
    const teams = loadTeamsConfig()
    return { teams }
  })

  // POST /legacy/teams/:project/:team/start — inicia team via script
  app.post<{ Params: { project: string; team: string } }>(
    '/legacy/teams/:project/:team/start',
    async (request) => {
      const { project, team } = request.params
      return startTeam(project, team)
    }
  )

  // POST /legacy/teams/:project/:team/stop — para team via script
  app.post<{ Params: { project: string; team: string } }>(
    '/legacy/teams/:project/:team/stop',
    async (request) => {
      const { project, team } = request.params
      return stopTeam(project, team)
    }
  )
}
