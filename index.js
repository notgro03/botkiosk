import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Twilio } from "twilio";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio client
const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Función para procesar con IA
async function iaResponder(texto) {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sos el asistente de KiosKeys. Respondé breve, clara y con tono cordial. Si es un pedido de llave o derivación, pedí ubicación y datos necesarios." },
          { role: "user", content: texto }
        ]
      })
    }).then(x => x.json());

    return r.choices?.[0]?.message?.content || "No te entendí, ¿me repetís?";
  } catch (err) {
    console.error("Error en IA:", err);
    return "Hubo un problema al procesar tu mensaje.";
  }
}

// Webhook para mensajes entrantes de WhatsApp
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;   // Ej: "whatsapp:+54911..."
  const body = req.body.Body || "";

  console.log("Mensaje recibido:", from, body);

  const reply = await iaResponder(body);

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: from,
    body: reply
  });

  res.sendStatus(200);
});

// Ruta básica de prueba
app.get("/", (_, res) => res.send("Bot KiosKeys funcionando 🚀"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot escuchando en puerto", process.env.PORT || 3000);
});
