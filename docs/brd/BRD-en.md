# Business Requirements Document
## SoftwareFactory Autonomous Orchestrator

| | |
|---|---|
| Document ID | BRD-SFAO-001 |
| Version | 1.0 |
| Date | 2026-05-16 |
| Status | Draft for approval |
| Owner | Angel Oliver (angel.oliver@kunfupay.com) |
| Product Manager | Camila |
| Technical Lead | Roman |
| Working directory | `~/.claude` |
| Team | softwarefactory (7 AI agents) |

---

## 1. Executive Summary

SoftwareFactory is a team of seven specialized AI agents (Product Management, UX, Tech Lead, Frontend, Backend, QA, DevOps) operating inside the Claude Code environment. Today they collaborate through human-triggered, single-conversation interactions.

This project delivers an **Autonomous Orchestrator**: a workflow engine plus external orchestration layer that lets SoftwareFactory execute the full lifecycle of a software factory (intake → design → architecture → development → QA → deployment) without continuous human prompting. The human role shifts from operator to product owner and quality auditor.

The orchestrator is the **only priority project** of the team. All other initiatives are paused or subordinated to it.

---

## 2. Business Context

### 2.1 Problem statement

The current operating model produces high-quality output but does not scale:

- Every handoff between agents requires a human prompt.
- Context, deliverables and decisions live in conversation history rather than durable state.
- Throughput is capped at one task at a time.
- Quality gates are informal and not enforceable.
- The team cannot operate when the human operator is offline.

### 2.2 Strategic intent

Transform SoftwareFactory from an *interactive multi-agent team* into a *self-sustaining digital factory* that can be tasked at the level of a user story or epic and return a deployed, QA-validated outcome, with the human acting as approver only at high-risk decision points.

### 2.3 Business value

- **10x throughput**: parallel pipelines, no human bottleneck for routine work.
- **24/7 operations**: factory keeps producing while the operator is offline.
- **Auditable trail**: every artifact and decision is persisted, signed and traceable.
- **Cost transparency**: token usage measured per pipeline, per agent, per stage.
- **Reproducibility**: the same input yields a comparable output and process.

---

## 3. Scope

### 3.1 In scope

- A workflow engine that models the SoftwareFactory pipeline as a directed graph of agent stages.
- An external orchestration layer (Phase 1: n8n + Node scripts; Phase 2: Temporal.io).
- Persistent state (Pipeline, Task, Execution, Gate, Artifact).
- A typed inter-agent contract (structured ticket: Context / Deliverable / Acceptance Criteria / Handoff Protocol).
- A "factory dashboard" for human observation.
- Mandatory non-negotiable safety controls: kill-switch, token rate limit, daily backups, mandatory human gates on architecture, production deployment, and critical hotfixes.
- Multi-level autonomy model (L0 manual to L5 sandbox autonomous).

### 3.2 Out of scope (Phase 1)

- Deciding *what* to build. The orchestrator automates execution, not product strategy.
- Cross-team coordination with other prefixed teams.
- Multi-tenant operation for external customers.
- Self-modification of the orchestrator by the agents themselves.

### 3.3 Assumptions

- Claude Code SDK / CLI remains the primary entry point for agent invocation.
- Local-first deployment is acceptable for Phase 1; cloud migration is a Phase 2 decision.
- The operator (Angel) is available to review approval gates within 24 hours.

### 3.4 Constraints

- Token cost is the dominant variable cost; a daily budget cap is mandatory.
- The orchestrator must run on a developer-class machine in Phase 1 (no enterprise infra required).
- All persisted state must remain on infrastructure controlled by the operator.

---

## 4. Stakeholders

| Role | Name | Responsibility |
|---|---|---|
| Sponsor / Operator | Angel | Final approver, sets priority |
| Product Manager | Camila | Defines requirements, success metrics |
| Tech Lead | Roman | Architectural decisions, technical risk |
| Frontend | Valeria | Dashboard, operator UI |
| Backend | Mateo | Data model, orchestrator API, persistence |
| QA | Sofia | Quality gates, regression strategy, audit |
| DevOps | Dante | Runtime, observability, safety controls |
| UX | Lucas | Operator UX, inter-agent contract |

---

## 5. Requirements

### 5.1 Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | The orchestrator shall accept a user story or ticket as input and produce a deployed artifact in staging as output. | Must |
| FR-02 | The orchestrator shall route tasks to the appropriate agent based on role and stage. | Must |
| FR-03 | Each stage shall validate explicit acceptance criteria before handing off to the next stage. | Must |
| FR-04 | The orchestrator shall persist every artifact (PRD, mockups, ADRs, code diffs, test reports) with a hash and metadata. | Must |
| FR-05 | The orchestrator shall expose a REST API for commands (create task, approve gate, retry, abort). | Must |
| FR-06 | The orchestrator shall stream logs in real time via WebSocket/SSE. | Must |
| FR-07 | The orchestrator shall support retries with exponential backoff and a dead-letter queue. | Must |
| FR-08 | The orchestrator shall enforce mandatory human gates on architectural changes, production deploys, and critical hotfixes. | Must |
| FR-09 | The orchestrator shall provide a kill-switch that halts all active pipelines within 60 seconds. | Must |
| FR-10 | The orchestrator shall enforce a configurable daily token budget per pipeline. | Must |
| FR-11 | The factory dashboard shall display agent state (idle / working / blocked), task queue per role, handoff logs and time metrics. | Must |
| FR-12 | Each completed pipeline shall generate a traceable audit report. | Must |
| FR-13 | The orchestrator shall support parallel pipelines (multiple user stories in flight). | Should |
| FR-14 | The orchestrator shall produce a weekly automated retrospective with metrics per agent. | Should |
| FR-15 | The orchestrator shall expose webhooks for external integrations (Slack, GitHub, Jira). | Could |

