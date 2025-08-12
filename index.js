// index.js
import express from "express";
import { load } from "cheerio";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Healthcheck
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));

// --- Scraping demo usando fetch nativo (Node 18+)
async function scrapeProductos(query = "") {
  const resp = await fetch("https://kioskeys.com/");
  const html = await resp.text();
  const $ = load(html);

  const items = [];
  $(".product").each((_, el) => {
    const nombre = $(el).find(".product-title").text().trim();
    const precio = $(el).find(".price").text().trim();
    const link = $(el).find("a").attr("href");
    if (!query || nombre.toLowerCase().includes(query.toLowerCase())) {
      items.push({ nombre, precio, link });
    }
  });

  return items.slice(0, 5);
}

app.get("/productos", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const productos = await scrapeProductos(q);
    res.json(productos);
  } catch (e) {
    console.error("Error /productos:", e);
    res.status(500).json({ error: "No se pudieron obtener los productos" });
  }
});

// --- Webhook de WhatsApp (Twilio -> tu bot)
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;                 // "whatsapp:+54911..."
  const body = (req.body.Body || "").trim();

  let reply = "¡Hola! Soy el bot de KiosKeys. Decime: *productos*, *turno* o *humano*.";

  if (/^hola|buenas/i.test(body)) {
    reply = "¡Hola! ¿En qué puedo ayudarte? (productos / turno / humano)";
  } else if (/producto/i.test(body)) {
    const q = body.replace(/producto[s]?:?/i, "").trim();
    try {
      const items = await scrapeProductos(q);
      reply = items.length
        ? items.map(p => `• ${p.nombre} — ${p.precio}\n${p.link ?? ""}`).join("\n\n")
        : "No encontré productos para esa búsqueda.";
    } catch (e) {
      console.error("Error productos:", e);
      reply = "No pude obtener los productos ahora. Probá más tarde 🙏";
    }
  } else if (/turno|cita|agendar/i.test(body)) {
    reply = "Genial. Decime *particular* o *seguro* y la *patente*. Luego te pido el resto.";
  } else if (/humano|asesor|persona/i.test(body)) {
    reply = "Te paso con un asesor ahora mismo. Aguantame un segundo 🙌";
    if (process.env.HUMAN_WHATSAPP_TO) {
      try {
        await client.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: `whatsapp:${process.env.HUMAN_WHATSAPP_TO.replace(/^whatsapp:/, "")}`,
          body: `⚠️ Handoff: el cliente ${from} pidió humano.`
        });
      } catch (e) {
        console.error("No pude avisar a humano:", e.message);
      }
    }
  }

  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: from,
      body: reply
    });
  } catch (e) {
    console.error("Error enviando WhatsApp:", e);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log("Servidor escuchando en", PORT));
