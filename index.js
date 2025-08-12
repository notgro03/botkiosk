import express from "express";
import fetch from "node-fetch";
import { load } from "cheerio";          // ✅ cheerio en ESM
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Necesario para leer el body x-www-form-urlencoded que envía Twilio
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---- RUTA DE SALUD
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));

// ---- SCRAPING DE PRODUCTOS (demo)
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
    const q = (req.query.q || "").toString();
    const productos = await scrapeProductos(q);
    res.json(productos);
  } catch (e) {
    console.error("Error /productos:", e);
    res.status(500).json({ error: "No se pudieron obtener los productos" });
  }
});

// ---- WEBHOOK WHATSAPP (Twilio -> tu bot)
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;              // ej: "whatsapp:+54911..."
  const body = (req.body.Body || "").trim();

  // reglas MUY simples para estar funcional
  let reply = "¡Hola! Soy el bot de KiosKeys. Decime: *productos*, *turno*, o *humano*.";

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
    // Opcional: avisar a un número interno
    if (process.env.HUMAN_WHATSAPP_TO) {
      try {
        await client.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: `whatsapp:${process.env.HUMAN_WHATSAPP_TO.replace(/^whatsapp:/,"")}`,
          body: `⚠️ Handoff: el cliente ${from} pidió humano.`
        });
      } catch (e) { console.error("No pude avisar a humano:", e.message); }
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
