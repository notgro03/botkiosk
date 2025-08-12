import express from "express";
import { load } from "cheerio";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// body parsers (Twilio manda x-www-form-urlencoded)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Healthcheck
app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));

// --- Scraping demo (usa fetch nativo de Node 18)
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
