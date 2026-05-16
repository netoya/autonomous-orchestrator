# Reunion: Coordinacion reactiva de trabajo (waiters intra-sprint)
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Camila (PM), Roman (Tech Lead), Mateo (Backend), Dante (DevOps)

## Contexto

Angel extiende el modelo de waiters. Ademas de coordinar condiciones externas (v0.2) y backlog vivo (v0.3), los waiters tambien sirven como **pegamento interno entre tareas de un mismo sprint**:

- Cada task puede declarar dependencias.
- Cada dependencia genera un waiter automatico.
- Cuando una task termina, su waiter dispara las dependientes.
- Tasks bloqueadas no consumen workers; los workers libres toman otras tasks activables (**work stealing contextual**).

Dos modos de invocacion al sistema:
- **single task**: ejecuta solo una tarea, sin waiters intra-sprint.
- **sprint completo**: el sistema auto-genera los waiters entre dependencias declaradas.

Principio formalizado por Angel:
> El trabajo no se empuja manualmente entre etapas. El trabajo despierta automaticamente cuando sus condiciones son verdaderas.

## Discusion

### Camila (Product Manager)
Cambio de modelo: de Gantt a grafo de dependencias declarativo.

**Pros**: el equipo declara "que depende de que", no fechas arbitrarias. Auto-ajuste ante bloqueos.
**Contras**: curva de aprendizaje para stakeholders no tecnicos. Necesita UI que abstraiga el grafo en timelines.

**Tercer modo de invocacion necesario**: `until-milestone` (ejecuta hasta una task etiquetada como milestone). Casos: deploy parcial hasta QA, entrega incremental a cliente, validacion temprana hasta prototipo.

**Estimacion / visibilidad**: cada task declara `estimated_effort`; el scheduler calcula **critical path dinamico**. Dashboard muestra "Xh restantes en camino critico, Yh activables en paralelo" en tiempo real.

**Visualizacion**: Kanban reactivo para operacion diaria + vista de grafo opcional para debugging. Codigo de color: verde (activable), gris (bloqueado por waiter), naranja (ejecutando).

**Deteccion de ciclos**: obligatoria pre-ejecucion. Si falla, rechaza el sprint con error claro `Ciclo detectado: TaskA -> TaskB -> TaskA`.

### Roman (Tech Lead)
**Diferencia con Temporal/Airflow**: ellos validan el grafo completo antes de ejecutar. Aqui las tasks se generan on-the-fly. **Si perdemos deteccion estatica de deadlocks**. Contramedida: timeout obligatorio en cada waiter + detector de ciclos en runtime cada N segundos. Trade-off aceptable.

**Modelo de dependencias** (tres sabores, default tags):
- `depends_on: ["task-123"]` — explicito, fragil.
- `depends_on_tag: "build-complete"` — resiliente, default.
- `depends_on_predicate: "status=done AND agent=mateo"` — solo si es inevitable.

**Work stealing**: usar **WSJF (Weighted Shortest Job First)**: `(priority * business_value) / estimated_duration`. Balancea urgencia y throughput.

**Eventos internos**: **publicar en `events.jsonl` es mas robusto** que polling SQLite. El scheduler lee tail del log, parsea `task.finished`, activa waiters dependientes.

**Condition kind**: nuevo `task-dependency` (no reusar `flow-dependency`, semantica distinta).

**Top 3 riesgos**:
1. **Ciclos**: A→B, B→A → deadlock. Detector obligatorio en pre-ejecucion + runtime.
2. **Fan-out**: 1 task genera 200 dependientes → colapso. Limite a 20 por task.
3. **Race condition**: task termina antes de que el waiter se registre. Solucion: **registrar waiter ANTES de iniciar la task precedente**, o replay de `events.jsonl` al registrar waiter tardio.

### Mateo (Backend)
**Schema**: tabla dedicada `task_dependencies(id, task_id, depends_on_task_id, kind, created_at)`. Indice compuesto en `(depends_on_task_id, task_id)` para responder "quien depende de mi" en O(1). Columna JSON dificulta queries e integridad referencial.

**Algoritmo de activacion** cuando task `T` pasa a `done`:

```sql
SELECT task_id FROM task_dependencies WHERE depends_on_task_id = T;
-- por cada dependiente d:
SELECT COUNT(*) FROM task_dependencies td
  JOIN tasks t ON td.depends_on_task_id = t.id
  WHERE td.task_id = d AND t.status <> 'done';
-- si 0, UPDATE tasks SET status='ready' WHERE id = d
```

**Deteccion de ciclos**: pre-ejecucion (fail-fast). Topological sort con DFS, recursion sobre `task_dependencies`.

**Work stealing**: `SELECT * FROM tasks WHERE status='ready' ORDER BY priority DESC, created_at ASC LIMIT 1`. Acepta `priority` opcional (Roman pide WSJF; Mateo prefiere campo simple; arrancar con `priority INTEGER`, calcular WSJF como vista si se necesita).

