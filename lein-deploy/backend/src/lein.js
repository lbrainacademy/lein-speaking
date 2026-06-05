// lein.js
// El "motor" de Lein: arma el system prompt (cerebro del nivel, + misión si la hay),
// llama a Claude con SALIDA ESTRUCTURADA, y devuelve el JSON de Lein.
//
// Mismo formato de salida para todos los niveles (Sección 2 del doc): así el
// motor nunca cambia entre niveles — solo se carga otro cerebro.

import Anthropic from "@anthropic-ai/sdk";
import { getBrain, PLACEMENT_BRAIN, missionBlock } from "./brains.js";

// Leemos el modelo cuando se usa (no al cargar el módulo), para que .env ya
// esté cargado por dotenv. Default: Sonnet (costo-eficiente).
export function getModel() {
  return process.env.MODEL || "claude-sonnet-4-6";
}

// Cliente perezoso: se crea en el primer uso, ya con la llave del .env cargada.
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// Palabras-clave de ESCENA para mostrar una imagen inmersiva según el tema.
// Lista cerrada (enum) para que el mapeo a imagen sea siempre confiable.
export const SCENE_KEYS = [
  "intro", "family", "food", "restaurant", "daily_routine", "weather",
  "free_time", "city", "travel", "airport", "work", "job_interview",
  "shopping", "doctor", "school", "weekend", "hobbies", "general",
];

// Regla para TODOS los niveles: hablar con contracciones naturales (inglés real,
// no de libro). Es la filosofía LBrain.
const NATURAL_SPEECH =
`NATURAL AMERICAN SPEECH:
- Always use the natural contractions Americans really use: "what's", "I'm", "you're", "let's", "don't", "it's", "we'll", "that's", "I'd", etc. Never the stiff textbook full forms ("what is", "I am", "do not") unless you are deliberately emphasizing a single word.`;

// Corrección suave y explícita (campo "correction" aparte), para TODOS los niveles
// de charla (no en el placement). Hace que el estudiante NOTE su error.
const CORRECTION_INSTRUCTION =
`GENTLE CORRECTION (use the separate "correction" field):
- When the student makes a meaningful English mistake, set "correction" to a SHORT, friendly note showing the better version, phrased as a natural sentence Lein could SAY OUT LOUD, e.g. "You said 'I goed', but we say 'I went'." or "Instead of 'I have 25 years', say 'I'm 25 years old'."
- Do NOT use arrows or symbols (no "->"). Write it as natural spoken words.
- Pick ONLY the single most useful fix per turn — never list several. Never give a grammar lecture or use grammar terms; just show the natural correct form.
- For beginners (A1/A1+), keep it extra gentle and simple. Write the correction in ENGLISH ONLY — do NOT add Spanish translations (the separate "hint" field already provides Spanish help when needed).
- If there is no notable mistake, set "correction" to null.
- Keep your spoken "say" warm and flowing; the app will read the correction out loud right after it.`;

// Regla global de BREVEDAD: Lein habla poco; el estudiante habla más.
const BREVITY =
`KEEP IT SHORT — this is SPEAKING practice, so the STUDENT should do most of the talking:
- Your turns are brief: one short reaction, then ONE simple question. Lower levels = shorter (1-2 sentences max).
- Never say several things at once or pile up multiple ideas/options. One clear thread per turn.
- No long preambles or over-explaining. Keep it light and let the student speak.`;

// Niveles donde Lein debe LLEVAR la conversación de forma proactiva.
const LEAD_LEVELS = ["A2", "B1", "B2", "C1"];

// Se añade a esos niveles: Lein guía SOLO si hace falta, y de forma BREVE.
const LEAD_INSTRUCTION =
`LEADING THE CONVERSATION (briefly):
- Keep it flowing, but stay short. Normally just react in one short sentence and ask ONE follow-up question.
- ONLY if the student is clearly stuck or says "I don't know", give a quick nudge in ONE short line — e.g. offer two simple options or ask a fun everyday question. Do NOT list many ideas or over-explain.`;

// Instrucción que se AÑADE al cerebro para que Lein etiquete la escena de cada
// turno. No cambia cómo habla; solo agrega un campo "scene" al JSON.
const SCENE_INSTRUCTION =
  `\n\nVISUAL SCENE: In every JSON response, also set "scene" to the ONE keyword ` +
  `from this list that best matches the topic of your current question, so the app ` +
  `can show an immersive background image: ${SCENE_KEYS.join(", ")}. ` +
  `Use "general" if nothing fits. This does NOT change how you talk.`;

// Esquema de salida de Lein. Le IMPONEMOS la forma a Claude (structured outputs),
// en lugar de pedir JSON y rezar. "hint" puede ser texto o null.
// "placement", "mission_complete" y "scene" son opcionales.
const LEIN_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string" },
    hint: { anyOf: [{ type: "string" }, { type: "null" }] },
    correction: { anyOf: [{ type: "string" }, { type: "null" }] },
    studentName: { anyOf: [{ type: "string" }, { type: "null" }] },
    suggestions: { type: "array", items: { type: "string" } },
    scene: { anyOf: [{ type: "string", enum: SCENE_KEYS }, { type: "null" }] },
    placement: {
      anyOf: [
        { type: "string", enum: ["A1", "A1+", "A2", "B1", "B2", "C1"] },
        { type: "null" },
      ],
    },
    mission_complete: { type: "boolean" },
  },
  required: ["say", "hint", "suggestions"],
  additionalProperties: false,
};

