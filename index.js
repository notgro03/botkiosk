// ==== helper: alerta a humano SIN molestar al cliente ====
async function alertHumanSafe(clientFrom, summary) {
  const to = (process.env.HUMAN_WHATSAPP_TO || "").replace(/^whatsapp:/, "");
  const from = process.env.TWILIO_WHATSAPP_FROM;

  // si no hay destino o es el mismo que el cliente, no enviamos alerta
  if (!to || !from) return;
  const normalizedClient = clientFrom.replace(/^whatsapp:/, "");
  if (to === normalizedClient) return;

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

// ==== webhook principal (reemplazá TODO tu app.post("/whatsapp", ...) por esto) ====
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;                 // "whatsapp:+54911..."
  const text = (req.body.Body || "").trim();

  let s = sessions.get(from);
  if (!s) {
    s = { stage: "menu", flow: null, data: {}, lastReply: "" };
    sessions.set(from, s);
  }

  let reply;

  // --------- NLP básico “corta” para preguntas comunes ---------
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  } else if (/precio|cu[aá]nto sale|costo|vale/i.test(text)) {
    reply = "💰 Los precios dependen del tipo de llave o servicio. Un asesor puede confirmarte el valor exacto. ¿Querés que te conecte con uno?";
    // aviso interno si corresponde (y NO al mismo chat)
    await alertHumanSafe(from, `Consulta de precios: "${text}" — Cliente: ${from.replace("whatsapp:","")}`);
    reply += `\n\n${toMenu(s)}`;
  } else if (/ubicaci[oó]n|d[oó]nde est[aá]n|direcci[oó]n|horarios?/i.test(text)) {
    reply = "📍 Estamos en Av. Hipólito Yrigoyen 114, Morón. Horario de atención: 9 a 13 y 14 a 17 hs.";
    reply += `\n\n${toMenu(s)}`;
  }
  // --------- si estoy en flujo activo, sigo el paso a paso ---------
  else if (s.stage !== "menu") {
    const d = s.data;

    switch (s.stage) {
      // DUPLICADO: elegir rol
      case "dup_rol": {
        if (/^1$/.test(text) || /asegurad/i.test(text)) {
          d.role = "ASEGURADO";
          reply = "Perfecto. Ahora indicame la *marca* del vehículo.";
          s.stage = "duplicado_marca";
        } else if (/^2$/.test(text) || /particular/i.test(text)) {
          d.role = "PARTICULAR";
          reply = "Entendido. Ahora indicame la *marca* del vehículo.";
          s.stage = "duplicado_marca";
        } else {
          reply = "Por favor respondé con *1 (Asegurado)* o *2 (Particular)*.";
        }
        break;
      }
      // MARCA → MODELO → AÑO → PATENTE
      case "duplicado_marca":
      case "carcasa_marca":
      case "llave_marca": {
        d.marca = text;
        reply = "Gracias. ¿Cuál es el *modelo*?";
        s.stage = `${s.flow}_modelo`;
        break;
      }
      case "duplicado_modelo":
      case "carcasa_modelo":
      case "llave_modelo": {
        d.modelo = text;
        reply = "Perfecto. ¿En qué *año* fue fabricado? (ej: 2019)";
        s.stage = `${s.flow}_anio`;
        break;
      }
      case "duplicado_anio":
      case "carcasa_anio":
      case "llave_anio": {
        const n = Number(text);
        const Y = new Date().getFullYear();
        if (!Number.isFinite(n) || n < 1980 || n > Y + 1) {
          reply = "El *año* no parece válido. Por ejemplo: *2019*.";
          break;
        }
        d.anio = String(n);
        reply = "Gracias. Por último, indicame la *patente* (ej: ABC123 o AA123BB).";
        s.stage = `${s.flow}_patente`;
        break;
      }
      case "duplicado_patente":
      case "carcasa_patente":
      case "llave_patente": {
        d.patente = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const resumen =
          `Ticket: ${Date.now().toString().slice(-6)}\n` +
          `Gestión: ${s.flow}\n` +
          (d.role ? `Rol: ${d.role}\n` : "") +
          `Marca/Modelo/Año: ${[d.marca, d.modelo, d.anio].filter(Boolean).join(" ")}\n` +
          `Patente: ${d.patente}\n` +
          `Cliente: ${from.replace("whatsapp:", "")}`;

        // Aviso interno solo si NO es el mismo chat
        await alertHumanSafe(from, resumen);

        reply = "✅ ¡Listo! Ya tomé tus datos. Te conecto con un asesor para continuar.";
        // volver a menú limpio
        s.stage = "menu";
        s.flow = null;
        s.data = {};
        reply += `\n\n${toMenu(s)}`;
        break;
      }
      default:
        reply = toMenu(s);
    }
  }
  // --------- estoy en menú: interpreto opciones ---------
  else {
    if (/^1$/.test(text) || /duplicad/i.test(text)) {
      s.flow = "duplicado";
      reply = "¿Es *1) Asegurado* o *2) Particular*? Respondé 1 o 2.";
      s.stage = "dup_rol";
    } else if (/^2$/.test(text) || /carcasa/i.test(text)) {
      s.flow = "carcasa";
      reply = "Perfecto. Indicane la *marca* del vehículo.";
      s.stage = "carcasa_marca";
    } else if (/^3$/.test(text) || /llave nueva/i.test(text)) {
      s.flow = "llave";
      reply = "Perfecto. Indicane la *marca* del vehículo.";
      s.stage = "llave_marca";
    } else if (/hola|buenas/i.test(text)) {
      reply = toMenu(s);
    } else {
      reply = toMenu(s);
    }
  }

  // ------- ANTI “OK”: solo enviamos si hay contenido y no es igual al último -------
  if (reply && reply.trim() && reply.trim() !== s.lastReply?.trim()) {
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: from,
        body: reply
      });
      s.lastReply = reply; // guardamos para evitar repeticiones
    } catch (e) {
      console.error("Twilio send:", e.message);
    }
  }

  res.sendStatus(200);
});
