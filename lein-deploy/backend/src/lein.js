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
  // timeout corto + 1 reintento: si Claude se cuelga, el alumno ve "Reintentar"
  // en segundos, en vez de quedarse esperando minutos.
  if (!_client) _client = new Anthropic({ timeout: 15000, maxRetries: 1 });
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
// Decisión del dueño (basada en investigación de feedback correctivo): corrección
// EXPLÍCITA en voz, pero UNA sola por turno, con fórmula variada, celebrando los
// aciertos y pidiendo a veces que lo repita. Esta regla MANDA sobre las secciones
// "CORRECTION" de cada cerebro.
const CORRECTION_INSTRUCTION =
`GENTLE EXPLICIT CORRECTION (this rule overrides any other correction rule above):
- When the student makes a meaningful English mistake, correct it explicitly using the separate fields:
  - "correction": ONE short, friendly spoken line with the better version, e.g. "Small fix: we say 'I went', not 'I goed'." The app reads it out loud FIRST, then your "say".
  - "fix_said": the student's wrong words, copied short (just the wrong part or short phrase, max ~8 words).
  - "fix_better": the natural correct version of that same part (max ~8 words).
- ONE fix per turn, the most useful one for real communication (word order, wrong verb/tense, wrong word, a "Spanish-style" phrase like "I have 25 years"). IGNORE minor details: small article slips, missing "s", punctuation, capitalization, accent, or anything that doesn't hurt understanding. Never list several, and never join two fixes with "and" — if there are two mistakes, pick only the more useful one.
- VARY the opening of "correction" every time. Rotate naturally between forms like: "Quick tip: ...", "Small fix: ...", "Just so you know, we say ...", "Almost! We say ...", "Here's a more natural way: ...". Never use the same opener twice in a row.
- No grammar lectures, no grammar terms, no arrows or symbols. Natural spoken words only, in ENGLISH (no Spanish).
- REPEAT PRACTICE: about one correction in three, invite the student to say the corrected sentence out loud. Set "repeat_target" to that short, correct sentence (max ~10 words, e.g. "I went to the park.") and make "say" a short, clear invitation that INCLUDES it, e.g. "Your turn! Say it with me: 'I went to the park.'" In that turn do NOT ask another question. In every other turn set "repeat_target" to null.
- When the student repeats it (right or close enough): set "correction" to null, react in 2-4 words ("Perfect!", "Yes, that's it!"), then CONTINUE the conversation exactly where it was — one new natural follow-up question on the same topic, building on what they originally told you. Never go back, never re-ask an earlier question, never ask them to repeat the same thing twice. If the repeat is still not perfect, do NOT correct it again — praise the effort and keep chatting.
- CELEBRATE: if the student now correctly uses something you corrected earlier (or repeats it right after you asked), set "correction" to null and start "say" with a short, specific celebration ("Yes! 'I went' — perfect!").
- Correct ONLY the student's MOST RECENT message. NEVER repeat or recycle an earlier correction. If there is no meaningful new mistake, set "correction", "fix_said" and "fix_better" to null.
- Write "say" so it flows naturally AFTER the correction — do NOT repeat the correction inside "say".
- CRITICAL: after a correction, "say" must ALWAYS react briefly to what they told you and END WITH ONE natural follow-up question, so the student knows it is their turn — EXCEPT in a repeat-practice turn, where "say" ends with the invitation to repeat. Never leave "say" empty.`;

// Anti-deriva: mantener a Lein consistente turno a turno (evita que "se vuelva
// loco" tras varios turnos: re-saludar, repetir preguntas, cambiar de tema/nivel).
const CONSISTENCY =
`STAY ON TRACK ACROSS TURNS:
- Read the whole conversation so far before replying, and build directly on what the student just said. Keep ONE clear thread.
- Do NOT greet again, and do NOT ask the student's name again once you know it.
- Do NOT repeat a question you already asked, and do NOT suddenly change the topic or the difficulty level. Keep the same warm persona and the same level the entire session.
- If the student gives a short or empty answer, gently help them expand on the SAME topic — don't jump to a new one.`;

