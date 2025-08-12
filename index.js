import express from "express";
import fetch from "node-fetch";
import { load } from "cheerio"; // ✅ Forma correcta de importar cheerio

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Bot KiosKeys funcionando 🚀");
});

// Ejemplo: Scraping de KiosKeys
app.get("/productos", async (req, res) => {
  try {
    const response = await fetch("https://kioskeys.com/");
    const body = await response.text();

    // Cargar HTML con cheerio
    const $ = load(body);

    let productos = [];
    $(".product").each((i, el) => {
      productos.push({
        nombre: $(el).find(".product-title").text().trim(),
        precio: $(el).find(".price").text().trim(),
        link: $(el).find("a").attr("href"),
      });
    });

    res.json(productos);
  } catch (error) {
    console.error("Error al obtener productos:", error);
    res.status(500).json({ error: "No se pudieron obtener los productos" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
