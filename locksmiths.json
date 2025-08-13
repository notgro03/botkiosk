// index.js — KiosKeys Bot (IA + Derivación por CP + Aviso interno + Sheets + Upsell sin catálogo)
// locksmiths.json se carga desde archivo separado (./locksmiths.json)

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import OpenAI from "openai";
import { google } from "googleapis";
import fs from "fs";

// ---------------------------
// Config
// ---------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const KIOSKEYS_URL = process.env.KIOSKEYS_URL || "https://kioskeys.com";

// Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TW_FROM = process.env.TWILIO_WHATSAPP_FROM; // ej: "whatsapp:+14155238886"
const HUMAN_TO = (process.env.HUMAN_WHATSAPP_TO || "+5491133343981").replace(/^whatsapp:/, ""); // tu número por default

const toWhats = n => `whatsapp:${n.replace(/^whatsapp:/, "")}`;

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
/** Google Sheets
 *  - Si GOOGLE_SHEET_ID no está, crea la planilla y muestra el ID en logs
 *  - Variables necesarias:
 *    GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY (con \n escapados)
 */
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Solicitudes";
let sheets = null;
let SHEET_ID = process.env.GOOGLE_SHEET_ID || "";

async function initSheets() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) return;

  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive"
    ]
  );
  sheets = google.sheets({ version: "v4", auth });

  if (!SHEET_ID) {
    const title = `KiosKeys Bot - ${new Date().toISOString().slice(0,10)}`;
    const createRes = await google.sheets({ version: "v4", auth }).spreadsheets.create({
      requestBody: { properties: { title } }
    });
    SHEET_ID = createRes.data.spreadsheetId;
    console.log("✅ Sheets creado. GOOGLE_SHEET_ID =", SHEET_ID);
    console.log("👉 Copiá ese ID a la variable GOOGLE_SHEET_ID en Railway.");

    // Encabezados
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          "timestamp","telefono","servicio","rol","aseguradora",
          "marca","modelo","anio","patente","cp","direccion_sugerida","evento","extra"
        ]]
      }
    });
  }
}
initSheets().catch(console.error);

async function logToSheet({
  servicio="", rol="", aseguradora="", marca="", modelo="", anio="",
  patente="", cp="", direccion_sugerida="", telefono="", evento="", extra=""
}) {
  if (!sheets || !SHEET_ID) return;
  try {
    const ts = new Date().toLocaleString("es-AR");
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        ts, telefono, servicio, rol, aseguradora, marca, modelo, anio,
        patente, cp, direccion_sugerida, evento, extra
      ]] }
    });
  } catch (e) {
    console.error("Sheets append error:", e.message);
  }
}

// ---------------------------
// Locksmiths (SEPARADO)
// ---------------------------
let LOCKSMITHS = [];
try {
  LOCKSMITHS = JSON.parse(fs.readFileSync("./locksmiths.json", "utf8"));
  if (!Array.isArray(LOCKSMITHS) || LOCKSMITHS.length === 0) throw new Error("JSON vacío");
  console.log(`Locksmiths cargados: ${LOCKSMITHS.length}`);
} catch (e) {
  LOCKSMITHS = [];
  console.warn("⚠️ No pude cargar locksmiths.json. Derivación automática limitada:", e.message);
}

// ---------------------------
// Utilidades geo / derivación
// ---------------------------
const toRad = d => (d * Math.PI) / 180;
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
const hasGeo = x => typeof x.lat === "number" && typeof x.lon === "number";
const normalize = s => (s || "").toString().trim().toLowerCase();
function insurerMatch(shop, aseguradora) {
  if (!aseguradora) return false;
  const want = normalize(aseguradora);
  const list = (shop.aseguradoras || []).map(normalize);
  return list.some(x => x && (x === want || want.includes(x) || x.includes(want)));
}
const mapsLink = addr => `https://maps.google.com/?q=${encodeURIComponent(addr)}`;

