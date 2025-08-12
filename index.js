// index.js
import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false })); // Twilio: x-www-form-urlencoded
app.use(express.json());

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Memoria simple de sesiones (MVP)
const sessions = new Map(); // key: whatsapp:+54911... -> { stage, flow, data:{} }

const saludo =
  "¡Hola! Soy el asistente de *KiosKeys* 👋\n" +
  "¿Qué necesitás hoy?\n\n" +
  "1) Solicitud de duplicado\n" +
  "2) Cambio de carcasa\n" +
  "3) Llave nueva\n\n" +
  "Respondé con *1, 2 o 3*. Escribí *0* o *menu* para volver al inicio.";

// Healthcheck
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));

// -------- utilidades ----------
function toTicket() {
  return new Date().toISOString().replace(/\D/g, "").slice(2, 10) + "-" + Math.floor(Math.random() * 900 + 100);
}
function normPatente(txt = "") {
  return txt.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function isYear(y) {
  const n = Number(String(y).trim());
  return n >= 1980 && n <= new Date().getFullYear() + 1;
}
async function alertHuman(summary) {
  const to = process.env.HUMAN_WHATSAPP_TO;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!to || !from) return;
  try {
    await client.messages.create({
      from,
      to: `whatsapp:${to.replace(/^whatsapp:/, "")}`,
      body: `🔔 *Handoff KiosKeys*\n${summary}`
    });
  } catch (e) {
    console.error("No pude avisar a humano:", e.message);
  }
}
function menuReply(s) {
  s.stage = "menu";
  s.flow = null;
  s.data = {};
  return saludo;
}
function pedirRol(s) {
  s.stage = "dup_rol";
  return "¿El duplicado es por *1) Seguro* o *2) Particular*?\nRespondé *1* o *2*.";
}
function pedirMarca(s) {
  s.stage = `${s.flow}_marca`;
  return "Decime la *marca* del vehículo.";
}
function pedirModelo(s) {
  s.stage = `${s.flow}_modelo`;
  return "Perfecto. ¿Cuál es el *modelo*?";
}
function pedirAnio(s) {
  s.stage = `${s.flow}_anio`;
  return "Gracias. Indicá el *año* (ej: 2018).";
}
function pedirPatente(s) {
  s.stage = `${s.flow}_patente`;
  return "Por último, decime la *patente* (ej: ABC123 o AA123BB).";
}
function resumenCliente(from, s) {
  const d = s.data || {};
  const base =
    `Cliente: ${from.replace("whatsapp:", "")}\n` +
    `Ticket: ${toTicket()}\n` +
    `Flujo: ${s.flow}\n` +
    (d.role ? `Rol: ${d.role}\n` : "") +
    `Marca/Modelo/Año: ${[d.marca, d.modelo, d.anio].filter(Boolean).join(" ") || "-"}\n` +
    `Patente: ${d.patente || "-"}`;
  return base;
}
function confirmacionUsuario(s) {
  const d = s.data || {};
  return (
    "¡Gracias! Ya tomé tus datos:\n" +
    `• Gestión: ${s.flow === "duplicado" ? "Solicitud de duplicado" : s.flow === "carcasa" ? "Cambio de carcasa" : "Llave nueva"}\n` +
    (d.role ? `• Rol: ${d.role}\n` : "") +
    `• Marca/Modelo/Año: ${[d.marca, d.modelo, d.anio].filter(Boolean).join(" ") || "-"}\n` +
    `• Patente: ${d.patente || "-"}\n\n` +
    "✅ Te paso con un asesor para finalizar. ¡Gracias por tu paciencia!"
  );
}

// -------- webhook WhatsApp ----------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From; // "whatsapp:+54911..."
  const text = (req.body.Body || "").trim();

  let s = sessions.get(from);
  if (!s) {
    s = { stage: "menu", flow: null, data: {} };
    sessions.set(from, s);
  }

  let reply;

  // Volver al menú
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = menuReply(s);
  }
  // Si estoy pidiendo algo puntual, proceso ese paso
  else if (s.stage && s.stage !== "menu") {
    const d = (s.data = s.data || {});
    switch (s.stage) {
      // --- Flujo duplicado
      case "dup_rol": {
        if (/^1/.test(text) || /seguro/i.test(text)) d.role = "ASEGURADO";
        else if (/^2/.test(text) || /particular/i.test(text)) d.role = "PARTICULAR";
        else return done("Por favor respondé *1 (Seguro)* o *2 (Particular)*.");

        reply = pedirMarca(s);
        break;
      }
      case "duplicado_marca":
      case "carcasa_marca":
      case "llave_marca": {
        d.marca = text;
        reply = pedirModelo(s);
        break;
      }
      case "duplicado_modelo":
      case "carcasa_modelo":
      case "llave_modelo": {
        d.modelo = text;
        reply = pedirAnio(s);
        break;
      }
      case "duplicado_anio":
      case "carcasa_anio":
      case "llave_anio": {
        if (!isYear(text)) return done("El *año* no parece válido. Ejemplo: *2018*. Probá de nuevo.");
        d.anio = String(text).trim();
        reply = pedirPatente(s);
        break;
      }
      case "duplicado_patente":
      case "carcasa_patente":
      case "llave_patente": {
        d.patente = normPatente(text);

        // Siempre derivamos a humano al completar datos
        const summary = resumenCliente(from, s);
        await alertHuman(summary);

        reply = confirmacionUsuario(s);
        // Reinicio a menú para una nueva gestión
        reply += `\n\n${saludo}`;
        s.stage = "menu";
        s.flow = null;
        s.data = {};
        break;
      }
      default:
        // Si el estado es raro, volanteamos a menú
        reply = menuReply(s);
    }
  }
  // Si estoy en menú (o sin estado), interpreto opción
  else {
    // Normalizo respuestas
    if (/^1$/.test(text) || /duplicado/i.test(text)) {
      s.flow = "duplicado";
      reply = pedirRol(s);
    } else if (/^2$/.test(text) || /carcasa/i.test(text)) {
      s.flow = "carcasa";
      reply = pedirMarca(s);
    } else if (/^3$/.test(text) || /llave nueva|nueva llave/i.test(text)) {
      s.flow = "llave";
      reply = pedirMarca(s);
    } else if (/^hola|buenas/i.test(text)) {
      reply = menuReply(s);
    } else {
      // Cualquier otra cosa: mostramos menú
      reply = menuReply(s);
    }
  }

  // Enviar WhatsApp (única respuesta)
  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: from,
      body: reply
    });
  } catch (e) {
    console.error("Error enviando WhatsApp:", e.message);
  }

  res.sendStatus(200);

  // util para responder inline en ciertos casos
  function done(msg) {
    reply = msg;
    return;
  }
});

app.listen(PORT, () => console.log("Servidor escuchando en", PORT));
