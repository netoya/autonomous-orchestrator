# Guia de Contribucion

Gracias por tu interes en contribuir al **SoftwareFactory Autonomous Orchestrator**. Este documento establece las reglas del juego para mantener cohesion arquitectonica, calidad y trazabilidad.

## Filosofia

### Principio 1.7 — NO NEGOCIABLE

El **principio de separacion observador/observado** (spec seccion 1.7) es la columna vertebral del orquestador. Una task NO controla el futuro del flujo; solo emite estado. Los waiters observan y coordinan la continuidad.

**Esto significa**:

- No creas campos como `onSuccess`, `onFailure`, `nextTask`, `callbackTo`, `then` en la API de tasks.
- No invoques `enqueueTask()` ni equivalentes desde una task en ejecucion (salvo si eres el `flow-coordinator`, que es la excepcion documentada).
- Toda dependencia task→task se modela como waiter con condicion verificable (`dependsOn`, `dependsOnTag`, `waitFor`).

**Si propones un cambio que viola 1.7, sera rechazado**. Si crees que un caso de uso no encaja en este modelo, abre un issue primero para discutirlo con Roman y Camila.

### TypeScript estricto

- `tsconfig.json` tiene `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`.
- No uses `any` salvo que sea absolutamente inevitable (y debes justificarlo en el PR).
- Prefiere tipos estrictos sobre `unknown` cuando sepas la forma del dato.

### Scripts Bash defensivos

