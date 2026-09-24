/* ============================================================
   SERVIDOR CENTRAL — ¡Forma el número! Multijugador
   ============================================================
   - Sincroniza dados y objetivo para TODOS los jugadores.
   - Recibe la primera respuesta correcta y asigna el punto.
   - Gestiona rondas, tiempo y marcador global.
   ============================================================ */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUERTO = 3000;
const MAX_JUGADORES = 30;
const MAX_RONDAS = 5;
const TIEMPO_RONDA = 300; // segundos

// ============================================================
// SERVIDOR HTTP (sirve el index.html)
// ============================================================
const servidorHTTP = http.createServer((req, res) => {
  let archivo = req.url === '/' ? '/index.html' : req.url;
  const ruta = path.join(__dirname, 'public', archivo);
  fs.readFile(ruta, (err, data) => {
    if (err) { res.writeHead(404); res.end('No encontrado'); return; }
    const ext = path.extname(ruta);
    const tipos = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript' };
    res.writeHead(200, { 'Content-Type': tipos[ext] || 'text/plain' });
    res.end(data);
  });
});

// ============================================================
// SERVIDOR WEBSOCKET
// ============================================================
const wss = new WebSocket.Server({ server: servidorHTTP });

// Estado global del juego
const juego = {
  jugadores: new Map(),   // ws -> { id, nombre, puntos }
  ronda: 1,
  dados: [0,0,0,0],
  objetivo: 0,
  timerId: null,
  tiempoRestante: TIEMPO_RONDA,
  respuestasRonda: new Set(), // ids que ya respondieron esta ronda
  estado: 'esperando'     // 'esperando' | 'jugando' | 'resuelta'
};

let contadorId = 1;

// ============================================================
// UTILIDADES
// ============================================================
function broadcast(mensaje, excepto = null) {
  const data = JSON.stringify(mensaje);
  wss.clients.forEach(cliente => {
    if (cliente.readyState === WebSocket.OPEN && cliente !== excepto) {
      cliente.send(data);
    }
  });
}

function enviarA(ws, mensaje) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(mensaje));
}

function listaJugadores() {
  return [...juego.jugadores.values()].map(j => ({
    id: j.id, nombre: j.nombre, puntos: j.puntos
  })).sort((a,b) => b.puntos - a.puntos);
}

function enviarEstadoCompleto(ws) {
  enviarA(ws, {
    tipo: 'estado',
    ronda: juego.ronda,
    maxRondas: MAX_RONDAS,
    estado: juego.estado,
    jugadores: listaJugadores(),
    dados: juego.dados,
    objetivo: juego.objetivo,
    tiempoRestante: juego.tiempoRestante
  });
}

// ============================================================
// LÓGICA DE RONDAS
// ============================================================
function lanzarDados() {
  if (juego.estado === 'jugando') return;

  juego.dados = [0,0,0,0].map(() => Math.floor(Math.random()*6)+1);
  juego.objetivo = Math.floor(Math.random()*6)+1;
  juego.respuestasRonda.clear();
  juego.tiempoRestante = TIEMPO_RONDA;
  juego.estado = 'jugando';

  broadcast({
    tipo: 'ronda_iniciada',
    ronda: juego.ronda,
    dados: juego.dados,
    objetivo: juego.objetivo,
    tiempoRestante: juego.tiempoRestante
  });

  iniciarTimer();
}

function iniciarTimer() {
  if (juego.timerId) clearInterval(juego.timerId);
  juego.timerId = setInterval(() => {
    juego.tiempoRestante--;
    broadcast({ tipo: 'tick', tiempoRestante: juego.tiempoRestante });
    if (juego.tiempoRestante <= 0) {
      clearInterval(juego.timerId);
      juego.timerId = null;
      finalizarRonda(null);
    }
  }, 1000);
}

function finalizarRonda(ganadorId) {
  if (juego.timerId) { clearInterval(juego.timerId); juego.timerId = null; }
  juego.estado = 'resuelta';

  if (ganadorId !== null) {
    const jugador = [...juego.jugadores.values()].find(j => j.id === ganadorId);
    if (jugador) jugador.puntos++;
  }

  broadcast({
    tipo: 'ronda_finalizada',
    ganadorId: ganadorId,
    jugadores: listaJugadores(),
    objetivo: juego.objetivo
  });

  // Esperar 4 segundos y pasar a la siguiente ronda
  setTimeout(() => {
    juego.ronda++;
    if (juego.ronda > MAX_RONDAS) {
      broadcast({
        tipo: 'juego_terminado',
        jugadores: listaJugadores()
      });
      juego.ronda = 1;
      juego.jugadores.forEach(j => j.puntos = 0);
      juego.estado = 'esperando';
      return;
    }
    juego.estado = 'esperando';
    broadcast({
      tipo: 'esperando_ronda',
      ronda: juego.ronda,
      maxRondas: MAX_RONDAS
    });
    // Auto-lanzar la siguiente ronda después de 3s
    setTimeout(lanzarDados, 3000);
  }, 4000);
}

