import assert from "node:assert/strict"
import test from "node:test"
import {
  SimulationResultsBroadcaster,
  formatSseEvent,
  type SimulationResultsStreamEvent,
} from "./simulation-results-stream.js"

test("formats stream events as JSON SSE messages", () => {
  const event: SimulationResultsStreamEvent = {
    type: "error",
    message: "Something failed.",
  }

  assert.equal(
    formatSseEvent(event),
    'data: {"type":"error","message":"Something failed."}\n\n'
  )
})

test("publishes events to active simulation subscribers immediately", () => {
  const broadcaster = new SimulationResultsBroadcaster()
  const writer = createWriter()

  broadcaster.subscribe("simulation-id", writer)
  broadcaster.publish("simulation-id", {
    type: "error",
    message: "Live event",
  })

  assert.equal(writer.writes.length, 1)
  assert.match(writer.writes[0], /Live event/)
})

test("unsubscribes closed simulation subscribers", () => {
  const broadcaster = new SimulationResultsBroadcaster()
  const writer = createWriter()
  const unsubscribe = broadcaster.subscribe("simulation-id", writer)

  assert.equal(broadcaster.getSubscriberCount("simulation-id"), 1)

  unsubscribe()

  assert.equal(broadcaster.getSubscriberCount("simulation-id"), 0)
})

test("closes and removes all subscribers for a completed simulation", () => {
  const broadcaster = new SimulationResultsBroadcaster()
  const firstWriter = createWriter()
  const secondWriter = createWriter()

  broadcaster.subscribe("simulation-id", firstWriter)
  broadcaster.subscribe("simulation-id", secondWriter)
  broadcaster.closeSimulation("simulation-id")

  assert.equal(firstWriter.endCount, 1)
  assert.equal(secondWriter.endCount, 1)
  assert.equal(broadcaster.getSubscriberCount("simulation-id"), 0)
})

function createWriter() {
  return {
    endCount: 0,
    writes: [] as string[],
    write(chunk: string) {
      this.writes.push(chunk)
    },
    end() {
      this.endCount += 1
    },
  }
}
