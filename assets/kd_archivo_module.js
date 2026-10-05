/* ═══════════════════════════════════════════════════════════════════
   KuraDoc — Módulo Archivo de Récords
   © 2026 KuraDoc. Todos los derechos reservados.

   FLUJO
   Secretaria (cita confirmada con récord)  →  botón S-R
   Archivista                               →  BUSCANDO  →  ENTREGADO
   Cada paso se sincroniza en tiempo real entre ambos paneles.

   DATOS
   Colección  solicitudes_record/{citaId}   (un documento por cita)
   estado: 'SR' | 'BUSCANDO' | 'ENTREGADO'
   No toca el documento de la cita.

   CONEXIÓN CON app_logic.js (todo defensivo, con typeof)
   · kdArchivoInit()   → se llama desde loadAllData() (secretaria y archivista)
   · renderArchivo()   → case 'archivo' de navigateTo()
   · kdArchivoChip(c)  → se inserta en la fila "En sala" de la secretaria

   DEPENDENCIAS GLOBALES (ya existen en app_logic.js)
   db, firebase, appState, fechaHoy(), _uGet() (opcional)
═══════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────
    // §0  CONSTANTES Y ESTADO
    // ──────────────────────────────────────────────────────────────
    const COL            = 'solicitudes_record';
    const VENTANA_DIAS   = 30;      // secretaria: solicitudes de ±30 días
    const ESPERA_AVISO   = 8;       // minutos → tarjeta en ámbar
    const ESPERA_URGENTE = 15;      // minutos → tarjeta en rojo
    const ETIQUETA = { SR: 'S-R', BUSCANDO: 'BUSCANDO', ENTREGADO: 'ENTREGADO' };
    const ESTADO_CITA = { pendiente: 'Pendiente', confirmada: 'Confirmada', atendida: 'Atendida', cancelada: 'Cancelada' };

    const S = window._kdArc = window._kdArc || {
        activo: false,           // true si el usuario actual es archivista
        centroId: '',
        hoy: '',
        sonido: true,
        mounted: false,
        root: null,
        tickId: null,
        // secretaria
        sec: { unsub: null, map: new Map(), centroId: '', tuvoDatos: false },
        // archivista
        f: null,                 // filtros
        citas: [], citasListo: false, unsubCitas: null,
        solPorFecha: new Map(),  // fecha → { map, listo, unsub }
        nuevos: new Set()        // ids resaltados por llegada reciente
    };

    // ──────────────────────────────────────────────────────────────
    // §1  UTILIDADES
    // ──────────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const norm = (s) => String(s == null ? '' : s)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    const ymd = (d) => d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');

    const hoyStr = () => (typeof fechaHoy === 'function') ? fechaHoy() : ymd(new Date());

    function sumarDias(f, n) {
        const d = new Date(f + 'T12:00:00');
        d.setDate(d.getDate() + n);
        return ymd(d);
    }

    function fechaLarga(f) {
        try {
            return new Date(f + 'T12:00:00')
                .toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' });
        } catch (e) { return f; }
    }

    const tsMs = (t) => t && t.toMillis ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : 0);

    function hora(ms) {
        if (!ms) return '--:--';
        return new Date(ms).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' });
    }

    function minutosDesde(ms) { return ms ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : 0; }

    function textoMin(m) {
        if (m < 1) return 'menos de 1 min';
        if (m < 60) return m + ' min';
        return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
    }

    function getUser(id) {
        if (!id) return null;
        try { if (typeof window._uGet === 'function') { const u = window._uGet(id); if (u) return u; } } catch (e) { /* sigue */ }
        return (appState.users || []).find(u => (u.uid || u.id) === id) || null;
    }

    function fechaDeCita(c) {
        if (c.fechaStr) return c.fechaStr;
        if (c.fecha && c.fecha.toDate) return ymd(c.fecha.toDate());
        return '';
    }

    const nombrePac = (c) => c.nombrePaciente || (getUser(c.pacienteId) || {}).nombre || 'Paciente';
    const nombreMed = (c) => c.nombreMedico || (getUser(c.medicoId) || {}).nombre || 'Médico';
    const espCita   = (c) => c.especialidadMedico || (getUser(c.medicoId) || {}).especialidad || 'General';

    function leer(doc) {
        const d = doc.data({ serverTimestamps: 'estimate' });
        return Object.assign({ id: doc.id }, d, {
            _creadoMs: tsMs(d.creadoEn),
            _buscandoMs: tsMs(d.buscandoEn),
            _entregadoMs: tsMs(d.entregadoEn)
        });
    }

    /** Errores de listeners. Si Firestore pide un índice, su mensaje trae el enlace
     *  para crearlo con un clic: se imprime COMPLETO en la consola como error. */
    function logErr(contexto, err) {
        if (err && err.code === 'failed-precondition' && /index/i.test(err.message || '')) {
            console.error('[Archivo] Firestore necesita un índice para esta consulta (' + contexto + ').\n' +
                'Abre el enlace del mensaje para crearlo automáticamente:\n\n' + err.message);
        } else {
            console.warn('[Archivo] ' + contexto + ':', (err && (err.code || err.message)) || err);
        }
    }

    function registrarListener(unsub) {
        try { if (typeof activeListeners !== 'undefined') activeListeners.push(unsub); } catch (e) { /* noop */ }
    }

    function toast(msg, tipo) {
        let box = $('kd-arc-toasts');
        if (!box) {
            box = document.createElement('div');
            box.id = 'kd-arc-toasts';
            box.setAttribute('role', 'status');
            box.setAttribute('aria-live', 'polite');
            document.body.appendChild(box);
        }
        const t = document.createElement('div');
        t.className = 'kd-arc-toast' + (tipo ? ' ' + tipo : '');
        t.textContent = msg;
        box.appendChild(t);
        setTimeout(() => t.remove(), 4500);
    }

    // ── Sonido (Web Audio, sin archivos) ─────────────────────────
    let audioCtx = null;
    function audio() {
        try {
            if (!audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                audioCtx = new AC();
            }
            if (audioCtx.state === 'suspended') audioCtx.resume();
            return audioCtx;
        } catch (e) { return null; }
    }

    function beep() {
        if (!S.sonido) return;
        const c = audio();
        if (!c) return;
        const t0 = c.currentTime;
        [[880, 0], [1175, 0.17]].forEach(([freq, dt]) => {
            const o = c.createOscillator(), g = c.createGain();
            o.type = 'sine';
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, t0 + dt);
            g.gain.exponentialRampToValueAtTime(0.28, t0 + dt + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.3);
            o.connect(g); g.connect(c.destination);
            o.start(t0 + dt); o.stop(t0 + dt + 0.32);
        });
    }

    // El navegador solo permite audio tras un gesto: lo "desbloqueamos" con el primer toque
    document.addEventListener('pointerdown', () => { if (S.activo) audio(); }, { passive: true });

    // ──────────────────────────────────────────────────────────────
    // §2  PUNTO DE ENTRADA (lo llama loadAllData)
    // ──────────────────────────────────────────────────────────────
    function detenerTodo() {
        if (S.sec.unsub) { try { S.sec.unsub(); } catch (e) { /* noop */ } S.sec.unsub = null; }
        if (S.unsubCitas) { try { S.unsubCitas(); } catch (e) { /* noop */ } S.unsubCitas = null; }
        S.solPorFecha.forEach(ent => { try { ent.unsub && ent.unsub(); } catch (e) { /* noop */ } });
        S.solPorFecha.clear();
        if (S.tickId) { clearInterval(S.tickId); S.tickId = null; }
    }

    window.kdArchivoInit = function () {
        const u = appState && appState.currentUserData;
        detenerTodo();
        S.activo = false;
        if (!u) return;
        if (u.rol === 'secretaria') initSecretaria(u);
        else if (u.rol === 'archivista') initArchivista(u);
    };

    // ══════════════════════════════════════════════════════════════
    // §3  SECRETARIA — botón S-R y chip de estado en "En sala"
    // ══════════════════════════════════════════════════════════════
    function initSecretaria(u) {
        const centroId = u.centroMedicoId || '';
        if (centroId !== S.sec.centroId) { S.sec.map = new Map(); S.sec.tuvoDatos = false; }
        S.sec.centroId = centroId;
        if (!centroId) return;               // sin centro asignado no hay archivo
        listenerSecretaria(true);
    }

    function listenerSecretaria(conRango) {
        if (S.sec.unsub) { try { S.sec.unsub(); } catch (e) { /* noop */ } }
        const hoy = hoyStr();
        let q = db.collection(COL).where('centroMedicoId', '==', S.sec.centroId);
        q = conRango
            ? q.where('fechaStr', '>=', sumarDias(hoy, -VENTANA_DIAS)).where('fechaStr', '<=', sumarDias(hoy, VENTANA_DIAS))
            : q.where('fechaStr', '==', hoy);

        let primera = true;
        S.sec.unsub = q.onSnapshot(snap => {
            if (primera) { S.sec.map = new Map(); primera = false; }   // el primer snapshot trae el estado completo
            const ids = [];
            snap.docChanges().forEach(ch => {
                if (ch.type === 'removed') S.sec.map.delete(ch.doc.id);
                else S.sec.map.set(ch.doc.id, leer(ch.doc));
                ids.push(ch.doc.id);
            });
            const eraPrimera = !S.sec.tuvoDatos;
            S.sec.tuvoDatos = true;
            if (eraPrimera) refrescarSlots(null); else refrescarSlots(ids);
        }, err => {
            logErr('solicitudes de la secretaria', err);
            if (conRango && err.code === 'failed-precondition') {
                console.warn('[Archivo] Mientras se crea el índice solo se mostrarán las solicitudes de hoy. Cuando el índice esté listo, recarga la página.');
                listenerSecretaria(false);
            }
        });
        registrarListener(S.sec.unsub);
    }

    function enVentana(c) {
        const f = fechaDeCita(c);
        if (!f) return false;
        const hoy = hoyStr();
        return f >= sumarDias(hoy, -VENTANA_DIAS) && f <= sumarDias(hoy, VENTANA_DIAS);
    }

    function chipHTML(s) {
        let tip, cls, txt;
        if (s.estado === 'BUSCANDO') {
            cls = 'kd-arc-chip-buscando'; txt = 'BUSCANDO';
            tip = 'Buscando: ' + (s.buscandoPorNombre || 'archivo') + ' desde las ' + hora(s._buscandoMs);
        } else if (s.estado === 'ENTREGADO') {
            cls = 'kd-arc-chip-entregado'; txt = 'ENTREGADO';
            tip = 'Entregado por ' + (s.entregadoPorNombre || 'archivo') + ' a las ' + hora(s._entregadoMs);
        } else {
            cls = 'kd-arc-chip-sr'; txt = 'S-R';
            tip = 'Solicitado por ' + (s.solicitadoPorNombre || 'secretaria') + ' a las ' + hora(s._creadoMs);
        }
        return '<span class="kd-arc-chip ' + cls + '" title="' + esc(tip) + '">' + txt + '</span>';
    }

    function slotInner(c) {
        if (!c || !S.sec.centroId || !S.sec.tuvoDatos) return '';
        if (!String(c.numeroRecord || '').trim()) return '';
        if (c.estado !== 'confirmada' && c.estado !== 'atendida') return '';
        const s = S.sec.map.get(c.id);
        if (!s) {
            if (!enVentana(c)) return '';
            return '<button type="button" class="kd-arc-btn-sr" ' +
                'onclick="event.stopPropagation();kdArchivoSolicitar(\'' + c.id + '\',this)" ' +
                'title="Pedir este récord al archivo">📁 S-R</button>';
        }
        let html = chipHTML(s);
        if (s.estado === 'SR') {
            html += '<button type="button" class="kd-arc-x" title="Cancelar la solicitud" aria-label="Cancelar solicitud" ' +
                'onclick="event.stopPropagation();kdArchivoCancelar(\'' + c.id + '\')">✕</button>';
        }
        return html;
    }

    /** Se inserta en la fila "En sala" (app_logic.js → renderItemCitaTemplate). */
    window.kdArchivoChip = function (c) {
        if (!c || !c.id) return '';
        return '<span class="kd-arc-slot" data-kd-arc-cita="' + esc(c.id) + '">' + slotInner(c) + '</span>';
    };

    /** Actualiza solo los chips afectados, sin redibujar la lista. ids = null → todos. */
    function refrescarSlots(ids) {
        const nodos = ids
            ? ids.reduce((acc, id) => acc.concat(Array.from(document.querySelectorAll('[data-kd-arc-cita="' + id + '"]'))), [])
            : Array.from(document.querySelectorAll('[data-kd-arc-cita]'));
        nodos.forEach(n => {
            const id = n.getAttribute('data-kd-arc-cita');
            const c = (appState.citas || []).find(x => x.id === id);
            if (c) n.innerHTML = slotInner(c);
        });
    }

    window.kdArchivoSolicitar = async function (citaId, btn) {
        const u = appState.currentUserData;
        const c = (appState.citas || []).find(x => x.id === citaId);
        if (!u || !c) return;
        const record = String(c.numeroRecord || '').trim();
        if (!record) { toast('Esta cita no tiene número de récord.', 'err'); return; }

        if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

        const data = {
            citaId: citaId,
            centroMedicoId: c.centroMedicoId || u.centroMedicoId || '',
            medicoId: c.medicoId || '',
            medicoNombre: nombreMed(c),
            especialidad: espCita(c),
            pacienteId: c.pacienteId || '',
            pacienteNombre: nombrePac(c),
            numeroRecord: record,
            fechaStr: fechaDeCita(c) || hoyStr(),
            tanda: c.tanda || '',
            estado: 'SR',
            solicitadoPor: appState.currentUser.uid,
            solicitadoPorNombre: u.nombre || 'Secretaria',
            creadoEn: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            await db.collection(COL).doc(citaId).set(data);
            toast('Récord solicitado al archivo.', 'ok');
            // el chip aparece solo cuando llega el snapshot
        } catch (e) {
            console.warn('[Archivo] solicitar:', e.code || e.message);
            if (e.code === 'permission-denied') {
                // lo más probable: ya existía la solicitud y esta ventana no la conocía
                try {
                    const d = await db.collection(COL).doc(citaId).get();
                    if (d.exists) {
                        S.sec.map.set(citaId, leer(d));
                        refrescarSlots([citaId]);
                        toast('Ese récord ya estaba solicitado.', '');
                        return;
                    }
                } catch (_) { /* cae al mensaje genérico */ }
                toast('No tienes permiso para solicitar este récord.', 'err');
            } else {
                toast('No se pudo solicitar: ' + (e.message || e.code), 'err');
            }
            refrescarSlots([citaId]);
        }
    };

    window.kdArchivoCancelar = async function (citaId) {
        if (!confirm('¿Cancelar la solicitud de este récord?')) return;
        try {
            await db.collection(COL).doc(citaId).delete();
            toast('Solicitud cancelada.', 'ok');
        } catch (e) {
            if (e.code === 'permission-denied') toast('El archivo ya empezó a buscar este récord. No se puede cancelar.', 'err');
            else toast('No se pudo cancelar: ' + (e.message || e.code), 'err');
            refrescarSlots([citaId]);
        }
    };

    // ══════════════════════════════════════════════════════════════
    // §4  ARCHIVISTA — datos
    // ══════════════════════════════════════════════════════════════
    function initArchivista(u) {
        S.activo = true;
        S.centroId = u.centroMedicoId || '';
        S.hoy = hoyStr();
        try { S.sonido = localStorage.getItem('kd_arc_sonido') !== '0'; } catch (e) { S.sonido = true; }

        // Los filtros sobreviven a una reconexión (inactividad, etc.)
        if (!S.f) {
            S.f = {
                izqFecha: S.hoy, izqMedico: '', izqEstado: '', izqTexto: '',
                derFecha: S.hoy, derEsp: '', derMedico: '', derEstado: 'SR'
            };
        }
        S.citas = []; S.citasListo = false;

        iniciarCitas();
        asegurarSolicitudes();
        S.tickId = setInterval(tick, 30000);
    }

    function iniciarCitas() {
        if (S.unsubCitas) { try { S.unsubCitas(); } catch (e) { /* noop */ } S.unsubCitas = null; }
        S.citas = []; S.citasListo = false;
        if (!S.centroId) { pintarIzq(); return; }
        S.unsubCitas = db.collection('citas')
            .where('centroMedicoId', '==', S.centroId)
            .where('fechaStr', '==', S.f.izqFecha)
            .onSnapshot(snap => {
                S.citas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                S.citasListo = true;
                pintarIzq();
            }, err => {
                logErr('citas del centro', err);
                S.citasListo = true;
                pintarIzq();
            });
        registrarListener(S.unsubCitas);
    }

    /** Mantiene un listener por cada fecha que se está viendo (+ hoy, para las alertas). */
    function asegurarSolicitudes() {
        const necesarias = new Set([S.hoy, S.f.izqFecha, S.f.derFecha]);
        necesarias.forEach(f => { if (!S.solPorFecha.has(f)) iniciarSolFecha(f); });
        Array.from(S.solPorFecha.keys()).forEach(f => {
            if (!necesarias.has(f)) {
                const ent = S.solPorFecha.get(f);
                try { ent.unsub && ent.unsub(); } catch (e) { /* noop */ }
                S.solPorFecha.delete(f);
            }
        });
    }

    function iniciarSolFecha(f) {
        const ent = { map: new Map(), listo: false, baseline: false, unsub: null };
        S.solPorFecha.set(f, ent);
        if (!S.centroId) return;
        ent.unsub = db.collection(COL)
            .where('centroMedicoId', '==', S.centroId)
            .where('fechaStr', '==', f)
            .onSnapshot(snap => {
                let llegoNueva = false;
                // La caché local puede entregar un primer snapshot viejo: el estado "base"
                // es el primer snapshot que viene del servidor; solo lo posterior suena.
                const esBase = !ent.baseline;
                snap.docChanges().forEach(ch => {
                    const id = ch.doc.id;
                    if (ch.type === 'removed') { ent.map.delete(id); S.nuevos.delete(id); return; }
                    const s = leer(ch.doc);
                    ent.map.set(id, s);
                    if (ch.type === 'added' && !esBase && s.estado === 'SR' && !ch.doc.metadata.hasPendingWrites) {
                        llegoNueva = true;
                        S.nuevos.add(id);
                        setTimeout(() => { S.nuevos.delete(id); }, 8000);
                    }
                });
                if (!snap.metadata.fromCache) ent.baseline = true;
                ent.listo = true;
                if (llegoNueva && f === S.hoy) beep();
                pintarDer();
                pintarIzq();
            }, err => {
                logErr('solicitudes del ' + f, err);
                ent.listo = true;
                pintarDer();
            });
        registrarListener(ent.unsub);
    }

    const solicitudesDe = (f) => { const e = S.solPorFecha.get(f); return e ? Array.from(e.map.values()) : []; };

    function buscarSol(id) {
        for (const ent of S.solPorFecha.values()) { if (ent.map.has(id)) return ent.map.get(id); }
        return null;
    }

    /** Cada 30 s: tiempos de espera y cambio de día. */
    function tick() {
        if (!S.activo) return;
        const h = hoyStr();
        if (h !== S.hoy) {
            const ayer = S.hoy;
            S.hoy = h;
            let cambioIzq = false;
            if (S.f.izqFecha === ayer) { S.f.izqFecha = h; cambioIzq = true; }
            if (S.f.derFecha === ayer) S.f.derFecha = h;
            if (cambioIzq) iniciarCitas();
            asegurarSolicitudes();
            sincronizarInputs();
            pintarIzq(); pintarDer();
        }
        actualizarEsperas();
    }

    // ══════════════════════════════════════════════════════════════
    // §5  ARCHIVISTA — interfaz
    // ══════════════════════════════════════════════════════════════
    const medicosCentro = () => (appState.users || [])
        .filter(u => u.rol === 'medico' && u.centroMedicoId === S.centroId)
        .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));

    function nombreCentro() {
        const c = (appState.centrosMedicos || []).find(x => x.id === S.centroId);
        return (c && c.nombre) || (appState.currentUserData && appState.currentUserData.centroNombre) || 'Centro médico';
    }

    window.renderArchivo = function () {
        const mc = $('mainContent');
        const u = appState.currentUserData;
        if (!mc || !u || u.rol !== 'archivista') return;
        appState.currentView = 'archivo';
        if (!S.activo) window.kdArchivoInit();

        // Si ya está montada, solo se refrescan datos (refreshCurrentView llama aquí a menudo)
        if (S.mounted && S.root && document.body.contains(S.root)) {
            sincronizarInputs();
            pintarIzq(); pintarDer();
            return;
        }

        if (!S.centroId) {
            mc.innerHTML = '<div class="kd-arc kd-arc-aviso"><h1>Archivo de récords</h1>' +
                '<p>Tu usuario no tiene un centro médico asignado. Pide al administrador que lo configure.</p></div>';
            S.mounted = false;
            return;
        }

        mc.innerHTML =
            '<div class="kd-arc" id="kd-arc-root">' +
              '<header class="kd-arc-head">' +
                '<div><h1>Archivo de récords</h1><p id="kd-arc-sub"></p></div>' +
                '<button type="button" id="kd-arc-sonido" class="kd-arc-sonido" data-accion="sonido" aria-pressed="true"></button>' +
              '</header>' +
              '<div class="kd-arc-grid">' +
                // ── Panel izquierdo
                '<section class="kd-arc-panel" aria-labelledby="kd-arc-t-izq">' +
                  '<div class="kd-arc-panel-head"><h2 id="kd-arc-t-izq">Citas del centro</h2><span class="kd-arc-total" id="kd-arc-izq-total"></span></div>' +
                  '<div class="kd-arc-filtros">' +
                    '<div class="kd-arc-fila">' +
                      '<button type="button" class="kd-arc-hoy" id="kd-arc-izq-hoy" data-accion="izq-hoy">Hoy</button>' +
                      '<input type="date" id="kd-arc-izq-fecha" aria-label="Fecha de las citas">' +
                      '<select id="kd-arc-izq-medico" aria-label="Médico"></select>' +
                      '<select id="kd-arc-izq-estado" aria-label="Estado de la cita">' +
                        '<option value="">Todos los estados</option>' +
                        '<option value="pendiente">Pendiente</option><option value="confirmada">Confirmada</option>' +
                        '<option value="atendida">Atendida</option><option value="cancelada">Cancelada</option>' +
                      '</select>' +
                    '</div>' +
                    '<input type="search" id="kd-arc-izq-texto" placeholder="Buscar por paciente o número de récord" aria-label="Buscar">' +
                  '</div>' +
                  '<div class="kd-arc-scroll" id="kd-arc-izq-lista"></div>' +
                '</section>' +
                // ── Panel derecho
                '<section class="kd-arc-panel" aria-labelledby="kd-arc-t-der">' +
                  '<div class="kd-arc-panel-head"><h2 id="kd-arc-t-der">Solicitudes de récord</h2><span class="kd-arc-total" id="kd-arc-der-total"></span></div>' +
                  '<div class="kd-arc-filtros">' +
                    '<div class="kd-arc-tabs" role="group" aria-label="Estado de la solicitud">' +
                      ['SR', 'BUSCANDO', 'ENTREGADO'].map(e =>
                        '<button type="button" class="kd-arc-tab kd-arc-tab-' + e + '" data-accion="tab" data-tab="' + e + '" aria-pressed="false">' +
                          '<span>' + ETIQUETA[e] + '</span><b class="kd-arc-badge" data-count="' + e + '">0</b></button>').join('') +
                    '</div>' +
                    '<div class="kd-arc-fila">' +
                      '<button type="button" class="kd-arc-hoy" id="kd-arc-der-hoy" data-accion="der-hoy">Hoy</button>' +
                      '<input type="date" id="kd-arc-der-fecha" aria-label="Fecha de las solicitudes">' +
                      '<select id="kd-arc-der-esp" aria-label="Especialidad"></select>' +
                      '<select id="kd-arc-der-medico" aria-label="Médico"></select>' +
                    '</div>' +
                  '</div>' +
                  '<div class="kd-arc-scroll" id="kd-arc-der-lista"></div>' +
                '</section>' +
              '</div>' +
            '</div>';

        S.root = $('kd-arc-root');
        S.mounted = true;
        conectarEventos();
        sincronizarInputs();
        pintarIzq(); pintarDer();
    };

    function conectarEventos() {
        const root = S.root;

        root.addEventListener('click', (e) => {
            const b = e.target.closest('[data-accion]');
            if (!b || !root.contains(b)) return;
            const a = b.getAttribute('data-accion');
            if (a === 'avanzar') avanzar(b.getAttribute('data-id'), b);
            else if (a === 'tab') { S.f.derEstado = b.getAttribute('data-tab'); pintarDer(); }
            else if (a === 'izq-hoy') cambiarFechaIzq(S.hoy);
            else if (a === 'der-hoy') cambiarFechaDer(S.hoy);
            else if (a === 'sonido') {
                S.sonido = !S.sonido;
                try { localStorage.setItem('kd_arc_sonido', S.sonido ? '1' : '0'); } catch (_) { /* noop */ }
                pintarSonido();
                if (S.sonido) beep();
            }
        });

        $('kd-arc-izq-fecha').addEventListener('change', (e) => cambiarFechaIzq(e.target.value || S.hoy));
        $('kd-arc-der-fecha').addEventListener('change', (e) => cambiarFechaDer(e.target.value || S.hoy));
        $('kd-arc-izq-medico').addEventListener('change', (e) => { S.f.izqMedico = e.target.value; pintarIzq(); });
        $('kd-arc-izq-estado').addEventListener('change', (e) => { S.f.izqEstado = e.target.value; pintarIzq(); });
        $('kd-arc-izq-texto').addEventListener('input', (e) => { S.f.izqTexto = e.target.value; pintarIzq(); });
        $('kd-arc-der-esp').addEventListener('change', (e) => { S.f.derEsp = e.target.value; pintarDer(); });
        $('kd-arc-der-medico').addEventListener('change', (e) => { S.f.derMedico = e.target.value; pintarDer(); });
    }

    function cambiarFechaIzq(f) {
        S.f.izqFecha = f;
        sincronizarInputs();
        iniciarCitas();
        asegurarSolicitudes();
        pintarIzq();
    }

    function cambiarFechaDer(f) {
        S.f.derFecha = f;
        sincronizarInputs();
        asegurarSolicitudes();
        pintarDer();
    }

    function setOpciones(id, opciones, valor) {
        const sel = $(id);
        if (!sel) return valor;
        const firma = JSON.stringify(opciones);
        if (sel.dataset.firma !== firma) {
            sel.innerHTML = opciones.map(o => '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>').join('');
            sel.dataset.firma = firma;
        }
        sel.value = valor;
        return sel.value;      // '' si el valor ya no existe en la lista
    }

    function pintarSonido() {
        const b = $('kd-arc-sonido');
        if (!b) return;
        b.textContent = S.sonido ? '🔔 Aviso sonoro activado' : '🔕 Aviso sonoro apagado';
        b.setAttribute('aria-pressed', S.sonido ? 'true' : 'false');
    }

    function sincronizarInputs() {
        if (!S.root || !document.body.contains(S.root)) return;
        const sub = $('kd-arc-sub');
        if (sub) sub.textContent = nombreCentro() + ', ' + fechaLarga(S.hoy);
        pintarSonido();

        const fi = $('kd-arc-izq-fecha'), fd = $('kd-arc-der-fecha');
        if (fi && fi.value !== S.f.izqFecha) fi.value = S.f.izqFecha;
        if (fd && fd.value !== S.f.derFecha) fd.value = S.f.derFecha;
        $('kd-arc-izq-hoy').classList.toggle('activo', S.f.izqFecha === S.hoy);
        $('kd-arc-der-hoy').classList.toggle('activo', S.f.derFecha === S.hoy);
        const ti = $('kd-arc-izq-texto');
        if (ti && ti.value !== S.f.izqTexto) ti.value = S.f.izqTexto;
        const es = $('kd-arc-izq-estado');
        if (es) es.value = S.f.izqEstado;

        const medicos = medicosCentro();

        // izquierda: médico
        S.f.izqMedico = setOpciones('kd-arc-izq-medico',
            [['', 'Todos los médicos']].concat(medicos.map(m => [m.id, m.nombre || 'Sin nombre'])), S.f.izqMedico);

        // derecha: especialidad (médicos del centro + las que ya traen las solicitudes)
        const esps = new Set(medicos.map(m => m.especialidad || 'General'));
        solicitudesDe(S.f.derFecha).forEach(s => esps.add(s.especialidad || 'General'));
        const listaEsp = Array.from(esps).sort((a, b) => a.localeCompare(b, 'es'));
        S.f.derEsp = setOpciones('kd-arc-der-esp',
            [['', 'Todas las especialidades']].concat(listaEsp.map(e => [e, e])), S.f.derEsp);

        // derecha: médico (acotado por la especialidad elegida)
        const medsDer = S.f.derEsp ? medicos.filter(m => (m.especialidad || 'General') === S.f.derEsp) : medicos;
        S.f.derMedico = setOpciones('kd-arc-der-medico',
            [['', 'Todos los médicos']].concat(medsDer.map(m => [m.id, m.nombre || 'Sin nombre'])), S.f.derMedico);
    }

    // ── Panel izquierdo: citas del centro (solo lectura) ─────────
    function pintarIzq() {
        const box = $('kd-arc-izq-lista');
        if (!box || !S.root) return;
        sincronizarInputs();

        const f = S.f, q = norm(f.izqTexto);
        const lista = S.citas.filter(c =>
            (!f.izqMedico || c.medicoId === f.izqMedico) &&
            (!f.izqEstado || c.estado === f.izqEstado) &&
            (!q || norm(nombrePac(c)).includes(q) || norm(c.numeroRecord).includes(q)));

        $('kd-arc-izq-total').textContent = S.citasListo ? (lista.length + (lista.length === S.citas.length ? '' : ' de ' + S.citas.length)) + ' citas' : '';

        if (!S.citasListo) { box.innerHTML = '<p class="kd-arc-vacio">Cargando citas…</p>'; return; }
        if (!lista.length) {
            box.innerHTML = '<p class="kd-arc-vacio">' + (S.citas.length ? 'Ninguna cita coincide con los filtros.' : 'No hay citas en esta fecha.') + '</p>';
            return;
        }

        const grupos = new Map();
        lista.forEach(c => {
            const k = c.medicoId || '';
            if (!grupos.has(k)) grupos.set(k, { nombre: nombreMed(c), items: [] });
            grupos.get(k).items.push(c);
        });

        const sols = S.solPorFecha.get(f.izqFecha);
        let html = '';
        Array.from(grupos.values())
            .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
            .forEach(g => {
                g.items.sort((a, b) => (a.numeroOrden || 999) - (b.numeroOrden || 999));
                html += '<div class="kd-arc-grupo"><h3>' + esc(g.nombre) + '<span>' + g.items.length + '</span></h3>';
                g.items.forEach(c => {
                    const rec = String(c.numeroRecord || '').trim();
                    const s = sols && sols.map.get(c.id);
                    const tanda = (c.tanda || '').toLowerCase().includes('vesp') ? 'Vespertina' : (c.tanda ? 'Matutina' : '');
                    html += '<article class="kd-arc-cita' + (c.estado === 'cancelada' ? ' cancelada' : '') + '">' +
                        '<span class="kd-arc-turno" title="Turno del sistema">' + esc(c.numeroOrden || '–') + '</span>' +
                        '<div class="kd-arc-cita-main"><strong>' + esc(nombrePac(c)) + '</strong>' +
                          '<span>' + esc([tanda, c.seguroMedicoPaciente].filter(Boolean).join(', ')) + '</span></div>' +
                        '<span class="kd-arc-record' + (rec ? '' : ' vacio') + '">' + (rec ? esc(rec) : 'Sin récord') + '</span>' +
                        '<div class="kd-arc-estados"><span class="kd-arc-est kd-arc-est-' + esc(c.estado) + '">' + esc(ESTADO_CITA[c.estado] || c.estado || '') + '</span>' +
                          (s ? chipHTML(s) : '') + '</div>' +
                      '</article>';
                });
                html += '</div>';
            });
        box.innerHTML = html;
    }

    // ── Panel derecho: la comanda ────────────────────────────────
    function esperaClase(min) { return min >= ESPERA_URGENTE ? ' urgente' : (min >= ESPERA_AVISO ? ' aviso' : ''); }

    function pintarDer() {
        const box = $('kd-arc-der-lista');
        if (!box || !S.root) return;
        sincronizarInputs();

        const f = S.f;
        const base = solicitudesDe(f.derFecha).filter(s =>
            (!f.derEsp || (s.especialidad || 'General') === f.derEsp) &&
            (!f.derMedico || s.medicoId === f.derMedico));

        const cuenta = { SR: 0, BUSCANDO: 0, ENTREGADO: 0 };
        base.forEach(s => { if (cuenta[s.estado] !== undefined) cuenta[s.estado]++; });
        S.root.querySelectorAll('.kd-arc-tab').forEach(t => {
            const e = t.getAttribute('data-tab');
            t.setAttribute('aria-pressed', e === f.derEstado ? 'true' : 'false');
            const b = t.querySelector('.kd-arc-badge');
            b.textContent = cuenta[e];
            b.classList.toggle('cero', cuenta[e] === 0);
        });

        const lista = base.filter(s => s.estado === f.derEstado);
        const ent = S.solPorFecha.get(f.derFecha);
        $('kd-arc-der-total').textContent = lista.length + ' ' + ETIQUETA[f.derEstado];

        if (!ent || !ent.listo) { box.innerHTML = '<p class="kd-arc-vacio">Cargando solicitudes…</p>'; return; }
        if (!lista.length) {
            const msg = { SR: 'No hay solicitudes nuevas.', BUSCANDO: 'No hay récords en búsqueda.', ENTREGADO: 'Aún no se ha entregado ningún récord.' }[f.derEstado];
            box.innerHTML = '<p class="kd-arc-vacio">' + msg + '</p>';
            return;
        }

        // especialidad → médico → tarjetas (las más antiguas primero, como una comanda)
        const porEsp = new Map();
        lista.forEach(s => {
            const e = s.especialidad || 'General', m = s.medicoId || '';
            if (!porEsp.has(e)) porEsp.set(e, new Map());
            const meds = porEsp.get(e);
            if (!meds.has(m)) meds.set(m, { nombre: s.medicoNombre || 'Médico', items: [] });
            meds.get(m).items.push(s);
        });

        const orden = f.derEstado === 'ENTREGADO'
            ? (a, b) => b._entregadoMs - a._entregadoMs
            : (a, b) => a._creadoMs - b._creadoMs;

        let html = '';
        Array.from(porEsp.keys()).sort((a, b) => a.localeCompare(b, 'es')).forEach(esp => {
            html += '<div class="kd-arc-esp"><h3>' + esc(esp) + '</h3>';
            Array.from(porEsp.get(esp).values())
                .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
                .forEach(m => {
                    html += '<div class="kd-arc-med"><h4>' + esc(m.nombre) + '<span>' + m.items.length + '</span></h4>';
                    m.items.sort(orden).forEach(s => { html += ticketHTML(s); });
                    html += '</div>';
                });
            html += '</div>';
        });
        box.innerHTML = html;
    }

    function ticketHTML(s) {
        const nuevo = S.nuevos.has(s.id) ? ' nuevo' : '';
        let detalle = '', boton = '';

        if (s.estado === 'SR') {
            const min = minutosDesde(s._creadoMs);
            detalle = '<span class="kd-arc-espera' + esperaClase(min) + '" data-ts="' + s._creadoMs + '">Esperando ' + textoMin(min) + '</span>';
            boton = '<button type="button" class="kd-arc-accion kd-arc-accion-buscando" data-accion="avanzar" data-id="' + esc(s.id) + '">Marcar BUSCANDO</button>';
        } else if (s.estado === 'BUSCANDO') {
            const min = minutosDesde(s._creadoMs);
            detalle = '<span class="kd-arc-espera' + esperaClase(min) + '" data-ts="' + s._creadoMs + '">Esperando ' + textoMin(min) + '</span>' +
                '<span class="kd-arc-meta">Buscando: ' + esc(s.buscandoPorNombre || 'archivo') + ' desde las ' + hora(s._buscandoMs) + '</span>';
            boton = '<button type="button" class="kd-arc-accion kd-arc-accion-entregado" data-accion="avanzar" data-id="' + esc(s.id) + '">Marcar ENTREGADO</button>';
        } else {
            const total = s._entregadoMs && s._creadoMs ? Math.max(0, Math.round((s._entregadoMs - s._creadoMs) / 60000)) : 0;
            detalle = '<span class="kd-arc-meta">Entregado a las ' + hora(s._entregadoMs) + ' por ' + esc(s.entregadoPorNombre || 'archivo') + '</span>' +
                '<span class="kd-arc-meta">Tiempo total: ' + textoMin(total) + '</span>';
        }

        return '<article class="kd-arc-ticket kd-arc-t-' + esc(s.estado) + nuevo + '" data-id="' + esc(s.id) + '">' +
            '<div class="kd-arc-ticket-num"><small>Récord</small><b>' + esc(s.numeroRecord || '—') + '</b></div>' +
            '<div class="kd-arc-ticket-body">' +
              '<strong>' + esc(s.pacienteNombre || 'Paciente') + '</strong>' +
              '<span class="kd-arc-meta">Pidió ' + esc(s.solicitadoPorNombre || 'secretaria') + ' a las ' + hora(s._creadoMs) + '</span>' +
              detalle +
            '</div>' +
            boton +
          '</article>';
    }

    function actualizarEsperas() {
        if (!S.root) return;
        S.root.querySelectorAll('.kd-arc-espera[data-ts]').forEach(n => {
            const ms = parseInt(n.getAttribute('data-ts'), 10);
            const min = minutosDesde(ms);
            n.textContent = 'Esperando ' + textoMin(min);
            n.classList.toggle('aviso', min >= ESPERA_AVISO && min < ESPERA_URGENTE);
            n.classList.toggle('urgente', min >= ESPERA_URGENTE);
        });
    }

    async function avanzar(id, btn) {
        const s = buscarSol(id);
        const u = appState.currentUserData;
        if (!s || !u) return;
        const FV = firebase.firestore.FieldValue;
        const uid = appState.currentUser.uid;
        let patch;
        if (s.estado === 'SR') {
            patch = { estado: 'BUSCANDO', buscandoPor: uid, buscandoPorNombre: u.nombre || 'Archivo', buscandoEn: FV.serverTimestamp() };
        } else if (s.estado === 'BUSCANDO') {
            patch = { estado: 'ENTREGADO', entregadoPor: uid, entregadoPorNombre: u.nombre || 'Archivo', entregadoEn: FV.serverTimestamp() };
        } else return;

        if (btn) btn.disabled = true;
        try {
            await db.collection(COL).doc(id).update(patch);
        } catch (e) {
            console.warn('[Archivo] avanzar:', e.code || e.message);
            if (btn) btn.disabled = false;
            toast(e.code === 'permission-denied'
                ? 'La solicitud cambió mientras tanto (quizá la secretaria la canceló).'
                : 'No se pudo actualizar: ' + (e.message || e.code), 'err');
        }
    }
})();
