// usage.js
// Lleva la cuenta del TIEMPO ACTIVO de cada estudiante por día, y aplica el
// tope diario (ej. 10 min). "Tiempo activo" = solo cuando el estudiante está
// realmente practicando; el frontend manda "pings" cada pocos segundos mientras
// graba/escucha, y aquí los acumulamos.
//
// Almacenamiento: por ahora un archivo JSON local (.data/usage.json), suficiente
// para desarrollo. En producción se cambia esta capa por un KV (Cloudflare/Vercel)
// SIN tocar el resto del código: solo hay que reimplementar load() y save().

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", ".data");
const DATA_FILE = path.join(DATA_DIR, "usage.json");

// Tope diario en segundos (configurable por env, default 10 minutos).
export const DAILY_LIMIT_SECONDS = Math.round(
  (Number(process.env.DAILY_LIMIT_MINUTES) || 10) * 60
);

// Zona horaria para decidir "qué día es hoy" (cuándo se reinicia el contador).
// Default: hora del centro de EE. UU. (estudiantes de LBrain). Configurable.
const RESET_TZ = process.env.DAILY_RESET_TZ || "America/Chicago";

// Tope por ping: ningún ping puede sumar más de 60s (anti-trampa).
const MAX_SECONDS_PER_PING = 60;

// "Hoy" como YYYY-MM-DD en la zona horaria configurada (en-CA da ese formato).
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RESET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
}

function recordKey(studentId, day) {
  return `${studentId}::${day}`;
}

/** Estado de uso de hoy para un estudiante. */
export function getStatus(studentId) {
  const day = todayKey();
  const db = load();
  const used = db[recordKey(studentId, day)]?.usedSeconds || 0;
  const remaining = Math.max(0, DAILY_LIMIT_SECONDS - used);
  return {
    usedSeconds: used,
    remainingSeconds: remaining,
    limitSeconds: DAILY_LIMIT_SECONDS,
    blocked: remaining <= 0,
    day,
  };
}

/** Suma segundos de práctica activa y devuelve el estado actualizado. */
export function addActiveSeconds(studentId, seconds) {
  const add = Math.max(0, Math.min(MAX_SECONDS_PER_PING, Number(seconds) || 0));
  const day = todayKey();
  const db = load();
  const k = recordKey(studentId, day);
  const cur = db[k]?.usedSeconds || 0;
  db[k] = { usedSeconds: cur + add, updatedAt: new Date().toISOString() };
  save(db);
  return getStatus(studentId);
}
