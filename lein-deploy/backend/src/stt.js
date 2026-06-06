// stt.js
// Voz del estudiante -> texto (Speech To Text) con la API de OpenAI.
// Usa la MISMA llave que la voz (OPENAI_API_KEY). Modelo configurable.

export function hasSTT() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Transcribe un audio (Buffer) y devuelve el texto.
export async function transcribe(buffer, mimetype) {
  const model = process.env.STT_MODEL || "gpt-4o-mini-transcribe"; // bueno y barato
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
  const lang = process.env.STT_LANGUAGE ?? "en";
  if (lang) form.append("language", lang);

  // Un "prompt" de contexto ayuda al modelo a interpretar mejor frases cortas y de
  // estudiantes. No es lo que se transcribe; solo orienta.
  const prompt = process.env.STT_PROMPT ??
    "Casual spoken English practice between a friendly tutor and an English learner. Expect short, simple answers like yes, no, I do, I don't, I cook at home.";
  if (prompt) form.append("prompt", prompt);

  // temperature 0 = lo más literal/estable posible (menos invención).
  form.append("temperature", "0");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI STT ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.text || "").trim();
}
