import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const sessions = new Map();

// -------------------- Función menú principal --------------------
function toMenu(session) {
  session.stage = "menu";
  session.flow = null;
  session.data = {};
  return `¡Hola! Soy el asistente virtual de *KiosKeys* 👋
Estoy aquí para ayudarte con tu consulta.

Elegí una opción:
1) *Solicitud de duplicado*
2) *Cambio de carcasa*
3) *Llave nueva*

Respondé con *1, 2 o 3*. En cualquier momento escribí *0* o *menu* para volver aquí.`;
}

// -------------------- Función para avisar a humano --------------------
async function alertHumanSafe(clientFrom, summary) {
  const to = (process.env.HUMAN_WHATSAPP_TO || "").replace(/^whatsapp:/, "");
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!to || !from) return;
  const normalizedClient = clientFrom.replace(/^whatsapp:/, "");
  if (to === normalizedClient) return; // evita que el cliente vea el mensaje interno

  try {
    await client.messages.create({
      from,
      to: `whatsapp:${to}`,
      body: `🔔 Aviso interno KiosKeys\n${summary}`
    });
  } catch (e) {
    console.error("No pude avisar a humano:", e.message);
  }
}

// -------------------- Webhook de WhatsApp --------------------
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const text = (req.body.Body || "").trim();

  let s = sessions.get(from);
  if (!s) {
    s = { stage: "menu", flow: null, data: {}, lastReply: "" };
    sessions.set(from, s);
  }

  let reply;

  // ---------- Comandos globales ----------
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  }

  // ---------- Comprensión de texto / preguntas directas ----------
  else if (/precio|cu[aá]nto sale|costo|vale/i.test(text)) {
    reply = "💰 Los precios dependen del tipo de llave o servicio. Un asesor podrá confirmarte el valor exacto. ¿Querés que te ponga en contacto con uno?";
    await alertHumanSafe(from, `Consulta de precios: "${text}" — Cliente: ${from.replace("whatsapp:", "")}`);
  } else if (/ubicaci[oó]n|d[oó]nde est[aá]n|direcci[oó]n/i.test(text)) {
    reply = "📍 Estamos en Av. Hipólito Yrigoyen 114, Morón. Horarios: 9:00 a 13:00 y 14:00 a 17:00 hs.";
  }

  // ---------- Flujos guiados ----------
  else if (s.stage !== "menu") {
    const d = s.data;
    switch (s.stage) {
      case "dup_rol":
        if (/^1$/.test(text) || /asegurad/i.test(text)) {
          d.role = "ASEGURADO";
          reply = "Perfecto. Indicame la *marca* del vehículo.";
          s.stage = "duplicado_marca";
        } else if (/^2$/.test(text) || /particular/i.test(text)) {
          d.role = "PARTICULAR";
          reply = "Entendido. Indicame la *marca* del vehículo.";
          s.stage = "duplicado_marca";
        } else {
          reply = "Por favor, respondé con *1 (Asegurado)* o *2 (Particular)*.";
        }
        break;

      case "duplicado_marca":
      case "carcasa_marca":
      case "llave_marca":
        d.marca = text;
        reply = "Gracias. ¿Cuál es el *modelo*?";
        s.stage = `${s.flow}_modelo`;
        break;

      case "duplicado_modelo":
      case "carcasa_modelo":
      case "llave_modelo":
        d.modelo = text;
        reply = "Perfecto. ¿En qué *año* fue fabricado? (ej: 2019)";
        s.stage = `${s.flow}_anio`;
        break;

      case "duplicado_anio":
      case "carcasa_anio":
      case "llave_anio":
        const year = Number(text);
        const currentYear = new Date().getFullYear();
        if (!Number.isFinite(year) || year < 1980 || year > currentYear + 1) {
          reply = "El año no parece válido. Por ejemplo: *2019*.";
        } else {
          d.anio = String(year);
          reply = "Por último, indicame la *patente* (ej: ABC123 o AA123BB).";
          s.stage = `${s.flow}_patente`;
        }
        break;

      case "duplicado_patente":
      case "carcasa_patente":
      case "llave_patente":
        d.patente = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const resumen =
          `Solicitud: ${s.flow}\n` +
          (d.role ? `Rol: ${d.role}\n` : "") +
          `Marca: ${d.marca}\nModelo: ${d.modelo}\nAño: ${d.anio}\nPatente: ${d.patente}\nCliente: ${from.replace("whatsapp:", "")}`;
        await alertHumanSafe(from, resumen);
        reply = "✅ Perfecto. Ya tengo todos tus datos. En breve, un asesor se comunicará por este mismo chat para continuar con tu solicitud.";
        s.stage = "menu";
        s.flow = null;
        s.data = {};
        break;
    }
  }

  // ---------- Selección de menú ----------
  else {
    if (/^1$/.test(text) || /duplicad/i.test(text)) {
      s.flow = "duplicado";
      s.stage = "dup_rol";
      reply = "¿Es *1) Asegurado* o *2) Particular*? Respondé 1 o 2.";
    } else if (/^2$/.test(text) || /carcasa/i.test(text)) {
      s.flow = "carcasa";
      s.stage = "carcasa_marca";
      reply = "Perfecto. Indicame la *marca* del vehículo.";
    } else if (/^3$/.test(text) || /llave nueva/i.test(text)) {
      s.flow = "llave";
      s.stage = "llave_marca";
      reply = "Perfecto. Indicame la *marca* del vehículo.";
    } else {
      reply = toMenu(s);
    }
  }

  // ---------- Anti repetición ----------
  if (reply && reply.trim() && reply.trim() !== s.lastReply?.trim()) {
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: from,
        body: reply
      });
      s.lastReply = reply;
    } catch (e) {
      console.error("Error enviando mensaje:", e.message);
    }
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor escuchando...");
});
