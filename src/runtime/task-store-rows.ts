/**
 * SQLite row shapes.
 *
 * Declarations only: exactly what each query returns, so the snake_case
 * boundary is stated once instead of being implied across many mappers.
 */

export interface TaskRow {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configuration_revision_id: string;
  readonly state: string;
  readonly attempt: number;
  readonly output: string | null;
  readonly partial_output: string | null;
  readonly error: string | null;
  readonly agent_id: string | null;
  readonly agent_revision_id: string | null;
  readonly provider_id: string | null;
  readonly model_id: string | null;
}

export interface EventRow {
  readonly sequence: number;
  readonly id: string;
  readonly task_id: string;
  readonly type: string;
  readonly state: string;
  readonly configuration_revision_id: string;
  readonly attempt: number;
  readonly data: string;
  readonly agent_id: string | null;
  readonly agent_revision_id: string | null;
  readonly provider_id: string | null;
  readonly model_id: string | null;
}

export interface AgentRow {
  readonly id: string;
  readonly current_revision_id: string;
  readonly archived: number;
}

export interface AgentRevisionRow {
  readonly id: string;
  readonly agent_id: string;
  readonly name: string;
  readonly instructions: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly granted_capabilities: string;
  readonly created_at: string;
}

export interface ToolRequestRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly configuration_revision_id: string;
  readonly composition_document_id: string;
  readonly composition_node_id: string;
  readonly tool_name: string;
  readonly arguments_digest: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly created_at: string;
  readonly approval_id: string | null;
  readonly approval_decision: string | null;
  readonly approval_reason_digest: string | null;
  readonly approval_decided_at: string | null;
}

export interface ConfigurationRevisionRow {
  readonly id: string;
  readonly document: string;
  readonly applied_at: string;
  readonly ordinal: number;
}

export interface ConfigurationActiveRow {
  readonly revision_id: string;
}
