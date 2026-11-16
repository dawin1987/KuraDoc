/* ═══════════════════════════════════════════════════════════════════
   KuraDoc — Módulo Atención al Usuario  (rol: 'atencion')
   © 2026 KuraDoc. Todos los derechos reservados.

   QUÉ HACE
   · Pantalla "Gestión de Citas" (vista 'citas-atencion'): citas de hoy,
     búsqueda por nombre / cédula / récord, rango de fechas, histórico,
     filtro por médico y minicalendario lateral (igual que Recepción),
     pero SIN acciones de facturación ni cambios de estado.
   · Pantalla del administrador "Atención al Usuario" (vista
     'atencion-admin'): crear / editar este personal, con centro y médicos.

   QUÉ REUTILIZA (no duplica) de app.logic.js
   · Nueva cita (abrirModalNuevaCitaInteligente), registro de paciente,
     búsqueda en pacientesEx, récord, ticket y notificaciones WhatsApp.
   · Reporte Financiero, perfil y mini calendario.

   CONEXIÓN CON app.logic.js (todo defensivo, con typeof)
   · renderCitasAtencion()  → case 'citas-atencion' de navigateTo()
   · renderAtencionAdmin()  → case 'atencion-admin' de navigateTo()
   · getConteoCitasPorDiaAtencion() / kdAtencionRefrescar() → mini calendario

   DEPENDENCIAS GLOBALES (ya existen en app.logic.js)
   db, firebase, appState, fechaHoy(), _uGet(), closeModal(),
   obtenerConteoCitasPorMedico(), cargarMedicosPorCentro()
═══════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────
    // §0  UTILIDADES
    // ──────────────────────────────────────────────────────────────
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
        ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const norm = s => String(s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    function misMedicosIds() {
        const a = (appState.currentUserData || {}).medicoAsignadoId;
        return (Array.isArray(a) ? a : (a ? [a] : [])).filter(Boolean);
    }

    function fechaDeCita(c) {
        if (c.fechaStr) return c.fechaStr;
        if (c.fecha) {
            const d = c.fecha.toDate ? c.fecha.toDate() : new Date((c.fecha.seconds || 0) * 1000);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        return '';
    }

    function toast(msg, tipo) {
        if (typeof window._mostrarToast === 'function') window._mostrarToast(msg, tipo || 'success');
        else alert(msg);
    }

    // ──────────────────────────────────────────────────────────────
    // §1  ESTILOS (prefijo kd-atn-, no chocan con app.styles.css)
    // ──────────────────────────────────────────────────────────────
    function inyectarEstilos() {
        if (document.getElementById('kd-atn-styles')) return;
        const s = document.createElement('style');
        s.id = 'kd-atn-styles';
        s.textContent = `
.kd-atn-resumen{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px;font-size:12px;color:#475569}
.kd-atn-pill{padding:3px 10px;border-radius:999px;border:1px solid;font-weight:700;font-size:11px;
  font-family:inherit;line-height:1.4;cursor:pointer;transition:opacity .15s,box-shadow .15s,transform .1s}
.kd-atn-pill:hover{transform:translateY(-1px)}
.kd-atn-pill:focus-visible{outline:2px solid #14908c;outline-offset:2px}
.kd-atn-resumen.hay-filtro .kd-atn-pill[aria-pressed="false"]{opacity:.55}
.kd-atn-pill[aria-pressed="true"]{opacity:1;box-shadow:0 0 0 2px currentColor;font-weight:800}
.kd-atn-pill[aria-pressed="true"]::before{content:"✓ "}
.kd-atn-p-total[aria-pressed="true"]{background:#e2e8f0}
.kd-atn-p-pendiente[aria-pressed="true"]{background:#fef3c7}
.kd-atn-p-confirmada[aria-pressed="true"]{background:#dbeafe}
.kd-atn-p-atendida[aria-pressed="true"]{background:#dcfce7}
.kd-atn-p-cancelada[aria-pressed="true"]{background:#fee2e2}
.kd-atn-p-total{color:#0f172a;border-color:#cbd5e1;background:#f8fafc}
.kd-atn-p-pendiente{color:#92400e;border-color:#fde68a;background:#fffbeb}
.kd-atn-p-confirmada{color:#1d4ed8;border-color:#bfdbfe;background:#eff6ff}
.kd-atn-p-atendida{color:#15803d;border-color:#86efac;background:#f0fdf4}
.kd-atn-p-cancelada{color:#dc2626;border-color:#fca5a5;background:#fef2f2}
.kd-atn-card{background:#fff;border:1px solid #e2e8f0;overflow:hidden}
.kd-atn-head,.kd-atn-row{display:grid;align-items:center;gap:10px;padding:9px 14px;
  grid-template-columns:minmax(160px,1.4fr) 84px minmax(140px,1.1fr) 118px 58px minmax(150px,1.2fr) minmax(110px,.9fr) 118px}
.kd-atn-head{background:#eff6ff;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #08fff1}
.kd-atn-row{border-bottom:1px solid #f1f5f9;font-size:13px;background:#fff}
.kd-atn-row.cancelada{opacity:.6}
.kd-atn-row.cancelada .kd-atn-pac strong{text-decoration:line-through}
.kd-atn-pac{display:grid;min-width:0}
.kd-atn-pac strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kd-atn-sub{font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kd-atn-record{font-weight:800;font-variant-numeric:tabular-nums;background:#f8fafc;border:1px solid #e2e8f0;
  padding:2px 8px;border-radius:6px;justify-self:start;font-size:13px}
.kd-atn-record.vacio{font-weight:600;color:#94a3b8;font-size:11px}
.kd-atn-est{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;border:1px solid;justify-self:start;white-space:nowrap}
.kd-atn-e-pendiente{color:#92400e;border-color:#fde68a;background:#fffbeb}
.kd-atn-e-confirmada{color:#1d4ed8;border-color:#bfdbfe;background:#eff6ff}
.kd-atn-e-atendida{color:#15803d;border-color:#86efac;background:#f0fdf4}
.kd-atn-e-cancelada{color:#dc2626;border-color:#fca5a5;background:#fef2f2}
.kd-atn-orden{font-weight:800;font-size:15px;text-align:center;border-radius:8px;padding:3px 0;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
.kd-atn-orden.vacio{background:#f8fafc;color:#cbd5e1;border-color:#e2e8f0;font-weight:600}
.kd-atn-seg{display:grid;gap:3px;justify-items:start}
.kd-atn-nota{font-size:10.5px;font-weight:600;line-height:1.25}
.kd-atn-nota.ok{color:#15803d}.kd-atn-nota.mal{color:#dc2626}.kd-atn-nota.info{color:#1d4ed8}
.kd-atn-acc{display:flex;gap:5px;justify-content:center;align-items:center}
.kd-atn-th-acc{text-align:center}
.kd-atn-tk{border:1px solid #cbd5e1;background:#f8fafc;border-radius:6px;cursor:pointer;padding:4px 6px;font-size:14px}
.kd-atn-tk:hover{background:#e2e8f0}
.kd-atn-tk.rep{border-color:#bfdbfe;background:#eff6ff}.kd-atn-tk.rep:hover{background:#dbeafe}
.kd-atn-tk.can{border-color:#fca5a5;background:#fef2f2}.kd-atn-tk.can:hover{background:#fee2e2}
.kd-atn-tk:disabled{opacity:.5;cursor:wait}
.kd-atn-vacio{text-align:center;color:#94a3b8;font-size:13px;padding:34px 16px}
.kd-atn-mas{display:block;margin:12px auto;padding:8px 18px;border-radius:8px;border:1px solid #14908c;
  background:#fff;color:#0f6f6c;font-weight:700;font-size:12px;cursor:pointer}
/* Ficha de paciente: Atención NO ve lo clínico ni factura */
body.rol-atencion .fp-tab[data-tab="expediente"],body.rol-atencion .fp-tab[data-tab="analiticas"],
body.rol-atencion .fp-tab[data-tab="docs"],body.rol-atencion .fp-tab[data-tab="facturas"],
body.rol-atencion .fp-btn[onclick*="'facturar'"],body.rol-atencion .fp-btn[onclick*="'imprimir'"],
body.rol-atencion button[onclick*="imprimirExpedientePaciente"]{display:none!important}
/* Directorio de médicos */
.kd-atn-md-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px}
.kd-atn-md{background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
.kd-atn-md-h{padding:14px 16px;background:#f8fafc;border-bottom:1px solid #f1f5f9}
.kd-atn-md-h h3{margin:0;font-size:15px;color:#1e293b}
.kd-atn-md-h span{font-size:12px;color:#64748b}
.kd-atn-md-b{padding:14px 16px;display:grid;gap:12px}
.kd-atn-sem{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.kd-atn-sem div{border:1px solid #e2e8f0;border-radius:6px;text-align:center;padding:4px 0;font-size:10px;font-weight:700;color:#cbd5e1}
.kd-atn-sem div.on{border-color:#99f6e4;background:#f0fdfa;color:#0f766e}
.kd-atn-sem small{display:block;font-size:8px;font-weight:600;text-transform:uppercase}
.kd-atn-tandas{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kd-atn-tanda{border:1px solid #e2e8f0;border-radius:8px;padding:8px;font-size:11px;text-align:center}
.kd-atn-tanda strong{display:block;font-size:12px}
.kd-atn-tanda.abierta{background:#f0fdf4;border-color:#86efac;color:#166534}
.kd-atn-tanda.llena{background:#fef2f2;border-color:#fca5a5;color:#991b1b}
.kd-atn-tanda.cerrada,.kd-atn-tanda.nolabora{background:#f8fafc;color:#94a3b8}
.kd-atn-fbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
@media (max-width:900px){
  .kd-atn-head{display:none}
  .kd-atn-row{grid-template-columns:1fr auto;gap:4px 10px}
  .kd-atn-row>*{grid-column:1}
  .kd-atn-row .kd-atn-acc{grid-column:2;grid-row:1}
}`;
        document.head.appendChild(s);
    }

    // ──────────────────────────────────────────────────────────────
    // §2  DATOS: conteo por día (minicalendario) y filtros
    // ──────────────────────────────────────────────────────────────
    window.getConteoCitasPorDiaAtencion = function () {
        if (appState.currentUserData?.rol !== 'atencion') return {};
        const ids = misMedicosIds();
        const mapa = {};
        (appState.citas || []).forEach(c => {
            if (!ids.includes(c.medicoId)) return;
            const f = fechaDeCita(c);
            if (f) mapa[f] = (mapa[f] || 0) + 1;
        });
        return mapa;
    };

    // Base: médico + fechas + texto (todo menos el estado). De aquí salen los contadores.
    function citasBase() {
        const ids = misMedicosIds();
        let l = (appState.citas || []).filter(c => ids.includes(c.medicoId));

        // 1. Médico
        if (appState.filtroMedicoSecretaria && appState.filtroMedicoSecretaria !== 'TODAS') {
            l = l.filter(c => c.medicoId === appState.filtroMedicoSecretaria);
        }

        // 2. Fechas: rango > histórico > día seleccionado (o hoy)
        if (appState.fechaInicioRango && appState.fechaFinRango) {
            l = l.filter(c => {
                const f = fechaDeCita(c);
                return f >= appState.fechaInicioRango && f <= appState.fechaFinRango;
            });
        } else if (!appState.verTodasLasCitas) {
            const f0 = appState.fechaSeleccionadaSecretaria || fechaHoy();
            l = l.filter(c => fechaDeCita(c) === f0);
        }

        // 3. Texto: nombre del paciente, cédula, número de récord (y médico)
        const q = (appState.filtroBusquedaTexto || '').trim();
        if (q) {
            const qn = norm(q);
            const ql = q.toLowerCase();
            const qd = q.replace(/\D/g, '');
            l = l.filter(c => {
                const pac = _uGet(c.pacienteId) || {};
                const med = _uGet(c.medicoId) || {};
                const nombre = norm(c.nombrePaciente || pac.nombre);
                const cedula = String(pac.cedula || '');
                const records = [c.numeroRecord]
                    .concat(pac.recordsPorCentro ? Object.values(pac.recordsPorCentro) : [])
                    .filter(Boolean).map(r => String(r).toLowerCase());
                return nombre.includes(qn)
                    || cedula.toLowerCase().includes(ql)
                    || (qd.length >= 3 && cedula.replace(/\D/g, '').includes(qd))
                    || records.some(r => r.includes(ql))
                    || norm(med.nombre).includes(qn);
            });
        }

        // 4. Orden: un solo día → tanda y turno; varios días → fecha reciente primero
        const tandaN = c => ((c.tanda || '').includes('vespert') ? 1 : 0);
        const unSoloDia = !appState.verTodasLasCitas && !(appState.fechaInicioRango && appState.fechaFinRango);
        l.sort((a, b) => {
            if (!unSoloDia) {
                const fa = fechaDeCita(a), fb = fechaDeCita(b);
                if (fa !== fb) return fa < fb ? 1 : -1;
            }
            if (tandaN(a) !== tandaN(b)) return tandaN(a) - tandaN(b);
            return (a.numeroOrden || 0) - (b.numeroOrden || 0);
        });
        return l;
    }

    // Filtro por estado (independiente de los demás). 'TODAS' = sin filtrar.
    const ESTADOS = ['pendiente', 'confirmada', 'atendida', 'cancelada'];
    function estadoActivo() {
        return ESTADOS.includes(appState.filtroEstadoAtencion) ? appState.filtroEstadoAtencion : 'TODAS';
    }
    function citasFiltradas() {
        const base = citasBase();
        const e = estadoActivo();
        return e === 'TODAS' ? base : base.filter(c => (c.estado || 'pendiente') === e);
    }

    // ──────────────────────────────────────────────────────────────
    // §3  PANTALLA "GESTIÓN DE CITAS"
    // ──────────────────────────────────────────────────────────────
    function pintarCabecera() {
        const cont = document.getElementById('atn-cabecera');
        if (!cont) return;

        const conteos = (typeof obtenerConteoCitasPorMedico === 'function') ? obtenerConteoCitasPorMedico() : {};
        const ids = misMedicosIds();
        const misMedicos = (appState.users || []).filter(u => ids.includes(u.id));

        const fecha = appState.fechaSeleccionadaSecretaria || fechaHoy();
        const fechaTexto = new Date(fecha + 'T00:00:00')
            .toLocaleDateString('es-DO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        const esHoy = !appState.verTodasLasCitas && !(appState.fechaInicioRango && appState.fechaFinRango)
            && fecha === fechaHoy();

        const textoFecha = (appState.fechaInicioRango && appState.fechaFinRango)
            ? '📂 Rango: ' + esc(appState.fechaInicioRango) + ' al ' + esc(appState.fechaFinRango)
            : (appState.verTodasLasCitas ? 'Histórico Completo' : '📅 : ' + esc(fechaTexto));

        const dias = [
            { k: 'lunes', l: 'Lun' }, { k: 'martes', l: 'Mar' }, { k: 'miércoles', l: 'Mié' },
            { k: 'jueves', l: 'Jue' }, { k: 'viernes', l: 'Vie' }, { k: 'sábado', l: 'Sáb' }, { k: 'domingo', l: 'Dom' }
        ];

        const chips = misMedicos.map(m => {
            const cm = conteos[m.id] || { total: 0, pendiente: 0, confirmada: 0, atendida: 0, cancelada: 0 };
            const sel = appState.filtroMedicoSecretaria === m.id;
            const horario = dias.map(d => {
                const h = m.horarioLaboral?.[d.k];
                if (h && (h.matutina || h.vespertina)) {
                    const tanda = (h.matutina && h.vespertina) ? 'mv' : (h.matutina ? 'm' : 'v');
                    return '<div style="border:1px solid #2828284a;display:flex;flex-direction:column;align-items:center;padding:2px 4px;border-radius:2px;line-height:1;">'
                        + '<span style="font-weight:700;font-size:9px;">' + d.l + '</span>'
                        + '<span style="font-size:7px;text-transform:uppercase;opacity:.9;color:#100101a8;">' + tanda + '</span></div>';
                }
                return '';
            }).join('');
            return '<button class="btn-filtro-medico ' + (sel ? 'activo' : 'inactivo') + '" onclick="kdAtnMedico(\'' + esc(m.id) + '\')"'
                + ' style="margin:1px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:5px 9px;min-width:160px;height:auto;">'
                + '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;">'
                + '<span style="font-size:13px;font-weight:600;">👨‍⚕️ ' + esc(m.nombre) + '</span>'
                + (cm.total > 0 ? '<span class="badge-contador">' + cm.total + '</span>' : '') + '</div>'
                + (cm.total > 0 ? '<div style="display:flex;gap:3px;flex-wrap:wrap;justify-content:center;width:100%;">'
                    + (cm.pendiente > 0 ? '<span style="color:#92400e;border:1px solid #fde68a;padding:1px 6px;border-radius:2px;font-size:9px;font-weight:700;">' + cm.pendiente + 'P</span>' : '')
                    + (cm.confirmada > 0 ? '<span style="color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 6px;border-radius:2px;font-size:9px;font-weight:700;">' + cm.confirmada + 'C</span>' : '')
                    + (cm.atendida > 0 ? '<span style="color:#15803d;border:1px solid #86efac;padding:1px 6px;border-radius:2px;font-size:9px;font-weight:700;">' + cm.atendida + 'A</span>' : '')
                    + (cm.cancelada > 0 ? '<span style="color:#dc2626;border:1px solid #fca5a5;padding:1px 6px;border-radius:2px;font-size:9px;font-weight:700;">' + cm.cancelada + 'Ca</span>' : '')
                    + '</div>' : '')
                + '<div style="display:flex;gap:3px;opacity:.9;">' + (horario || '<span style="font-size:8px;font-style:italic;">Sin horario</span>') + '</div>'
                + '</button>';
        }).join('');

        cont.innerHTML =
            '<div class="page-header" style="background:#14908cc4;padding:10px 0 0;margin-bottom:10px;box-shadow:var(--shadow);">'
            + '<div class="kd-citas-box">'
            +   '<div class="kd-citas-top">'
            +   '<div class="kd-citas-tit" style="margin-left:5px;">'
            +     '<h1 class="page-title" style="margin:0;font-size:16px;">Gestión de Citas</h1>'
            +     '<p style="color:#64748b;font-size:13px;margin:2px 0 3px;">' + textoFecha + '</p>'
            +   '</div>'
            +   (typeof kdHtmlCentroTrabajo === 'function' ? kdHtmlCentroTrabajo() : '')
            +   '</div>'
            +   '<div class="citas-filtros-bar">'
            +     '<input type="text" id="atn-buscar" placeholder="Buscar paciente, cédula o récord..." class="form-control search-input citas-buscador-input"'
            +       ' value="' + esc(appState.filtroBusquedaTexto || '') + '" oninput="kdAtnBuscar(this.value)">'
            +     '<div class="citas-rango-wrap">'
            +       '<span class="citas-rango-label">DESDE:</span>'
            +       '<input type="date" id="atn-desde" class="form-control citas-fecha-input" value="' + esc(appState.fechaInicioRango || '') + '" onchange="kdAtnRango()">'
            +       '<span class="citas-rango-label">HASTA:</span>'
            +       '<input type="date" id="atn-hasta" class="form-control citas-fecha-input" value="' + esc(appState.fechaFinRango || '') + '" onchange="kdAtnRango()">'
            +     '</div>'
            +     '<button class="btn ' + (esHoy ? 'btn-primary' : 'btn-secondary') + ' citas-btn-todas" onclick="kdAtnHoy()">📅 Hoy</button>'
            +     '<button class="btn ' + (appState.verTodasLasCitas ? 'btn-primary' : 'btn-secondary') + ' citas-btn-todas" onclick="kdAtnHistorico()">📂 Todas</button>'
            +     '<button class="citas-btn-nueva" onclick="abrirModalNuevaCitaInteligente()" title="Agendar nueva cita">&#65291; Nueva Cita</button>'
            +   '</div>'
            + '</div>'
            + '<div class="filter-container" style="background:#fff;width:100%;display:flex;gap:6px;margin-top:9px;overflow-x:auto;padding:9px 0;align-items:stretch;">'
            +   '<button class="btn-filtro-medico ' + (appState.filtroMedicoSecretaria === 'TODAS' ? 'activo' : 'inactivo') + '" onclick="kdAtnMedico(\'TODAS\')"'
            +     ' style="margin:1px 4px 1px 1px;display:flex;align-items:center;justify-content:center;min-width:100px;">🌟 Todos</button>'
            +   chips
            + '</div></div>';
    }

    function fmtTs(ts) {
        try {
            const d = ts && ts.toDate ? ts.toDate() : (ts && ts.seconds ? new Date(ts.seconds * 1000) : null);
            return d ? d.toLocaleString('es-DO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        } catch (e) { return ''; }
    }

    // Qué pasó con la cita: WhatsApp del paciente, recepción, atención
    function seguimientoCita(c) {
        const est = c.estado || 'pendiente';
        const n = [];
        if (c.confirmadoPorPaciente) {
            n.push('<span class="kd-atn-nota ok">✅ Paciente confirmó por WhatsApp ' + esc(fmtTs(c.fechaConfirmacionPaciente)) + '</span>');
        }
        if (est === 'cancelada') {
            const quien = c.canceladoPor === 'paciente' ? 'el paciente (WhatsApp)'
                : c.canceladoPor === 'secretaria' ? 'secretaría' + (c.canceladoPorNombre ? ' (' + esc(c.canceladoPorNombre) + ')' : '')
                : c.canceladoPor === 'atencion' ? 'atención al usuario' + (c.canceladoPorNombre ? ' (' + esc(c.canceladoPorNombre) + ')' : '')
                : (c.canceladoPor ? esc(c.canceladoPor) : 'el personal');
            n.push('<span class="kd-atn-nota mal">❌ Cancelada por ' + quien + ' ' + esc(fmtTs(c.fechaCancelacion)) + '</span>');
            if (c.motivoCancelacion) n.push('<span class="kd-atn-nota mal" style="font-weight:500;">' + esc(c.motivoCancelacion) + '</span>');
        }
        if (est === 'confirmada') n.push('<span class="kd-atn-nota info">🧾 Confirmada en recepción' + (c.ordenAtencion ? ' · Orden #' + esc(c.ordenAtencion) : '') + '</span>');
        if (est === 'atendida') n.push('<span class="kd-atn-nota ok">🩺 Atendida' + (c.ordenAtencion ? ' · Orden #' + esc(c.ordenAtencion) : '') + '</span>');
        return n.join('');
    }

    function filaCita(c) {
        const pac = _uGet(c.pacienteId) || {};
        const med = _uGet(c.medicoId) || {};
        const estado = c.estado || 'pendiente';
        const record = c.numeroRecord
            || (pac.recordsPorCentro && pac.recordsPorCentro[c.centroMedicoId]) || '';
        const f = fechaDeCita(c);
        const fTxt = f ? new Date(f + 'T12:00:00').toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const tanda = (c.tanda || '').includes('vespert') ? '🌆 Vespertina' : '🌅 Matutina';

        // Quién tomó la cita
        let quien = c.creadaPorNombre || (_uGet(c.creadaPor) || {}).nombre || '';
        if (!quien) quien = (c.creadaPor && c.creadaPor === c.pacienteId) ? 'Paciente (app)' : '—';
        const rolTxt = { secretaria: 'Secretaria', atencion: 'Atención al usuario', medico: 'Médico', admin: 'Admin' }[c.creadaPorRol] || '';

        return '<div class="kd-atn-row ' + (estado === 'cancelada' ? 'cancelada' : '') + '">'
            + '<div class="kd-atn-pac"><strong>' + esc(c.nombrePaciente || pac.nombre || '—') + '</strong>'
            +   '<span class="kd-atn-sub">' + (pac.cedula ? 'Céd. ' + esc(pac.cedula) : '') + (pac.telefono ? (pac.cedula ? ' · ' : '') + esc(pac.telefono) : '') + '</span></div>'
            + (record ? '<span class="kd-atn-record">' + esc(record) + '</span>' : '<span class="kd-atn-record vacio">Sin récord</span>')
            + '<div class="kd-atn-pac"><strong style="font-weight:600;">' + esc(c.nombreMedico || med.nombre || '—') + '</strong>'
            +   '<span class="kd-atn-sub">' + esc(c.especialidadMedico || med.especialidad || '') + '</span></div>'
            + '<div class="kd-atn-pac"><span>' + esc(fTxt) + '</span><span class="kd-atn-sub">' + tanda + '</span></div>'
            + (c.ordenAtencion ? '<span class="kd-atn-orden" title="Orden de atención asignado al confirmar">#' + esc(c.ordenAtencion) + '</span>' : '<span class="kd-atn-orden vacio" title="Se asigna cuando la secretaria confirma">—</span>')
            + '<div class="kd-atn-seg"><span class="kd-atn-est kd-atn-e-' + esc(estado) + '">' + esc(estado.toUpperCase()) + '</span>' + seguimientoCita(c) + '</div>'
            + '<div class="kd-atn-pac"><span style="font-size:12px;">' + esc(quien) + '</span><span class="kd-atn-sub">' + esc(rolTxt) + '</span></div>'
            + '<div class="kd-atn-acc">'
            +   '<button class="kd-atn-tk" title="Ver / imprimir ticket" onclick="abrirModalTicketCita(\'' + esc(c.id) + '\')">🎫</button>'
            +   (estado === 'pendiente'
                    ? '<button class="kd-atn-tk rep" title="Reprogramar cita" onclick="kdAtnReprogramar(\'' + esc(c.id) + '\')">📅</button>'
                    + '<button class="kd-atn-tk can" title="Cancelar cita" onclick="kdAtnCancelar(\'' + esc(c.id) + '\', this)">🚫</button>'
                    : '')
            + '</div>'
            + '</div>';
    }

    function pintarLista() {
        const cont = document.getElementById('atn-lista');
        if (!cont) return;
        const base = citasBase();                           // contadores: NO cambian al elegir un estado
        const act = estadoActivo();
        const lista = act === 'TODAS' ? base : base.filter(c => (c.estado || 'pendiente') === act);
        const n = e => base.filter(c => (c.estado || 'pendiente') === e).length;

        const pill = (clave, cls, texto, cantidad) =>
            '<button type="button" class="kd-atn-pill ' + cls + '" aria-pressed="' + (act === clave) + '"'
            + ' title="' + (act === clave && clave !== 'TODAS' ? 'Quitar filtro' : 'Mostrar: ' + texto) + '"'
            + ' onclick="kdAtnEstado(\'' + clave + '\')">' + cantidad + ' ' + texto + '</button>';

        const hayMas = appState._citasCursor && (appState.verTodasLasCitas || (appState.fechaInicioRango && appState.fechaFinRango));
        const vacio = act === 'TODAS'
            ? 'No hay citas para los filtros seleccionados'
            : 'No hay citas ' + act + 's para los filtros seleccionados. Pulsa «Todas» para ver el resto.';

        cont.innerHTML =
            '<div class="kd-atn-resumen' + (act !== 'TODAS' ? ' hay-filtro' : '') + '">'
            + pill('TODAS', 'kd-atn-p-total', 'Todas', base.length)
            + pill('pendiente', 'kd-atn-p-pendiente', 'pendientes', n('pendiente'))
            + pill('confirmada', 'kd-atn-p-confirmada', 'confirmadas', n('confirmada'))
            + pill('atendida', 'kd-atn-p-atendida', 'atendidas', n('atendida'))
            + pill('cancelada', 'kd-atn-p-cancelada', 'canceladas', n('cancelada'))
            + '</div>'
            + '<div class="kd-atn-card" style="overflow-x: auto;">'
            +   '<div class="kd-atn-head"><span>Paciente</span><span>Récord</span><span>Médico</span><span>Fecha</span><span>Orden</span><span>Estado / Seguimiento</span><span>Registrada por</span><span class="kd-atn-th-acc">Acciones</span></div>'
            +   (lista.length === 0
                    ? '<div class="kd-atn-vacio">' + vacio + '</div>'
                    : lista.map(filaCita).join(''))
            + '</div>'
            + (hayMas ? '<button id="btn-cargar-mas-citas" class="kd-atn-mas" onclick="cargarMasCitas()">Cargar más citas</button>' : '');
    }

    // Punto de entrada de la vista. "forzar" repinta también la cabecera.
    window.renderCitasAtencion = function (forzar) {
        inyectarEstilos();
        appState.currentView = 'citas-atencion';
        const main = document.getElementById('mainContent');
        if (!main) return;

        if (!document.getElementById('atn-lista')) {
            main.innerHTML = '<div id="atn-cabecera"></div><div id="atn-lista"></div>';
            pintarCabecera();
        } else {
            // No repintar la cabecera mientras se escribe, para no perder el foco
            const ae = document.activeElement;
            const escribiendo = ae && ae.closest && ae.closest('#atn-cabecera') && /INPUT|SELECT/.test(ae.tagName);
            if (forzar === true || !escribiendo) pintarCabecera();
        }
        pintarLista();
    };

    // Lo usa el minicalendario al pulsar un día
    window.kdAtencionRefrescar = function () {
        window.renderCitasAtencion(true);
        if (typeof window.renderCalendar === 'function') window.renderCalendar();
    };

    // ── Acciones por cita: cancelar / reprogramar (solo PENDIENTES) ──
    // Reprogramar reutiliza el modal y la validación existentes (abrirReprogramarCita /
    // _guardarReprogramacion). Cancelar es nueva solo para guardar canceladoPor='atencion'.
    function citaPendiente(id) {
        const c = (appState.citas || []).find(x => x.id === id);
        if (!c) { alert('No se encontró la cita. Actualiza la pantalla e intenta de nuevo.'); return null; }
        if ((c.estado || 'pendiente') !== 'pendiente') {
            alert('Solo se pueden modificar citas en estado PENDIENTE.\n\nEsta cita ya está ' + String(c.estado).toUpperCase() + ' (la gestiona recepción).');
            return null;
        }
        return c;
    }

    window.kdAtnReprogramar = function (id) {
        if (!citaPendiente(id)) return;
        if (typeof abrirReprogramarCita === 'function') abrirReprogramarCita(id);
    };

    window.kdAtnCancelar = async function (id, btn) {
        const c = citaPendiente(id);
        if (!c) return;
        const f = fechaDeCita(c);
        const fTxt = f ? new Date(f + 'T12:00:00').toLocaleDateString('es-DO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : '';
        const ok = confirm('¿Cancelar la cita de ' + (c.nombrePaciente || 'este paciente') + '?\n\n'
            + 'Médico: ' + (c.nombreMedico || (_uGet(c.medicoId) || {}).nombre || '—') + '\n'
            + 'Fecha: ' + fTxt + ' · tanda ' + (c.tanda || '—') + '\n\n'
            + 'El estado cambiará de Pendiente a Cancelada y quedará registrado.');
        if (!ok) return;
        if (btn) btn.disabled = true;                               // evita doble clic
        try {
            const upd = db.collection('citas').doc(id).update({
                estado: 'cancelada',
                canceladoPor: 'atencion',
                canceladoPorUid: appState.currentUser?.uid || '',
                canceladoPorNombre: appState.currentUserData?.nombre || '',
                fechaCancelacion: firebase.firestore.FieldValue.serverTimestamp(),
                ultimaModificacion: firebase.firestore.FieldValue.serverTimestamp()
            });
            upd.catch(() => {});
            // No esperar indefinidamente al servidor (internet lento / sin red)
            await Promise.race([upd, new Promise(res => setTimeout(res, navigator.onLine ? 8000 : 1200))]);
            toast(navigator.onLine ? 'Cita cancelada.' : 'Sin conexión: la cancelación se sincronizará sola.', 'success');
        } catch (err) {
            console.error('[atencion] cancelar:', err);
            alert('❌ No se pudo cancelar la cita: ' + (err && err.message || err));
            if (btn) btn.disabled = false;
        }
    };

    // ── Handlers de la barra de filtros ───────────────────────────
    window.kdAtnBuscar = function (v) {
        appState.filtroBusquedaTexto = v;
        pintarLista();                         // solo la lista: el input conserva el foco
    };

    window.kdAtnRango = function () {
        const d = document.getElementById('atn-desde')?.value || '';
        const h = document.getElementById('atn-hasta')?.value || '';
        if (d && h) {
            appState.fechaInicioRango = d;
            appState.fechaFinRango = h;
            appState.filtroBusquedaTexto = '';
            appState.fechaSeleccionadaSecretaria = null;   // limpia el minicalendario
            appState.filtroMedicoSecretaria = 'TODAS';
            appState.verTodasLasCitas = false;
            window.kdAtencionRefrescar();
        } else if (!d && !h) {
            appState.fechaInicioRango = '';
            appState.fechaFinRango = '';
            appState.fechaSeleccionadaSecretaria = fechaHoy();
            window.kdAtencionRefrescar();
        }
    };

    window.kdAtnHoy = function () {
        appState.filtroEstadoAtencion = 'TODAS';       // «Hoy» también reinicia el filtro de estado
        appState.fechaInicioRango = '';
        appState.fechaFinRango = '';
        appState.verTodasLasCitas = false;
        appState.filtroBusquedaTexto = '';
        appState.filtroMedicoSecretaria = 'TODAS';
        appState.fechaSeleccionadaSecretaria = fechaHoy();
        window.kdAtencionRefrescar();
    };

    window.kdAtnHistorico = function () {
        appState.fechaInicioRango = '';
        appState.fechaFinRango = '';
        appState.filtroBusquedaTexto = '';
        appState.filtroMedicoSecretaria = 'TODAS';
        appState.verTodasLasCitas = !appState.verTodasLasCitas;
        appState.fechaSeleccionadaSecretaria = appState.verTodasLasCitas ? null : fechaHoy();
        window.kdAtencionRefrescar();
    };

    // Filtro por estado: independiente; volver a pulsar el activo equivale a «Todas»
    window.kdAtnEstado = function (e) {
        appState.filtroEstadoAtencion = (e === 'TODAS' || e === appState.filtroEstadoAtencion) ? 'TODAS' : e;
        pintarLista();                  // solo la lista: no toca búsqueda, fechas ni médico
    };

    window.kdAtnMedico = function (id) {
        appState.filtroMedicoSecretaria = id;
        window.renderCitasAtencion(true);
    };

    // ──────────────────────────────────────────────────────────────
    // §3b  AVISOS EN VIVO: cambios de estado de las citas de mis médicos
    //      (lo invoca el listener de citas de app.logic.js)
    // ──────────────────────────────────────────────────────────────
    window.kdAtencionCambiosCitas = function (snap, citasAntes) {
        try {
            if (appState.currentUserData?.rol !== 'atencion') return;
            if (!citasAntes || citasAntes.length === 0) return;        // primera carga: sin avisos
            const ids = misMedicosIds();
            const antes = {};
            citasAntes.forEach(c => { antes[c.id] = c; });
            snap.docChanges().forEach(ch => {
                if (ch.type !== 'modified' || ch.doc.metadata.hasPendingWrites) return;
                const n = { id: ch.doc.id, ...ch.doc.data() }, o = antes[n.id];
                if (!o || !ids.includes(n.medicoId)) return;
                const pac = n.nombrePaciente || 'Paciente';
                if (!o.confirmadoPorPaciente && n.confirmadoPorPaciente) {
                    toast('✅ ' + pac + ' confirmó su cita por WhatsApp', 'success');
                } else if (o.estado !== n.estado) {
                    if (n.estado === 'cancelada') toast('❌ Cita cancelada: ' + pac + (n.canceladoPor === 'paciente' ? ' (por el paciente)' : ''), 'error');
                    else if (n.estado === 'confirmada') toast('🧾 Recepción confirmó la cita de ' + pac + (n.ordenAtencion ? ' · Orden #' + n.ordenAtencion : ''), 'success');
                    else if (n.estado === 'atendida') toast('🩺 ' + pac + ' fue atendido(a)', 'success');
                } else if (!o.ordenAtencion && n.ordenAtencion) {
                    toast('🎫 ' + pac + ': orden de atención #' + n.ordenAtencion, 'success');
                }
            });
        } catch (e) { console.warn('[atencion] avisos:', e); }
    };

    // ──────────────────────────────────────────────────────────────
    // §3c  DIRECTORIO DE MÉDICOS: horario semanal + disponibilidad por día
    // ──────────────────────────────────────────────────────────────
    const DIAS = [['lunes', 'Lun'], ['martes', 'Mar'], ['miércoles', 'Mié'], ['jueves', 'Jue'], ['viernes', 'Vie'], ['sábado', 'Sáb'], ['domingo', 'Dom']];
    let _mdFecha = null;

    function sumarDias(f, n) {
        const d = new Date(f + 'T12:00:00'); d.setDate(d.getDate() + n);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    async function ocupacionDia(medicoId, fecha) {
        const o = { matutina: 0, vespertina: 0 };
        try {
            const snap = await db.collection('citas').where('medicoId', '==', medicoId)
                .where('fechaStr', '==', fecha).where('estado', 'in', ['pendiente', 'confirmada']).get();
            snap.forEach(d => { const t = d.data().tanda; if (o[t] !== undefined) o[t]++; });
        } catch (e) {
            (appState.citas || []).forEach(c => {
                if (c.medicoId === medicoId && fechaDeCita(c) === fecha && ['pendiente', 'confirmada'].includes(c.estado) && o[c.tanda] !== undefined) o[c.tanda]++;
            });
        }
        return o;
    }

    function cajaTanda(nombre, horas, trabaja, cupo, ocupadas, cerrada) {
        if (!trabaja) return '<div class="kd-atn-tanda nolabora"><strong>' + nombre + '</strong>No atiende</div>';
        const libres = Math.max(0, cupo - ocupadas);
        const cls = libres === 0 ? 'llena' : (cerrada ? 'cerrada' : 'abierta');
        const txt = libres === 0 ? 'Sin cupo' : libres + ' de ' + cupo + ' disponibles';
        return '<div class="kd-atn-tanda ' + cls + '"><strong>' + nombre + ' · ' + horas + '</strong>' + txt
            + (cerrada && libres > 0 ? '<br><em>Ya pasó (solo personal puede agendar)</em>' : '') + '</div>';
    }

    window.renderMedicosAtencion = function () {
        inyectarEstilos();
        appState.currentView = 'medicos-atencion';
        if (!_mdFecha) _mdFecha = fechaHoy();
        const main = document.getElementById('mainContent');
        if (!main) return;
        main.innerHTML =
            '<div class="page-header" style="margin-bottom:12px;"><h1 class="page-title" style="margin:0;">Directorio de Médicos</h1>'
            + '<p style="color:#64748b;font-size:13px;margin:3px 0 0;">Horarios y disponibilidad de los médicos que atiendes</p></div>'
            + '<div class="kd-atn-fbar"><button class="btn btn-secondary" onclick="kdAtnMdDia(-1)">◀</button>'
            + '<input type="date" id="atn-md-fecha" class="form-control" style="max-width:170px;" value="' + esc(_mdFecha) + '" onchange="kdAtnMdFecha(this.value)">'
            + '<button class="btn btn-secondary" onclick="kdAtnMdDia(1)">▶</button>'
            + '<button class="btn btn-primary" onclick="kdAtnMdFecha(\'' + esc(fechaHoy()) + '\')">Hoy</button>'
            + '<span id="atn-md-tit" style="font-size:13px;color:#475569;text-transform:capitalize;"></span></div>'
            + '<div id="atn-md-grid" class="kd-atn-md-grid"></div>';
        pintarMedicos();
    };

    async function pintarMedicos() {
        const grid = document.getElementById('atn-md-grid');
        if (!grid) return;
        const fecha = _mdFecha;
        const ids = misMedicosIds();
        const meds = (appState.users || []).filter(u => ids.includes(u.id) && u.activo !== false);
        const tit = document.getElementById('atn-md-tit');
        if (tit) tit.textContent = new Date(fecha + 'T12:00:00').toLocaleDateString('es-DO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        if (!meds.length) { grid.innerHTML = '<div class="kd-atn-vacio" style="grid-column:1/-1;">No tienes médicos asignados.</div>'; return; }
        grid.innerHTML = '<div class="kd-atn-vacio" style="grid-column:1/-1;">Verificando cupos...</div>';

        const ocu = await Promise.all(meds.map(m => ocupacionDia(m.id, fecha)));
        if (fecha !== _mdFecha) return;                       // el usuario cambió de día mientras cargaba
        const dk = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(fecha + 'T12:00:00').getDay()];
        const hoy = fechaHoy();

        grid.innerHTML = meds.map((m, i) => {
            const h = (m.horarioLaboral || {})[dk] || {};
            const semana = DIAS.map(([k, l]) => {
                const d = (m.horarioLaboral || {})[k] || {};
                const t = d.matutina && d.vespertina ? 'Mañana y tarde' : (d.matutina ? 'Mañana' : (d.vespertina ? 'Tarde' : ''));
                return '<div class="' + (t ? 'on' : '') + '">' + l + '<small>' + (t ? (d.matutina && d.vespertina ? 'M+V' : (d.matutina ? 'Mat' : 'Vesp')) : '—') + '</small></div>';
            }).join('');
            const esPasadoHoy = fecha === hoy;
            const horaRD = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santo_Domingo', hour: '2-digit', hour12: false }).format(new Date()), 10) % 24;
            const cerrM = esPasadoHoy && horaRD >= 12, cerrV = esPasadoHoy && horaRD >= 18;
            const centro = (appState.centrosMedicos || []).find(c => c.id === m.centroMedicoId);
            const precio = m.tipoServicio === 'privado' ? 'RD$ ' + Number(m.costoConsulta || 0).toLocaleString() : (m.tipoServicio ? 'Servicio ' + esc(m.tipoServicio) : '');
            return '<div class="kd-atn-md"><div class="kd-atn-md-h"><h3>👨‍⚕️ ' + esc(m.nombre) + '</h3>'
                + '<span>' + esc(m.especialidad || '') + (centro ? ' · 🏢 ' + esc(centro.nombre) : '') + (precio ? ' · ' + precio : '') + '</span></div>'
                + '<div class="kd-atn-md-b"><div><div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:5px;">Horario semanal</div><div class="kd-atn-sem">' + semana + '</div></div>'
                + '<div><div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:5px;">Disponibilidad del día</div><div class="kd-atn-tandas">'
                + cajaTanda('Matutina', '8am-12pm', !!h.matutina, m.cupoMatutina || 15, ocu[i].matutina, cerrM)
                + cajaTanda('Vespertina', '2pm-6pm', !!h.vespertina, m.cupoVespertina || 15, ocu[i].vespertina, cerrV)
                + '</div></div>'
                + '<button class="btn btn-primary" style="width:100%;" onclick="abrirModalNuevaCitaInteligente()">＋ Agendar cita</button></div></div>';
        }).join('');
    }
    window.kdAtnMdFecha = function (f) { if (!f) return; _mdFecha = f; const i = document.getElementById('atn-md-fecha'); if (i) i.value = f; pintarMedicos(); };
    window.kdAtnMdDia = function (n) { window.kdAtnMdFecha(sumarDias(_mdFecha || fechaHoy(), n)); };

    // ──────────────────────────────────────────────────────────────
    // §4  ADMIN: Gestión de usuarios de Atención al Usuario
    // ──────────────────────────────────────────────────────────────
    window.renderAtencionAdmin = function () {
        appState.currentView = 'atencion-admin';
        const lista = (appState.users || []).filter(u => u.rol === 'atencion');

        document.getElementById('mainContent').innerHTML =
            '<div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;flex-wrap:wrap;gap:12px;">'
            + '<div><h1 class="page-title" style="margin:0;">Atención al Usuario</h1>'
            + '<p style="color:#64748b;font-size:14px;">Personal que agenda citas y orienta a los pacientes, con sus médicos asignados</p></div>'
            + '<button class="btn btn-primary" onclick="openModalAtencion()" style="box-shadow:0 4px 12px rgba(37,99,235,.2);">+ Nuevo Usuario de Atención</button>'
            + '</div>'
            + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;">'
            + (lista.length === 0
                ? '<div style="grid-column:1/-1;text-align:center;padding:50px;background:#fff;border-radius:12px;color:#94a3b8;">No hay usuarios de Atención al Usuario registrados actualmente.</div>'
                : lista.map(s => {
                    const ids = Array.isArray(s.medicoAsignadoId) ? s.medicoAsignadoId : [s.medicoAsignadoId];
                    const medicos = (appState.users || []).filter(u => ids.includes(u.id));
                    const centro = (appState.centrosMedicos || []).find(c => c.id === s.centroMedicoId);
                    return '<div style="background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;display:flex;flex-direction:column;">'
                        + '<div style="padding:20px;border-bottom:1px solid #f1f5f9;background:#f8fafc;display:flex;align-items:center;gap:15px;">'
                        +   '<div style="width:45px;height:45px;background:#0d9488;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:18px;">' + esc((s.nombre || '?').charAt(0)) + '</div>'
                        +   '<div style="flex:1;"><h3 style="margin:0;font-size:16px;color:#1e293b;">' + esc(s.nombre) + '</h3>'
                        +   '<span style="font-size:12px;color:#64748b;">ID: ' + esc(s.cedula || '---') + '</span></div>'
                        +   '<button onclick="openEditModalAtencion(\'' + esc(s.id) + '\')" style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px;cursor:pointer;" title="Editar">✏️</button>'
                        + '</div>'
                        + '<div style="padding:20px;flex:1;">'
                        +   '<div style="margin-bottom:15px;"><label style="display:block;font-size:11px;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:8px;">Centro Médico</label>'
                        +   '<div style="color:#475569;font-size:14px;">🏢 ' + esc(centro?.nombre || 'No asignado') + '</div></div>'
                        +   '<div style="margin-bottom:15px;"><label style="display:block;font-size:11px;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:8px;">Médicos a Cargo (' + medicos.length + ')</label>'
                        +   '<div style="display:flex;flex-wrap:wrap;gap:6px;">'
                        +   (medicos.length ? medicos.map(m => '<span style="background:#f0fdfa;color:#0f766e;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid #99f6e4;font-weight:500;">👨‍⚕️ Dr. ' + esc((m.nombre || '').split(' ')[0]) + '</span>').join('')
                                         : '<span style="color:#cbd5e1;font-style:italic;font-size:13px;">Sin médicos asignados</span>')
                        +   '</div></div>'
                        +   '<div style="background:#f8fafc;border-radius:8px;padding:12px;font-size:13px;color:#475569;">'
                        +   '<div style="margin-bottom:5px;">📧 ' + esc(s.email) + '</div><div>📞 ' + esc(s.telefono || 'No registrado') + '</div></div>'
                        + '</div>'
                        + '<div style="padding:12px 20px;background:' + (s.activo ? '#f0fdf4' : '#fef2f2') + ';border-top:1px solid #f1f5f9;font-size:12px;color:' + (s.activo ? '#166534' : '#991b1b') + ';">'
                        +   (s.activo ? '● Cuenta Activa' : '● Inactiva') + '</div></div>';
                }).join(''))
            + '</div>';
    };

    function opcionesCentro(sel) {
        return (appState.centrosMedicos || []).map(c =>
            '<option value="' + esc(c.id) + '" ' + (c.id === sel ? 'selected' : '') + '>' + esc(c.nombre) + '</option>').join('');
    }

    const BLOQUE_MEDICOS =
        '<div class="form-group" style="grid-column:span 2;">'
        + '<label class="form-label">Médicos Asignados (Seleccione uno o varios) *</label>'
        + '<div id="contenedorMedicosCheck" style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;max-height:150px;overflow-y:auto;background:#f8fafc;">'
        + '<p style="font-size:12px;color:#94a3b8;">Primero seleccione un centro médico...</p></div></div>';

    window.openModalAtencion = function () {
        const modal = document.getElementById('modalContainer');
        modal.innerHTML =
            '<div class="modal-overlay"><div class="modal-content" style="max-width:600px;">'
            + '<div class="modal-header"><h3 class="modal-title">Registrar Usuario de Atención al Usuario</h3><button class="btn-close" onclick="closeModal()">×</button></div>'
            + '<form id="formAtencion" onsubmit="submitAtencion(event)" style="padding:15px;background:#fff;">'
            +   '<div class="grid grid-2">'
            +     '<div class="form-group"><label class="form-label">Nombre Completo *</label><input type="text" id="atnNombre" class="form-input" required></div>'
            +     '<div class="form-group"><label class="form-label">Cédula *</label><input type="text" id="atnCedula" class="form-input" required></div>'
            +   '</div>'
            +   '<div class="grid grid-2">'
            +     '<div class="form-group"><label class="form-label">Centro Médico *</label>'
            +       '<select id="atnCentro" class="form-input" required onchange="cargarMedicosPorCentro(this.value)"><option value="">Seleccione Centro...</option>' + opcionesCentro('') + '</select></div>'
            +     BLOQUE_MEDICOS
            +   '</div>'
            +   '<div class="form-group"><label class="form-label">Correo Electrónico *</label><input type="email" id="atnEmail" class="form-input" required></div>'
            +   '<div class="grid grid-2">'
            +     '<div class="form-group"><label class="form-label">Teléfono</label><input type="tel" id="atnTelefono" class="form-input"></div>'
            +     '<div class="form-group"><label class="form-label">Dirección</label><input type="text" id="atnDireccion" class="form-input"></div>'
            +   '</div>'
            +   '<div class="form-group"><label class="form-label">Contraseña *</label><input type="password" id="atnPassword" class="form-input" required minlength="6" placeholder="Mínimo 6 caracteres"></div>'
            +   '<div class="form-group"><label class="form-label">Clave de Recuperación (referencia admin)</label><input type="text" id="atnClaveRef" class="form-input" placeholder="Copia de la clave para soporte"></div>'
            +   '<div style="display:flex;gap:10px;">'
            +     '<button type="submit" id="btnSubmitAtencion" class="btn btn-primary" style="flex:1;">Guardar Registro</button>'
            +     '<button type="button" class="btn btn-secondary" style="flex:1;" onclick="closeModal()">Cancelar</button>'
            +   '</div>'
            + '</form></div></div>';
        modal.classList.remove('hidden');
    };

    window.submitAtencion = async function (e) {
        e.preventDefault();
        const val = id => (document.getElementById(id)?.value || '').trim();
        const password = document.getElementById('atnPassword').value;
        const medicosIds = Array.from(document.querySelectorAll('input[name="medicosSeleccionados"]:checked')).map(cb => cb.value);

        if (medicosIds.length === 0) { alert('Por favor, seleccione al menos un médico.'); return; }
        if (!password || password.length < 6) { alert('⚠️ La contraseña debe tener al menos 6 caracteres.'); return; }

        const btn = document.getElementById('btnSubmitAtencion');
        if (btn) { btn.disabled = true; btn.textContent = 'Creando...'; }
        try {
            const crearPersonal = firebase.functions().httpsCallable('crearPersonal');
            const r = await crearPersonal({
                nombre: val('atnNombre'), cedula: val('atnCedula'), email: val('atnEmail'),
                password, claveRecuperacion: val('atnClaveRef'),
                rol: 'atencion', centroId: val('atnCentro'),
                telefono: val('atnTelefono'), direccion: val('atnDireccion'),
            });
            await db.collection('users').doc(r.data.uid).update({ medicoAsignadoId: medicosIds });
            closeModal();
            toast('Usuario de Atención al Usuario creado correctamente.');
            if (appState.currentView === 'atencion-admin') window.renderAtencionAdmin();
        } catch (err) {
            console.error('[submitAtencion]', err);
            alert('Error al crear: ' + (err?.message || err));
            if (btn) { btn.disabled = false; btn.textContent = 'Guardar Registro'; }
        }
    };

    window.openEditModalAtencion = function (id) {
        const s = _uGet(id);
        if (!s) return;
        const modal = document.getElementById('modalContainer');
        modal.innerHTML =
            '<div class="modal-overlay"><div class="modal-content" style="max-width:600px;">'
            + '<div class="modal-header"><h3 class="modal-title">Editar: ' + esc(s.nombre) + '</h3><button class="btn-close" onclick="closeModal()">×</button></div>'
            + '<form onsubmit="submitUpdateAtencion(event,\'' + esc(id) + '\')" style="padding:15px;background:#fff;">'
            +   '<div class="grid grid-2">'
            +     '<div class="form-group"><label class="form-label">Nombre Completo *</label><input type="text" id="editAtnNombre" class="form-input" value="' + esc(s.nombre) + '" required></div>'
            +     '<div class="form-group"><label class="form-label">Cédula *</label><input type="text" id="editAtnCedula" class="form-input" value="' + esc(s.cedula || '') + '" required></div>'
            +   '</div>'
            +   '<div class="grid grid-2">'
            +     '<div class="form-group"><label class="form-label">Centro Médico *</label>'
            +       '<select id="editAtnCentro" class="form-input" required onchange="cargarMedicosPorCentro(this.value)"><option value="">Seleccione Centro...</option>' + opcionesCentro(s.centroMedicoId) + '</select></div>'
            +     BLOQUE_MEDICOS
            +   '</div>'
            +   '<div class="grid grid-2">'
            +     '<div class="form-group"><label class="form-label">Teléfono</label><input type="tel" id="editAtnTelefono" class="form-input" value="' + esc(s.telefono || '') + '"></div>'
            +     '<div class="form-group"><label class="form-label">Dirección</label><input type="text" id="editAtnDireccion" class="form-input" value="' + esc(s.direccion || '') + '"></div>'
            +   '</div>'
            +   '<div style="background:#fff4e5;padding:10px;border-radius:5px;margin-bottom:15px;font-size:13px;">⚠️ <strong>Nota:</strong> Los cambios de correo o contraseña principal deben realizarse desde la consola de Firebase por seguridad.</div>'
            +   '<div style="display:flex;gap:10px;">'
            +     '<button type="submit" class="btn btn-primary" style="flex:1;">Actualizar Datos</button>'
            +     '<button type="button" class="btn btn-secondary" style="flex:1;" onclick="closeModal()">Cancelar</button>'
            +   '</div>'
            + '</form></div></div>';
        modal.classList.remove('hidden');
        const actuales = Array.isArray(s.medicoAsignadoId) ? s.medicoAsignadoId : (s.medicoAsignadoId ? [s.medicoAsignadoId] : []);
        cargarMedicosPorCentro(s.centroMedicoId, actuales);
    };

    window.submitUpdateAtencion = async function (e, id) {
        e.preventDefault();
        const medicosIds = Array.from(document.querySelectorAll('input[name="medicosSeleccionados"]:checked')).map(cb => cb.value);
        if (medicosIds.length === 0) { alert('Por favor, seleccione al menos un médico.'); return; }

        const centroId = document.getElementById('editAtnCentro').value;
        const centro = (appState.centrosMedicos || []).find(c => c.id === centroId);
        try {
            await db.collection('users').doc(id).update({
                nombre: document.getElementById('editAtnNombre').value.trim(),
                cedula: document.getElementById('editAtnCedula').value.trim(),
                telefono: document.getElementById('editAtnTelefono').value.trim(),
                direccion: document.getElementById('editAtnDireccion').value.trim(),
                centroMedicoId: centroId,
                centroNombre: centro?.nombre || '',
                medicoAsignadoId: medicosIds,
                ultimaActualizacion: firebase.firestore.FieldValue.serverTimestamp()
            });
            closeModal();
            toast('Datos actualizados correctamente.');
        } catch (err) {
            console.error('[submitUpdateAtencion]', err);
            alert('Hubo un error al intentar actualizar los datos');
        }
    };
})();