// Lein es un AMIGO para conversar y corregir, NO un profesor que explica.
// (Los alumnos se confundían pidiéndole explicaciones; esa no es su función.)
const FRIEND_ROLE =
`YOUR ROLE — A CONVERSATION FRIEND, NOT A TEACHER:
- You are the student's warm, friendly native-speaker buddy. Your job is to CHAT with them and gently CORRECT their English — NOT to give lessons, grammar rules, definitions, or translations.
- If the student asks you to EXPLAIN something (grammar, why something is right/wrong, what a word means, "explain", "teach me", "translate this"), do NOT give a lesson. In ONE short, warm line, lovingly remind them you're their friend for PRACTICE, then keep the conversation going. Example: "Aw, I'm your speaking buddy — I'm here to chat and help you sound natural, not to explain rules! Let's keep practicing: <one simple question>." You may show the correct way to SAY something (that's correcting), but never lecture on the "why".
- Never make them feel bad for asking. Always warm, always steer back to talking.`;

// Regla global de BREVEDAD: Lein habla poco; el estudiante habla más.
const BREVITY =
`KEEP IT SHORT — this is SPEAKING practice, so the STUDENT should do most of the talking:
- Your turns are brief: one short reaction, then ONE simple question. Lower levels = shorter (1-2 sentences max).
- Never say several things at once or pile up multiple ideas/options. One clear thread per turn.
- No long preambles or over-explaining. Keep it light and let the student speak.`;

// Cuándo ofrecer opciones de respuesta (campo "suggestions"). Regla para TODOS
// los niveles: las opciones son un salvavidas, NO el comportamiento normal.
const SUGGESTIONS_RULE =
`WHEN TO OFFER ANSWER OPTIONS (the "suggestions" field):
- By DEFAULT keep "suggestions" as an empty array []. This is SPEAKING practice: let the student answer in their OWN words.
- ONLY fill "suggestions" (2-3 very short example answers) when the student clearly needs a lifeline: they stayed silent, said "I don't know", answered in Spanish, seemed confused, or got stuck. As soon as they are talking on their own again, go back to [].
- Options are a rescue, never a default. Do NOT add them just to be helpful.`;

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
    fix_said: { anyOf: [{ type: "string" }, { type: "null" }] },
    fix_better: { anyOf: [{ type: "string" }, { type: "null" }] },
    repeat_target: { anyOf: [{ type: "string" }, { type: "null" }] },
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
  // studentName y correction son obligatorios (pueden ser null) para que el modelo
  // SIEMPRE los considere: así captura el nombre en cuanto lo oye y no lo omite.
  required: ["say", "hint", "suggestions", "studentName", "correction", "fix_said", "fix_better", "repeat_target"],
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
// - returning: el alumno tocó "Seguir practicando" (ya vino antes). NUNCA se le
//   pide el nombre otra vez, aunque no lo tengamos guardado.
function openingMessage(level, knownName, returning = false) {
  const low = level === "A1" || level === "A1+";
  if (!knownName && returning) {
    return low
      ? "[The session is starting. The student is coming back to practice. Warmly welcome them back in very simple English and ask one easy, concrete question (for example about their day). Do NOT ask their name.]"
      : "[The session is starting. The student is coming back to practice. Warmly welcome them back at their level and ask one easy, concrete question about their day or week. Do NOT ask their name. One natural turn ending in a question.]";
  }
  if (knownName) {
    return low
      ? `[The session is starting. The student's name is ${knownName}. Warmly welcome ${knownName} back by name in very simple English, then ask one easy question to get going. Do NOT ask their name.]`
      : `[The session is starting. The student's name is ${knownName}. Warmly welcome ${knownName} back by name at their level, then invite them to choose what to practice today or share what's new. Do NOT ask their name. One natural turn ending in a question.]`;
  }
  return low
    ? "[The session is starting now. Greet the student warmly and very simply in English, then ask their name. Just one short, easy question.]"
    : "[The session is starting now. Greet the student warmly in English at their level, ask their name, and invite them to tell you a little about themselves so you can get to know them. Keep it to one natural turn ending in a question.]";
}

