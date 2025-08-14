// index.js — Flujo avanzado básico: menú + datos en 1 mensaje + derivación por CP + handoff sandbox
// Requisitos: Twilio Sandbox + locksmiths.json en la raíz del repo.

import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT    = process.env.PORT || 3000;
const client  = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Twilio (SANDBOX por ahora)
const TW_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";        // sandbox sender
const OWNER   = (process.env.HUMAN_WHATSAPP_TO || "+5491133343981").replace(/^whatsapp:/,""); // tu número admin
const toWhats = n => `whatsapp:${n.replace(/^whatsapp:/,"")}`;

// ---------- Cargar cerrajerías ----------
let LOCKSMITHS = [];
try {
  LOCKSMITHS = JSON.parse(fs.readFileSync("./locksmiths.json", "utf8"));
  if (!Array.isArray(LOCKSMITHS) || LOCKSMITHS.length === 0) throw new Error("JSON vacío");
  console.log(`Locksmiths cargados: ${LOCKSMITHS.length}`);
} catch (e) {
  console.error("No pude cargar locksmiths.json:", e.message);
  LOCKSMITHS = [];
}

// ---------- Derivación por CP ----------
function deriveByCP(cp, servicio = null) {
  if (!/^\d{4}$/.test(cp) || LOCKSMITHS.length === 0) return null;

  const byService = list =>
    list.filter(x => !servicio || !x.servicios || x.servicios.includes(servicio));

  const byPriority = list => [...list].sort((a,b) => (b.prioridad||0) - (a.prioridad||0));

  // 1) CP exacto
  let exact = byService(LOCKSMITHS.filter(x => x.cp === cp));
  if (exact.length) return byPriority(exact)[0];

  // 2) Misma zona (prefijo 2 dígitos)
  const pref2 = cp.slice(0,2);
  let zone = byService(LOCKSMITHS.filter(x => (x.cp||"").slice(0,2) === pref2));
  if (zone.length) return byPriority(zone)[0];

  // 3) Distancia numérica de CP
  let nearest = byService(
    LOCKSMITHS.filter(x => /^\d{4}$/.test(x.cp))
      .map(x => ({ ...x, dist: Math.abs(Number(x.cp) - Number(cp)) }))
  ).sort((a,b) => a.dist - b.dist || (b.prioridad||0) - (a.prioridad||0));

  return nearest[0] || null;
}

const mapsLink = addr => `https://maps.google.com/?q=${encodeURIComponent(addr)}`;

// ---------- Helpers / Sesiones ----------
const S = new Map(); // from -> { stage, flow, data, lastReply }
const Y = new Date().getFullYear();
const clean = t => (t || "").normalize("NFKC").trim();
const isCP   = v => /^\d{4}$/.test(v);
const isYear = v => /^\d{4}$/.test(v) && +v >= 1980 && +v <= Y + 1;
const isPat  = v => /^(?:[A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z]{2})$/.test(v);
const normPlate = p => clean(p).toUpperCase().replace(/[^A-Z0-9]/g, "");

function menu(s){
  s.stage="menu"; s.flow=null; s.data={};
  return `👋 ¡Bienvenido a *KiosKeys*!
Elegí una opción (respondé con número):

1) *Solicitud de duplicado*
2) *Cambio de carcasa*
3) *Llave nueva*
4) *Hablar con un asesor*

En cualquier momento escribí *0* o *menu* para volver acá.`;
}

function faltantes(flow, d) {
  const req = ["marca","modelo","anio","patente","cp"];   // todo junto
  if (!d.role) req.unshift("role");
  if (d.role === "ASEGURADO" && !d.aseguradora) req.unshift("aseguradora");
  return req.filter(k => !d[k]);
}

