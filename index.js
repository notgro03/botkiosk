// index.js — Bot KiosKeys (Twilio TwiML + Google Sheets, formal, sin "OK")
import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio (solo para avisos internos)
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ===== Google Sheets =====
const SHEET_ID = process.env.GOOGLE_SHEET_ID;        // ID de la planilla
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Solicitudes";

const sheetsAuth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

async function logToSheet(row) {
  if (!SHEET_ID) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (e) {
    console.error("Sheets append error:", e.message);
  }
}

// ===== Sesiones (memoria) =====
const sessions = new Map(); // from -> { stage, flow, data, lastReply }

// ===== Helpers de diálogo =====
function toMenu(s) {
  s.stage = "menu";
  s.flow = null;
  s.data = {};
  return `¡Hola! Soy el asistente virtual de *KiosKeys* 👋
Estoy aquí para ayudarte.

Elegí una opción:
1) *Solicitud de duplicado*
2) *Cambio de carcasa*
3) *Llave nueva*

Respondé con *1, 2 o 3*. En cualquier momento escribí *0* o *menu* para volver aquí.`;
}

function pedirRol(s) {
  s.stage = "dup_rol";
  return "¿El trámite es *1) Asegurado* o *2) Particular*? Respondé 1 o 2.";
}

// Aviso interno (silencioso para el cliente)
async function alertHumanSafe(clientFrom, summary) {
  const to = (process.env.HUMAN_WHATSAPP_TO || "").replace(/^whatsapp:/, "");
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!to || !from) return;

  const normalizedClient = clientFrom.replace(/^whatsapp:/, "");
  if (to === normalizedClient) return; // no avisar al mismo chat del cliente

  try {
    await client.messages.create({
      from,
      to: `whatsapp:${to}`,
      body: `🔔 Aviso interno KiosKeys\n${summary}`,
    });
  } catch (e) {
    console.error("Aviso interno falló:", e.message);
  }
}

// ===== Webhook principal: respondemos con TwiML =====
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;          // "whatsapp:+549..."
  const text = (req.body.Body || "").trim();

  let s = sessions.get(from);
  if (!s) {
    s = { stage: "menu", flow: null, data: {}, lastReply: "" };
    sessions.set(from, s);
  }

  let reply; // lo que enviaremos en TwiML

  // ---- Comandos globales
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  }
  // ---- Comprensión breve fuera de flujo
  else if (/precio|cu[aá]nto sale|costo|vale/i.test(text)) {
    reply = "💰 El precio depende del tipo de llave o servicio. Un asesor puede confirmarte el valor exacto. ¿Querés que te contacte un asesor?";
    await alertHumanSafe(from, `Consulta de precios: “${text}” — Cliente: ${from.replace("whatsapp:","")}`);
  } else if (/ubicaci[oó]n|d[oó]nde est[aá]n|direcci[oó]n|horarios?/i.test(text)) {
    reply = "📍 Av. Hipólito Yrigoyen 114, Morón. Horario: 9:00–13:00 y 14:00–17:00 hs.";
  }
  // ---- Flujos guiados (si no estoy en menú)
  else if (s.stage !== "menu") {
    const d = s.data;
    const Y = new Date().getFullYear();

    switch (s.stage) {
      case "dup_rol": {
        if (/^1$/.test(text) || /asegurad/i.test(text)) {
          d.role = "ASEGURADO";
          s.stage = "duplicado_marca";
          reply = "Perfecto. Indicame la *marca* del vehículo.";
        } else if (/^2$/.test(text) || /particular/i.test(text)) {
          d.role = "PARTICULAR";
          s.stage = "duplicado_marca";
          reply = "Entendido. Indicame la *marca* del vehículo.";
        } else {
          reply = "Por favor, respondé con *1 (Asegurado)* o *2 (Particular)*.";
        }
        break;
      }

      case "duplicado_marca":
      case "carcasa_marca":
      case "llave_marca": {
        d.marca = text;
        s.stage = `${s.flow}_modelo`;
        reply = "Gracias. ¿Cuál es el *modelo*?";
        break;
      }

      case "duplicado_modelo":
      case "carcasa_modelo":
      case "llave_modelo": {
        d.modelo = text;
        s.stage = `${s.flow}_anio`;
        reply = "Perfecto. ¿En qué *año* fue fabricado? (ej: 2019)";
        break;
      }

      case "duplicado_anio":
      case "carcasa_anio":
      case "llave_anio": {
        const n = Number(text);
        if (!Number.isFinite(n) || n < 1980 || n > Y + 1) {
          reply = "El año no parece válido. Por ejemplo: *2019*.";
        } else {
          d.anio = String(n);
          s.stage = `${s.flow}_patente`;
          reply = "Por último, indicame la *patente* (ej: ABC123 o AA123BB).";
        }
        break;
      }

      case "duplicado_patente":
      case "carcasa_patente":
      case "llave_patente": {
        d.patente = text.toUpperCase().replace(/[^A-Z0-9]/g, "");

        // Guardamos en Sheets
        const now = new Date().toLocaleString("es-AR");
        const row = [
          now,
          from.replace("whatsapp:", ""),
          s.flow,
          d.role || "",
          d.marca || "",
          d.modelo || "",
          d.anio || "",
          d.patente || "",
        ];
        logToSheet(row);

        // Aviso interno
        const resumen =
          `Solicitud: ${s.flow}\n` +
          (d.role ? `Rol: ${d.role}\n` : "") +
          `Marca: ${d.marca}\nModelo: ${d.modelo}\nAño: ${d.anio}\nPatente: ${d.patente}\n` +
          `Cliente: ${from.replace("whatsapp:","")}`;
        await alertHumanSafe(from, resumen);

        reply = "✅ Gracias. Registré tu solicitud. En breve, un asesor se comunicará por este mismo chat para continuar.";
        reply += `\n\n${toMenu(s)}`; // resetea y muestra menú
        break;
      }

      default:
        reply = toMenu(s);
    }
  }
  // ---- Menú principal
  else {
    if (/^1$/.test(text) || /duplicad/i.test(text)) {
      s.flow = "duplicado";
      reply = pedirRol(s);
    } else if (/^2$/.test(text) || /carcasa/i.test(text)) {
      s.flow = "carcasa";
      s.stage = "carcasa_marca";
      reply = "Perfecto. Indicame la *marca* del vehículo.";
    } else if (/^3$/.test(text) || /llave nueva/i.test(text)) {
      s.flow = "llave";
      s.stage = "llave_marca";
      reply = "Perfecto. Indicame la *marca* del vehículo.";
    } else if (/hola|buenas/i.test(text)) {
      reply = toMenu(s);
    } else {
      reply = toMenu(s);
    }
  }

  // ==== ANTI “OK” / ANTI-ECO ====
  const safeReply = (reply || "").trim();
  const isOkOnly = /^ok\.?$/i.test(safeReply);
  const isDuplicate = safeReply && s.lastReply && safeReply === s.lastReply.trim();

  if (!safeReply || isOkOnly || isDuplicate) {
    // 200 sin TwiML => Twilio no agrega nada (y no mandamos "OK")
    return res.status(200).end();
  }

  // Respondemos con TwiML para que Twilio use SOLO esta respuesta
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(safeReply);
  s.lastReply = safeReply;

  res.type("text/xml").send(twiml.toString());
});

// Healthcheck
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));
app.listen(process.env.PORT || 3000, () =>
  console.log("UP on", process.env.PORT || 3000)
);