// ¿Las palabras que Lein corrige están en el mensaje ACTUAL del alumno?
// Comparación flexible: al menos ~60% de las palabras de "fix_said".
function correctionMatches(fixSaid, text) {
  const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const said = words(fixSaid);
  if (!said.length) return true; // sin detalle: no podemos comprobar, se deja pasar
  const current = new Set(words(text));
  const hits = said.filter((w) => current.has(w)).length;
  return hits / said.length >= 0.6;
}

// Frases para invitar a repetir la forma correcta (varían para no sonar robot).
const REPEAT_INVITES = [
  "Your turn! Say it with me:",
  "Let's practice it. Say it out loud:",
  "Try it! Say:",
  "Now you say it:",
];

// Quita de "say" las oraciones que repiten la corrección (ya se dice antes).
function dropRepeatedCorrection(say, correction) {
  const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const corr = new Set(words(correction));
  const sentences = say.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => {
    const w = words(s);
    if (w.length < 4) return true;
    const overlap = w.filter((x) => corr.has(x)).length / w.length;
    return overlap < 0.6;
  });
  return kept.join(" ").trim() || say;
}

// Tema elegido por el alumno ("🎯 Tengo un tema"). Puede venir en español.
function topicBlock(topic) {
  return `TODAY'S TOPIC: The student chose to talk about: "${topic}". They may have written it in Spanish — understand it, but always speak English at their level. Keep the whole conversation about this topic with practical, everyday questions. Stay on it unless the student clearly changes it.`;
}
function topicOpening(level, knownName, topic) {
  const low = level === "A1" || level === "A1+";
  const who = knownName ? ` The student's name is ${knownName}; greet them by name.` : "";
  return `[The session is starting.${who} The student wants to talk about: "${topic}". Greet them warmly in one short line${low ? " in very simple English" : ""}, react with interest to the topic, and ask ONE easy, concrete first question about it. Do NOT ask their name.]`;
}

// Mensaje (oculto) para el repaso final: Lein recapitula errores y pide repetir.
function recapMessage(errors) {
  const list = (errors && errors.length)
    ? errors.map((e, i) => `${i + 1}) ${e}`).join("  ")
    : "(no specific mistakes were noted today)";
  return `[Only about 1 minute of practice left. Warmly wrap up: start with something like "Let's stop here and practice a few things you got wrong today." Then briefly say the main mistakes with their correct versions and ask the student to repeat the corrected sentence(s) out loud. Be warm, quick and encouraging — keep it short since time is almost up. Today's corrections: ${list}. End by inviting them to say the corrected sentence(s) back.]`;
}

