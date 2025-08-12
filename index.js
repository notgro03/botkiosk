// index.js — Bot KiosKeys con IA (intenciones + extracción de datos)
import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---------------------------- Helpers ---------------------------------
const SALUDO =
  "¡Hola! Soy el asistente de *KiosKeys* 👋\n" +
  "Elegí una opción:\n\n" +
  "1) *Solicitud de duplicado*\n" +
  "2) *Cambio de carcasa*\n" +
  "3) *Llave nueva*\n\n" +
  "Respondé con *1, 2 o 3*. En cualquier momento escribí *0* o *menu* para volver al inicio.";

const sessions = new Map(); // key: whatsapp:+54... -> {stage, flow, data:{}}

const isYear = (y) => {
  const n = Number(String(y).trim());
  const Y = new Date().getFullYear();
  return Number.isFinite(n) && n >= 1980 && n <= Y + 1;
};
const normPat = (p = "") => p.toUpperCase().replace(/[^A-Z0-9]/g, "");
const ticket = () => Date.now().toString().slice(-6);

function newSession() { return { stage: "menu", flow: null, data: {} }; }
function toMenu(s) { s.stage = "menu"; s.flow = null; s.data = {}; return SALUDO; }
function pedirRol(s) { s.stage = "dup_rol"; return "¿Es *1) Asegurado* o *2) Particular*? Respondé 1 o 2."; }
function pedirMarca(s) { s.stage = `${s.flow}_marca`; return "Por favor, indicame la *marca* del vehículo."; }
function pedirModelo(s){ s.stage = `${s.flow}_modelo`; return "Gracias. ¿Cuál es el *modelo*?"; }
function pedirAnio(s)  { s.stage = `${s.flow}_anio`;   return "Perfecto. ¿En qué *año* fue fabricado? (ej: 2019)"; }
function pedirPatente(s){ s.stage = `${s.flow}_patente`; return "Por último, la *patente* (ej: ABC123 o AA123BB)."; }

async function alertHuman(text){
  const to = process.env.HUMAN_WHATSAPP_TO;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if(!to || !from) return;
  try{
    await client.messages.create({
      from,
      to: `whatsapp:${to.replace(/^whatsapp:/,"")}`,
      body: `🔔 *Handoff KiosKeys*\n${text}`
    });
  }catch(e){ console.error("Aviso humano:", e.message); }
}

// ------------------------ IA: extracción de datos ----------------------
async function nlu(userText, flowHint = null) {
  if (!process.env.OPENAI_API_KEY) return null;

  const sys =
`Actuás como un extractor de intención y datos para un bot de cerrajería.
Devolvés SIEMPRE un JSON con esta forma:

{
  "intent": "MENU|DUPLICADO|CARCASA|LLAVE|HUMANO|PRECIO|UBICACION|OTRO",
  "role": "ASEGURADO|PARTICULAR|null",
  "fields": {
    "marca": null,
    "modelo": null,
    "anio": null,
    "patente": null
  },
  "reply": "texto breve y profesional para el usuario"
}

Reglas:
- Detectá si el usuario ya dio marca, modelo, año, patente o si dice que es de seguro/particular.
- Si pide humano, intent = HUMANO.
- Si pregunta precios: intent = PRECIO.
- Si pregunta ubicación/horarios: intent = UBICACION.
- Si menciona duplicado/copia: intent = DUPLICADO.
- Si menciona carcasa: intent = CARCASA.
- Si menciona llave nueva: intent = LLAVE.
- La patente va en mayúsculas sin espacios ni guiones. Año debe ser numérico.
- No inventes datos. Si no está, dejalo null.
${flowHint ? `\nContexto: el usuario está en el flujo ${flowHint}.` : ""}`;

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userText }
    ]
  };

  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(res => res.json());

    const text = r?.choices?.[0]?.message?.content || "{}";
    const json = JSON.parse(text);
    return json;
  }catch(e){
    console.error("NLU error:", e.message);
    return null;
  }
}

