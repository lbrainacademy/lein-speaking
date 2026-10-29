// tts.js
// Voz de Lein desde el servidor (premium, natural, IGUAL en todos los equipos:
// iPhone, Android, PC). Usa la API de audio de OpenAI.
//
// Si NO hay OPENAI_API_KEY, hasTTS() devuelve false y el frontend usa la voz del
// navegador como respaldo automático. La llave vive solo aquí (backend).
//
// VOZ EN STREAMING: startJob() arranca la generación en el servidor y va guardando
// los pedacitos de mp3 a medida que llegan. El navegador los pide con
// GET /api/tts/stream/:id y empieza a SONAR con el primer pedazo, sin esperar el
// mp3 completo. El audio queda guardado unos minutos (botón Repetir = gratis).

import { randomUUID } from "node:crypto";

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

// Limpia el texto antes de hablarlo: "Lein" se pronuncia "Lane", sin emojis ni
// paréntesis (para que no diga "smiley face"). Igual que hacía el frontend.
export function cleanForSpeech(t) {
  return (t || "")
    .replace(/\bLein\b/gi, "Lane")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Arma el pedido a OpenAI y devuelve la respuesta HTTP (cuerpo sin leer).
async function requestSpeech(text, level = "A1", voiceOverride) {
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
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res;
}

// Genera el audio (mp3) COMPLETO de un texto. Devuelve un Buffer.
// voiceOverride: permite que el frontend pida una voz concreta (selector).
export async function synthesize(text, level = "A1", voiceOverride) {
  const res = await requestSpeech(text, level, voiceOverride);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Trabajos de voz en streaming ----------
const JOB_TTL_MS = 10 * 60 * 1000; // el audio queda guardado 10 min (para Repetir)
const MAX_JOBS = 500;
const jobs = new Map(); // id -> { chunks, size, done, error, waiters, created }

function cleanupJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.created > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

function notify(job) {
  const w = job.waiters;
  job.waiters = [];
  w.forEach((fn) => { try { fn(); } catch {} });
}

/** Arranca la generación de voz YA (sin esperar a que el navegador la pida). Devuelve el id. */
export function startJob(text, level = "A1", voice) {
  cleanupJobs();
  const id = randomUUID();
  const job = { chunks: [], size: 0, done: false, error: null, waiters: [], created: Date.now() };
  jobs.set(id, job);
  const t0 = Date.now();
  (async () => {
    try {
      const res = await requestSpeech(text, level, voice);
      let first = true;
      for await (const chunk of res.body) {
        if (first) { first = false; console.log(`[timing] tts primer-audio=${Date.now() - t0}ms`); }
        const buf = Buffer.from(chunk);
        job.chunks.push(buf);
        job.size += buf.length;
        notify(job);
      }
      console.log(`[timing] tts completo=${Date.now() - t0}ms (${job.size} bytes)`);
    } catch (err) {
      job.error = err;
      console.error("[tts job] Error:", err?.message || err);
    } finally {
      job.done = true;
      notify(job);
    }
  })();
  return id;
}

function waitForChange(job) {
  return new Promise((resolve) => job.waiters.push(resolve));
}

/**
 * Envía el audio de un trabajo al navegador.
 * - Sin "Range" (o "bytes=0-"): se manda en streaming a medida que se genera.
 * - Con un rango cerrado (Safari/iPhone lo pide así): se espera a que termine y
 *   se responde 206 con ese pedazo (Safari exige rangos para reproducir audio).
 */
export async function pipeJob(id, req, res) {
  const job = jobs.get(id);
  if (!job) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "not_found" }));
  }

  // Si falló antes de producir audio: error claro (el frontend usa otra voz).
  const failEarly = () => {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "tts_error", message: job.error?.message || "Error de voz." }));
  };

  const range = req.headers.range || "";
  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  const wantsClosedRange = m && (m[2] !== "" || m[1] !== "0");

  if (wantsClosedRange) {
    while (!job.done) await waitForChange(job);
    if (job.error && !job.size) return failEarly();
    const all = Buffer.concat(job.chunks);
    const start = Number(m[1]);
    const end = m[2] === "" ? all.length - 1 : Math.min(Number(m[2]), all.length - 1);
    if (start >= all.length || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${all.length}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${all.length}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    return res.end(all.subarray(start, end + 1));
  }

  // Streaming: esperar el primer pedazo (o el error) antes de mandar cabeceras.
  while (!job.size && !job.done) await waitForChange(job);
  if (job.error && !job.size) return failEarly();

  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" };
  if (job.done) headers["Content-Length"] = job.size; // ya completo: tamaño exacto
  res.writeHead(200, headers);

  let sent = 0;
  let closed = false;
  res.on("close", () => { closed = true; });
  while (!closed) {
    while (sent < job.chunks.length) res.write(job.chunks[sent++]);
    if (job.done) break;
    await waitForChange(job);
  }
  res.end();
}
