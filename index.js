import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import fetch from "node-fetch";
import cheerio from "cheerio"; // npm i cheerio

dotenv.config();
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---- Cache muy simple (MVP)
const mem = {
  kioskeysHtml: null,
  kioskeysText: null,
  kioskeysFetchedAt: 0,
  sessions: new Map(), // key: phone -> {stage, data:{}}
};

// ---- 1) Fetch & parse de kioskeys.com (RAG liviano)
async function getKioskeysText() {
  const maxAgeMs = 1000 * 60 * 30; // cache 30 min
  if (Date.now() - mem.kioskeysFetchedAt < maxAgeMs && mem.kioskeysText) return mem.kioskeysText;

  const url = process.env.KIOSKEYS_SITE_URL || "https://kioskeys.com";
  const html = await fetch(url).then(r => r.text()).catch(()=>null);
  if (!html) return mem.kioskeysText || "KiosKeys: sitio no disponible ahora.";
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ").trim();
  mem.kioskeysHtml = html;
  mem.kioskeysText = text.slice(0, 4000); // limitamos contexto
  mem.kioskeysFetchedAt = Date.now();
  return mem.kioskeysText;
}

// ---- 2) IA: función que devuelve intención + entidades estructuradas
async function nlu(userText, session) {
  const siteText = await getKioskeysText();

  const body = {
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
`Sos el asistente de KiosKeys. Respondé breve y accionable.
Devolvé SIEMPRE un JSON con:
{ "intent": "INFO|PEDIR_LLAVE|PEDIR_TURNO|PRODUCTOS|DERIVAR|HUMANO",
  "role": "PARTICULAR|SEGURO|null",
  "fields": { "aseguradora": null, "patente": null, "cp": null, "marca": null, "modelo": null, "anio": null, "consulta": null, "query": null },
  "reply": "texto breve para el usuario" }
Usá este contexto del sitio para responder dudas:
${siteText}`
      },
      { role: "user", content: userText }
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }).then(x=>x.json());

  try {
    const json = JSON.parse(r.choices?.[0]?.message?.content || "{}");
    return json;
  } catch {
    return { intent: "INFO", role: null, fields: { consulta: userText }, reply: "Te ayudo con eso." };
  }
}

// ---- 3) Derivación por código postal (usando tu mapa)
import fs from "fs";
let ZIP_MAP = {};
try {
  // archivo JSON: [{cp:"1708", nombre:"Cerrajería X", whatsapp:"+54...", servicios:["presencia","corte"], lat:-34.6, lon:-58.7 }]
  const raw = fs.readFileSync("./locksmiths.json","utf8");
  const arr = JSON.parse(raw);
  ZIP_MAP = arr.reduce((acc, x)=>{
    acc[x.cp] = acc[x.cp] || [];
    acc[x.cp].push(x);
    return acc;
  }, {});
} catch (e) {
  console.warn("No encontré locksmiths.json, derivación limitada:", e.message);
}

function deriveByCP(cp, servicio="llave") {
  if (!cp || !ZIP_MAP[cp]) return null;
  // simple: primera de la lista, podés ordenar por rating/servicio
  return ZIP_MAP[cp][0];
}

// ---- 4) Tienda Nube: listar productos/precios/links
async function tnListProducts(query="") {
  if (!process.env.TN_SHOP_ID || !process.env.TN_ACCESS_TOKEN) return [];
  // Doc: GET /products
  const url = `https://api.tiendanube.com/v1/${process.env.TN_SHOP_ID}/products?per_page=5&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: {
      "Authentication": `bearer ${process.env.TN_ACCESS_TOKEN}`,
      "User-Agent": "kioskeys-bot (kioskeys.com)"
    }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data || []).map(p => ({
    id: p.id,
    name: p.name?.es || p.name?.en || p.name,
    price: p.variants?.[0]?.price,
    url: p.handle ? `https://${process.env.TN_DOMAIN}/products/${p.handle}` : null
  }));
}

