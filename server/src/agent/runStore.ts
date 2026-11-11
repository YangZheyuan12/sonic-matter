import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redact, redactText } from '../logger.ts'
import {
  agentRunSchema,
  type AgentRun,
  type AgentStep,
  type ToolCall,
} from './types.ts'

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS agent_runs (
    id            TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    instruction   TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    summary       TEXT,
    error_code    TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_steps (
    run_id        TEXT NOT NULL,
    id            TEXT NOT NULL,
    position      INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    status        TEXT NOT NULL,
    title         TEXT NOT NULL,
    summary       TEXT,
    started_at    INTEGER,
    finished_at   INTEGER,
    error_code    TEXT,
    error_message TEXT,
    PRIMARY KEY (run_id, id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_tool_calls (
    run_id         TEXT NOT NULL,
    step_id        TEXT NOT NULL,
    id             TEXT NOT NULL,
    position       INTEGER NOT NULL,
    tool_name      TEXT NOT NULL,
    status         TEXT NOT NULL,
    input_summary  TEXT NOT NULL,
    output_summary TEXT,
    error_code     TEXT,
    error_message  TEXT,
    started_at     INTEGER,
    finished_at    INTEGER,
    PRIMARY KEY (run_id, step_id, id),
    FOREIGN KEY (run_id, step_id) REFERENCES agent_steps(run_id, id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_steps_run
    ON agent_steps (run_id, position);
  CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_step
    ON agent_tool_calls (run_id, step_id, position);
`

type RunRow = {
  id: string
  status: AgentRun['status']
  instruction: string
  created_at: number
  updated_at: number
  summary: string | null
  error_code: string | null
  error_message: string | null
}

type StepRow = {
  id: string
  kind: AgentStep['kind']
  status: AgentStep['status']
  title: string
  summary: string | null
  started_at: number | null
  finished_at: number | null
  error_code: string | null
  error_message: string | null
}

type ToolCallRow = {
  id: string
  tool_name: string
  status: ToolCall['status']
  input_summary: string
  output_summary: string | null
  error_code: string | null
  error_message: string | null
  started_at: number | null
  finished_at: number | null
}

const PLAIN_SECRET_ASSIGNMENT = /(\b(?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|cookie)\b\s*[:=]\s*)([^\r\n,;]+)/gi

function sanitizeText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown
    return JSON.stringify(redact(parsed))
  } catch {
    return redactText(value).replace(PLAIN_SECRET_ASSIGNMENT, '$1***')
  }
}

/**
 * Trace 只保留可审计摘要。写入和读取都会脱敏，避免旧数据或手工写入的数据
 * 通过查询响应泄露 API Key、Authorization、Token 等凭据。
 */
function sanitizeRun(run: AgentRun): AgentRun {
  return agentRunSchema.parse({
    ...run,
    instruction: sanitizeText(run.instruction),
    ...(run.summary === undefined ? {} : { summary: sanitizeText(run.summary) }),
    ...(run.errorMessage === undefined
      ? {}
      : { errorMessage: sanitizeText(run.errorMessage) }),
    steps: run.steps.map((step) => ({
      ...step,
      title: sanitizeText(step.title),
      ...(step.summary === undefined ? {} : { summary: sanitizeText(step.summary) }),
      ...(step.errorMessage === undefined
        ? {}
        : { errorMessage: sanitizeText(step.errorMessage) }),
      toolCalls: step.toolCalls.map((call) => ({
        ...call,
        inputSummary: sanitizeText(call.inputSummary),
        ...('outputSummary' in call
          ? { outputSummary: sanitizeText(call.outputSummary) }
          : {}),
        ...('errorMessage' in call && call.errorMessage !== undefined
          ? { errorMessage: sanitizeText(call.errorMessage) }
          : {}),
      })),
    })),
  })
}

export class AgentRunStore {
  readonly databasePath: string
  #db: DatabaseSync | null = null

  constructor(dir: string) {
    this.databasePath = path.join(dir, 'agent-runs.db')
  }

  #open(): DatabaseSync {
    if (this.#db) return this.#db
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.databasePath)
    if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 3000;')
    db.exec(SCHEMA)
    this.#db = db
    return db
  }

  #transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.#open()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  #insertRun(db: DatabaseSync, run: AgentRun): void {
    db.prepare(`
      INSERT INTO agent_runs (
        id, status, instruction, created_at, updated_at, summary, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.status,
      run.instruction,
      run.createdAt,
      run.updatedAt,
      run.summary ?? null,
      run.errorCode ?? null,
      run.errorMessage ?? null,
    )
  }

  #replaceTrace(db: DatabaseSync, run: AgentRun): void {
    db.prepare('DELETE FROM agent_steps WHERE run_id = ?').run(run.id)
    const insertStep = db.prepare(`
      INSERT INTO agent_steps (
        run_id, id, position, kind, status, title, summary,
        started_at, finished_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertCall = db.prepare(`
      INSERT INTO agent_tool_calls (
        run_id, step_id, id, position, tool_name, status, input_summary,
        output_summary, error_code, error_message, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    run.steps.forEach((step, stepIndex) => {
      insertStep.run(
        run.id,
        step.id,
        stepIndex,
        step.kind,
        step.status,
        step.title,
        step.summary ?? null,
        step.startedAt ?? null,
        step.finishedAt ?? null,
        step.errorCode ?? null,
        step.errorMessage ?? null,
      )
      step.toolCalls.forEach((call, callIndex) => {
        insertCall.run(
          run.id,
          step.id,
          call.id,
          callIndex,
          call.toolName,
          call.status,
          call.inputSummary,
          'outputSummary' in call ? call.outputSummary : null,
          'errorCode' in call ? call.errorCode : null,
          'errorMessage' in call ? call.errorMessage ?? null : null,
          'startedAt' in call ? call.startedAt ?? null : null,
          'finishedAt' in call ? call.finishedAt : null,
        )
      })
    })
  }

  create(input: AgentRun): AgentRun {
    const run = sanitizeRun(agentRunSchema.parse(input))
    return this.#transaction((db) => {
      this.#insertRun(db, run)
      this.#replaceTrace(db, run)
      return run
    })
  }

  /** 更新的是完整 Trace 快照；事务内替换子记录，重复更新不会追加 Tool Call。 */
  update(input: AgentRun): AgentRun | null {
    const run = sanitizeRun(agentRunSchema.parse(input))
    return this.#transaction((db) => {
      const exists = db.prepare('SELECT 1 FROM agent_runs WHERE id = ?').get(run.id)
      if (exists === undefined) return null
      db.prepare(`
        UPDATE agent_runs SET
          status = ?, instruction = ?, created_at = ?, updated_at = ?,
          summary = ?, error_code = ?, error_message = ?
        WHERE id = ?
      `).run(
        run.status,
        run.instruction,
        run.createdAt,
        run.updatedAt,
        run.summary ?? null,
        run.errorCode ?? null,
        run.errorMessage ?? null,
        run.id,
      )
      this.#replaceTrace(db, run)
      return run
    })
  }

  get(id: string): AgentRun | null {
    const db = this.#open()
    const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow | undefined
    if (row === undefined) return null
    const stepRows = db.prepare(`
      SELECT id, kind, status, title, summary, started_at, finished_at, error_code, error_message
      FROM agent_steps WHERE run_id = ? ORDER BY position ASC
    `).all(id) as StepRow[]
    const selectCalls = db.prepare(`
      SELECT id, tool_name, status, input_summary, output_summary,
             error_code, error_message, started_at, finished_at
      FROM agent_tool_calls
      WHERE run_id = ? AND step_id = ?
      ORDER BY position ASC
    `)

    const steps = stepRows.map((step) => ({
      id: step.id,
      kind: step.kind,
      status: step.status,
      title: step.title,
      toolCalls: (selectCalls.all(id, step.id) as ToolCallRow[]).map((call) => ({
        id: call.id,
        toolName: call.tool_name,
        status: call.status,
        inputSummary: call.input_summary,
        ...(call.output_summary === null ? {} : { outputSummary: call.output_summary }),
        ...(call.error_code === null ? {} : { errorCode: call.error_code }),
        ...(call.error_message === null ? {} : { errorMessage: call.error_message }),
        ...(call.started_at === null ? {} : { startedAt: call.started_at }),
        ...(call.finished_at === null ? {} : { finishedAt: call.finished_at }),
      })),
      ...(step.summary === null ? {} : { summary: step.summary }),
      ...(step.started_at === null ? {} : { startedAt: step.started_at }),
      ...(step.finished_at === null ? {} : { finishedAt: step.finished_at }),
      ...(step.error_code === null ? {} : { errorCode: step.error_code }),
      ...(step.error_message === null ? {} : { errorMessage: step.error_message }),
    }))

    return sanitizeRun(agentRunSchema.parse({
      id: row.id,
      status: row.status,
      instruction: row.instruction,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      steps,
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    }))
  }

  close(): void {
    this.#db?.close()
    this.#db = null
  }
}

export { AgentRunStore as RunStore }