function deriveByCPGeo({ cp, servicio, role, aseguradora, approxLat = null, approxLon = null }) {
  if (!LOCKSMITHS.length) return null;
  const wantCP = /^\d{4}$/.test(cp) ? cp : null;
  const wantRole = normalize(role);

  const byService = list =>
    list.filter(x => !servicio || !x.servicios || x.servicios.includes(servicio));

  const byInsurerIfNeeded = list => {
    if (wantRole !== "asegurado") return list;
    const withIns = list.filter(x => insurerMatch(x, aseguradora));
    return withIns.length ? withIns : list;
  };

  const sortByPriority = list => [...list].sort((a,b) => (b.prioridad||0) - (a.prioridad||0));

  // 1) CP exacto
  if (wantCP) {
    let exact = LOCKSMITHS.filter(x => x.cp === wantCP);
    exact = byService(exact);
    exact = byInsurerIfNeeded(exact);
    if (exact.length) return sortByPriority(exact)[0];
  }

  // 2) Prefijo 2 dígitos
  if (wantCP) {
    const pref2 = wantCP.slice(0,2);
    let zone = LOCKSMITHS.filter(x => (x.cp || "").slice(0,2) === pref2);
    zone = byService(zone);
    zone = byInsurerIfNeeded(zone);
    if (zone.length) return sortByPriority(zone)[0];
  }

  // 3) Geo real si hay lat/lon
  let rest = byService(LOCKSMITHS);
  rest = byInsurerIfNeeded(rest);

  if (approxLat != null && approxLon != null) {
    const withGeo = rest.filter(hasGeo);
    if (withGeo.length) {
      const ranked = withGeo
        .map(x => ({ ...x, dist: haversineKm(approxLat, approxLon, x.lat, x.lon) }))
        .sort((a,b) => a.dist - b.dist || (b.prioridad||0) - (a.prioridad||0));
      return ranked[0] || null;
    }
  }

  // 4) Fallback por distancia numérica de CP
  if (wantCP) {
    const fallback = rest
      .filter(x => /^\d{4}$/.test(x.cp))
      .map(x => ({ ...x, dist: Math.abs(Number(x.cp) - Number(wantCP)) }))
      .sort((a,b) => a.dist - b.dist || (b.prioridad||0) - (a.prioridad||0));
    if (fallback.length) return fallback[0];
  }

  return sortByPriority(rest)[0] || null;
}

// ---------------------------
// Sesiones y helpers
// ---------------------------
const sessions = new Map(); // from -> { stage, flow, data, lastReply }
const Y = new Date().getFullYear();
const isYear = v => /^\d{4}$/.test(v) && +v >= 1980 && +v <= Y + 1;
const isCP   = v => /^\d{4}$/.test(v);
const isPat  = v => /^(?:[A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z]{2})$/.test(v);
const clean  = t => (t || "").normalize("NFKC").trim();
const normalizePlate = p => clean(p).toUpperCase().replace(/[^A-Z0-9]/g, "");

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

// Aviso interno SOLO a vos (el cliente no lo ve)
async function notifyOwner(body) {
  if (!HUMAN_TO || !TW_FROM) return;
  try {
    await twilioClient.messages.create({
      from: TW_FROM,
      to: toWhats(HUMAN_TO),
      body
    });
  } catch (e) { console.error("No pude notificar al owner:", e.message); }
}

// Upsell sin catálogo
function upsellMenu(s) {
  s.stage = "upsell";
  return `¿Querés aprovechar algo más ahora mismo?

1) *Reemplazar carcasa* (consultar modelos)
2) *Duplicado extra* (dejarlo agendado)
3) *Hablar con un asesor*
0) *No, gracias*

Respondé con el número.`;
}

// ---------------------------
// IA: extracción de datos
// ---------------------------
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

