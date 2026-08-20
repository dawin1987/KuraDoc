/* ═══════════════════════════════════════════════════════════════════
   KuraDoc — Módulo de Impresión Dual (Térmica 80mm + Hoja Carta)
   © 2026 KuraDoc. Todos los derechos reservados.

   ARQUITECTURA:
   ┌─────────────────────────────────────────────────────────────┐
   │  1. _kdPrint.detectarTerMica()  — Detección de impresora    │
   │  2. generarHTMLTicket80mm()     — Plantilla POS 80mm        │
   │  3. generarHTMLTicketCarta()    — Plantilla Hoja Carta      │
   │  4. ejecutarImpresion()         — Despacho + window.print() │
   │  5. imprimirTicket80mm()        — Forzar térmica            │
   │  6. imprimirTicketCarta()       — Forzar carta/PDF          │
   │  7. imprimirTicketAutomatico()  — Detección automática      │
   │  8. abrirModalTicketCita()      — Modal (REEMPLAZA original)│
   └─────────────────────────────────────────────────────────────┘

   COMPATIBILIDAD:
   • Usa appState.citas y appState.users (sin nuevas consultas Firebase)
   • Funciona offline
   • Compatible móvil y desktop
   • Mantiene lógica QZ Tray + RawBT + Fallback HTML existente
   • NO rompe ninguna función existente
═══════════════════════════════════════════════════════════════════ */

// ──────────────────────────────────────────────────────────────────
// NAMESPACE INTERNO — evita colisiones con código existente
// ──────────────────────────────────────────────────────────────────
window._kdPrint = window._kdPrint || {};

// ══════════════════════════════════════════════════════════════════
// §1  UTILIDADES INTERNAS
// ══════════════════════════════════════════════════════════════════

/** Devuelve el usuario (médico o paciente) desde appState.users */
function _kdGetUser(uid) {
    if (!uid || !appState?.users) return null;
    return appState.users.find(u => (u.uid || u.id) === uid) || null;
}

