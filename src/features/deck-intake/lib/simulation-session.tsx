import { ToolCardList } from "@/features/deck-intake/components/tool-card-elements"
import {
  type SimulationActivityDetail,
} from "@/shared/simulation-session-core"

export {
  cancelPromptRun,
  createActivityId,
  createPromptRun,
  createStartingHandValidationRun,
  getKeepHandCardsFromEvent,
  getToolGameId,
  markPromptRunError,
  recomputePromptRun,
  recordPromptStreamEvent,
  restorePromptRuns,
  type FinalAnswerStatus,
  type GameCardPayload,
  type PromptRunEventRecord,
  type PromptStreamEvent,
  type SimulationActivity,
  type SimulationActivityDetail,
  type SimulationPayload,
  type SimulationPromptRun,
  type SimulationPromptRunFlow,
  type SimulationPromptRunKind,
  type SimulationPromptRunStatus,
  type StartingHandValidation,
} from "@/shared/simulation-session-core"

export function renderSimulationActivityDetail(
  detail: SimulationActivityDetail | undefined
): React.ReactNode {
  if (!detail) {
    return null
  }

  switch (detail.kind) {
    case "text":
      return <p className="text-xs leading-5 text-stone-400">{detail.text}</p>
    case "preformatted_text":
      return (
        <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-black/20 p-3 text-xs leading-5 whitespace-pre-wrap text-stone-300">
          {detail.text}
        </pre>
      )
    case "card_list":
      return <ToolCardList cards={detail.cards} label={detail.label} />
    case "stack":
      return (
        <div className="space-y-2">
          {detail.items.map((item, index) => (
            <div key={index}>{renderSimulationActivityDetail(item)}</div>
          ))}
        </div>
      )
  }
}