// ---------------------------
// Webhook Twilio WhatsApp
// ---------------------------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const msg  = clean(req.body.Body || "");
  let reply;

  let s = sessions.get(from);
  if (!s) { s = { stage: "menu", flow: null, data: {}, lastReply: "" }; sessions.set(from, s); }

  // Comandos globales
  if (/^(0|menu|menú)$/i.test(msg)) {
    reply = toMenu(s);
  } else if (/humano|asesor|persona/i.test(msg)) {
    // No mostramos "handoff" al cliente: solo mensaje neutro + alerta interna para vos
    reply = "Perfecto, un asesor te contactará por este chat.";
    await notifyOwner(`🤝 Pedido de asesor — Cliente: ${from.replace("whatsapp:","")}\nMensaje: ${msg}`);
    await logToSheet({ telefono: from.replace("whatsapp:",""), evento: "ASESOR_SOLICITADO" });
  } else if (/precio|cu[aá]nto sale|costo|vale/i.test(msg)) {
    reply = "💰 El precio depende del tipo de llave/servicio. Un asesor puede confirmarte el valor exacto.";
    await notifyOwner(`💰 Consulta de precios — ${from.replace("whatsapp:","")} — “${msg}”`);
  } else if (/ubicaci[oó]n|d[oó]nde est[aá]n|direcci[oó]n|horarios?/i.test(msg)) {
    reply = "📍 Av. Hipólito Yrigoyen 114, Morón. Horario: 9–13 y 14–17 hs.";
  } else {
    // IA: entender e integrar datos
    const ai = await extractWithAI(msg, s);
    if (!s.flow && ai.servicio && ["duplicado","carcasa","llave"].includes(ai.servicio)) {
      s.flow = ai.servicio;
      s.stage = "collect";
    }
    s.data = {
      ...s.data,
      ...Object.fromEntries(
        Object.entries(ai).filter(([k]) => ["role","aseguradora","marca","modelo","anio","patente","cp"].includes(k))
      )
    };

    // Menú por números
    if (!s.flow && s.stage !== "upsell") {
      if (/^1$/.test(msg)) { s.flow="duplicado"; s.stage="collect"; }
      else if (/^2$/.test(msg)) { s.flow="carcasa";  s.stage="collect"; }
      else if (/^3$/.test(msg)) { s.flow="llave";    s.stage="collect"; }
      else reply = toMenu(s);
    }

    // Upsell
    if (!reply && s.stage === "upsell") {
      if (/^1$/.test(msg)) {
        reply = `Podés ver opciones de carcasas acá: ${KIOSKEYS_URL}\nSi querés ayuda, decí *asesor*.`;
        await logToSheet({ telefono: from.replace("whatsapp:",""), evento: "UPSELL_CARCASA" });
      } else if (/^2$/.test(msg)) {
        s.data.upsellDuplicadoExtra = true;
        reply = "Anotado un duplicado extra. Lo coordinamos con tu pedido principal. ¿Algo más? 1) Carcasa 3) Asesor 0) No, gracias";
        await logToSheet({ telefono: from.replace("whatsapp:",""), evento: "UPSELL_DUPLICADO_EXTRA" });
      } else if (/^3$/.test(msg)) {
        reply = "De acuerdo, un asesor te contactará por este chat.";
        await notifyOwner(`🤝 Asesor (upsell) — Cliente: ${from.replace("whatsapp:","")}`);
        await logToSheet({ telefono: from.replace("whatsapp:",""), evento: "HANDOFF_FROM_UPSELL" });
      } else if (/^0$/.test(msg)) {
        reply = `¡Gracias! Si necesitás algo más, estoy acá.\n\n${toMenu(s)}`;
      } else {
        reply = "No entendí. Opciones: 1) Carcasa 2) Duplicado extra 3) Asesor 0) No, gracias";
      }
    }

    // Flujo principal
    if (!reply && s.flow) {
      const faltan = requiredFields(s.flow, s.data).filter(f => !s.data[f]);
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
      } else if (s.stage !== "upsell") {
        // derivación + confirmación
        const target = deriveByCPGeo({
          cp: s.data.cp,
          servicio: s.flow,
          role: s.data.role,
          aseguradora: s.data.aseguradora
        });
        s.data._target = target || null;

        const summary = compactSummary(s.data);
        const destino = target
          ? `\n📌 *Dirección sugerida según tu CP*: ${target.direccion}\nMapa: ${mapsLink(target.direccion)}`
          : `\n📌 *Dirección sugerida*: la confirmamos por este chat.`;

        reply = `${summary}${destino}\n\n¿Confirmás? *1 Sí* / *2 Corregir*`;
        s.stage = "confirm";
      }
    }

    // Confirmación
    if (!reply && s.stage === "confirm" && /^1$/.test(msg)) {
      const d = s.data;
      await logToSheet({
        servicio: s.flow, rol: d.role || "", aseguradora: d.aseguradora || "",
        marca: d.marca || "", modelo: d.modelo || "", anio: d.anio || "",
        patente: d.patente || "", cp: d.cp || "", direccion_sugerida: d._target?.direccion || "",
        telefono: from.replace("whatsapp:",""), evento: "REQUEST_CONFIRMED"
      });

      // Aviso interno SOLO a vos
      const body =
        `🔔 Nuevo pedido confirmado\n` +
        `Cliente: ${from.replace("whatsapp:","")}\n` +
        `Servicio: ${s.flow}\n` +
        `Rol: ${d.role || "-"}  Aseguradora: ${d.aseguradora || "-"}\n` +
        `Vehículo: ${[d.marca,d.modelo,d.anio].filter(Boolean).join(" ")}\n` +
        `Patente: ${d.patente || "-"}  CP: ${d.cp || "-"}\n` +
        (d._target ? `Dirección sugerida: ${d._target.direccion}` : "Sin dirección sugerida");
      await notifyOwner(body);

      reply = d._target
        ? `✅ Listo. Registré tu solicitud.\nDirección más cercana según tu CP: *${d._target.direccion}*\nMapa: ${mapsLink(d._target.direccion)}\nUn asesor te confirmará la dirección y horario por este chat.\n\n${upsellMenu(s)}`
        : `✅ Listo. Registré tu solicitud. Un asesor te confirmará la dirección y horario por este chat.\n\n${upsellMenu(s)}`;
    } else if (!reply && s.stage === "confirm" && /^2$/.test(msg)) {
      s.stage = "collect";
      reply = "Sin problema. Indicame las correcciones en *un solo mensaje*.";
    }
  }

  // Respuesta Twilio (evitamos “ok” vacío y duplicados)
  const safeReply = (reply || "").trim();
  const isOkOnly  = /^ok\.?$/i.test(safeReply);
  const sRef = sessions.get(from);
  const isDup     = safeReply && sRef?.lastReply && safeReply === sRef.lastReply.trim();

  if (!safeReply || isOkOnly || isDup) {
    const twiml = new twilio.twiml.MessagingResponse();
    return res.type("text/xml").send(twiml.toString());
  }
  sRef.lastReply = safeReply;

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(safeReply);
  res.type("text/xml").send(twiml.toString());
});

// Health
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));
app.listen(PORT, () => console.log("UP on", PORT));