// ---- 5) Handoff humano (manda alerta a tu número/Grupo)
async function alertHuman(msg) {
  if (!process.env.HUMAN_WHATSAPP_TO) return;
  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${process.env.HUMAN_WHATSAPP_TO.replace(/^whatsapp:/,"")}`,
      body: `⚠️ Handoff: ${msg}`
    });
  } catch (e) { console.error("No pude avisar a humano:", e.message); }
}

// ---- 6) Orquestación principal
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;         // "whatsapp:+54911..."
  const text = (req.body.Body || "").trim();

  // estado por sesión (MVP en memoria)
  const s = mem.sessions.get(from) || { stage: "idle", data: {} };

  // NLU
  const act = await nlu(text, s);
  const f = act.fields || {};
  let reply = act.reply || "Listo.";

  // Normalización de role/datos
  if (act.role) s.data.role = act.role;                  // PARTICULAR | SEGURO
  if (f.aseguradora) s.data.aseguradora = f.aseguradora;
  if (f.patente) s.data.patente = f.patente?.toUpperCase();
  if (f.cp) s.data.cp = f.cp;
  if (f.marca) s.data.marca = f.marca;
  if (f.modelo) s.data.modelo = f.modelo;
  if (f.anio) s.data.anio = f.anio;

  // Reglas de diálogo mínimas para completar datos de pedido
  if (act.intent === "PEDIR_LLAVE" || act.intent === "PEDIR_TURNO" || act.intent === "DERIVAR") {
    // pedir rol
    if (!s.data.role) {
      reply = "¿El pedido es *PARTICULAR* o por *SEGURO*?";
      s.stage = "ask_role";
    } else if (s.data.role === "SEGURO" && !s.data.aseguradora) {
      reply = "Decime la *aseguradora*.";
      s.stage = "ask_aseguradora";
    } else if (!s.data.patente) {
      reply = "Pasame la *patente* (ej: ABC123 o AA123BB).";
      s.stage = "ask_patente";
    } else if (!s.data.cp) {
      reply = "Decime tu *código postal* (solo números).";
      s.stage = "ask_cp";
    } else {
      // derivar
      const target = deriveByCP(s.data.cp, "llave");
      if (target) {
        reply =
`Listo ✅
Te derivo a *${target.nombre}* (CP ${s.data.cp}).
Te van a contactar por WhatsApp: ${target.whatsapp}.
*Ticket*: ${Date.now().toString().slice(-6)}.

¿Querés que te pase con un humano ahora?`;
        // Notificar a cerrajero (plantilla básica)
        try {
          await client.messages.create({
            from: process.env.TWILIO_WHATSAPP_FROM,
            to: `whatsapp:${target.whatsapp.replace("+","")}`,
            body:
`🔔 Nuevo pedido KiosKeys:
Rol: ${s.data.role}
Aseguradora: ${s.data.aseguradora || "-"}
Patente: ${s.data.patente}
CP: ${s.data.cp}
Marca/Modelo/Año: ${[s.data.marca,s.data.modelo,s.data.anio].filter(Boolean).join(" ") || "-"}
Cliente: ${from.replace("whatsapp:","")}`
          });
        } catch (e) { console.error("No pude notificar cerrajero:", e.message); }

        s.stage = "handoff_offer";
      } else {
        reply = "No encontré cerrajerías para ese CP. Pasame *una zona cercana* o CP alternativo.";
        s.stage = "ask_cp";
      }
    }
  }

  // Intent: productos (Tienda Nube)
  if (act.intent === "PRODUCTOS") {
    const q = f.query || text;
    const items = await tnListProducts(q);
    if (items.length === 0) {
      reply = "No encontré productos para esa búsqueda. Probá con otra palabra.";
    } else {
      reply = items.map(p => `• ${p.name} - $${p.price} \n${p.url ? p.url : ""}`).join("\n\n");
    }
  }

  // Intent: humano
  if (act.intent === "HUMANO" || /humano|asesor|persona/i.test(text)) {
    await alertHuman(`Cliente ${from} pide humano. Datos: ${JSON.stringify(s.data)}`);
    reply = "Te paso con un asesor ahora mismo. Aguantame un segundo 🙌";
    s.stage = "handoff";
  }

  // Guardar sesión
  mem.sessions.set(from, s);

  // Responder 1 sola vez
  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: from,
      body: reply
    });
  } catch (e) {
    console.error("Error al responder:", e.message);
  }
  res.sendStatus(200);
});

// Healthcheck
app.get("/", (_, res) => res.send("Bot KiosKeys funcionando 🚀"));
app.listen(process.env.PORT || 3000, () => console.log("UP"));
