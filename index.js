import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ====== Estado por sesión ======
const sessions = new Map(); // key: From -> { stage, flow, data, lastReply }

// ====== Helpers de diálogo ======
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
  return "¿Es *1) Asegurado* o *2) Particular*? Respondé con 1 o 2.";
}

// ====== Aviso interno (silencioso para el cliente) ======
async function alertHumanSafe(clientFrom, summary) {
  const to = (process.env.HUMAN_WHATSAPP_TO || "").replace(/^whatsapp:/, "");
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!to || !from) return; // sin destino configurado
  const normalizedClient = (clientFrom || "").replace(/^whatsapp:/, "");
  if (to === normalizedClient) return; // no avises al mismo chat del cliente

  try {
    await client.messages.create({
      from,
      to: `whatsapp:${to}`,
      body: `🔔 Aviso interno KiosKeys\n${summary}`,
    });
  } catch (e) {
    console.error("No pude avisar a humano:", e.message);
  }
}

// ====== Webhook principal ======
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;                  // "whatsapp:+54911..."
  const text = (req.body.Body || "").trim();

  let s = sessions.get(from);
  if (!s) {
    s = { stage: "menu", flow: null, data: {}, lastReply: "" };
    sessions.set(from, s);
  }

  let reply; // lo que eventualmente enviaremos al cliente

  // ---- Comandos globales
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  }
  // ---- Comprensión básica fuera de flujo
  else if (/precio|cu[aá]nto sale|costo|vale/i.test(text)) {
    reply =
      "💰 Los precios dependen del tipo de llave o servicio. Un asesor podrá confirmarte el valor exacto. ¿Querés que te contacte un asesor?";
    await alertHumanSafe(
      from,
      `Consulta de precios: "${text}" — Cliente: ${from.replace("whatsapp:", "")}`
    );
  } else if (/ubicaci[oó]n|d[oó]nde est[aá]n|direcci[oó]n|horarios?/i.test(text)) {
    reply =
      "📍 Estamos en Av. Hipólito Yrigoyen 114, Morón. Horario de atención: 9:00–13:00 y 14:00–17:00 hs.";
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
        const resumen =
          `Solicitud: ${s.flow}\n` +
          (d.role ? `Rol: ${d.role}\n` : "") +
          `Marca: ${d.marca}\nModelo: ${d.modelo}\nAño: ${d.anio}\nPatente: ${d.patente}\n` +
          `Cliente: ${from.replace("whatsapp:", "")}`;

        await alertHumanSafe(from, resumen);

        reply =
          "✅ Perfecto. Ya registré tu solicitud. En breve, un asesor se comunicará por este mismo chat para continuar.";
        // volvemos a menú limpio
        reply += `\n\n${toMenu(s)}`;
        break;
      }

      default:
        reply = toMenu(s);
    }
  }
  // ---- Estoy en menú: interpretar opción
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

  // ====== ANTI-“OK” / ANTI-ECO ======
  // 1) no enviar si reply es vacío
  // 2) no enviar si reply es "ok" (cualquier combinación)
  // 3) no enviar si es igual a la última respuesta enviada
  const safeReply = (reply || "").trim();
  const isOkOnly = /^ok\.?$/i.test(safeReply);
  const isDuplicate = safeReply && s.lastReply && safeReply === s.lastReply.trim();

  if (safeReply && !isOkOnly && !isDuplicate) {
    try {
      // log opcional para depurar
      console.log("OUTBOUND >>", from, "||", safeReply.slice(0, 120));
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: from,
        body: safeReply,
      });
      s.lastReply = safeReply;
    } catch (e) {
      console.error("Twilio send error:", e.message);
    }
  }

  // devolvemos 200 sin cuerpo (Twilio no necesita TwiML si usamos API saliente)
  res.sendStatus(200);
});

// ====== Healthcheck ======
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));
app.listen(process.env.PORT || 3000, () =>
  console.log("UP on", process.env.PORT || 3000)
);