/**
 * Genera un turno de Lein.
 *
 * @param {Object} params
 * @param {string} params.text     - Lo que dijo el estudiante (texto).
 * @param {Array}  params.history  - Historial [{role:'user'|'assistant', content:string}].
 * @param {string} params.level    - Nivel CEFR ("A1".."C1"). Default "A1".
 * @param {Object} [params.mission]- Misión opcional {scene, role, goal}.
 * @param {boolean}[params.placement] - Si true, usa el cerebro del test de ubicación.
 * @returns {Promise<{say:string, hint:string|null, suggestions:string[], placement?:string|null, mission_complete?:boolean, _usage:object}>}
 */
// Captura del nombre: Lein lo guarda en el campo studentName en cuanto lo sabe.
const NAME_CAPTURE =
`STUDENT NAME: As soon as you know the student's first name, set the "studentName" field to just that first name. If you don't know it yet, set "studentName" to null.`;

// Mensaje (oculto) que abre la sesión, según el nivel y si ya sabemos el nombre.
// - Si conocemos el nombre: saludo de "bienvenida de nuevo", SIN volver a preguntarlo.
// - A1 / A1+: saludo simple. A2 en adelante: + invitar a contar/practicar.
function openingMessage(level, knownName) {
  const low = level === "A1" || level === "A1+";
  if (knownName) {
    return low
      ? `[The session is starting. The student's name is ${knownName}. Warmly welcome ${knownName} back by name in very simple English, then ask one easy question to get going. Do NOT ask their name.]`
      : `[The session is starting. The student's name is ${knownName}. Warmly welcome ${knownName} back by name at their level, then invite them to choose what to practice today or share what's new. Do NOT ask their name. One natural turn ending in a question.]`;
  }
  return low
    ? "[The session is starting now. Greet the student warmly and very simply in English, then ask their name. Just one short, easy question.]"
    : "[The session is starting now. Greet the student warmly in English at their level, ask their name, and invite them to tell you a little about themselves so you can get to know them. Keep it to one natural turn ending in a question.]";
}

// Mensaje (oculto) para el repaso final: Lein recapitula errores y pide repetir.
function recapMessage(errors) {
  const list = (errors && errors.length)
    ? errors.map((e, i) => `${i + 1}) ${e}`).join("  ")
    : "(no specific mistakes were noted today)";
  return `[The practice session is almost over — about 2 minutes left. Time for a short, warm wrap-up at the student's level. Briefly recap the main mistakes from today and their correct versions, then ask the student to say the corrected sentence(s) back to you out loud to practice. Be warm, encouraging and concise. Today's corrections: ${list}. End by inviting them to repeat the corrected sentence(s).]`;
}

export async function leinTurn({ text, history = [], level = "A1", mission = null, placement = false, opening = false, recap = false, errors = [], studentName = "" }) {
  // 1. Elegir el cerebro base.
  let system = placement ? PLACEMENT_BRAIN : getBrain(level);

  // 2. Si hay misión, se antepone al cerebro del nivel (Sección 4.8).
  if (mission && !placement) {
    system = system + "\n\n" + missionBlock(mission);
  }

  // 2a. Inglés americano real (contracciones) en todos los niveles.
  system = system + "\n\n" + NATURAL_SPEECH;

  // 2a-name. Capturar el nombre del estudiante (en todos los modos).
  system = system + "\n\n" + NAME_CAPTURE;

  // 2a-brief. Lein habla POCO; el estudiante debe hablar más.
  system = system + "\n\n" + BREVITY;

  // 2a-bis. Corrección suave y explícita (no en el placement).
  if (!placement) {
    system = system + "\n\n" + CORRECTION_INSTRUCTION;
  }

  // 2b. De A2 en adelante, Lein lleva la conversación de forma proactiva.
  if (!placement && LEAD_LEVELS.includes(level)) {
    system = system + "\n\n" + LEAD_INSTRUCTION;
  }

  // 2c. (Las imágenes de escena se desactivaron; preferimos el avatar animado.)
  //     Dejamos el campo "scene" en el esquema por compatibilidad, pero ya no
  //     se lo pedimos al modelo (ahorra tokens).

  // 3. Construir los mensajes: historial previo + el turno nuevo del estudiante.
  //    En la apertura (charla normal) usamos un saludo estándar por nivel.
  const userText = recap ? recapMessage(errors)
                 : (opening && !placement) ? openingMessage(level, studentName)
                 : text;
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  // 4. Llamar a Claude.
  const response = await getClient().messages.create({
    model: getModel(),
    max_tokens: 400, // las respuestas de Lein son cortas (es voz)
    thinking: { type: "disabled" }, // mínima latencia
    system: [
      {
        type: "text",
        text: system,
        // Cacheamos el cerebro para ahorrar cuando crezca (misiones / niveles altos).
        // En A1 el prompt es corto y puede que aún no llegue al mínimo cacheable;
        // no pasa nada: simplemente no cachea todavía.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
    // Salida estructurada: Claude DEBE devolver JSON que cumpla el esquema.
    output_config: { format: { type: "json_schema", schema: LEIN_SCHEMA } },
  });

  // 5. Con structured outputs, el primer bloque de texto es JSON válido.
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("Claude no devolvió texto.");
  }
  const data = JSON.parse(textBlock.text);

  // Adjuntamos uso de tokens (útil para vigilar costo en desarrollo).
  data._usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  };

  return data;
}