export async function leinTurn({ text, history = [], level = "A1", mission = null, placement = false, opening = false, recap = false, errors = [], studentName = "", topic = "", returning = false }) {
  topic = String(topic || "").replace(/[\[\]"]/g, " ").trim().slice(0, 160);
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

  // 2a-track. Consistencia turno a turno (no en el placement, que tiene su guion).
  if (!placement) {
    system = system + "\n\n" + CONSISTENCY;
  }

  // 2a-friend. Lein es amigo para conversar/corregir, NO profesor que explica.
  if (!placement) {
    system = system + "\n\n" + FRIEND_ROLE;
  }

  // 2a-sugg. Las opciones son un SALVAVIDAS (solo si el alumno se traba), no salen
  // por defecto. Decisión del dueño: empujar a que hable con sus propias palabras.
  if (!placement) {
    system = system + "\n\n" + SUGGESTIONS_RULE;
  }

  // 2a-bis. Corrección suave y explícita (no en el placement).
  if (!placement) {
    system = system + "\n\n" + CORRECTION_INSTRUCTION;
  }

  // 2b. De A2 en adelante, Lein lleva la conversación de forma proactiva.
  if (!placement && LEAD_LEVELS.includes(level)) {
    system = system + "\n\n" + LEAD_INSTRUCTION;
  }

  // 2b-bis. Tema elegido por el alumno.
  if (!placement && topic) {
    system = system + "\n\n" + topicBlock(topic);
  }

  // 2c. (Las imágenes de escena se desactivaron; preferimos el avatar animado.)
  //     Dejamos el campo "scene" en el esquema por compatibilidad, pero ya no
  //     se lo pedimos al modelo (ahorra tokens).

  // 3. Construir los mensajes: historial previo + el turno nuevo del estudiante.
  //    En la apertura (charla normal) usamos un saludo estándar por nivel.
  const userText = recap ? recapMessage(errors)
                 : (opening && !placement && topic) ? topicOpening(level, studentName, topic)
                 : (opening && !placement) ? openingMessage(level, studentName, returning)
                 : text;
  const messages = [
    // Si en un turno anterior Lein corrigió algo, va como nota entre corchetes:
    // así sabe que ya lo corrigió, sin "copiar" ese formato en su respuesta.
    ...history.map((m) => ({
      role: m.role,
      content: m.role === "assistant" && m.correction ? `[Already corrected: ${m.correction}] ${m.content}` : m.content,
    })),
    { role: "user", content: userText },
  ];

  // 4. Llamar a Claude.
  const t0 = Date.now();
  const response = await getClient().messages.create({
    model: getModel(),
    max_tokens: 700, // margen para que el JSON NUNCA se corte (texto+corrección+ideas); Lein igual habla corto por BREVITY
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

  console.log(`[timing] claude=${Date.now() - t0}ms (${getModel()})`);

  // 5. Con structured outputs, el primer bloque de texto es JSON válido.
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("Claude no devolvió texto.");
  }
  const data = JSON.parse(textBlock.text);

  // Blindaje: el campo "placement" SOLO tiene sentido en el test de ubicación.
  // Si el modelo lo mete por error en una charla normal, lo anulamos para que el
  // frontend nunca cambie el nivel a media conversación.
  if (!placement) data.placement = null;

  // Blindaje: la corrección debe ser de lo que el alumno dijo EN ESTE turno. Si
  // las palabras corregidas ("fix_said") no aparecen en su mensaje actual, es un
  // error viejo reciclado: lo descartamos antes de que se lea en voz alta.
  if (data.correction && !opening && !recap && !placement && !correctionMatches(data.fix_said, text)) {
    console.log(`[correction] descartada (no está en este turno): "${data.fix_said}"`);
    data.correction = null; data.fix_said = null; data.fix_better = null;
  }

  // "say" limpio: sin notas entre corchetes copiadas del historial y sin repetir
  // la corrección (si no, Lein la diría DOS veces en voz alta).
  data.say = String(data.say || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  if (data.correction) data.say = dropRepeatedCorrection(data.say, data.correction);

  // "Repite la frase": solo en charla normal y solo junto a una corrección. Si
  // la hay, "say" ES la invitación a repetir (antes a veces marcaba la frase
  // pero preguntaba otra cosa, y el alumno no sabía qué hacer).
  if (placement || recap || opening || !data.correction) data.repeat_target = null;
  if (data.repeat_target) {
    const target = String(data.repeat_target).replace(/["“”]/g, "").trim();
    data.repeat_target = target;
    data.say = REPEAT_INVITES[Math.floor(Math.random() * REPEAT_INVITES.length)] + ` "${target}"`;
  }

  // Blindaje: Lein nunca se queda callado después de corregir (antes podía
  // dejar "say" vacío y el alumno no sabía que era su turno).
  if (!placement && !recap && !data.say) {
    data.say = "Tell me more! What else happened?";
  }

  // Adjuntamos uso de tokens (útil para vigilar costo en desarrollo).
  data._usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  };

  return data;
}
