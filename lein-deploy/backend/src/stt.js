// stt.js
// Voz del estudiante -> texto (Speech To Text) con la API de OpenAI.
// Usa la MISMA llave que la voz (OPENAI_API_KEY). Modelo configurable.

export function hasSTT() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Transcribe un audio (Buffer) y devuelve el texto.
// opts.anyLanguage: true cuando el alumno dice su TEMA (puede hablar en español).
export async function transcribe(buffer, mimetype, opts = {}) {
  // gpt-4o-transcribe: más preciso con acentos de hispanohablantes que el "mini"
  // (cuesta ~$0.006/min vs $0.003/min; ~1 centavo más por sesión de 10 min).
  const model = process.env.STT_MODEL || "gpt-4o-transcribe";
  const mt = mimetype || "audio/webm";
  const ext = mt.includes("mp4") || mt.includes("aac") ? "mp4"
            : mt.includes("mpeg") || mt.includes("mp3") ? "mp3"
            : mt.includes("ogg") ? "ogg"
            : mt.includes("wav") ? "wav"
            : "webm";

  // Node 18+ trae FormData/Blob/fetch globales.
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mt }), "audio." + ext);
  form.append("model", model);

  // PRECISIÓN: como es práctica de inglés, le decimos al "oído" que ESPERE inglés
  // (reduce errores tipo "does"->"dance", "Yes"->"Just"). Configurable por env:
  //   STT_LANGUAGE="" para que vuelva a autodetectar (si algún alumno mezcla español).
  const lang = opts.anyLanguage ? "" : (process.env.STT_LANGUAGE ?? "en");
  if (lang) form.append("language", lang);

  // Contexto: la ÚLTIMA pregunta de Lein (lo que el alumno está respondiendo).
  // Antes el prompt traía frases de ejemplo ("I cook at home"...) que podían
  // "colarse" en la transcripción. Y pedimos copiar los errores tal cual: si el
  // oído los corrige, Lein no puede corregirlos.
  const ctx = String(opts.context || "").slice(0, 300);
  const prompt = opts.anyLanguage ? "" : (process.env.STT_PROMPT ??
    ("An English learner (native Spanish speaker) is answering a tutor. Transcribe exactly what they say, keeping their grammar mistakes as spoken; do not correct or complete their words." +
     (ctx ? ` The tutor just said: "${ctx}"` : "")));
  if (prompt) form.append("prompt", prompt);

  // temperature 0 = lo más literal/estable posible (menos invención).
  form.append("temperature", "0");

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  console.log(`[timing] stt=${Date.now() - t0}ms`);

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI STT ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.text || "").trim();
}
