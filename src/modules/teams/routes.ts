import type { FastifyInstance } from 'fastify'
import { loadTeamsConfig, startTeam, stopTeam } from './service.js'

export async function teamsRoutes(app: FastifyInstance) {
  app.get('/teams', async () => {
    const teams = loadTeamsConfig()
    return { teams }
  })

  app.post<{ Params: { project: string; team: string } }>(
    '/teams/:project/:team/start',
    async (request) => {
      const { project, team } = request.params
      return startTeam(project, team)
    }
  )

  app.post<{ Params: { project: string; team: string } }>(
    '/teams/:project/:team/stop',
    async (request) => {
      const { project, team } = request.params
      return stopTeam(project, team)
    }
  )
}