function pedirTodo(flow, d) {
  const pretty = faltantes(flow, d).map(k=>{
    if (k==="role") return "Rol (Asegurado/Particular)";
    if (k==="aseguradora") return "Aseguradora";
    if (k==="anio") return "Año (4 dígitos)";
    if (k==="cp") return "CP (4 dígitos)";
    if (k==="patente") return "Patente (ABC123 o AA123BB)";
    return k[0].toUpperCase()+k.slice(1);
  }).join(", ");
  const ej = (d.role==="ASEGURADO")
    ? `Asegurado (La Caja), Ford Fiesta, 2018, AB123CD, CP 1708`
    : `Particular, VW Gol, 2017, AC123BD, CP 1407`;
  return `Perfecto. Para avanzar, enviá *en un solo mensaje*:
- ${pretty}
Ejemplo: "${ej}"`;
}

function resumen(d, flow){
  const L=(k,v)=>v?`• ${k}: ${v}\n`:"";
  return (
`📝 *Resumen*
• Servicio: ${flow}
${L("Rol",d.role)}${L("Aseguradora",d.aseguradora)}${L("Marca",d.marca)}${L("Modelo",d.modelo)}${L("Año",d.anio)}${L("Patente",d.patente)}${L("CP",d.cp)}`
  ).trim();
}

// parsing liviano
function absorber(d, text){
  const t = text;

  if (/asegurad/i.test(t)) d.role="ASEGURADO";
  if (/particular/i.test(t)) d.role="PARTICULAR";

  const aseg = t.match(/(la caja|sancor|galeno|sura|zurich|mapfre|allianz|meridional|provincia seguros)/i);
  if (aseg && d.role==="ASEGURADO") d.aseguradora = aseg[0].replace(/\s+/g," ").trim();

  const y = t.match(/\b(19|20)\d{2}\b/);
  if (y && isYear(y[0])) d.anio = y[0];

  const cp = t.match(/\b\d{4}\b/);
  if (cp && isCP(cp[0])) d.cp = cp[0];

  const p1 = t.match(/\b[A-Z]{3}\d{3}\b/i);
  const p2 = t.match(/\b[A-Z]{2}\d{3}[A-Z]{2}\b/i);
  const pat = (p2?.[0] || p1?.[0]);
  if (pat) {
    const np = normPlate(pat);
    if (isPat(np)) d.patente = np;
  }

  // Marca/Modelo heurística simple (dos tokens con mayúscula)
  if (!d.marca || !d.modelo) {
    const mm = t.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\s+([A-Z0-9ÁÉÍÓÚÑ][a-z0-9áéíóúñ]+)\b/);
    if (mm && !d.marca && !d.modelo) {
      d.marca = mm[1]; d.modelo = mm[2];
    }
  }
}