### 5.2 Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Time-to-staging for a simple user story | < 4 hours |
| NFR-02 | QA rejection rate of agent output | < 20% |
| NFR-03 | Pipeline state durability | 100% (no loss on crash) |
| NFR-04 | Orchestrator availability when running locally | 99% during business hours |
| NFR-05 | Recovery time after a stage failure | < 5 minutes (auto-retry) |
| NFR-06 | Phase 1 infrastructure cost | $0 local, < $20/month on VPS |
| NFR-07 | Mean human approval latency on gates | < 24 hours |
| NFR-08 | All inter-agent messages must be schema-validated | 100% |

---

## 6. Solution Overview

### 6.1 Architecture (Phase 1 — MVP)

Four layers:

1. **Workflow engine** — defines the SoftwareFactory pipeline (Camila → Lucas → Roman → Valeria || Mateo → Sofia → Dante).
2. **State store** — MongoDB for pipelines, tasks, executions, gates and artifacts. Redis for distributed locks and queues.
3. **Message bus** — events emitted on file writes under `.claude/memory/tasks/<task-id>.json`; n8n triggers next stage.
4. **External orchestration** — n8n self-hosted, talking to Claude Code via `npx @claude/sdk task <agent>`.

### 6.2 Architecture (Phase 2 — Consolidation)

- Migrate workflow engine to **Temporal.io** for durable, long-running multi-agent workflows.
- Add Next.js dashboard with Server Components + SSE.
- Add observability stack: Loki, Prometheus, Grafana.
- Optional move to VPS with Docker Compose.

### 6.3 Data model (high-level)

- `Pipeline { _id, name, version, stages[] }`
- `Task { _id, pipelineId, status, assignedAgent, input, output, parentTaskId, retries, idempotencyKey }`
- `Execution { _id, taskId, agentId, startedAt, finishedAt, status, logs[], artifacts[] }`
- `Gate { _id, taskId, type, approver, decision, timestamp }`
- `Artifact { _id, executionId, type, path, hash, metadata }`

### 6.4 Autonomy model

| Level | Description | Example |
|---|---|---|
| L0 | Manual | Human writes the PRD |
| L1 | Assisted | Agent proposes, human approves each step |
| L2 | Supervised | Agent executes, human reviews each handoff |
| L3 | Autonomous with audit | Agent executes, human audits asynchronously |
| L4 | Fully autonomous, gated | Agent executes; human approves only critical gates |
| L5 | Sandbox autonomous | Fully autonomous, isolated environment |

Default for Phase 1: **L3**. Mandatory human gates apply regardless of level.

---

## 7. Workflow

```
Intake (Camila)
   → Design (Lucas)
      → Architecture (Roman) [gate: human approval]
         → Frontend (Valeria) || Backend (Mateo)   [parallel]
            → QA (Sofia)  [gate: 80% coverage minimum]
               → Deploy to staging (Dante)
                  → Audit + retrospective (auto)
                     → Optional gate: production deploy (human)
```

---

## 8. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Latency accumulates across stages | High | Medium | Parallelize QA and DevOps; pre-compute artifacts |
| Race conditions between agents | Medium | High | Redis locks; idempotency keys |
| Cascading failures | Medium | High | Retry with backoff; rollback to N-1; dead-letter queue |
| Silent regressions in autonomous mode | Medium | High | Mandatory regression tests on every bug; weekly audit |
| Hallucinated code passing tests | Medium | High | Multi-layer QA; static analysis; secondary review agent |
| Token cost runaway | Medium | High | Daily budget cap; circuit breaker on tokens/minute |
| Spec drift | Medium | Medium | Periodic human checkpoints; spec hash diffing |
| Operator becomes blocker | Low | Medium | Async approval queue; 24h SLA on gates |

---

## 9. Success metrics

- **Time-to-staging** for a Hello World user story: < 4 hours.
- **QA rejection rate**: < 20% on first pass.
- **Human intervention rate**: < 1 per pipeline (excluding mandatory gates).
- **Cost per delivered feature**: tracked and trending down month over month.
- **Pipeline reproducibility**: same input → equivalent output in >= 90% of cases.

---

## 10. Roadmap

| Phase | Duration | Outcome |
|---|---|---|
| Phase 0 — BRD and POC | 1-2 weeks | This BRD signed; n8n + MongoDB POC running |
| Phase 1 — MVP | 4-6 weeks | Hello World user story flows end-to-end |
| Phase 2 — Consolidation | 6-10 weeks | Temporal migration, dashboard, observability |
| Phase 3 — Scale | 12+ weeks | Parallel pipelines, multi-project, learning loops |

---

## 11. Open questions

1. Should the orchestrator host its own LLM gateway, or call Anthropic directly?
2. How do we version the inter-agent contract without breaking running pipelines?
3. What is the policy when an agent disagrees with another agent's deliverable?
4. Should we adopt a "supervisor" agent that watches the pipeline meta-level, or keep that role human?

---

## 12. Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Sponsor | Angel Oliver | _________ | _________ |
| PM | Camila | _________ | _________ |
| Tech Lead | Roman | _________ | _________ |
