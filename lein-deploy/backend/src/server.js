// server.js
// Servidor HTTP mínimo para desarrollo local. Sin frameworks (Node puro),
// para que sea fácil de leer y de portar luego a Vercel/Cloudflare.
//
// Endpoints:
//   GET  /api/health        -> diagnóstico (¿está vivo? ¿hay llave cargada?)
//   POST /api/chat          -> recibe {text, history, level, mission, placement, studentId}
//                              y devuelve el JSON de Lein {say, hint, suggestions, ...}
//   POST /api/usage/ping    -> {studentId, seconds}: suma tiempo activo, devuelve estado
//   GET  /api/usage/status  -> ?studentId=...: tiempo restante de hoy

import "./env.js"; // carga .env de PRIMERO (antes que lein.js/usage.js lean process.env)
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leinTurn, getModel } from "./lein.js";
import { getStatus, addActiveSeconds, DAILY_LIMIT_SECONDS } from "./usage.js";
import { synthesize, hasTTS } from "./tts.js";
import { transcribe, hasSTT } from "./stt.js";
import { claudeCostUSD, ttsCostUSD, sttCostUSD, addCost, getDailyTotals, round4 } from "./cost.js";

// Carpeta del frontend (../../frontend respecto a este archivo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "*";

// --- CORS: el frontend vivirá en otra URL, así que hay que permitir el origen.
function setCors(res, origin) {
  const allow =
    ALLOWED_ORIGINS === "*"
      ? "*"
      : ALLOWED_ORIGINS.split(",").map((s) => s.trim()).includes(origin)
        ? origin
        : "";
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body demasiado grande")); // ~1MB tope
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Lee el cuerpo como binario (para el audio del micrófono).
function readRawBody(req, limit = 12_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("audio demasiado grande")); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  setCors(res, origin);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Preflight de CORS.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Health check — no necesita llave.
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "lein-backend",
      model: getModel(),
      hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
      dailyLimitMinutes: DAILY_LIMIT_SECONDS / 60,
      ttsProvider: hasTTS() ? "openai" : "browser",
      sttProvider: hasSTT() ? "openai" : "none",
    });
  }

  // Micrófono: audio del estudiante -> texto (Whisper de OpenAI).
  if (req.method === "POST" && url.pathname === "/api/stt") {
    if (!hasSTT()) {
      return sendJson(res, 200, { error: "no_stt", message: "Sin OPENAI_API_KEY para transcribir." });
    }
    let buf;
    try {
      buf = await readRawBody(req);
    } catch {
      return sendJson(res, 413, { error: "too_large", message: "Audio demasiado largo." });
    }
    if (!buf || !buf.length) {
      return sendJson(res, 400, { error: "no_audio", message: "No llegó audio." });
    }
    try {
      const text = await transcribe(buf, req.headers["content-type"]);
      // Medidor: costo (estimado) de la transcripción, atribuido al estudiante.
      const sid = url.searchParams.get("studentId") || "anon";
      addCost(sid, sttCostUSD(buf.length), "stt");
      return sendJson(res, 200, { text });
    } catch (err) {
      console.error("[/api/stt] Error:", err?.message || err);
      return sendJson(res, 502, { error: "stt_error", message: err?.message || "Error transcribiendo." });
    }
  }

  // Voz premium de Lein (audio mp3). Si no hay llave de OpenAI, avisa para que
  // el frontend use la voz del navegador como respaldo.
  if (req.method === "POST" && url.pathname === "/api/tts") {
    if (!hasTTS()) {
      return sendJson(res, 200, { error: "no_tts", message: "Sin OPENAI_API_KEY; usar voz del navegador." });
    }
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: "bad_json" });
    }
    const { text, level = "A1", voice, studentId = "anon" } = payload;
    if (!text || typeof text !== "string") {
      return sendJson(res, 400, { error: "missing_text" });
    }
    try {
      const audio = await synthesize(text, level, voice);
      // Medidor: costo (estimado) de la voz, atribuido al estudiante.
      addCost(studentId, ttsCostUSD(text), "tts");
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
      return res.end(audio);
    } catch (err) {
      console.error("[/api/tts] Error:", err?.message || err);
      return sendJson(res, 502, { error: "tts_error", message: err?.message || "Error de voz." });
    }
  }

  // Estado de tiempo de un estudiante (cuánto le queda hoy).
  if (req.method === "GET" && url.pathname === "/api/usage/status") {
    const studentId = url.searchParams.get("studentId");
    if (!studentId) {
      return sendJson(res, 400, { error: "missing_student_id", message: "Falta studentId." });
    }
    return sendJson(res, 200, getStatus(studentId));
  }

  // Medidor de costo del día (SOLO para el dueño). Protegido con METER_KEY:
  // - Si NO hay METER_KEY configurada, el endpoint está apagado (404), para no
  //   exponer el gasto públicamente.
  // - Si la hay, se consulta con ?key=TU_LLAVE
  if (req.method === "GET" && url.pathname === "/api/usage/costs") {
    const key = process.env.METER_KEY;
    if (!key) {
      return sendJson(res, 404, { error: "disabled", message: "Define METER_KEY para activar el reporte de costos." });
    }
    if (url.searchParams.get("key") !== key) {
      return sendJson(res, 403, { error: "forbidden", message: "Llave incorrecta (?key=...)." });
    }
    const t = getDailyTotals();
    return sendJson(res, 200, {
      day: t.day,
      totalUSD: round4(t.global.total || 0),
      desglose: {
        claudeUSD: round4(t.global.claude || 0),
        vozUSD: round4(t.global.tts || 0),
        escuchaUSD: round4(t.global.stt || 0),
      },
      estudiantesActivos: t.count,
      porEstudiante: t.students.map((s) => ({
        studentId: s.studentId,
        totalUSD: round4(s.total || 0),
        turnos: s.turns || 0,
      })),
    });
  }

  // "Latido" desde el frontend mientras el estudiante practica: suma tiempo activo.
  if (req.method === "POST" && url.pathname === "/api/usage/ping") {
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: "bad_json", message: "El cuerpo no es JSON válido." });
    }
    const { studentId, seconds } = payload;
    if (!studentId) {
      return sendJson(res, 400, { error: "missing_student_id", message: "Falta studentId." });
    }
    return sendJson(res, 200, addActiveSeconds(studentId, seconds));
  }

  // El endpoint principal: un turno de conversación.
  if (req.method === "POST" && url.pathname === "/api/chat") {
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: "bad_json", message: "El cuerpo no es JSON válido." });
    }

    const {
      text,
      history = [],
      level = "A1",
      mission = null,
      placement = false,
      studentId = null,
      opening = false,
      recap = false,
      errors = [],
      studentName = "",
    } = payload;

    // Tope diario por estudiante (backstop del servidor: aunque el frontend
    // falle o recarguen la página, aquí se respeta). Si no hay studentId no se
    // puede identificar, así que no se aplica tope (en producción Moodle siempre
    // lo manda por la URL).
    if (studentId) {
      const status = getStatus(studentId);
      if (status.blocked) {
        return sendJson(res, 200, {
          limitReached: true,
          message: "Llegaste a tu práctica de hoy. ¡Nos vemos mañana! 👋",
          status,
        });
      }
    }

    // Avisar claro si falta la llave (en vez de un error feo de la API).
    if (!process.env.ANTHROPIC_API_KEY) {
      return sendJson(res, 500, {
        error: "missing_api_key",
        message:
          "Falta ANTHROPIC_API_KEY. Copia .env.example a .env y pega tu llave de https://console.anthropic.com",
      });
    }

    if ((!text || typeof text !== "string") && !placement && !opening && !recap) {
      return sendJson(res, 400, {
        error: "missing_text",
        message: 'Falta "text" (lo que dijo el estudiante).',
      });
    }

    try {
      const result = await leinTurn({
        text: text || "",
        history,
        level,
        mission,
        placement,
        opening,
        recap,
        errors,
        studentName,
      });
      // Adjuntamos el tiempo restante de hoy para que el frontend lo muestre.
      if (studentId) result._timeStatus = getStatus(studentId);

      // Medidor de costo: Claude es EXACTO (tokens reales). Sumamos al estudiante
      // y devolvemos el costo de este turno + el total de su sesión de hoy.
      const turnUSD = claudeCostUSD(result._usage);
      const rec = addCost(studentId || "anon", turnUSD, "claude", { turn: true });
      result._cost = { turnUSD: round4(turnUSD), sessionUSD: round4(rec.total), turns: rec.turns };
      console.log(`[cost] alumno=${studentId || "anon"} turno=$${round4(turnUSD)} sesionHoy=$${round4(rec.total)} (${rec.turns} turnos)`);

      return sendJson(res, 200, result);
    } catch (err) {
      console.error("[/api/chat] Error:", err?.message || err);
      return sendJson(res, 502, {
        error: "claude_error",
        message: err?.message || "Error llamando a Claude.",
      });
    }
  }

  // --- Servir el frontend (cualquier GET que no sea /api/...) ---
  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    // Evitar salirse de la carpeta del frontend (path traversal).
    const filePath = path.join(FRONTEND_DIR, rel);
    if (!filePath.startsWith(FRONTEND_DIR)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    try {
      const buf = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return res.end(buf);
    } catch {
      // Fallback: si no existe el archivo, devolvemos index.html.
      try {
        const buf = await readFile(path.join(FRONTEND_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        return res.end(buf);
      } catch {
        return sendJson(res, 404, { error: "not_found", message: "Frontend no encontrado." });
      }
    }
  }

  // Cualquier otra ruta.
  sendJson(res, 404, { error: "not_found", message: `Ruta no encontrada: ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`\n🧠  Lein backend escuchando en http://localhost:${PORT}`);
  console.log(`    Modelo:      ${getModel()}`);
  console.log(`    Tope diario: ${DAILY_LIMIT_SECONDS / 60} min por estudiante`);
  console.log(`    Voz:         ${hasTTS() ? "OpenAI premium ✅ (igual en todos los equipos)" : "navegador (gratis; pega OPENAI_API_KEY para premium)"}`);
  console.log(`    Llave:       ${process.env.ANTHROPIC_API_KEY ? "cargada ✅" : "FALTA ❌  (pega ANTHROPIC_API_KEY en .env)"}`);
  console.log(`    App:         http://localhost:${PORT}/  <- abre esto en el navegador`);
  console.log(`    Health:      http://localhost:${PORT}/api/health\n`);
});