// ---------- Webhook Twilio ----------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const text = clean(req.body.Body || "");
  let reply;

  let s = S.get(from);
  if (!s) { s = { stage:"menu", flow:null, data:{}, lastReply:"" }; S.set(from, s); }

  // comandos globales
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = menu(s);
  } else if (s.stage === "menu") {
    if (/^1$/.test(text) || /duplicad/i.test(text)) {
      s.flow="duplicado"; s.stage="collect"; reply = pedirTodo(s.flow, s.data);
    } else if (/^2$/.test(text) || /carcasa/i.test(text)) {
      s.flow="carcasa"; s.stage="collect"; reply = pedirTodo(s.flow, s.data);
    } else if (/^3$/.test(text) || /llave\s*nueva|llave\s*0km|^llave$/i.test(text)) {
      s.flow="llave"; s.stage="collect"; reply = pedirTodo(s.flow, s.data);
    } else if (/^4$/.test(text) || /asesor|humano|persona/i.test(text)) {
      reply = "Perfecto, un asesor te contactará por este chat.";
      // aviso interno a vos (cliente no lo ve)
      try {
        await client.messages.create({
          from: TW_FROM,
          to: toWhats(OWNER),
          body: `🤝 Pedido de asesor — Cliente: ${from.replace("whatsapp:","")} — Mensaje: ${text}`
        });
      } catch (e) { console.error("Aviso asesor falló:", e.message); }
    } else {
      reply = menu(s);
    }
  } else if (s.stage === "collect") {
    absorber(s.data, text);

    const faltan = faltantes(s.flow, s.data);
    if (faltan.length) {
      reply = pedirTodo(s.flow, s.data);
    } else {
      const target = deriveByCP(s.data.cp, s.flow);
      s.data._target = target || null;

      const destino = target
        ? `\n📌 *Dirección sugerida según tu CP*: ${target.direccion}\n🔗 ${mapsLink(target.direccion)}`
        : `\n📌 *Dirección sugerida*: la confirmamos por este chat.`;

      reply = `${resumen(s.data, s.flow)}${destino}\n\n¿Confirmás? *1 Sí* / *2 Corregir*`;
      s.stage = "confirm";
    }
  } else if (s.stage === "confirm") {
    if (/^1$/.test(text)) {
      const d = s.data;
      // handoff interno (sandbox → a tu número)
      try {
        await client.messages.create({
          from: TW_FROM,
          to: toWhats(OWNER),
          body:
`🔔 Nuevo pedido confirmado
Cliente: ${from.replace("whatsapp:","")}
Servicio: ${s.flow}
Rol: ${d.role || "-"}  Aseguradora: ${d.aseguradora || "-"}
Vehículo: ${[d.marca,d.modelo,d.anio].filter(Boolean).join(" ")}
Patente: ${d.patente || "-"}  CP: ${d.cp || "-"}
${d._target ? `Dirección sugerida: ${d._target.direccion}` : "Sin dirección sugerida"}`
        });
      } catch (e) { console.error("Handoff falló:", e.message); }

      reply = d._target
        ? `✅ Listo. Registré tu solicitud.
Dirección más cercana según tu CP: *${d._target.direccion}*
🔗 ${mapsLink(d._target.direccion)}
Un asesor te confirmará por este chat.

Escribí *menu* para volver al inicio.`
        : `✅ Listo. Registré tu solicitud. Un asesor te confirmará por este chat.

Escribí *menu* para volver al inicio.`;
      s.stage="done";
    } else if (/^2$/.test(text)) {
      s.stage="collect";
      reply = "De acuerdo, indicame las correcciones en *un solo mensaje* (Rol, Aseguradora si corresponde, Marca, Modelo, Año, Patente y CP).";
    } else {
      reply = "¿Confirmás? *1 Sí* / *2 Corregir*";
    }
  } else {
    reply = "¿Seguimos? Escribí *menu* para iniciar una nueva gestión.";
  }

  // evitar “ok”/duplicados
  const safe=(reply||"").trim();
  const isOkOnly=/^ok\.?$/i.test(safe);
  const dup=safe && s.lastReply && safe===s.lastReply.trim();
  if (!safe || isOkOnly || dup) {
    const twiml=new twilio.twiml.MessagingResponse();
    return res.type("text/xml").send(twiml.toString());
  }
  s.lastReply=safe;

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(safe);
  res.type("text/xml").send(twiml.toString());
});

// ---------- Endpoints de prueba ----------
app.get("/", (_req,res)=>res.send("Bot KiosKeys (flujo avanzado básico) funcionando 🚀"));
app.get("/test/owner", async (_req,res)=>{
  try{
    await client.messages.create({
      from: TW_FROM,
      to: toWhats(OWNER),
      body: "📣 Test: si ves este mensaje, el sandbox puede mandarte el handoff."
    });
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get("/test/derive/:cp",(req,res)=>{
  const cp=(req.params.cp||"").trim();
  const t=deriveByCP(cp);
  if(t) res.json({ok:true,cp,direccion:t.direccion,maps:mapsLink(t.direccion)});
  else  res.json({ok:false,cp,error:"Sin coincidencias"});
});

// ---------- UP ----------
app.listen(PORT, ()=>console.log("UP on", PORT));
