// cost.js
// Medidor de costo REAL en dólares. Acumula por estudiante (por día) y un total
// global del día. Mismo estilo y almacén que usage.js (.data/costs.json).
//
// - Claude: costo EXACTO, calculado con los tokens reales que devuelve la API.
// - Voz (TTS) y escucha (STT) de OpenAI: ESTIMADO (no devuelven costo por llamada),
//   con tarifas configurables. La parte más cara (Claude) es exacta.
//
// Precios por defecto (USD). Se pueden ajustar por variables de entorno sin tocar
// el código, por si cambian las tarifas:
//   CLAUDE_USD_IN, CLAUDE_USD_OUT, CLAUDE_USD_CACHE_WRITE, CLAUDE_USD_CACHE_READ  (por millón de tokens)
//   TTS_USD_PER_MIN, TTS_CHARS_PER_SEC
//   STT_USD_PER_MIN, STT_BYTES_PER_SEC

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", ".data");
const DATA_FILE = path.join(DATA_DIR, "costs.json");
const RESET_TZ = process.env.DAILY_RESET_TZ || "America/Chicago";

const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));

// --- Tarifas de Claude (USD por millón de tokens), SEGÚN el modelo en uso ---
// Así el medidor muestra el costo REAL aunque cambies de modelo (Haiku/Sonnet/Opus).
// Se puede forzar con env CLAUDE_USD_* si las tarifas cambian.
const PRICES = {
  haiku:  { in: 1,  out: 5,  cw: 1.25,  cr: 0.10 },
  sonnet: { in: 3,  out: 15, cw: 3.75,  cr: 0.30 },
  opus:   { in: 15, out: 75, cw: 18.75, cr: 1.50 },
};
const MODEL_NAME = (process.env.MODEL || "claude-sonnet-4-6").toLowerCase();
const family = MODEL_NAME.includes("haiku") ? "haiku"
             : MODEL_NAME.includes("opus")  ? "opus"
             : "sonnet";
const P = PRICES[family];
const CLAUDE = {
  in:        num(process.env.CLAUDE_USD_IN, P.in) / 1e6,
  out:       num(process.env.CLAUDE_USD_OUT, P.out) / 1e6,
  cacheWrite:num(process.env.CLAUDE_USD_CACHE_WRITE, P.cw) / 1e6,
  cacheRead: num(process.env.CLAUDE_USD_CACHE_READ, P.cr) / 1e6,
};
const TTS_USD_PER_MIN   = num(process.env.TTS_USD_PER_MIN, 0.015);
const TTS_CHARS_PER_SEC = num(process.env.TTS_CHARS_PER_SEC, 14);  // ~ritmo de habla
const STT_USD_PER_MIN   = num(process.env.STT_USD_PER_MIN, 0.003);
const STT_BYTES_PER_SEC = num(process.env.STT_BYTES_PER_SEC, 3000); // ~audio de voz comprimido

// --- Cálculo de costo por llamada ---
export function claudeCostUSD(u) {
  if (!u) return 0;
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cw  = u.cache_creation_input_tokens || 0;
  const cr  = u.cache_read_input_tokens || 0;
  return inp * CLAUDE.in + out * CLAUDE.out + cw * CLAUDE.cacheWrite + cr * CLAUDE.cacheRead;
}
export function ttsCostUSD(text) {
  const chars = (text || "").length;
  const minutes = chars / (TTS_CHARS_PER_SEC * 60);
  return minutes * TTS_USD_PER_MIN;
}
export function sttCostUSD(bytes) {
  const seconds = (bytes || 0) / STT_BYTES_PER_SEC;
  return (seconds / 60) * STT_USD_PER_MIN;
}

// --- Acumulador (archivo JSON, por día y zona horaria) ---
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RESET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function load() { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; } }
function save(db) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
const recordKey = (sid, day) => `${sid}::${day}`;
const GLOBAL = "__ALL__";

const blank = () => ({ name: null, total: 0, claude: 0, tts: 0, stt: 0, turns: 0, updatedAt: null });

/** Suma un costo (kind: 'claude' | 'tts' | 'stt') a un estudiante y al total global.
 *  opts.name = nombre del alumno (para el reporte); opts.turn = cuenta un turno. */
export function addCost(studentId, usd, kind, opts = {}) {
  if (!usd && !opts.turn) return getCost(studentId);
  const day = todayKey();
  const db = load();
  for (const id of [studentId || "anon", GLOBAL]) {
    const k = recordKey(id, day);
    const rec = db[k] || blank();
    rec.total += usd || 0;
    if (kind && rec[kind] !== undefined) rec[kind] += usd || 0;
    if (opts.turn) rec.turns += 1;
    if (id !== GLOBAL && opts.name) rec.name = opts.name; // guarda el nombre del alumno
    rec.updatedAt = new Date().toISOString();
    db[k] = rec;
  }
  save(db);
  return getCost(studentId);
}

/** Costo de HOY de un estudiante (su "sesión" del día). */
export function getCost(studentId) {
  const db = load();
  const rec = db[recordKey(studentId || "anon", todayKey())] || blank();
  return { ...rec, day: todayKey() };
}

/** Día de hoy (para defaults externos). */
export const today = () => todayKey();

/** Totales de un día: global + lista por estudiante (para el dueño). */
export function getDailyTotals(day = todayKey()) {
  const db = load();
  const students = [];
  let global = blank();
  for (const [k, v] of Object.entries(db)) {
    if (!k.endsWith("::" + day)) continue;
    const id = k.slice(0, -(day.length + 2));
    if (id === GLOBAL) global = v;
    else students.push({ studentId: id, ...v });
  }
  students.sort((a, b) => b.total - a.total);
  return { day, global, students, count: students.length };
}

/** Redondeo bonito a 4 decimales (centésimas de centavo). */
export const round4 = (n) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
