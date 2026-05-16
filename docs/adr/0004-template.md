# ADR-XXX: [Titulo conciso de la decision]

| | |
|---|---|
| **Status** | Draft / Accepted / Rejected / Superseded |
| **Fecha** | YYYY-MM-DD |
| **Version spec** | vX.Y |
| **Autores** | Nombre(s) |
| **Supersedes** | ADR-XXX (si aplica) |
| **Superseded by** | ADR-XXX (si aplica) |

---

## Contexto

[Describe el problema que motiva esta decision. Incluye:]

- Que situacion o requerimiento genera la necesidad de decidir.
- Que opciones se evaluaron (minimo 2).
- Principios arquitectonicos o requerimientos no funcionales aplicables (del spec seccion 1).
- Restricciones tecnicas, temporales o de negocio.

[Ejemplo: "El orquestador necesita invocar agentes de IA. El BRD proponia SDK anthropic-sdk-typescript. Evaluamos SDK vs CLI headless vs API HTTP directa."]

---

## Decision

[Que se decidio, con justificacion concisa.]

[Ejemplo: "Adoptamos CLI headless via interfaz AgentRunner. La implementacion default es ClaudeCodeRunner sobre `claude -p`. La abstraccion permite swapear el backend sin tocar el motor."]

### Detalles de implementacion (opcional)

[Si hay detalles tecnicos relevantes, incluirlos aqui. Ejemplo: flags del CLI, schema de tablas nuevas, etc.]

---

## Consecuencias

### Positivas

1. [Beneficio 1]
2. [Beneficio 2]
3. [Beneficio 3]

### Negativas

1. [Trade-off 1 + mitigacion si existe]
2. [Trade-off 2 + mitigacion si existe]
3. [Trade-off 3 + mitigacion si existe]

[No ocultar los trade-offs. Los ADRs son para entender el "por que", no para vender la decision.]

---

## Alternativas consideradas

| Alternativa | Por que se rechazo |
|-------------|-------------------|
| Opcion A | Razon concreta |
| Opcion B | Razon concreta |

---

## Referencias

- **Spec seccion X.Y**: [link o descripcion]
- **BRD seccion Z**: [link o descripcion]
- **Acta reunion**: `meetings/YYYY-MM-DD-tema.md`
- **ADR relacionado**: ADR-XXX

---

**Firmado**: [Nombre(s)], YYYY-MM-DD  
**Aprobado por**: Roman (Tech Lead)