// ---------------------------- Webhook ----------------------------------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const text = (req.body.Body || "").trim();

  let s = sessions.get(from) || newSession();
  sessions.set(from, s);

  let reply;

  // 0) Comandos rápidos
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  } else {
    // 1) IA: intento entender libremente lo que dijo
    const guess = await nlu(text, s.flow || (s.stage !== "menu" ? s.stage : null));

    // 2) Si estoy en menú (o sin estado)
    if (s.stage === "menu") {
      if (/^1$/.test(text) || guess?.intent === "DUPLICADO") {
        s.flow = "duplicado";
        // ya tengo rol?
        if (guess?.role) { s.data.role = guess.role; reply = pedirMarca(s); }
        else reply = pedirRol(s);
      } else if (/^2$/.test(text) || guess?.intent === "CARCASA") {
        s.flow = "carcasa"; reply = pedirMarca(s);
      } else if (/^3$/.test(text) || guess?.intent === "LLAVE") {
        s.flow = "llave"; reply = pedirMarca(s);
      } else if (/hola|buenas/i.test(text) || guess?.intent === "MENU") {
        reply = toMenu(s);
      } else if (guess?.intent === "PRECIO") {
        reply = "💰 Los precios dependen del tipo de llave o servicio. Un asesor puede confirmarte el valor exacto. ¿Querés que te pase con uno?";
        await alertHuman(`Consulta de precios: "${text}" — Cliente: ${from}`);
        reply += `\n\n${toMenu(s)}`;
      } else if (guess?.intent === "UBICACION") {
        reply = "📍 Estamos en Av. Hipólito Yrigoyen 114, Morón. Horarios: 9 a 13 y 14 a 17 hs.";
        reply += `\n\n${toMenu(s)}`;
      } else if (guess?.intent === "HUMANO") {
        await alertHuman(`Pide humano: "${text}" — Cliente: ${from}`);
        reply = "Te conecto con un asesor ahora mismo. 🙌";
        reply += `\n\n${toMenu(s)}`;
      } else {
        // default: mostrar menú
        reply = toMenu(s);
      }
    }
    // 3) Estoy en un paso del flujo → usar IA para completar campos y saltar preguntas
    else {
      const d = s.data;

      // pre-relleno con IA si vino algo
      if (guess?.fields) {
        if (guess.fields.marca)  d.marca  = d.marca  || guess.fields.marca;
        if (guess.fields.modelo) d.modelo = d.modelo || guess.fields.modelo;
        if (guess.fields.anio && isYear(guess.fields.anio)) d.anio = d.anio || String(guess.fields.anio);
        if (guess.fields.patente) d.patente = d.patente || normPat(guess.fields.patente);
        if (guess.role && !d.role) d.role = guess.role;
      }

      switch (s.stage) {
        // DUPLICADO: rol
        case "dup_rol": {
          if (/^1$/.test(text) || /asegurad/i.test(text)) d.role = "ASEGURADO";
          else if (/^2$/.test(text) || /particular/i.test(text)) d.role = "PARTICULAR";

          if (!d.role) { reply = "Por favor respondé *1 (Asegurado)* o *2 (Particular)*."; break; }
          reply = d.marca ? pedirModelo(s) : pedirMarca(s);
          break;
        }

        // MARCA → MODELO → AÑO → PATENTE (para cualquier flujo)
        case "duplicado_marca":
        case "carcasa_marca":
        case "llave_marca": {
          d.marca = d.marca || text;
          reply = d.modelo ? pedirAnio(s) : pedirModelo(s);
          break;
        }
        case "duplicado_modelo":
        case "carcasa_modelo":
        case "llave_modelo": {
          d.modelo = d.modelo || text;
          reply = d.anio ? pedirPatente(s) : pedirAnio(s);
          break;
        }
        case "duplicado_anio":
        case "carcasa_anio":
        case "llave_anio": {
          if (!d.anio) {
            if (!isYear(text)) { reply = "El *año* no parece válido. Ej: 2019."; break; }
            d.anio = String(text).trim();
          }
          reply = d.patente ? finalize() : pedirPatente(s);
          break;
        }
        case "duplicado_patente":
        case "carcasa_patente":
        case "llave_patente": {
          d.patente = d.patente || normPat(text);
          reply = finalize();
          break;
        }
        default:
          reply = toMenu(s);
      }

      // Finalizar: enviar a humano con resumen
      function finalize() {
        const sum =
          `Ticket: ${ticket()}\n` +
          `Gestión: ${s.flow}\n` +
          (d.role ? `Rol: ${d.role}\n` : "") +
          `Marca/Modelo/Año: ${[d.marca, d.modelo, d.anio].filter(Boolean).join(" ") || "-"}\n` +
          `Patente: ${d.patente || "-"}\n` +
          `Cliente: ${from.replace("whatsapp:","")}`;

        alertHuman(sum);
        // mensaje al cliente
        const msg =
          "✅ ¡Gracias! Ya tengo tus datos. En breve te contacta un asesor para continuar con tu solicitud.\n\n" +
          SALUDO;
        // reset
        toMenu(s);
        return msg;
      }
    }
  }

  // enviar solo si hay texto
  if (reply) {
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: from,
        body: reply
      });
    } catch (e) {
      console.error("Twilio send:", e.message);
    }
  }

  res.sendStatus(200);
});

// Healthcheck
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));

app.listen(PORT, () => console.log("UP on", PORT));
