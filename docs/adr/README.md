# ADRs — Architecture Decision Records

Registro de decisiones arquitectonicas significativas del Autonomous Orchestrator.

---

## Indice

| ADR | Titulo | Status | Fecha | Autores |
|-----|--------|--------|-------|---------|
| [ADR-001](0001-claude-headless-via-agent-runner-interface.md) | Invocacion de agentes via interfaz `AgentRunner` con `ClaudeCodeRunner` headless | Accepted | 2026-05-16 | Roman, equipo |
| [ADR-002](0002-script-first-no-n8n.md) | Script-first sin n8n | Accepted | 2026-05-16 | Equipo completo |
| [ADR-003](0003-observer-observed-separation.md) | Separacion entre observador y objeto observado | Accepted | 2026-05-16 | Roman, Camila |
| [ADR-004](0004-template.md) | (Template para futuros ADRs) | Draft | — | — |

---

## Que merece un ADR

Una decision arquitectonica debe documentarse como ADR si:

1. **Impacto alto**: afecta multiples componentes o define un patron fundamental.
2. **Trade-offs significativos**: hay pros y contras que el equipo necesita entender.
3. **Irreversible o costoso revertir**: cambiar la decision requiere refactor importante.
4. **Polemico o no obvio**: el equipo debatio opciones y necesita recordar el "por que".

**Ejemplos que merecen ADR**:
- Eleccion de base de datos (SQLite vs MongoDB vs PostgreSQL).
- Patron de invocacion de agentes (SDK vs CLI vs API HTTP).
- Modelo de coordinacion (callbacks vs waiters).
- Stack de infraestructura (n8n vs scripts custom).

**Ejemplos que NO merecen ADR** (van en docs de componentes o en el spec):
- Nombre de una funcion.
- Formato de un campo JSON.
- Eleccion de libreria de validacion (Zod vs Joi) si no hay debate.

---

## Como escribir un ADR

Usa el template [`0004-template.md`](0004-template.md).

**Estructura obligatoria**:

1. **Metadata**: status, fecha, version spec, autores, supersedes.
2. **Contexto**: problema que motiva la decision, opciones evaluadas, principios aplicables.
3. **Decision**: que se decidio, con justificacion concisa.
4. **Consecuencias**: positivas y negativas, sin ocultar trade-offs.
5. **Referencias**: links al spec, BRD, actas de reuniones.

**Status posibles**:
- `Draft`: propuesta en discusion.
- `Accepted`: decision tomada, implementandose o implementada.
- `Superseded`: reemplazada por otro ADR (especificar cual).
- `Rejected`: evaluada y rechazada (documentar por que).

---

## Politica de modificacion

**ADRs son inmutables una vez aceptados.**

- Si una decision cambia, se escribe un **nuevo ADR** que supersede al anterior.
- El ADR viejo se marca `Superseded` con referencia al nuevo.
- Nunca se edita el contenido de un ADR aceptado, salvo typos menores.

**Racional**: los ADRs son registro historico. Deben reflejar el contexto y razonamiento en el momento de la decision, aunque despues cambie.

---

## Proceso de aprobacion

1. **Draft**: autor escribe el ADR y lo commitea con status `Draft`.
2. **Review**: equipo lo revisa en reunion o via PR comments.
3. **Decision**: Roman (Tech Lead) decide si se acepta, rechaza o difiere.
4. **Commit**: cambiar status a `Accepted` / `Rejected` y mergear.
5. **Comunicacion**: Camila (PM) comunica la decision al equipo via Slack/email.

---

## Referencias

- **Spec**: [docs/spec.md](../spec.md)
- **Arquitectura general**: [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- **Componentes**: [docs/components/](../components/)

---

**Siguiente lectura**:
- [ADR-001](0001-claude-headless-via-agent-runner-interface.md) — decision mas reciente (v0.7)
- [ADR-003](0003-observer-observed-separation.md) — principio arquitectonico fundamental