Todo script Bash (waiters activos, wrappers, helpers) debe empezar con:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Kill-switch defensivo
[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0

# Trap de errores inesperados
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR
```

**Nunca** interpoles valores de entrada directamente en queries SQL ni en shells. Usa `sqlite3 -cmd ".parameter set"`, heredocs sin expansion, o `printf %q`.

### Sin emojis

Salvo que el usuario los solicite explicitamente, NO uses emojis en:

- Codigo (comentarios, logs, mensajes de error).
- Documentacion (README, guias, referencias).
- Commits.
- Pull requests.

Esta regla existe para mantener consistencia con el estilo del equipo y evitar distracciones visuales en logs y reportes.

## Setup local

1. Clona el repo (o navega al directorio si ya lo tienes):

```bash
cd /home/angel/projects/autonomous-orchestrator/
```

2. Instala dependencias:

```bash
npm install
```

3. Valida dependencias del SO:

```bash
npm run check-deps
# Debe confirmar: bash >= 5.0, jq, sqlite3, curl, GNU coreutils
```

4. Aplica migraciones:

```bash
npm run migrate
```

5. Corre los tests:

```bash
npm test
```

Si todo pasa, estas listo para contribuir.

Para troubleshooting, consulta [RUNBOOK.md](RUNBOOK.md).

## Reglas de Pull Request

### 1. Tests obligatorios

Todo cambio al motor (core, dispatcher, agent-runner, waiters) DEBE incluir tests. Sin tests, el PR no se mergea.

- **Unit tests**: para funciones puras y validaciones de schema.
- **Integration tests**: para ciclos completos de waiter (creado → fulfilled, timeout, invalid).
- **E2E tests**: para flows end-to-end con mocks de agentes (ver `src/test/harness/mockClaude.ts`).

### 2. Sign-off obligatorio

| Tipo de cambio | Requiere sign-off de |
|---|---|
| Cambios al motor (dispatcher, scheduler, agent-runner) | **Roman** |
| Cambios a gates de calidad (validaciones, criterios de aceptacion) | **Sofia** |
| Cambios a contratos de entrada/salida de agentes | **Roman + Camila** |
| Cambios a migraciones SQL | **Mateo + Roman** |
| Cambios a PRAGMAs o configuracion de PM2 | **Dante + Roman** |

El sign-off se da con un comentario `LGTM + sign-off` en el PR.

### 3. Definition of Done

Un PR esta Done cuando cumple **todos** estos criterios:

- [ ] Tests unitarios pasan (`npm test`).
- [ ] Tests E2E pasan (`npm run test:e2e`).
- [ ] Lint pasa (`npm run lint`).
- [ ] Type-check pasa (`npx tsc --noEmit`).
- [ ] Migraciones aplicadas sin error (`npm run migrate`).
- [ ] CHANGELOG.md actualizado en seccion `[Unreleased]`.
- [ ] Documentacion actualizada (si el cambio afecta API publica, CLI o contratos).
- [ ] Codigo revisado por al menos 1 reviewer (ademas del owner del area).
- [ ] Sign-off obtenido (si aplica segun tabla arriba).
- [ ] Branch actualizado con `main` (sin conflictos).

### 4. Estructura de commits

Seguimos **Conventional Commits** con los siguientes tipos:

```
feat: nueva funcionalidad (ej. "feat: agrega waiter goal-seeker experimental")
fix: correccion de bug (ej. "fix: race condition en lease de waiters activos")
docs: cambios solo en documentacion (ej. "docs: actualiza glosario con termino 'lease pattern'")
refactor: cambio que no agrega features ni corrige bugs (ej. "refactor: extrae logica de validacion de schema a modulo separado")
test: agrega o corrige tests (ej. "test: cubre caso de timeout en waiter pasivo")
chore: cambios en build, CI, dependencias (ej. "chore: actualiza dependencies en package.json")
```

**Ejemplos de buenos commits**:

```
feat: implementa waiter activo db-record-ready
fix: dispatcher no libera lease si waiter lanza excepcion
docs: agrega anexo M con goal-seeker.sh
refactor: unifica validacion de WaiterSpec en funcion compartida
test: agrega fixture para flow con dependencias circulares
chore: configura eslint con reglas strict
```

**Ejemplos de malos commits**:

```
WIP (no descriptivo)
fix stuff (demasiado vago)
feat: nueva feature muy cool (no especifica que feature)
```

## Como agregar un waiter Bash

1. Crea el script en `bin/waiters/active/<tu-kind>.sh` (kebab-case).

2. Usa el template del Anexo L del spec como base:

```bash
#!/usr/bin/env bash
set -euo pipefail

[ -f "${STATE_DIR}/.KILLSWITCH" ] && exit 0
trap 'echo "{\"error\":\"unexpected\",\"cmd\":\"${BASH_COMMAND}\"}" >&2; exit 2' ERR

# Parsea WAITER_PARAMS_JSON con jq
# ... tu logica ...

# Si la condicion se cumple:
if condition_met; then
  echo '{"snapshot":{},"observed_at":"'"$(date -u +%FT%TZ)"'"}'
  exit 0
fi

# Si no se cumple aun:
exit 1
```

3. Agrega permisos:

```bash
chmod 750 bin/waiters/active/<tu-kind>.sh
```

4. Escribe tests en `src/test/waiters/<tu-kind>.test.ts`:

```typescript
describe('tu-kind waiter', () => {
  it('cumple cuando la condicion es verdadera', async () => { /* ... */ });
  it('no cumple cuando la condicion es falsa', async () => { /* ... */ });
  it('emite error transitorio ante fallo de red', async () => { /* ... */ });
  it('respeta kill-switch', async () => { /* ... */ });
});
```

5. Documenta el nuevo waiter en `docs/GLOSSARY.md` y en `docs/guides/writing-a-waiter.md`.

6. Abre el PR con titulo: `feat: agrega waiter activo <tu-kind>`.

Checklist antes de mergear (referencia spec 3.3.3):

- [ ] Cumple el contrato Bash (env vars + exit codes + stdout JSON).
- [ ] Respeta kill-switch.
- [ ] Trap de errores configurado.
- [ ] No interpola valores sin sanitizar en queries SQL.
- [ ] Script versionado en git.
- [ ] Permisos 750.
- [ ] Tests cubren al menos: condicion cumplida, no cumplida, error transitorio, kill-switch.

## Como agregar un flow nuevo

1. Crea el archivo en `src/flows/<nombre>.flow.ts`.

2. Define el flow con `defineSprint` y `defineTask`:

```typescript
import { defineSprint, defineTask } from '../core/flow';

export const miFlow = defineSprint({
  name: 'mi-flow',
  tasks: [
    defineTask({
      id: 'task-1',
      agentId: 'softwarefactory_mateo',
      prompt: 'Crea un endpoint REST para listar usuarios',
      dependsOn: [],
      tags: [],
    }),
    defineTask({
      id: 'task-2',
      agentId: 'softwarefactory_sofia',
      prompt: 'Escribe tests para el endpoint',
      dependsOn: ['task-1'],
      tags: ['qa', 'milestone'],
      isMilestone: true,
    }),
  ],
});
```

3. Valida el schema antes de commitear:

```bash
npx orchestrator sprint plan --validate src/flows/mi-flow.flow.ts
```

4. Escribe tests E2E en `src/test/flows/mi-flow.test.ts`:

```typescript
describe('mi-flow', () => {
  it('ejecuta end-to-end con mocks', async () => {
    // ... usa mockClaude ...
  });
});
```

5. Documenta el flow en `docs/flows/` (opcional si es de ejemplo).

6. Abre el PR con titulo: `feat: agrega flow <nombre>`.

**Antipatrones que violan principio 1.7** (NO hacer):

- Llamar a `enqueueTask()` desde una task.
- Declarar callbacks `onSuccess`, `onFailure` en `defineTask`.
- Guardar estado mutable compartido entre tasks (usa artifacts o DB).
- Crear dependencias circulares (el validador las detecta y falla).

## Convenciones de codigo

### Nombres de archivos

- TypeScript: `kebab-case.ts` (ej. `agent-runner.ts`).
- Bash: `kebab-case.sh` (ej. `db-record-ready.sh`).
- SQL: `NNN_descripcion.sql` (ej. `001_add_waiter_horizon.sql`).

### Nombres de funciones y variables

- Funciones: `camelCase` (ej. `enqueueTask`, `fulfillWaiter`).
- Constantes: `UPPER_SNAKE_CASE` (ej. `MAX_WORKERS`, `DB_PATH`).
- Tipos: `PascalCase` (ej. `WaiterSpec`, `AgentRunParams`).

### Indentacion

- TypeScript/JavaScript: 2 espacios.
- Bash: 2 espacios.
- SQL: 2 espacios.

### Lineas maximas

- 120 caracteres (configurable en `.editorconfig`).

### Comentarios

- Prefiere codigo auto-documentado sobre comentarios.
- Si agregas un comentario, que aporte contexto no obvio (el "por que", no el "que").

**Ejemplo bueno**:

```typescript
// Work-stealing: priorizamos por WSJF (business_value / estimated_minutes).
// Evita que tasks largas bloqueen la cola ante multiples cortas de alto valor.
const tasks = await db.query(`
  SELECT * FROM tasks
  WHERE status = 'ready'
  ORDER BY (business_value / NULLIF(estimated_minutes, 0)) DESC
  LIMIT :limit
`, { limit: MAX_WORKERS });
```

**Ejemplo malo**:

```typescript
// Trae las tasks
const tasks = await db.query(`SELECT * FROM tasks`);
```

## Proceso de revision

1. Abres PR contra `main`.
2. CI corre automaticamente (lint, tests, type-check).
3. Asigna reviewers segun la tabla de sign-off (arriba).
4. Reviewers dejan comentarios. Direccionas cada uno.
5. Cuando todos los sign-off estan, mergeas con squash (1 commit por PR).
6. CI post-merge verifica que `main` sigue pasando.

## Politica de versionado

Seguimos [Semantic Versioning](https://semver.org/):

- `MAJOR.MINOR.PATCH`
- `MAJOR`: cambios incompatibles en la API publica.
- `MINOR`: nuevas funcionalidades compatibles hacia atras.
- `PATCH`: correcciones de bugs compatibles.

Mientras estamos en `0.x.y`, la API puede cambiar sin aviso (MVP). Desde `1.0.0` en adelante, nos comprometemos a no romper retrocompatibilidad sin incrementar `MAJOR`.

## Preguntas frecuentes

**P: Necesito agregar un campo nuevo a `WaiterSpec`. Como lo hago sin romper flows existentes?**

R: Hazlo opcional con default. Ej:

```typescript
export interface WaiterSpec {
  // ... campos existentes ...
  nuevoField?: string; // opcional, default undefined
}
```

Luego agrega migracion SQL si persistes ese campo. Documenta el cambio en CHANGELOG.md bajo `[Unreleased]`.

**P: Mi PR no pasa el lint. Como lo arreglo?**

R: Corre `npm run lint:fix` (si usamos eslint con autofix). Si hay errores que no se arreglan solos, direccionalos manualmente. El CI no te dejara mergear si el lint falla.

**P: Necesito agregar una dependencia externa. Como la justifico?**

R: Abre un issue primero explicando por que es necesaria. Roman y Dante evaluaran:

- Tamano del bundle.
- Mantenimiento activo del paquete.
- Alternativas en stdlib o con dependencias que ya tenemos.

Si se aprueba, actualiza `package.json`, corre `npm install`, commitea el `package-lock.json`, y documenta en el PR por que la agregaste.

**P: Encontre un bug critico en produccion. Puedo saltarme el proceso de PR?**

R: No. Pero puedes abrir un **hotfix PR** con prioridad alta:

1. Crea branch `hotfix/<descripcion>` desde `main`.
2. Commitea el fix minimo (solo lo necesario para resolver el bug).
3. Agrega test que reproduzca el bug (antes del fix deberia fallar).
4. Pide review urgente a Roman + Sofia.
5. Mergea con fast-track (sin esperar CI completo si es critico).
6. Monitora post-merge.

Luego documenta el incidente en `docs/postmortems/<fecha>-<titulo>.md` (si aplica).

## Recursos utiles

- [Spec completa (v0.8.1)](docs/spec.md)
- [Glosario](docs/GLOSSARY.md)
- [Guia: escribir un flow](docs/guides/writing-a-flow.md)
- [Guia: escribir un waiter](docs/guides/writing-a-waiter.md)
- [Referencia CLI](docs/reference/cli.md)
- [RUNBOOK operativo](RUNBOOK.md)

Gracias por contribuir. Si tienes dudas, abre un issue o pregunta en el canal del equipo.