/** Formatea fecha YYYY-MM-DD → "lun. 02 jun. 2025" */
function _kdFechaBonita(fechaStr, largo) {
    if (!fechaStr) return '—';
    try {
        const opts = largo
            ? { weekday: 'long',  day: '2-digit', month: 'long',  year: 'numeric' }
            : { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' };
        return new Date(fechaStr + 'T12:00:00').toLocaleDateString('es-DO', opts);
    } catch(e) { return fechaStr; }
}

/** Devuelve emoji + texto de tanda */
function _kdTanda(tanda) {
    return (tanda || '').toLowerCase().includes('vespert')
        ? { texto: 'Vespertina · 2:00 PM', emoji: '🌆' }
        : { texto: 'Matutina · 8:00 AM',   emoji: '🌅' };
}

/** Obtiene email y clave del paciente desde appState.users */
function _kdDatosPaciente(cita) {
    const pac = _kdGetUser(cita.pacienteId);
    return {
        email : pac?.email || cita.emailPaciente || '—',
        clave : pac?.clave || '—',
        telefono: pac?.telefono || cita.telefonoPaciente || '—',
        nombre: pac?.nombre  || cita.nombrePaciente || '—',
    };
}

/** Obtiene datos del médico / centro */
function _kdDatosMedico(cita) {
    const med    = _kdGetUser(cita.medicoId);
    const centro = appState?.centrosMedicos?.find(c => c.id === (med?.centroMedicoId || cita.centroId));
    return {
        nombre     : med?.nombre        || cita.nombreMedico       || '—',
        especialidad: med?.especialidad || cita.especialidadMedico  || '—',
        telefono   : med?.telefono      || centro?.telefono         || '—',
        email      : med?.email         || '—',
        centro     : centro?.nombre     || cita.nombreCentro        || '—',
        direccion  : centro?.direccion  || med?.direccion           || '—',
        whatsapp   : centro?.whatsapp   || med?.whatsapp            || med?.telefono || '—',
        sitioWeb   : centro?.sitioWeb   || med?.sitioWeb            || '',
        logo       : med?.logoEspecialidadUrl || centro?.logoUrl    || '',
        redes      : centro?.redesSociales    || med?.redesSociales || '',
    };
}

// ══════════════════════════════════════════════════════════════════
// §2  DETECCIÓN DE IMPRESORA TÉRMICA
//     Reutiliza la lógica existente: QZ Tray para PC, RawBT para Android
// ══════════════════════════════════════════════════════════════════

/**
 * Detecta si hay impresora térmica disponible.
 * Devuelve: { tipo: 'termica'|'normal', metodo: 'qz'|'rawbt'|'fallback' }
 */
window._kdPrint.detectarTerMica = async function() {
    // Android → RawBT (siempre intenta térmica)
    if (window._esAndroid && window._esAndroid()) {
        return { tipo: 'termica', metodo: 'rawbt' };
    }

    // PC → intentar QZ Tray
    try {
        const conectado = await window._conectarQZ();
        if (conectado) {
            const impresoras = await qz.printers.find();
            const termica = impresoras.find(p =>
                /thermal|termic|58mm|80mm|pos|receipt|epson|xprinter|bixolon|citizen|star|tsc/i.test(p)
            );
            if (termica) return { tipo: 'termica', metodo: 'qz', impresora: termica };
        }
    } catch(e) {
        console.warn('[KDPrint] QZ no disponible, usando fallback:', e.message);
    }

    // Sin impresora térmica → hoja carta
    return { tipo: 'normal', metodo: 'fallback' };
};

// ══════════════════════════════════════════════════════════════════
// §3  GENERADOR HTML — PLANTILLA TÉRMICA 80MM
// ══════════════════════════════════════════════════════════════════

window.generarHTMLTicket80mm = function(cita) {
    const pac    = _kdDatosPaciente(cita);
    const med    = _kdDatosMedico(cita);
    const tanda  = _kdTanda(cita.tanda);
    const fecha  = _kdFechaBonita(cita.fechaStr, false);
    const token  = cita.tokenConfirmacion || cita.id || '—';
    const urlQR  = cita.urlConfirmacion   || '';
    const turno  = cita.ordenAtencion     || cita.numeroOrden || '?';
    const seguro = cita.seguroMedicoPaciente || '';

    // Aviso de seguridad para credenciales
    const tieneCredenciales = pac.email !== '—' && pac.clave !== '—';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket KuraDoc · Turno #${turno}</title>
<style>
/* ── Reset ── */
*{margin:0;padding:0;box-sizing:border-box;}

/* ── Pantalla: centrar preview ── */
body{
  background:#e5e7eb;
  display:flex;
  justify-content:center;
  padding:20px;
  font-family:'Courier New',Courier,monospace;
}

/* ── Tarjeta del ticket ── */
.ticket{
  text-align: center;
  background:#fff;
  width:80mm;
  max-width:80mm;
  padding:6mm 5mm 8mm;
  border-radius:4px;
  box-shadow:0 4px 20px rgba(0,0,0,.15);
  font-size:11px;
  color:#0f172a;
  line-height:1.4;
}

/* ── Print: ajustar a 80mm real ── */
@media print{
  @page{
    size:80mm auto;
    margin:0;
  }
  body{
    background:none;
    padding:0;
    display:block;
    width:80mm;
  }
  .ticket{
    width:80mm;
    max-width:80mm;
    box-shadow:none;
    border-radius:0;
    padding:4mm 4mm 6mm;
    page-break-inside:avoid;
  }
  .no-print{display:none!important;}
  img{max-width:100%!important;}
}

/* ── Tipografía ── */
.t-center{text-align:center;}
.t-left  {text-align:left;}
.bold    {font-weight:900;font-size: 13px;}
.small   {font-size:9px;}
.tiny    {font-size:8px;color:#64748b;}

/* ── Logo / Encabezado ── */
.hdr-logo{
  display:flex;
  flex-direction:column;
  align-items:center;
  padding-bottom:1mm;
  margin-bottom:1mm;
}
.hdr-title{
  font-size:16px;
  font-weight:900;
  letter-spacing:1px;
  text-transform:uppercase;
  color:#0f172a;
}
.hdr-sub{font-size:11px;color:#333333;margin-top:1px;}
.hdr-logo-img{max-height:15mm;max-width:58mm;object-fit:contain;margin-bottom:1mm;}

/* ── Turno ── */
.turno-box{
  text-align:center;
  padding:1mm 0;
  border-top:2px dashed #0f172a;
  border-bottom:2px dashed #0f172a;
  margin:1mm 0 1mm;
}
.turno-label{font-size:9px;font-weight:700;letter-spacing:2px;color:#475569;text-transform:uppercase;}
.turno-num  {font-size:19px;font-weight:900;line-height:1;color:#0f172a;}

/* ── Sección ── */
.sec{margin-bottom:1mm;}
.sec-label{
  font-size:8px;font-weight:800;letter-spacing:1.5px;
  text-transform:uppercase;color:#94a3b8;margin-bottom:1mm;
}
.sec-val{font-size:11px;font-weight:700;color:#0f172a;word-break:break-word;}
.sec-val-sm{font-size:10px;color:#334155;word-break:break-word;}

/* ── Separador ── */
.sep{border:none;border-top:1px dashed #cbd5e1;margin:0.9mm 0;}

/* ── Fila de datos ── */
.row{display:flex;gap:2mm;margin-bottom:0.2mm;align-items:baseline;}
.row-icon{font-size:1px;flex-shrink:0;width:1px;}
.row-text{color:#1e293b;flex:1;word-break:break-word;}

/* ── QR ── */
.qr-zone{
  display:flex;
  flex-direction:column;
  align-items:center;
  margin:1mm 0 1mm;
  padding:1mm 0;
  border-top:1px dashed #cbd5e1;
  border-bottom:1px dashed #cbd5e1;
}
#qr-80mm{width:30mm;height:30mm;}
.qr-label{font-size:8px;color:#64748b;margin-top:2mm;text-align:center;}

/* ── Credenciales ── */
.cred-box{
  background:#fef9c3;
  border:1px dashed #f59e0b;
  border-radius:3px;
  padding:1mm;
  margin:1mm 0;
}
.cred-warn{font-size:8px;font-weight:800;color:#b45309;text-transform:uppercase;
           letter-spacing:.5px;margin-bottom:2mm;text-align:center;}
.cred-row{display:flex;justify-content:space-between;margin-bottom:1.5mm;font-size:10px;}
.cred-key{color:#78350f;font-weight:700;}
.cred-val{color:#0f172a;font-weight:600;word-break:break-all;text-align:right;max-width:55mm;}
.cred-aviso{font-size:7.5px;color:#92400e;text-align:center;margin-top:2mm;
            font-style:italic;line-height:1.4;}

/* ── Instrucciones ── */
.instr-box{
  background:#f0fdf4;
  border-left:3px solid #22c55e;
  padding:1.5mm 1mm;
  margin:1mm 0;
  font-size:9px;color:#166534;line-height:1.5;
}

/* ── Pie ── */
.footer{
  text-align:center;
  padding-top:1mm;
  border-top:2px dashed #0f172a;
  margin-top:2mm;
}
.footer-agradecimiento{
  font-size:10px;font-weight:700;color:#0f172a;margin-bottom:1.5mm;
}
.footer-tel{font-size:10px;color:#475569;margin-bottom:1mm;}
.footer-marca{font-size:8px;color:#94a3b8;margin-top:2mm;}
.no-print-bar{
  text-align:center;margin-bottom:10px;display:flex;gap:8px;
  justify-content:center;flex-wrap:wrap;
}
.no-print-bar button{
  border:none;padding:9px 18px;border-radius:8px;font-size:12.5px;
  font-weight:700;cursor:pointer;font-family:'Segoe UI',Arial,sans-serif;
}
.btn-ticket-print{background:#0f172a;color:#fff;}
.btn-ticket-close{background:#e2e8f0;color:#1e293b;}
</style>
</head>
<body>
<div class="no-print-bar no-print">
  <button class="btn-ticket-print" onclick="window.print()">🖨️ Imprimir</button>
  <button class="btn-ticket-close" onclick="window.close()">✕ Cerrar</button>
</div>
<div class="ticket">

  <!-- ── ENCABEZADO ── -->
  <div class="hdr-logo">
    ${med.logo
        ? `<img src="${med.logo}" alt="Logo" class="hdr-logo-img">`
        : `<div class="hdr-title">KuraDoc</div>`}
    <div class="hdr-sub"> <strong>Sistema de Citas Médicas</strong></div>
    ${med.centro !== '—' ? `<div style="font-size:9px;color:#334155;margin-top:1mm;text-align:center;">${med.centro}</div>` : ''}
  </div>

  <!-- ── TURNO ── -->
  <div class="turno-box">
    <div class="turno-label">Turno</div>
    <div class="turno-num">#${turno}</div>
  </div>

  <!-- ── PACIENTE ── -->
  <div class="sec">
    <div class="sec-label">Paciente</div>
    <div class="sec-val">${(pac.nombre || '—').toUpperCase()}</div>
    ${pac.telefono !== '—' ? `<div class="sec-val-sm">${pac.telefono}</div>` : ''}
    ${pac.email    !== '—' ? `<div class="sec-val-sm" style="font-size:9px;color:#475569;">✉ ${pac.email}</div>` : ''}
  </div>
  <hr class="sep">

  <!-- ── MÉDICO / CENTRO ── -->
  <div class="row"><span class="row-icon"></span><span class="row-text bold">${med.nombre}</span></div>
  <div class="row"><span class="row-icon"></span><span class="row-text">${med.especialidad}</span></div>
  <div class="row"><span class="row-icon"></span><span class="row-text">${med.centro}</span></div>
  ${med.direccion && med.direccion !== '—' ? `<div class="row"><span class="row-icon">📍</span><span class="row-text">${med.direccion}</span></div>` : ''}
  <hr class="sep">

  <!-- ── FECHA / TANDA ── -->
  <div class="row"><span class="row-icon"></span><span class="row-text bold">${fecha}</span></div>
  <div class="row"><span class="row-icon"></span><span class="row-text">${tanda.texto}</span></div>
  ${seguro ? `<div class="row"><span class="row-icon"></span><span class="row-text">Seguro: ${seguro}</span></div>` : ''}
  <hr class="sep">

  <!-- ── CÓDIGO / TOKEN ── -->
  <div class="sec">
    <div class="sec-label">Código de confirmación</div>
    <div style="font-size:9px;color:#334155;word-break:break-all;">${token}</div>
  </div>

  <!-- ── QR ── -->
  <div class="qr-zone">
    <div id="qr-80mm"></div>
    <div class="qr-label">Escanea para confirmar asistencia</div>
  </div>

  <!-- ── INSTRUCCIONES ── -->
  <div class="instr-box">
    Llegue al menos <strong>15 min</strong> antes de su turno.<br>
    Presente este ticket en recepción.<br>
    Para cancelar: contáctenos 24h antes.<br>
    ${med.telefono !== '—' ? `📞 <strong>${med.telefono}</strong>` : ''}
  </div>

  <!-- ── CREDENCIALES DE ACCESO ── -->
  ${tieneCredenciales ? `
  <div class="cred-box">
    <div class="cred-warn">🔒 Credenciales de su cuenta</div>
    <div class="cred-row">
      <span class="cred-key">Usuario:</span>
      <span class="cred-val">${pac.email}</span>
    </div>
    <div class="cred-row">
      <span class="cred-key">Clave:</span>
      <span class="cred-val">${pac.clave}</span>
    </div>
    <div class="cred-aviso">
      ⚠️ No comparta ni pierda este ticket.<br>
      Contiene información personal de su cuenta KuraDoc.
    </div>
  </div>
  ` : ''}

  <!-- ── PIE ── -->
  <div class="footer">
    <div class="footer-agradecimiento">¡Gracias por confiar en nosotros!</div>
    ${med.telefono !== '—' ? `<div class="footer-tel">📞 ${med.telefono}</div>` : ''}
    <div class="footer-marca">KuraDoc · Sistema Médico Inteligente</div>
  </div>

</div>

<!-- QR render -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
(function(){
  const url = ${JSON.stringify(urlQR || '')};
  const el  = document.getElementById('qr-80mm');
  if (!url || !el || typeof QRCode === 'undefined') return;
  try {
    new QRCode(el, {
      text: url, width: 110, height: 110,
      colorDark: '#0f172a', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch(e){ el.innerHTML='<div style="font-size:8px;text-align:center;padding:10px;color:#94a3b8;">QR no disponible</div>'; }
})();
</script>
</body>
</html>`;
};

// ══════════════════════════════════════════════════════════════════
// §4  GENERADOR HTML — PLANTILLA HOJA CARTA
// ══════════════════════════════════════════════════════════════════

window.generarHTMLTicketCarta = function(cita) {
    const pac    = _kdDatosPaciente(cita);
    const med    = _kdDatosMedico(cita);
    const tanda  = _kdTanda(cita.tanda);
    const fecha  = _kdFechaBonita(cita.fechaStr, true);
    const token  = cita.tokenConfirmacion || cita.id   || '—';
    const urlQR  = cita.urlConfirmacion   || '';
    const turno  = cita.ordenAtencion     || cita.numeroOrden || '?';
    const seguro = cita.seguroMedicoPaciente || '';
    const ahora  = new Date().toLocaleDateString('es-DO', {
        day:'2-digit', month:'long', year:'numeric',
        hour:'2-digit', minute:'2-digit'
    });
    const tieneCredenciales = pac.email !== '—' && pac.clave !== '—';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirmación de Cita · KuraDoc</title>
<style>
/* ── Reset ── */
*{margin:0;padding:0;box-sizing:border-box;}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#f1f5f9;
  color:#0f172a;
  padding:24px;
}

/* ── Print ── */
@media print{
  @page{
    size:letter;
    margin:10mm;
  }
  body{background:none;padding:0;}
  .no-print{display:none!important;}
  .carta{box-shadow:none!important;border:none!important;}
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}

/* ── Carta principal ── */
.carta{
  max-width:720px;
  margin:0 auto;
  background:#fff;
  border-radius:16px;
  overflow:hidden;
  box-shadow:0 8px 40px rgba(0,0,0,.12);
}

/* ── Header azul marino ── */
.hdr{
  background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#0369a1 100%);
  padding:8px 32px 4px;
  color:white;
  position:relative;
  overflow:hidden;
}
.hdr::before{
  content:'';
  position:absolute;inset:0;
  background:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.04'%3E%3Ccircle cx='30' cy='30' r='20'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
  pointer-events:none;
}
.hdr-top{display:flex;justify-content:space-between;align-items:flex-start;position:relative;z-index:1;}
.hdr-brand{display:flex;flex-direction:column;gap:4px;}
.hdr-logo-text{
  font-size:20px;font-weight:800;letter-spacing:2px;
  background:linear-gradient(90deg,#fff,#93c5fd);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  background-clip:text;
}
.hdr-logo-sub{font-size:11px;color:rgba(255,255,255,.6);letter-spacing:1px;text-transform:uppercase;}
.hdr-badge{
  background:rgba(255,255,255,.15);
  border:1px solid rgba(255,255,255,.25);
  border-radius:20px;
  padding:3px 10px;
  font-size:11px;font-weight:700;color:white;
  backdrop-filter:blur(4px);
}
.hdr-title-area{
  margin-top:3px;position:relative;z-index:1;
  border-top:1px solid rgba(255,255,255,.15);padding-top:6px;
}
.hdr-title{font-size:20px;font-weight:800;margin-bottom:4px;}
.hdr-fecha{font-size:11px;color:rgba(255,255,255,.55);}

/* ── Turno flotante ── */
.turno-band{
  background:linear-gradient(90deg,#0369a1,#0ea5e9);
  padding:3px 32px;
  display:flex;align-items:center;gap:10px;
}
.turno-num{
  font-size:31px;font-weight:800;color:white;line-height:1;
  text-shadow:0 2px 8px rgba(0,0,0,.2);
}
.turno-info{color:rgba(255,255,255,.9);}
.turno-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.7;margin-bottom:2px;}
.turno-desc {font-size:13px;font-weight:600;}

/* ── Cuerpo ── */
.body{padding:8px 32px;}

/* ── Grid 2 columnas ── */
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:4px;}
@media(max-width:600px){.grid-2{grid-template-columns:1fr;}}

/* ── Card de sección ── */
.card{
  background:#f8fafc;
  border:1px solid #e2e8f0;
  border-radius:12px;
  padding:3px 18px;
}
.card-full{
  background:#f8fafc;
  border:1px solid #e2e8f0;
  border-radius:12px;
  padding:3px 18px;
  margin-bottom:2px;
}
.card-title{
  font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;
  color:#94a3b8;margin-bottom:5px;display:flex;align-items:center;gap:5px;
}
.card-title span{font-size:14px;}
.field{margin-bottom:3px;}
.field-label{font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;}
.field-val{font-size:11px;font-weight:600;color:#0f172a;word-break:break-word;}
.field-val-sm{font-size:10px;color:#334155;word-break:break-word;}

/* ── Separador con texto ── */
.divider{
  display:flex;align-items:center;gap:5px;
  margin:4px 0;color:#94a3b8;font-size:10px;
}
.divider::before,.divider::after{content:'';flex:1;border-top:1px dashed #e2e8f0;}

/* ── QR + código ── */
.qr-row{
  display:flex;gap:20px;align-items:center;
  background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;
  padding:2px 18px;margin-bottom:2px;
}
#qr-carta{width:100px;height:100px;flex-shrink:0;}
.qr-info{flex:1;}
.qr-scan-text{font-size:11px;font-weight:700;color:#0369a1;margin-bottom:6px;}
.qr-token{font-size:8px;color:#475569;word-break:break-all;
          background:#fff;border:1px solid #bae6fd;border-radius:6px;
          padding:3px 6px;margin-top:4px;}

/* ── Indicaciones ── */
.instr-card{
  background:linear-gradient(135deg,#f0fdf4,#dcfce7);
  border:1px solid #86efac;border-radius:12px;
  padding:1px 18px;margin-bottom:2px;
}
.instr-title{font-size:11px;font-weight:800;color:#166534;margin-bottom:8px;
             display:flex;align-items:center;gap:6px;}
.instr-list{list-style:none;display:flex;flex-direction:column;gap:2px;}
.instr-list li{font-size:11px;color:#166534;display:flex;align-items:baseline;gap:6px;}
.instr-list li::before{content:'✔';font-size:9px;color:#22c55e;flex-shrink:0;}

/* ── Cancelación ── */
.cancel-card{
  background:#fffbeb;border:1px solid #fde68a;border-radius:12px;
  padding:2px 16px;margin-bottom:5px;
  font-size:10px;color:#92400e;line-height:1.4;
}
.cancel-title{font-weight:800;margin-bottom:4px;}

/* ── Credenciales ── */
.cred-card{
  background:linear-gradient(135deg,#fefce8,#fef9c3);
  border:2px dashed #f59e0b;border-radius:12px;
  padding:2px 18px;margin-bottom:2px;
}
.cred-title{
  font-size:10px;font-weight:750;color:#b45309;text-transform:uppercase;
  letter-spacing:.2px;margin-bottom:3px;display:flex;align-items:center;gap:4px;
}
.cred-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:3px;}
@media(max-width:480px){.cred-grid{grid-template-columns:1fr;}}
.cred-item{background:#fff;border:1px solid #fde68a;border-radius:8px;padding:2px 12px;}
.cred-key{font-size:9px;font-weight:750;color:#92400e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.cred-val{font-size:11px;font-weight:650;color:#0f172a;word-break:break-all;}
.cred-aviso{
  font-size:9px;color:#78350f;background:#fff7ed;
  border:1px solid #fed7aa;border-radius:8px;
  padding:2px 10px;line-height:1.3;text-align:center;
}

/* ── Contacto / Pie ── */
.contact-row{
  display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;
  justify-content:center;
}
.contact-chip{
  background:#f1f5f9;border:1px solid #e2e8f0;border-radius:20px;
  padding:6px 12px;font-size:11px;color:#334155;
  display:flex;align-items:center;gap:5px;
}

/* ── Footer ── */
.footer{
  background:#0f172a;padding:4px 32px;
  text-align:center;
}
.footer-brand{font-size:13px;font-weight:800;color:white;margin-bottom:3px;}
.footer-sub  {font-size:10px;color:rgba(255,255,255,.4);}
.footer-gen  {font-size:9px;color:rgba(255,255,255,.3);margin-top:3px;}
</style>
</head>
<body>
<div class="no-print" style="text-align:center;margin-bottom:6px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
  <button onclick="window.print()"
          style="background:#0f172a;color:white;border:none;padding:5px 24px;
                 border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">
    🖨️ Imprimir / Guardar PDF
  </button>
  <button onclick="window.close()"
          style="background:#f1f5f9;color:#334155;border:1px solid #e2e8f0;
                 padding:4px 20px;border-radius:8px;font-size:14px;cursor:pointer;">
    ✕ Cerrar
  </button>
</div>

<div class="carta">

  <!-- ══ HEADER ══ -->
  <div class="hdr">
    <div class="hdr-top">
      <div class="hdr-brand">
        ${med.logo ? `<img src="${med.logo}" alt="Logo" style="height:44px;width:auto;margin-bottom:4px;filter:brightness(0) invert(1);">` : ''}
        <div class="hdr-logo-text">KuraDoc</div>
        <div class="hdr-logo-sub">Sistema de Citas Médicas</div>
      </div>
      <div class="hdr-badge">📋 Confirmación Oficial</div>
    </div>
    <div class="hdr-title-area">
      <div class="hdr-title">Confirmación de Cita Médica</div>
      <div class="hdr-fecha">Generado el ${ahora}</div>
    </div>
  </div>

  <!-- ══ TURNO ══ -->
  <div class="turno-band">
    <div class="turno-num">#${turno}</div>
    <div class="turno-info">
      <div class="turno-label">Número de turno</div>
      <div class="turno-desc">Su orden de atención para este día</div>
    </div>
  </div>

  <!-- ══ CUERPO ══ -->
  <div class="body">

    <!-- Paciente + Médico -->
    <div class="grid-2">
      <!-- Paciente -->
      <div class="card">
        <div class="card-title"><span>👤</span> Datos del Paciente</div>
        <div class="field">
          <div class="field-label">Nombre completo</div>
          <div class="field-val">${(pac.nombre || '—').toUpperCase()}</div>
        </div>
        ${pac.telefono !== '—' ? `
        <div class="field">
          <div class="field-label">Teléfono</div>
          <div class="field-val-sm">📞 ${pac.telefono}</div>
        </div>` : ''}
        ${pac.email !== '—' ? `
        <div class="field">
          <div class="field-label">Correo electrónico</div>
          <div class="field-val-sm" style="font-size:11px;">✉ ${pac.email}</div>
        </div>` : ''}
        ${seguro ? `
        <div class="field">
          <div class="field-label">Seguro médico</div>
          <div class="field-val-sm">🛡️ ${seguro}</div>
        </div>` : ''}
      </div>

      <!-- Médico -->
      <div class="card">
        <div class="card-title"><span>👨‍⚕️</span> Médico Tratante</div>
        <div class="field">
          <div class="field-label">Dr. / Dra.</div>
          <div class="field-val">${med.nombre}</div>
        </div>
        <div class="field">
          <div class="field-label">Especialidad</div>
          <div class="field-val-sm">🩺 ${med.especialidad}</div>
        </div>
        ${med.telefono !== '—' ? `
        <div class="field">
          <div class="field-label">Teléfono consultorio</div>
          <div class="field-val-sm">📞 ${med.telefono}</div>
        </div>` : ''}
      </div>
    </div>

    <!-- Centro + Cita -->
    <div class="grid-2">
      <!-- Centro médico -->
      <div class="card">
        <div class="card-title"><span>🏥</span> Centro Médico</div>
        <div class="field">
          <div class="field-label">Nombre</div>
          <div class="field-val">${med.centro}</div>
        </div>
        ${med.direccion && med.direccion !== '—' ? `
        <div class="field">
          <div class="field-label">Dirección</div>
          <div class="field-val-sm">📍 ${med.direccion}</div>
        </div>` : ''}
        ${med.whatsapp !== '—' ? `
        <div class="field">
          <div class="field-label">WhatsApp</div>
          <div class="field-val-sm" style="color:#16a34a;">💬 ${med.whatsapp}</div>
        </div>` : ''}
        ${med.sitioWeb ? `
        <div class="field">
          <div class="field-label">Sitio web</div>
          <div class="field-val-sm" style="font-size:10px;color:#0369a1;">🌐 ${med.sitioWeb}</div>
        </div>` : ''}
      </div>

      <!-- Fecha y hora -->
      <div class="card">
        <div class="card-title"><span>📅</span> Detalles de la Cita</div>
        <div class="field">
          <div class="field-label">Fecha</div>
          <div class="field-val" style="font-size:12px;">${fecha}</div>
        </div>
        <div class="field">
          <div class="field-label">Tanda</div>
          <div class="field-val-sm">${tanda.emoji} ${tanda.texto}</div>
        </div>
        <div class="field">
          <div class="field-label">Consultorio / Centro</div>
          <div class="field-val-sm">🏥 ${med.centro}</div>
        </div>
      </div>
    </div>

    <!-- QR + Código -->
    <div class="qr-row">
      <div id="qr-carta"></div>
      <div class="qr-info">
        <div class="qr-scan-text">📱 Escanea el código QR para confirmar tu asistencia</div>
        <div style="font-size:11px;color:#334155;margin-bottom:6px;line-height:1.5;">
          Presenta este código en recepción o escanéalo con tu teléfono para validar tu cita en el sistema.
        </div>
        <div class="qr-token">
          <strong style="color:#0369a1;">Código:</strong> ${token}
        </div>
      </div>
    </div>

    <!-- Indicaciones -->
    <div class="instr-card">
      <div class="instr-title">✅ Indicaciones importantes</div>
      <ul class="instr-list">
        <li>Llegue al menos <strong>15 minutos antes</strong> de su turno programado.</li>
        <li>Traiga su cédula de identidad y este comprobante de cita.</li>
        <li>Si tiene seguro médico, traiga su tarjeta vigente.</li>
        <li>En caso de fiebre u otro impedimento, comuníquese con anticipación.</li>
        ${med.telefono !== '—' ? `<li>Consultas: <strong>${med.telefono}</strong></li>` : ''}
      </ul>
    </div>

    <!-- Política de cancelación -->
    <div class="cancel-card">
      <div class="cancel-title">⚠️ Política de cancelación</div>
      Para cancelar o reprogramar su cita sin cargo, por favor notifíquenos con al menos
      <strong>24 horas de anticipación</strong>. Las ausencias sin previo aviso pueden
      generar restricciones para futuras citas. Comuníquese por WhatsApp o teléfono.
    </div>

    <!-- Credenciales (si aplica) -->
    ${tieneCredenciales ? `
    <div class="cred-card">
      <div class="cred-title">🔐 Credenciales de acceso a KuraDoc</div>
      <div class="cred-grid">
        <div class="cred-item">
          <div class="cred-key">Usuario (correo)</div>
          <div class="cred-val">${pac.email}</div>
        </div>
        <div class="cred-item">
          <div class="cred-key">Contraseña</div>
          <div class="cred-val">${pac.clave}</div>
        </div>
      </div>
      <div class="cred-aviso">
        🔒 <strong>Importante:</strong> No comparta ni pierda este documento.<br>
        Contiene datos personales de acceso a su cuenta KuraDoc.<br>
        Puede iniciar sesión desde <strong>kd.app</strong> con estas credenciales.
      </div>
    </div>
    ` : ''}

    <!-- Contacto -->
    <div style="text-align:center;margin-bottom:4px;">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:3px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;">Contáctenos</div>
      <div class="contact-row">
        ${med.telefono !== '—' ? `<div class="contact-chip">📞 ${med.telefono}</div>` : ''}
        ${med.whatsapp !== '—' ? `<div class="contact-chip">💬 WhatsApp: ${med.whatsapp}</div>` : ''}
        ${med.email    !== '—' ? `<div class="contact-chip">✉ ${med.email}</div>` : ''}
        ${med.sitioWeb          ? `<div class="contact-chip">🌐 ${med.sitioWeb}</div>` : ''}
      </div>
      ${med.redes ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px;">📲 ${med.redes}</div>` : ''}
    </div>

  </div><!-- /body -->

  <!-- ══ FOOTER ══ -->
  <div class="footer">
    <div class="footer-brand">KuraDoc · Sistema de Citas Médicas</div>
    <div class="footer-sub">Tecnología al servicio de su salud</div>
    <div class="footer-gen">Documento generado el ${ahora} · Turno #${turno}</div>
  </div>

</div><!-- /carta -->

<!-- QR render -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
(function(){
  const url = ${JSON.stringify(urlQR || '')};
  const el  = document.getElementById('qr-carta');
  if (!url || !el || typeof QRCode === 'undefined') return;
  try {
    new QRCode(el, {
      text: url, width: 100, height: 100,
      colorDark: '#0f172a', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch(e){ el.innerHTML='<div style="font-size:9px;text-align:center;padding:10px;color:#94a3b8;">QR no disponible</div>'; }
})();
</script>
</body>
</html>`;
};

// ══════════════════════════════════════════════════════════════════
// §5  EJECUCIÓN DE IMPRESIÓN
// ══════════════════════════════════════════════════════════════════

/**
 * Abre ventana y ejecuta window.print() con el HTML dado.
 * @param {string} html  - HTML completo de la plantilla
 * @param {string} ancho - '360px' para 80mm, '800px' para carta
 */
window.ejecutarImpresion = function(html, ancho) {
    ancho = ancho || '800px';
    const win = window.open('', '_blank', `width=${parseInt(ancho)},height=700,scrollbars=yes`);
    if (!win) {
        alert('Por favor permite ventanas emergentes para imprimir.');
        return;
    }
    win.document.write(html);
    win.document.close();
    // El script de QR ya hace window.print() dentro del HTML,
    // aquí como respaldo extra si QR no carga:
    win.addEventListener('load', () => {
        setTimeout(() => { try { win.focus(); win.print(); } catch(e){} }, 600);
    });
};

// ══════════════════════════════════════════════════════════════════
// §6  FUNCIONES PÚBLICAS DE IMPRESIÓN
// ══════════════════════════════════════════════════════════════════

/** Fuerza impresión con plantilla térmica 80mm (ignora detección) */
window.imprimirTicket80mm = function(citaOrId) {
    const cita = _kdResolveCita(citaOrId);
    if (!cita) { alert('No se encontraron datos de la cita.'); return; }
    const html = window.generarHTMLTicket80mm(cita);
    window.ejecutarImpresion(html, '320px');
};

/** Fuerza impresión con plantilla carta/PDF (ignora detección) */
window.imprimirTicketCarta = function(citaOrId) {
    const cita = _kdResolveCita(citaOrId);
    if (!cita) { alert('No se encontraron datos de la cita.'); return; }
    const html = window.generarHTMLTicketCarta(cita);
    window.ejecutarImpresion(html, '800px');
};

/**
 * Impresión automática: detecta tipo de impresora y elige la plantilla.
 * — Impresora térmica → 80mm
 * — Sin térmica       → Carta
 * Esta función REEMPLAZA la lógica del fallback en _imprimirFallback.
 */
window.imprimirTicketAutomatico = async function(citaOrId, statusEl) {
    const cita = _kdResolveCita(citaOrId);
    if (!cita) return;

    function st(msg, color) {
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color || 'inherit'; }
    }

    // 1. Android → RawBT (impresión directa ESC/POS, sin cambiar nada)
    if (window._esAndroid && window._esAndroid()) {
        if (typeof window._imprimirAndroid === 'function') {
            window._imprimirAndroid(cita, statusEl);
        }
        return;
    }

    // 2. PC → intentar QZ Tray con impresora térmica
    st('Detectando impresora…', '#2563eb');
    const deteccion = await window._kdPrint.detectarTerMica();

    if (deteccion.tipo === 'termica' && deteccion.metodo === 'qz') {
        // Impresora térmica via QZ → ESC/POS existente
        st('Impresora térmica detectada (' + deteccion.impresora + ')…', '#0369a1');
        try {
            const cfg      = qz.configs.create(deteccion.impresora);
            const commands = window._buildTicketCommands(cita);
            await qz.print(cfg, commands);
            st('✅ Ticket enviado a ' + deteccion.impresora, '#059669');
        } catch(e) {
            st('Error QZ. Usando plantilla 80mm…', '#f59e0b');
            window.imprimirTicket80mm(cita);
        }
    } else {
        // Sin impresora térmica → plantilla carta
        st('Usando plantilla hoja carta…', '#7c3aed');
        window.imprimirTicketCarta(cita);
    }
};

// ══════════════════════════════════════════════════════════════════
// §7  HELPER — resolver cita desde id o objeto
// ══════════════════════════════════════════════════════════════════

function _kdResolveCita(citaOrId) {
    if (!citaOrId) return window._ticketState?.citaActual || null;
    if (typeof citaOrId === 'string') {
        return appState?.citas?.find(c => c.id === citaOrId) || null;
    }
    return citaOrId;
}

// ══════════════════════════════════════════════════════════════════
// §8  MODAL DE TICKET — VERSIÓN MEJORADA
//     Reemplaza window.abrirModalTicketCita() original
//     Añade botón "📄 Imprimir Hoja Carta / PDF" sin romper nada
// ══════════════════════════════════════════════════════════════════

window.abrirModalTicketCita = async function(citaOrId) {
    let cita = (typeof citaOrId === 'string')
        ? appState.citas.find(c => c.id === citaOrId)
        : citaOrId;

    if (!cita) { alert('No se encontraron datos de la cita.'); return; }

    window._ticketState.citaActual = cita;

    const tanda      = _kdTanda(cita.tanda);
    const fechaBonita = _kdFechaBonita(cita.fechaStr, true);
    const urlQR      = cita.urlConfirmacion || '';
    const esAndroid  = window._esAndroid && window._esAndroid();
    const turno      = cita.ordenAtencion || cita.numeroOrden || '?';
    const pac        = _kdDatosPaciente(cita);
    const med        = _kdDatosMedico(cita);

    document.getElementById('modalContainer').innerHTML = `
    <div class="modal-overlay" id="ticketOverlay"
         onclick="if(event.target===this)this.remove()"
         style="z-index:3000;backdrop-filter:blur(4px);">
      <div style="background:white;border-radius:20px;max-width:440px;width:100%;
                  box-shadow:0 24px 64px rgba(0,0,0,.22);overflow:hidden;
                  animation:fadeInUp .25s ease;">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);
                    padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:22px;">🎫</span>
            <div>
              <div style="color:white;font-weight:800;font-size:15px;">Ticket de Cita</div>
              <div style="color:rgba(255,255,255,.6);font-size:11px;">Listo para imprimir</div>
            </div>
          </div>
          <button onclick="document.getElementById('ticketOverlay').remove()"
                  style="background:rgba(255,255,255,.12);border:none;color:white;
                         width:32px;height:32px;border-radius:50%;cursor:pointer;
                         font-size:18px;display:flex;align-items:center;justify-content:center;">✕</button>
        </div>

        <!-- Acciones de impresión — arriba, sutiles, una al lado de la otra -->
        <div style="display:flex;gap:6px;padding:8px 18px 0;">
          <button id="btnImprimirTicket"
                  onclick="window._ejecutarImpresion()"
                  title="Imprimir ticket (térmica / automático)"
                  style="flex:1;padding:6px 8px;background:#f1f5f9;color:#334155;
                         border:1px solid #e2e8f0;border-radius:8px;font-size:11px;
                         font-weight:700;cursor:pointer;display:flex;align-items:center;
                         justify-content:center;gap:5px;transition:background .15s;"
                  onmouseover="this.style.background='#e2e8f0'"
                  onmouseout="this.style.background='#f1f5f9'">
            🖨️ Ticket
          </button>
          <button onclick="window._ejecutarImpresionCarta()"
                  title="Imprimir Hoja Carta / PDF"
                  style="flex:1;padding:6px 8px;background:#f1f5f9;color:#334155;
                         border:1px solid #e2e8f0;border-radius:8px;font-size:11px;
                         font-weight:700;cursor:pointer;display:flex;align-items:center;
                         justify-content:center;gap:5px;transition:background .15s;"
                  onmouseover="this.style.background='#e2e8f0'"
                  onmouseout="this.style.background='#f1f5f9'">
            📄 Carta/PDF
          </button>
        </div>

        <!-- Preview compacto -->
        <div style="display:flex;gap:0;padding:16px 18px 8px;">
          <!-- Datos -->
          <div style="flex:1;min-width:0;">
            <div style="background:#f8fafc;border-radius:12px;padding:12px 14px;
                        border:1px solid #e2e8f0;font-family:monospace;font-size:11px;">
              <div style="text-align:center;margin-bottom:1px;">
                ${med.logo
                    ? `<img src="${med.logo}" alt="Logo" style="max-height:26px;max-width:150px;object-fit:contain;">`
                    : `<div style="font-weight:900;font-size:14px;color:#0f172a;">KuraDoc</div>`}
              </div>
              <div style="text-align:center;font-size:9px;color:#64748b;margin-bottom:6px;">Sistema de Citas Médicas</div>
              <div style="border-top:2px dashed #cbd5e1;margin:5px 0;"></div>
              <div style="text-align:center;font-size:9px;color:#64748b;">TURNO</div>
              <div style="text-align:center;font-size:26px;font-weight:900;color:#0f172a;line-height:1.1;margin:1px 0 5px;">#${turno}</div>
              <div style="border-top:2px dashed #cbd5e1;margin:5px 0;"></div>
              <div style="font-size:8px;color:#64748b;font-weight:750;">PACIENTE</div>
              <div style="font-weight:700;font-size:11px;color:#0f172a;word-break:break-word;margin-bottom:5px;">
                ${(cita.nombrePaciente || '—').toUpperCase()}
              </div>
              <div style="font-size:8px;color:#64748b;font-weight:750;">TEL:</div>
              <div style="font-weight:700;font-size:11px;color:#0f172a;word-break:break-word;margin-bottom:5px;">
                ${(cita.telefonoPaciente || '—')}
              </div>
              <div style="border-top:1px dashed #e2e8f0;margin:3px 0;"></div>
              <div style="font-size:10px;color:#475569;margin:1px 0;"><strong>👨‍⚕️ </strong> ${med.nombre}</div>
              <div style="font-size:10px;color:#475569;margin:1px 0;"><strong>🩺 Especialidad:</strong> ${med.especialidad}</div>
              <div style="font-size:10px;color:#475569;margin:1px 0;word-break:break-word;"><strong>🏥 Centro:</strong> ${med.centro}</div>
              <div style="border-top:1px dashed #e2e8f0;margin:3px 0;"></div>
              <div style="font-size:10px;color:#475569;margin:1px 0;"><strong>📅 Fecha:</strong> ${fechaBonita}</div>
              <div style="font-size:10px;color:#475569;margin:1px 0;"><strong>${tanda.emoji} Tanda:</strong> ${tanda.texto}</div>
            </div>
          </div>

          <!-- QR -->
          <div style="display:flex;flex-direction:column;align-items:center;
                      justify-content:flex-start;padding-left:12px;min-width:100px;">
            <div style="background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;
                        padding:7px;text-align:center;">
              <div id="qrTicketPreview" style="width:85px;height:85px;"></div>
              <div style="font-size:7.5px;color:#94a3b8;margin-top:3px;line-height:1.3;">
                Escanear para<br>confirmar asistencia
              </div>
            </div>
            <div style="margin-top:6px;background:#eff6ff;border-radius:8px;
                        padding:5px 7px;text-align:center;width:100%;">
              <div style="font-size:8px;color:#1e40af;font-weight:700;">
                ${esAndroid ? '📱 Android' : '🖥️ PC / Tablet'}
              </div>
              <div style="font-size:7.5px;color:#64748b;margin-top:1px;">
                ${esAndroid ? 'RawBT App' : 'Ticket 80mm · Carta'}
              </div>
            </div>
          </div>
        </div>

        <!-- Status impresión -->
        <div id="ticketPrintStatus"
             style="margin:0 18px 6px;font-size:11px;color:#64748b;
                    min-height:18px;text-align:center;"></div>

        <!-- Botones -->
        <div style="padding:6px 18px 18px;display:flex;flex-direction:column;gap:8px;">

          <!-- Reimprimir -->
          <button onclick="window._ejecutarImpresion()"
                  style="width:100%;padding:9px;background:#f8fafc;color:#475569;
                         border:1px solid #e2e8f0;border-radius:12px;font-size:12px;
                         font-weight:600;cursor:pointer;">
            🔄 Reimprimir
          </button>

          <!-- Cerrar -->
          <button onclick="document.getElementById('ticketOverlay').remove()"
                  style="width:100%;padding:8px;background:transparent;color:#94a3b8;
                         border:none;border-radius:12px;font-size:12px;cursor:pointer;">
            Cerrar
          </button>
        </div>
      </div>
    </div>`;

    // Generar QR preview
    if (urlQR && typeof QRCode !== 'undefined') {
        const qrEl = document.getElementById('qrTicketPreview');
        if (qrEl) {
            try {
                new QRCode(qrEl, {
                    text: urlQR, width: 85, height: 85,
                    colorDark: '#0f172a', colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M,
                });
            } catch(e) {
                qrEl.innerHTML = '<div style="font-size:8px;color:#94a3b8;padding:16px 4px;text-align:center;">QR no disponible</div>';
            }
        }
    }

    // Handler: botón principal "🖨️ Imprimir ticket".
    // Android sigue usando RawBT (impresión directa por intent — no
    // depende de QZ Tray, así que se deja igual). En PC/tablet ya NO
    // se intenta detectar ni conectar con QZ Tray: se genera la
    // plantilla térmica de 80mm directamente y se abre la ventana de
    // impresión normal del sistema operativo, donde el usuario elige
    // su impresora (térmica u otra) desde el propio diálogo.
    window._ejecutarImpresion = async function() {
        const statusEl = document.getElementById('ticketPrintStatus');
        const c = window._ticketState.citaActual;
        if (!c) return;

        if (window._esAndroid && window._esAndroid()) {
            if (typeof window._imprimirAndroid === 'function') {
                window._imprimirAndroid(c, statusEl);
                return;
            }
        }

        if (statusEl) { statusEl.textContent = 'Abriendo ticket 80mm…'; statusEl.style.color = '#0369a1'; }
        window.imprimirTicket80mm(c);
    };

    // Handler: forzar carta/PDF (botón nuevo)
    // No dispara detección de impresora, no lanza ventanas emergentes automáticas
    window._ejecutarImpresionCarta = function() {
        const c = window._ticketState.citaActual;
        if (!c) return;
        const statusEl = document.getElementById('ticketPrintStatus');
        if (statusEl) { statusEl.textContent = 'Abriendo plantilla carta…'; statusEl.style.color = '#7c3aed'; }
        setTimeout(() => window.imprimirTicketCarta(c), 200);
    };

    // ── SIN auto-print al abrir el modal ──────────────────────────
    // La impresión solo se inicia cuando la secretaria presiona
    // un botón explícitamente:
    //   🖨️ "Imprimir ticket"     → _ejecutarImpresion()   (detecta térmica)
    //   📄 "Hoja Carta / PDF"   → _ejecutarImpresionCarta() (carta directo)
    //   🔄 "Reimprimir"         → _ejecutarImpresion()   (detecta térmica)
    // Esto evita la ventana emergente de búsqueda de impresora cuando
    // la secretaria quiere usar la plantilla carta directamente.
};

// ══════════════════════════════════════════════════════════════════
// §9  TAMBIÉN reemplazar _imprimirFallback para usar plantilla 80mm
//     Mantiene la firma original para no romper nada
// ══════════════════════════════════════════════════════════════════
window._imprimirFallback = function(cita) {
    // Ahora usa la plantilla 80mm profesional en vez del HTML mínimo
    window.imprimirTicket80mm(cita);
};

// ══════════════════════════════════════════════════════════════════
// §10  BOTÓN CARTA GLOBAL
//      Para usar desde agenda, citas pendientes, detalle de cita, etc.
//      Uso: onclick="window.abrirImpresionCarta('citaId')"
// ══════════════════════════════════════════════════════════════════
window.abrirImpresionCarta = function(citaOrId) {
    window.imprimirTicketCarta(_kdResolveCita(citaOrId));
};

// CSS de animación (si no existe ya)
(function() {
    if (document.getElementById('kd-print-styles')) return;
    const st = document.createElement('style');
    st.id = 'kd-print-styles';
    st.textContent = `
@keyframes fadeInUp {
  from { opacity:0; transform:translateY(16px); }
  to   { opacity:1; transform:translateY(0); }
}`;
    document.head.appendChild(st);
})();

console.log('[KuraDoc] Módulo de impresión dual cargado ✅ (80mm + Carta)');
