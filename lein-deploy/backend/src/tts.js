// tts.js
// Voz de Lein desde el servidor (premium, natural, IGUAL en todos los equipos:
// iPhone, Android, PC). Usa la API de audio de OpenAI.
//
// Si NO hay OPENAI_API_KEY, hasTTS() devuelve false y el frontend usa la voz del
// navegador como respaldo automático. La llave vive solo aquí (backend).

// Velocidad por nivel para el motor "tts-1" (más lenta abajo).
const LEVEL_SPEED = {
  A1: 0.72, "A1+": 0.80, A2: 0.88, B1: 0.95, B2: 1.0, C1: 1.0, PLACEMENT: 0.9,
};
// Ritmo (en lenguaje natural) por nivel para el motor "gpt-4o-mini-tts".
const LEVEL_PACE = {
  A1: "slowly and very clearly", "A1+": "slowly and clearly", A2: "clearly",
  B1: "at a natural conversational pace", B2: "at a natural conversational pace",
  C1: "at a natural, lively pace", PLACEMENT: "clearly",
};

export function hasTTS() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Genera el audio (mp3) de un texto. Devuelve un Buffer.
// voiceOverride: permite que el frontend pida una voz concreta (selector).
export async function synthesize(text, level = "A1", voiceOverride) {
  const voice = voiceOverride || process.env.TTS_VOICE || "coral";
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts"; // el más natural

  const body = { model, voice, input: text, response_format: "mp3" };
  if (model.startsWith("gpt-")) {
    // Motor nuevo: el tono/ritmo se controla con "instructions" (no con speed).
    const pace = LEVEL_PACE[level] || "at a natural conversational pace";
    body.instructions =
      `You are Lein, a warm, friendly, encouraging English tutor speaking to a student. ` +
      `Use a natural, human, warm American accent — relaxed and conversational, never robotic or monotone. ` +
      `Speak ${pace}. Sound kind, upbeat, and motivating.`;
  } else {
    // Motor clásico tts-1/tts-1-hd: el ritmo se controla con "speed".
    body.speed = LEVEL_SPEED[level] || 0.95;
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
