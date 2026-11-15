/**
 * AG-UI event-type mapping.
 *
 * AG-UI (https://github.com/ag-ui-protocol/ag-ui) defines an event vocabulary
 * for agent-to-frontend streaming. Conchbase already publishes its own frame
 * vocabulary under ADR 0060; renaming those frames would break every accepted
 * client. Instead each frame *also* carries an `agUiType`, so a third-party
 * AG-UI client can map frames without Conchbase maintaining a private adapter.
 *
 * Only the subset Conchbase actually emits is mapped. A frame with no faithful
 * AG-UI equivalent carries `null` rather than a misleading label.
 */

export const AG_UI_EVENT_TYPES = Object.freeze({
  runStarted: 'RUN_STARTED',
  runFinished: 'RUN_FINISHED',
  runError: 'RUN_ERROR',
  textMessageStart: 'TEXT_MESSAGE_START',
  textMessageContent: 'TEXT_MESSAGE_CONTENT',
  textMessageEnd: 'TEXT_MESSAGE_END',
  toolCallStart: 'TOOL_CALL_START',
  toolCallArgs: 'TOOL_CALL_ARGS',
  toolCallEnd: 'TOOL_CALL_END',
  stateSnapshot: 'STATE_SNAPSHOT',
  stateDelta: 'STATE_DELTA',
  custom: 'CUSTOM',
} as const);

export type AgUiEventType = typeof AG_UI_EVENT_TYPES[keyof typeof AG_UI_EVENT_TYPES];

export type ConchbaseFrameKind = 'snapshot' | 'message' | 'health';

export interface AgUiProjectionInput {
  readonly kind: ConchbaseFrameKind;
  readonly messageState?: string | null;
  readonly phase?: string | null;
  readonly author?: string | null;
}

/**
 * Maps one Conchbase stream frame onto the closest AG-UI event type.
 * `health` is transport-level liveness and has no AG-UI equivalent, so it maps
 * to `null` instead of being mislabelled as `CUSTOM`.
 */
export function agUiEventType(input: AgUiProjectionInput): AgUiEventType | null {
  if (input.kind === 'health') return null;
  if (input.kind === 'snapshot') return AG_UI_EVENT_TYPES.stateSnapshot;

  if (input.author === 'user') return AG_UI_EVENT_TYPES.textMessageStart;
  switch (input.messageState) {
    case 'thinking':
    case 'streaming':
    case 'organizing':
      return AG_UI_EVENT_TYPES.textMessageContent;
    case 'pending':
      return AG_UI_EVENT_TYPES.toolCallStart;
    case 'waiting_approval':
    case 'waiting_attention':
      return AG_UI_EVENT_TYPES.custom;
    case 'failed':
    case 'unavailable':
    case 'cancelled':
      return AG_UI_EVENT_TYPES.runError;
    default:
      return AG_UI_EVENT_TYPES.textMessageEnd;
  }
}