**Patron event-driven**: **trigger SQLite escribe a `events.jsonl`** cuando `tasks.status` cambia a `done`. Scheduler hace tail del archivo cada 200 ms (I/O secuencial, barato). Waiters de tipo `task-dependency` reaccionan via query dirigida, no full-scan.

### Dante (DevOps)
**Dispatcher con work stealing**: el algoritmo de seleccion pasa a ser "el mas prioritario activable en cada tick". Si la cola esta vacia pero hay waiters proximos a cumplirse, el slot queda ocioso hasta el proximo tick. Propone **micro-tick de 500 ms** que solo evalua waiters con `next_check_at - now < 1s` para minimizar idle.

**Limites globales**: `MAX_TOTAL_PENDING = 50` (queued + waiting). Si fan-out supera, el dispatcher rechaza nuevas tasks hasta que drene.

**Metricas Prometheus**:
- `dispatcher_tasks_throughput` (gauge, tasks/hora)
- `dispatcher_slots_idle_seconds` (histogram)
- `dispatcher_tasks_blocked_count` (gauge por estado)
- `dispatcher_deadlock_detected_total` (counter)
- `dispatcher_waiter_resolution_latency` (histogram)

**Alertas**: deadlock → page inmediato; fan-out > 30 → warning; task > 2 h en `queued` con waiters cumplidos → slot starvation.

**Tokens**: reusar budget per-flow. Un sprint es N flows bajo mismo contexto. Si el operador quiere sprint ilimitado, ajusta budget global antes de invocar.

## Tensiones y resoluciones

### T1: dependencias por ID vs tag (Mateo IDs / Roman tags)
- **Resolucion**: ambos modos conviven. Tabla `task_dependencies` resuelve referencias por ID (integridad referencial). Cuando la declaracion es por tag, el spawner del sprint resuelve a IDs al crear las tasks. Predicados quedan para v1.1.

### T2: polling vs event-driven (Mateo trigger + tail / Roman tail puro)
- **Resolucion**: trigger SQLite `AFTER UPDATE OF status ON tasks` que hace `INSERT INTO events`. El scheduler tail-ea `events.jsonl` que se construye desde la tabla `events` via writer del dispatcher. Lo mejor de ambos: integridad transaccional + I/O secuencial barato.

### T3: prioridad simple vs WSJF (Mateo INTEGER / Roman WSJF)
- **Resolucion**: campo `priority INTEGER` en `tasks` + columnas opcionales `business_value`, `estimated_minutes`. El selector de work stealing usa **WSJF si los tres estan presentes**, sino fallback a `priority DESC, created_at ASC`. Pragmatismo + futuro abierto.

### T4: micro-tick (Dante 500 ms para waiters proximos / tick estandar 5 s actual)
- **Resolucion**: agregar **tick D = 500 ms** que evalua solo waiters con `next_check_at - now < 1000 ms`. El resto sigue en tick B = 5 s.

## Decisiones

1. Adoptar **coordinacion reactiva de trabajo** como capa de primera clase. Spec pasa a v0.4.
2. Tres modos de invocacion: `single-task`, `until-milestone`, `sprint-completo`.
3. Tabla nueva `task_dependencies(id, task_id, depends_on_task_id, kind, resolved_via_tag)`.
4. Nuevo `condition_kind='task-dependency'` para los waiters auto-generados intra-sprint.
5. Trigger SQLite + writer al `events.jsonl` para publicar `task.finished`. Scheduler tail-ea el archivo.
6. **Detector de ciclos obligatorio pre-ejecucion** (topological sort). Si falla, rechaza el sprint.
7. Detector de ciclos en runtime cada 60 s (segundo loop de defensa).
8. **Work stealing** con WSJF como politica preferida; fallback `priority DESC, created_at ASC` si faltan datos.
9. Limite global `MAX_TOTAL_PENDING=50` y `MAX_FANOUT_PER_TASK=20`.
10. Estado `ready` agregado a `tasks.status`: task activable cuyas dependencias todas cumplieron.
11. Race condition resuelta: **registrar el waiter ANTES de iniciar la task precedente** (commit del registro y luego dispatch del runner).
12. Micro-tick D = 500 ms para waiters proximos a vencer.
13. Metricas Prometheus expuestas; alertas para deadlock, fan-out, slot starvation.

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.4 con seccion 7.10 + work stealing + tres modos | 2026-05-17 |
| Mateo | Migracion SQL: `task_dependencies` + estado `ready` + trigger AFTER UPDATE | 2026-05-22 |
| Mateo | Algoritmo topological sort + detector runtime de ciclos | 2026-05-25 |
| Roman | Spec del DSL para declarar dependencias (tags + ids) | 2026-05-20 |
| Camila | Plantilla de sprint declarativo + UI mockup (Kanban reactivo + vista grafo) | 2026-05-24 |
| Dante | Micro-tick D + metricas Prometheus + alertas | 2026-05-27 |
| Sofia (out) | Tests de race conditions, ciclos y fan-out maximo | 2026-05-30 |
