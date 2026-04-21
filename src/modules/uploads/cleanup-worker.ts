import { Worker, Queue } from 'bullmq'
import { cleanOnce } from './cleanup-logic.js'

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/i9-team-uploads'

const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
}

export const cleanupQueue = new Queue('cleanup-uploads', { connection: redisConnection })

/**
 * Worker BullMQ — dispara `cleanOnce` a cada 30min (agendado em
 * `scheduleCleanupJob`). Lógica de varredura está em `cleanup-logic.ts`
 * (sem side effects de import, testável em isolado).
 */
export function startCleanupWorker(): Worker {
  const worker = new Worker(
    'cleanup-uploads',
    async () => {
      const { removedFiles, scanned, removedDirs } = cleanOnce(UPLOAD_DIR)
      console.log(
        `[cleanup-uploads] scanned=${scanned} removedFiles=${removedFiles} removedDirs=${removedDirs}`
      )
    },
    { connection: redisConnection }
  )

  worker.on('failed', (job, err) => {
    console.error(`[cleanup-uploads] job ${job?.id} falhou:`, err.message)
  })

  console.log('[cleanup-uploads] worker iniciado')
  return worker
}

/** Agenda o job recorrente a cada 30min. */
export async function scheduleCleanupJob(): Promise<void> {
  await cleanupQueue.add(
    'cleanup',
    {},
    {
      repeat: { every: 30 * 60 * 1000 },
      removeOnComplete: 10,
      removeOnFail: 5,
    }
  )
  console.log('[cleanup-uploads] job agendado (intervalo: 30min)')
}
