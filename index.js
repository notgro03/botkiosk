// index.js — KiosKeys Bot con IA + TwiML + Sheets + Derivación por CP (muestra solo dirección)
import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import OpenAI from "openai";
import { google } from "googleapis";
import fs from "fs";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== Twilio (solo avisos internos, NO se contacta al proveedor) =====
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Google Sheets (opcional) =====
const SHEET_ID  = process.env.GOOGLE_SHEET_ID || "";
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Solicitudes";
let sheets = null;

async function initSheets() {
  if (!SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) return;
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  sheets = google.sheets({ version: "v4", auth });
}
initSheets().catch(console.error);

async function logToSheet(row) {
  if (!sheets || !SHEET_ID) return;
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

// ===== Carga de cerrajerías (derivación) =====
let LOCKSMITHS = [];
try {
  const path = process.env.LOCKSMITHS_PATH || "./locksmiths.json";
  LOCKSMITHS = JSON.parse(fs.readFileSync(path, "utf8"));
  console.log(`Locksmiths cargados: ${LOCKSMITHS.length}`);
} catch (e) {
  console.warn("No se pudo cargar locksmiths.json, derivación desactivada:", e.message);
}

// ---- Utilidades de derivación
const pickPreferred = (list, servicio) =>
  list
    .filter(x => !servicio || !x.servicios || x.servicios.includes(servicio))
    .sort((a,b) => (b.prioridad||0) - (a.prioridad||0))[0] || null;

function deriveByCP(cp, servicio /* "duplicado" | "carcasa" | "llave" */) {
  if (!cp || !/^\d{4}$/.test(cp) || !LOCKSMITHS.length) return null;

  // 1) Exacto
  const exact = LOCKSMITHS.filter(x => x.cp === cp);
  let pick = pickPreferred(exact, servicio);
  if (pick) return pick;

  // 2) Prefijo (misma zona: dos primeros dígitos)
  const pref2 = cp.slice(0,2);
  const sameZone = LOCKSMITHS.filter(x => (x.cp || "").slice(0,2) === pref2);
  pick = pickPreferred(sameZone, servicio);
  if (pick) return pick;

  // 3) Mínima distancia por CP (absoluta)
  const nearest = [...LOCKSMITHS]
    .filter(x => /^\d{4}$/.test(x.cp))
    .map(x => ({ ...x, dist: Math.abs(Number(x.cp) - Number(cp)) }))
    .sort((a,b) => a.dist - b.dist || (b.prioridad||0) - (a.prioridad||0));

  pick = pickPreferred(nearest, servicio);
  return pick;
}

function mapsLink(address) {
  // Link de Google Maps simple
  const q = encodeURIComponent(address);
  return `https://maps.google.com/?q=${q}`;
}

// ===== Sesiones =====
const sessions = new Map(); // from -> { stage, flow, data, lastReply }

const Y = new Date().getFullYear();
const isYear = v => /^\d{4}$/.test(v) && +v >= 1980 && +v <= Y + 1;
const isCP   = v => /^\d{4}$/.test(v);
const isPat  = v => /^(?:[A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z]{2})$/.test(v);

function clean(text) {
  return (text || "").normalize("NFKC").trim();
}
function normalizePlate(p) {
  return clean(p).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function toMenu(s) {
  s.stage = "menu";
  s.flow  = null;
  s.data  = {};
  return `¡Hola! Soy el asistente de *KiosKeys* 👋
Estoy para ayudarte.

Elegí una opción:
1) *Solicitud de duplicado*
2) *Cambio de carcasa*
3) *Llave nueva*

Respondé con *1, 2 o 3*. En cualquier momento escribí *0* o *menu* para volver aquí.`;
}

function compactSummary(d) {
  const line = (k, v) => (v ? `• ${k}: ${v}\n` : "");
  return (
    `📝 *Resumen del pedido*\n` +
    line("Rol", d.role) +
    line("Aseguradora", d.aseguradora) +
    line("Marca", d.marca) +
    line("Modelo", d.modelo) +
    line("Año", d.anio) +
    line("Patente", d.patente) +
    line("CP", d.cp)
  ).trim();
}

function requiredFields(flow, data) {
  const base = ["marca", "modelo", "anio", "patente"];
  if (!data.role) base.unshift("role");
  if (data.role === "ASEGURADO" && !data.aseguradora) base.unshift("aseguradora");
  if (!data.cp) base.push("cp");
  return [...new Set(base)];
}

async function alertHumanSafe(clientFrom, summary) {
  const to   = (process.env.HUMAN_WHATSAPP_TO || "").replace(/^whatsapp:/, "");
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!to || !from) return;
  const normalizedClient = (clientFrom || "").replace(/^whatsapp:/, "");
  if (to === normalizedClient) return;
  try {
    await twilioClient.messages.create({
      from,
      to: `whatsapp:${to}`,
      body: `🔔 Nuevo caso KiosKeys\n${summary}`,
    });
  } catch (e) {
    console.error("Handoff interno falló:", e.message);
  }
}

// ===== IA: extracción de datos =====
async function extractWithAI(userText, current) {
  try {
    const system =
`Sos un extractor de datos para un bot de cerrajería (KiosKeys).
Devolvés SIEMPRE JSON válido.
Campos:
- servicio: "duplicado" | "carcasa" | "llave" | "consulta" | "humano" | null
- role: "ASEGURADO" | "PARTICULAR" | null
- aseguradora: string|null
- marca: string|null
- modelo: string|null
- anio: string|null (4 dígitos)
- patente: string|null (ABC123/AA123BB)
- cp: string|null (4 dígitos)
- intent_extra: "precio" | "ubicacion" | null
No inventes. Dejá null si no está.`;

    const user = `
Usuario: """${userText}"""
Contexto: ${JSON.stringify(current || {})}
Devolvé JSON:
{"servicio":...,"role":...,"aseguradora":...,"marca":...,"modelo":...,"anio":...,"patente":...,"cp":...,"intent_extra":...}`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    const data = JSON.parse(content);

    if (data.anio && !isYear(data.anio)) data.anio = null;
    if (data.cp && !isCP(data.cp)) data.cp = null;
    if (data.patente) {
      data.patente = normalizePlate(data.patente);
      if (!isPat(data.patente)) data.patente = null;
    }
    if (data.role) data.role = data.role.toUpperCase();
    const mapS = { "llave_nueva": "llave" };
    if (data.servicio) data.servicio = mapS[data.servicio] || data.servicio;

    return data;
  } catch (e) {
    console.error("OpenAI extract error:", e.message);
    return {};
  }
}

// ===== Webhook principal (Twiml) =====
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const text = clean(req.body.Body);
  let reply;

  let s = sessions.get(from);
  if (!s) { s = { stage: "menu", flow: null, data: {}, lastReply: "" }; sessions.set(from, s); }

  // Comandos globales
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  } else if (/humano|asesor|persona/i.test(text)) {
    reply = "Un asesor te contactará por este chat a la brevedad 🙌";
    await alertHumanSafe(from, `Pedido de humano — Cliente: ${from.replace("whatsapp:","")}`);
  } else if (/precio|cu[aá]nto sale|costo|vale/i.test(text)) {
    reply = "💰 El precio depende del tipo de llave/servicio. ¿Querés que un asesor confirme el valor exacto?";
    await alertHumanSafe(from, `Consulta de precios: “${text}” — ${from.replace("whatsapp:","")}`);
  } else if (/ubicaci[oó]n|d[oó]nde est[aá]n|direcci[oó]n|horarios?/i.test(text)) {
    reply = "📍 Av. Hipólito Yrigoyen 114, Morón. Horario: 9–13 y 14–17 hs.";
  } else {
    // IA: entendimiento + extracción
    const ai = await extractWithAI(text, s);

    // setear servicio/flow si viene de IA
    if (!s.flow && ai.servicio && ["duplicado","carcasa","llave"].includes(ai.servicio)) {
      s.flow = ai.servicio;
      s.stage = "collect";
    }

    // merge datos
    s.data = {
      ...s.data,
      ...Object.fromEntries(
        Object.entries(ai).filter(([k]) => ["role","aseguradora","marca","modelo","anio","patente","cp"].includes(k))
      )
    };

    // menú por números
    if (!s.flow) {
      if (/^1$/.test(text)) { s.flow="duplicado"; s.stage="collect"; }
      else if (/^2$/.test(text)) { s.flow="carcasa";  s.stage="collect"; }
      else if (/^3$/.test(text)) { s.flow="llave";    s.stage="collect"; }
      else reply = toMenu(s);
    }

    if (!reply && s.flow) {
      const need = ["marca","modelo","anio","patente","cp"];
      if (!s.data.role) need.unshift("role");
      if (s.data.role === "ASEGURADO" && !s.data.aseguradora) need.unshift("aseguradora");

      const faltan = need.filter(f => !s.data[f]);
      if (faltan.length > 0) {
        const pretty = faltan.map(f=>{
          if (f==="role") return "rol (Asegurado/Particular)";
          if (f==="anio") return "año (4 dígitos)";
          if (f==="cp")   return "código postal (4 dígitos)";
          return f;
        }).join(", ");

        let ejemplo = "La Caja, Ford Fiesta 2018, AB123CD, CP 1708";
        if (!faltan.includes("aseguradora")) ejemplo = "Ford Fiesta 2018, AB123CD, CP 1708";
        if (s.data.role === "PARTICULAR") ejemplo = "VW Gol 2017, AC123BD, CP 1407";

        reply =
`Perfecto. Para avanzar necesito: *${pretty}*.
Escribilo en *un solo mensaje* (ej: “${ejemplo}”).`;
        s.stage = "collect";
      } else {
        // tenemos todo → derivación + confirmación (MUESTRA SOLO DIRECCIÓN)
        const target = deriveByCP(s.data.cp, s.flow);
        s.data._target = target || null;

        const summary = compactSummary(s.data);
        const destino = target
          ? `\n📌 *Dirección sugerida según tu CP*: ${target.direccion}\nMapa: ${mapsLink(target.direccion)}`
          : `\n📌 *Dirección sugerida*: la confirmamos por este chat.`;

        reply = `${summary}${destino}\n\n¿Confirmás? *1 Sí* / *2 Corregir*`;
        s.stage = "confirm";
      }
    }

    if (s.stage === "confirm" && /^1$/.test(text)) {
      const d = s.data, now = new Date().toLocaleString("es-AR");
      await logToSheet([
        now, from.replace("whatsapp:",""), s.flow,
        d.role || "", d.aseguradora || "", d.marca || "", d.modelo || "", d.anio || "",
        d.patente || "", d.cp || "", d._target?.direccion || ""
      ]);

      // Aviso interno SOLO al equipo (no al proveedor)
      const baseSummary = compactSummary(d) + `\nServicio: ${s.flow}\nCliente: ${from.replace("whatsapp:","")}`;
      await alertHumanSafe(from, baseSummary + (d._target ? `\nDirección sugerida: ${d._target.direccion}` : ""));

      // Respuesta al cliente: SOLO DIRECCIÓN
      reply = d._target
        ? `✅ Listo. Registré tu solicitud.\nDirección más cercana según tu CP: *${d._target.direccion}*\nMapa: ${mapsLink(d._target.direccion)}\nUn asesor te confirmará la disponibilidad y horario por este chat.\n\n${toMenu(s)}`
        : `✅ Listo. Registré tu solicitud. Un asesor te confirmará la dirección y horario por este chat.\n\n${toMenu(s)}`;
    } else if (s.stage === "confirm" && /^2$/.test(text)) {
      s.stage = "collect";
      reply = "Sin problema. Indicame las correcciones en *un solo mensaje*.";
    }
  }

  // ---- Anti “OK” / anti-eco + TwiML ----
  const safeReply = (reply || "").trim();
  const isOkOnly  = /^ok\.?$/i.test(safeReply);
  const isDup     = safeReply && s.lastReply && safeReply === s.lastReply.trim();

  if (!safeReply || isOkOnly || isDup) return res.status(200).end();
  s.lastReply = safeReply;

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(safeReply);
  res.type("text/xml").send(twiml.toString());
});

// Healthcheck
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));
app.listen(process.env.PORT || 3000, () => console.log("UP on", process.env.PORT || 3000));
