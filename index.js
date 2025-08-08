import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";           // 👈 import default (no { Twilio })
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Cliente Twilio (con import default)
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---- IA
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
          { role: "system", content: "Sos el asistente de KiosKeys. Respondé breve y accionable. Acciones: INFO, DERIVAR, AGENDAR." },
          { role: "user", content: texto }
        ]
      })
    }).then(x => x.json());

    return r.choices?.[0]?.message?.content || "No te entendí, ¿me repetís?";
  } catch (e) {
    console.error("Error IA:", e);
    return "Tuve un problema procesando tu mensaje.";
  }
}

// ---- Webhook WhatsApp
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From || "";
  const body = req.body.Body || "";

  console.log("Mensaje:", from, body);

  const reply = await iaResponder(body);

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: from,
    body: reply
  });

  res.sendStatus(200);
});

// Healthcheck
app.get("/", (_, res) => res.send("Bot KiosKeys funcionando 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot escuchando en puerto", PORT));
