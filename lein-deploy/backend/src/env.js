// env.js
// Carga las variables de entorno ANTES que cualquier otro módulo del proyecto.
// Se importa de PRIMERO en server.js y en los scripts, para que el .env ya esté
// disponible cuando los demás módulos lean process.env.
// Usa ruta absoluta a backend/.env, así no depende de desde dónde se arranque.
// override:true -> el .env manda sobre variables vacías que traiga el entorno.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: true });