// ============================================================
// VALIDACIÓN DE EXPRESIONES (en el servidor, por seguridad)
// ============================================================
function validarExpresion(expresion, dados) {
  const limpia = expresion.replace(/\s/g, "");

  // Quitar exponentes de comodines para extraer números
  let soloNums = limpia.replace(/\^0/g, "").replace(/\)\^2/g, ")").replace(/\^\d+/g, "");
  const nums = (soloNums.match(/\d+/g) || []).map(n => parseInt(n));

  // No concatenar dígitos
  for (const n of soloNums.match(/\d+/g) || []) {
    if (n.length > 1) return { ok:false, msg:`Número inválido: ${n}. No puedes concatenar dados.` };
  }

  // Comparar con los dados
  const ordenados = [...nums].sort((a,b) => a-b);
  const dadosOrd = [...dados].sort((a,b) => a-b);
  if (JSON.stringify(ordenados) !== JSON.stringify(dadosOrd)) {
    return { ok:false, msg:"Debes usar exactamente los 4 números de los dados, cada uno una vez." };
  }

  // Validar comodín 1
  const c1 = [...limpia.matchAll(/(\d+)\^0/g)].map(m => parseInt(m[1]));
  const c1Val = c1.filter(n => dados.includes(n));
  if (c1Val.length > 1) return { ok:false, msg:"Comodín 1 usado más de una vez." };
  if (c1.length > 0 && c1Val.length === 0) return { ok:false, msg:"Comodín 1 mal aplicado." };

  // Validar comodín 2
  const c2 = [...limpia.matchAll(/\((\d+)\+(\d+)\)\^2/g)].map(m => [parseInt(m[1]), parseInt(m[2])]);
  const c2Val = c2.filter(([a,b]) => dados.includes(a) && dados.includes(b));
  if (c2Val.length > 1) return { ok:false, msg:"Comodín 2 usado más de una vez." };
  if (c2.length > 0 && c2Val.length === 0) return { ok:false, msg:"Comodín 2 mal aplicado." };

  return { ok:true, numeros:nums };
}

function evaluarExpresion(expr) {
  let e = expr.replace(/\^/g, "**");
  e = e.replace(/√(\d+)/g, "Math.sqrt($1)");
  e = e.replace(/√/g, "Math.sqrt");
  // Solo permitir caracteres matemáticos seguros
  if (!/^[0-9+\-*/().\s*]+$/.test(e.replace(/Math\.sqrt/g, ""))) {
    throw new Error("Caracteres no permitidos");
  }
  return Function('"use strict"; return (' + e + ')')();
}

// ============================================================
// CONEXIONES WEBSOCKET
// ============================================================
wss.on('connection', (ws) => {
  if (juego.jugadores.size >= MAX_JUGADORES) {
    enviarA(ws, { tipo: 'error', msg: 'Servidor lleno (máx. 30 jugadores).' });
    ws.close();
    return;
  }

  const id = contadorId++;
  ws.jugadorId = id;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- Registro ---
    if (msg.tipo === 'unirse') {
      const nombre = (msg.nombre || `Jugador ${id}`).slice(0, 20);
      juego.jugadores.set(ws, { id, nombre, puntos: 0 });
      enviarA(ws, { tipo: 'bienvenida', id, nombre });
      enviarEstadoCompleto(ws);
      broadcast({ tipo: 'jugadores_actualizados', jugadores: listaJugadores() });

      // Si es el primero y no hay ronda activa, iniciar
      if (juego.jugadores.size === 1 && juego.estado === 'esperando') {
        setTimeout(() => { if (juego.estado === 'esperando') lanzarDados(); }, 2000);
      }
      return;
    }

    // --- Respuesta de un jugador ---
    if (msg.tipo === 'respuesta') {
      if (juego.estado !== 'jugando') {
        enviarA(ws, { tipo: 'respuesta_rechazada', msg: 'La ronda no está activa.' });
        return;
      }
      if (juego.respuestasRonda.has(id)) {
        enviarA(ws, { tipo: 'respuesta_rechazada', msg: 'Ya enviaste una respuesta esta ronda.' });
        return;
      }

      const validacion = validarExpresion(msg.expresion, juego.dados);
      if (!validacion.ok) {
        enviarA(ws, { tipo: 'respuesta_incorrecta', msg: validacion.msg });
        return;
      }

      let resultado;
      try { resultado = evaluarExpresion(msg.expresion); }
      catch (e) {
        enviarA(ws, { tipo: 'respuesta_incorrecta', msg: 'Expresión no válida.' });
        return;
      }

      if (Math.abs(resultado - juego.objetivo) < 1e-9) {
        // ¡Ganador de la ronda!
        juego.respuestasRonda.add(id);
        finalizarRonda(id);
      } else {
        enviarA(ws, {
          tipo: 'respuesta_incorrecta',
          msg: `Tu resultado fue ${resultado}, el objetivo es ${juego.objetivo}.`
        });
      }
      return;
    }

    // --- Chat / ping ---
    if (msg.tipo === 'ping') enviarA(ws, { tipo: 'pong' });
  });

  ws.on('close', () => {
    const jugador = juego.jugadores.get(ws);
    if (jugador) {
      juego.jugadores.delete(ws);
      broadcast({ tipo: 'jugadores_actualizados', jugadores: listaJugadores() });
    }
  });
});

// ============================================================
// INICIO
// ============================================================
servidorHTTP.listen(PUERTO, () => {
  console.log(`✅ Servidor listo en http://localhost:${PUERTO}`);
  console.log(`   Los jugadores deben conectarse a esa dirección.`);
});