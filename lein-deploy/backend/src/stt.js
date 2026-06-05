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
  // No forzamos idioma: el alumno habla inglés, pero un principiante puede
  // mezclar español; dejamos que el modelo lo detecte.

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
