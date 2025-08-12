import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const sessions = new Map();

const SALUDO =
  "¡Hola! Soy el asistente de *KiosKeys* 👋\n" +
  "Elegí una opción:\n\n" +
  "1) *Solicitud de duplicado*\n" +
  "2) *Cambio de carcasa*\n" +
  "3) *Llave nueva*\n\n" +
  "Respondé con *1, 2 o 3*. En cualquier momento escribí *0* o *menu* para volver al inicio.";

app.get("/", (_req, res) => res.send("Bot KiosKeys funcionando 🚀"));

function newSession() { return { stage: "menu", flow: null, data: {} }; }
function toMenu(s){ s.stage="menu"; s.flow=null; s.data={}; return SALUDO; }
function pedirRol(s){ s.stage="dup_rol"; return "¿Es *1) Asegurado* o *2) Particular*? Respondé 1 o 2."; }
function pedirMarca(s){ s.stage=`${s.flow}_marca`; return "Decime la *marca* del vehículo."; }
function pedirModelo(s){ s.stage=`${s.flow}_modelo`; return "Perfecto. ¿Cuál es el *modelo*?"; }
function pedirAnio(s){ s.stage=`${s.flow}_anio`; return "Gracias. Indicá el *año* (ej: 2018)."; }
function pedirPatente(s){ s.stage=`${s.flow}_patente`; return "Por último, la *patente* (ej: ABC123 o AA123BB)."; }
const isYear = y => { const n=+String(y).trim(); const Y=new Date().getFullYear(); return n>=1980 && n<=Y+1; };
const normPat = p => String(p).toUpperCase().replace(/[^A-Z0-9]/g,"");
const ticket = () => Date.now().toString().slice(-6);

async function alertHuman(msg){
  const to = process.env.HUMAN_WHATSAPP_TO, from = process.env.TWILIO_WHATSAPP_FROM;
  if(!to || !from) return;
  try{
    await client.messages.create({
      from,
      to: `whatsapp:${to.replace(/^whatsapp:/,"")}`,
      body: `🔔 *Handoff KiosKeys*\n${msg}`
    });
  }catch(e){ console.error("Aviso humano:", e.message); }
}

app.post("/whatsapp", async (req,res)=>{
  const from = req.body.From;
  const text = (req.body.Body||"").trim();

  let s = sessions.get(from) || newSession();
  sessions.set(from, s);

  let reply;

  // Menú forzado
  if (/^(0|menu|menú)$/i.test(text)) {
    reply = toMenu(s);
  }
  // Si estoy dentro de un paso
  else if (s.stage !== "menu") {
    const d = s.data;
    switch (s.stage) {
      case "dup_rol":
        if (/^1$/.test(text) || /asegurad/i.test(text)) d.role = "ASEGURADO";
        else if (/^2$/.test(text) || /particular/i.test(text)) d.role = "PARTICULAR";
        else { reply = "Por favor respondé *1 (Asegurado)* o *2 (Particular)*."; break; }
        reply = pedirMarca(s); break;

      case "duplicado_marca":
      case "carcasa_marca":
      case "llave_marca":
        d.marca = text; reply = pedirModelo(s); break;

      case "duplicado_modelo":
      case "carcasa_modelo":
      case "llave_modelo":
        d.modelo = text; reply = pedirAnio(s); break;

      case "duplicado_anio":
      case "carcasa_anio":
      case "llave_anio":
        if (!isYear(text)){ reply="El *año* no parece válido. Ej: *2018*."; break; }
        d.anio = String(text).trim(); reply = pedirPatente(s); break;

      case "duplicado_patente":
      case "carcasa_patente":
      case "llave_patente":
        d.patente = normPat(text);
        const resumen =
          `Ticket: ${ticket()}\n`+
          `Gestión: ${s.flow}\n`+
          (d.role?`Rol: ${d.role}\n`:"")+
          `Marca/Modelo/Año: ${[d.marca,d.modelo,d.anio].filter(Boolean).join(" ")||"-"}\n`+
          `Patente: ${d.patente||"-"}\n`+
          `Cliente: ${from.replace("whatsapp:","")}`;
        await alertHuman(resumen);
        reply =
          "¡Gracias! Ya tengo tus datos ✅\n"+
          "Te paso con un asesor para finalizar la gestión.\n\n"+
          SALUDO;
        toMenu(s);
        break;

      default:
        reply = toMenu(s);
    }
  }
  // Estoy en menú (o sin estado): interpreto opción
  else {
    if (/^1$/.test(text)) { s.flow="duplicado"; reply = pedirRol(s); }
    else if (/^2$/.test(text)) { s.flow="carcasa"; reply = pedirMarca(s); }
    else if (/^3$/.test(text)) { s.flow="llave";   reply = pedirMarca(s); }
    else if (/^hola|buenas/i.test(text)) { reply = toMenu(s); }
    else { reply = toMenu(s); }
  }

  try{
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: from,
      body: reply
    });
  }catch(e){ console.error("Twilio send:", e.message); }

  res.sendStatus(200);
});

app.listen(PORT, ()=> console.log("UP on", PORT));
