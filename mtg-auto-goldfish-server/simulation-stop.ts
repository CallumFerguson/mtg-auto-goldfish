export const SIMULATION_STOP_TIMEOUT_MS = 10_000

const SIMULATION_STOP_TIMEOUT_MESSAGE =
  "Simulation stop timed out before all active LLM runs were cancelled."

export class SimulationStopTimeoutError extends Error {
  constructor(message = SIMULATION_STOP_TIMEOUT_MESSAGE) {
    super(message)
    this.name = "SimulationStopTimeoutError"
  }
}

export async function waitForSimulationStopCompletions(
  completionPromises: readonly Promise<void>[],
  timeoutMs = SIMULATION_STOP_TIMEOUT_MS
) {
  if (completionPromises.length === 0) {
    return
  }

  let timeout: NodeJS.Timeout | null = null

  try {
    await Promise.race([
      Promise.all(completionPromises),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new SimulationStopTimeoutError())
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
