/* ═══════════════════════════════════════════════════════════════════
   KuraDoc — Reglas de agendamiento de citas
   © 2026 KuraDoc. Todos los derechos reservados.

   REGLA 1 · Sin tanda duplicada (aplica a TODOS los roles)
     Un paciente no puede tener dos citas activas (no canceladas) para
     la misma FECHA + TANDA + MÉDICO. Sí puede tomar otra tanda, otro
     día u otro médico.
     → Para ser más estricto (misma fecha + tanda en el MISMO CENTRO,
       aunque sea otro médico) cambia  DUP_MODO  a 'centro'.

   REGLA 2 · Cierre de tandas (paciente, secretaria y atención)
     Matutina  → se cierra a las 12:00 pm del mismo día.
     Vespertina→ se cierra a las  6:00 pm del mismo día.
     Solo MÉDICO y ADMIN pueden registrar citas en una tanda que ya pasó.

   REGLA 3 · Un solo guardado a la vez + campos faltantes
     · Se ignora el doble clic mientras una cita se está guardando.
     · El botón de guardar solo cambia a "Guardando..." al pulsarlo.
     · Se indica qué campos faltan por elegir (paciente y personal).

   CÓMO SE APLICA (sin reescribir app.logic.js)
   · Envuelve window.procesarReservaCita → validación ANTES de pedir
     récord o guardar, para los 3 flujos (paciente, secretaria, atención).
   · Envuelve seleccionarFechaCita (paciente) y nciEF (staff) para
     deshabilitar visualmente las tandas no disponibles.

   HORA: se usa la zona America/Santo_Domingo con el reloj del
   dispositivo. Las reglas se validan en el navegador (no en Firestore).
═══════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const TZ = 'America/Santo_Domingo';
    const DUP_MODO = 'medico';                       // 'medico' | 'centro'
    const CIERRE = { matutina: 12, vespertina: 18 };  // hora de cierre (24 h)
    const TXT_CIERRE = { matutina: '12:00 pm', vespertina: '6:00 pm' };
    const NOMBRE_TANDA = { matutina: 'matutina', vespertina: 'vespertina' };

    // ── Hora actual en República Dominicana ───────────────────────
    function ahoraRD() {
        const partes = new Intl.DateTimeFormat('en-CA', {
            timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(new Date());
        const g = t => partes.find(p => p.type === t).value;
        let h = parseInt(g('hour'), 10);
        if (h === 24) h = 0;
        return { fecha: g('year') + '-' + g('month') + '-' + g('day'), hora: h };
    }

    const esPaciente = () => appState.currentUserData?.rol === 'paciente';
    // Roles sujetos al cierre de tandas. Médico y admin quedan fuera a propósito.
    const ROLES_CON_CIERRE = ['paciente', 'secretaria', 'atencion'];
    const sujetoACierre = () => ROLES_CON_CIERRE.includes(appState.currentUserData?.rol);

    function fechaBonita(f) {
        try {
            return new Date(f + 'T12:00:00').toLocaleDateString('es-DO',
                { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        } catch (e) { return f; }
    }

    // ── REGLA 2: ¿la tanda ya cerró? (solo para pacientes) ────────
    window.kdTandaCerrada = function (fechaStr, tanda) {
        if (!sujetoACierre()) return false;              // médico y admin: sin límite
        const ahora = ahoraRD();
        if (fechaStr < ahora.fecha) return true;
        if (fechaStr > ahora.fecha) return false;
        return ahora.hora >= (CIERRE[tanda] ?? 24);
    };

    function mensajeCierre(tanda, fecha) {
        const ahora = ahoraRD();
        const cuando = (fecha && fecha < ahora.fecha) ? 'esa fecha ya pasó' : 'de hoy ya cerró (' + TXT_CIERRE[tanda] + ')';
        if (fecha && fecha < ahora.fecha) {
            return '⏰ No se puede agendar en una fecha que ya pasó.\n\nElige hoy o un día futuro.';
        }
        if (tanda === 'matutina') {
            return '⏰ La tanda matutina ' + cuando + '.\n\n'
                 + 'Elige la tanda vespertina (disponible hasta las ' + TXT_CIERRE.vespertina + ') u otro día.';
        }
        return '⏰ La tanda vespertina ' + cuando + '.\n\nElige otro día.';
    }

    // ── REGLA 1: buscar cita duplicada ────────────────────────────
    async function buscarDuplicada(pacienteId, medicoId, fechaStr, tanda, excluirId) {
        let citas = null;
        if (navigator.onLine) {
            try {
                const snap = await Promise.race([
                    db.collection('citas')
                        .where('pacienteId', '==', pacienteId)
                        .where('fechaStr', '==', fechaStr)
                        .get(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
                ]);
                citas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            } catch (e) { /* cae a lo cargado en memoria */ }
        }
        if (!citas) {
            citas = (appState.citas || []).filter(c => c.pacienteId === pacienteId && c.fechaStr === fechaStr);
        }
        const med = _uGet(medicoId) || {};
        return citas.find(c => {
            if (excluirId && c.id === excluirId) return false;             // la propia cita (reprogramar)
            if ((c.estado || 'pendiente') === 'cancelada') return false;   // las canceladas no bloquean
            if (c.tanda !== tanda) return false;
            const mismoCentro = !c.centroMedicoId || !med.centroMedicoId || c.centroMedicoId === med.centroMedicoId;
            return DUP_MODO === 'centro'
                ? (c.centroMedicoId || '') === (med.centroMedicoId || '')
                : (c.medicoId === medicoId && mismoCentro);
        }) || null;
    }
    window.kdBuscarCitaDuplicada = buscarDuplicada;

    function mensajeDuplicada(dup, propia) {
        const quien = propia ? 'Ya tienes' : 'Este paciente ya tiene';
        const med = dup.nombreMedico || (_uGet(dup.medicoId) || {}).nombre || 'este médico';
        return '⚠️ ' + quien + ' una cita con ' + med + ' para el ' + fechaBonita(dup.fechaStr)
            + ' en la tanda ' + (NOMBRE_TANDA[dup.tanda] || dup.tanda)
            + ' (estado: ' + (dup.estado || 'pendiente') + ').\n\n'
            + 'No se puede agendar otra cita en la misma tanda y fecha'
            + (DUP_MODO === 'centro' ? ' en el mismo centro' : ' con el mismo médico') + '.\n'
            + 'Puede elegir otro día, la otra tanda' + (DUP_MODO === 'centro' ? '' : ' u otro médico') + '.';
    }

    // ── Guardia principal: envuelve procesarReservaCita ───────────
    //   Devuelve false cuando NO se guardó (bloqueo por regla, cancelado, error)
    //   para que el modal Nueva Cita se quede abierto y el botón se restaure.
    const _orig = window.procesarReservaCita;
    let _guardando = false;
    if (typeof _orig === 'function') {
        window.procesarReservaCita = async function (medicoId) {
            if (_guardando) return false;              // doble clic / reintento mientras guarda
            _guardando = true;

            const flujoStaff = !!appState.pacienteTemporalParaCita;   // modal Nueva Cita
            const btnP = flujoStaff ? null : document.getElementById('btnConfirmarCita');
            const txtP = btnP ? btnP.textContent : '';
            if (btnP) { btnP.disabled = true; btnP.textContent = 'Guardando...'; }  // solo al pulsar

            try {
                const pacienteId = flujoStaff
                    ? (appState.pacienteTemporalParaCita.uid || appState.pacienteTemporalParaCita.id)
                    : appState.currentUser?.uid;
                const fecha = (typeof selectedDate !== 'undefined') ? selectedDate : null;
                const tanda = (typeof selectedTanda !== 'undefined') ? selectedTanda : null;

                let bloqueo = '';
                if (fecha && tanda && pacienteId) {
                    if (window.kdTandaCerrada(fecha, tanda)) {
                        bloqueo = mensajeCierre(tanda, fecha);
                    } else {
                        const dup = await buscarDuplicada(pacienteId, medicoId, fecha, tanda);
                        if (dup) bloqueo = mensajeDuplicada(dup, !flujoStaff);
                    }
                }
                if (bloqueo) { alert(bloqueo); return false; }

                const r = await _orig.apply(this, arguments);
                return r;
            } finally {
                _guardando = false;
                // Si el botón del paciente sigue en pantalla (no guardó), se restaura
                const b2 = document.getElementById('btnConfirmarCita');
                if (b2 && b2 === btnP) { b2.textContent = txtP || 'Confirmar Cita'; b2.disabled = false; }
            }
        };
    }

    // ── Apoyo visual ──────────────────────────────────────────────
    function deshabilitarTarjetaPaciente(el, texto) {
        if (!el) return;
        el.removeAttribute('onclick');
        el.onclick = null;
        el.classList.add('full');
        el.classList.remove('selected');
        const sub = el.querySelector('span');
        if (sub) sub.textContent = texto;
    }

    // Paciente: tarjetas de tanda (calendario del paciente)
    async function decorarTandasPaciente(medicoId, fechaStr) {
        if (!esPaciente()) return;
        const pid = appState.currentUser?.uid;
        let dupM = null, dupV = null;
        try {
            [dupM, dupV] = await Promise.all([
                buscarDuplicada(pid, medicoId, fechaStr, 'matutina'),
                buscarDuplicada(pid, medicoId, fechaStr, 'vespertina')
            ]);
        } catch (e) {}
        ['matutina', 'vespertina'].forEach(t => {
            const el = document.getElementById('tanda-' + t);
            if (!el) return;
            if (window.kdTandaCerrada(fechaStr, t)) deshabilitarTarjetaPaciente(el, 'Tanda cerrada (' + TXT_CIERRE[t] + ')');
            else if ((t === 'matutina' ? dupM : dupV)) deshabilitarTarjetaPaciente(el, 'Ya tienes cita en esta tanda');
        });
    }
    if (typeof window.seleccionarFechaCita === 'function') {
        const _sel = window.seleccionarFechaCita;
        window.seleccionarFechaCita = function (medicoId, fechaStr) {
            const r = _sel.apply(this, arguments);        // sincrónico hasta su 1er await (usa event.currentTarget)
            Promise.resolve(r).then(() => decorarTandasPaciente(medicoId, fechaStr)).catch(() => {});
            return r;
        };
    }

    // Personal (modal Nueva Cita): avisar de tandas donde el paciente ya tiene cita
    if (typeof window.nciEF === 'function') {
        const _ef = window.nciEF;
        window.nciEF = function (fS) {
            const r = _ef.apply(this, arguments);
            Promise.resolve(r).then(async () => {
                const N = window.N;
                if (!N || !N.med) return;
                const pid = N.pac ? (N.pac.uid || N.pac.id) : null;
                const mid = N.med.id || N.med.uid;
                for (const t of ['matutina', 'vespertina']) {
                    const btn = document.getElementById('nci-tb-' + t);
                    if (!btn || btn.disabled) continue;
                    if (window.kdTandaCerrada(fS, t)) {                 // pasó la hora de la tanda
                        btn.disabled = true;
                        btn.classList.add('lleno');
                        btn.classList.remove('recom', 'sel');
                        btn.removeAttribute('onclick');
                        btn.innerHTML = (t === 'matutina' ? '&#127749; Ma&#241;ana' : '&#127750; Tarde')
                            + '<div class="nci-tsub">Cerrada (' + TXT_CIERRE[t] + ')</div>';
                        continue;
                    }
                    const dup = pid ? await buscarDuplicada(pid, mid, fS, t) : null;
                    if (dup) {
                        btn.disabled = true;
                        btn.classList.add('lleno');
                        btn.removeAttribute('onclick');
                        const sub = btn.querySelector('.nci-tsub');
                        if (sub) sub.textContent = 'Ya tiene cita';
                    }
                }
            }).catch(() => {});
            return r;
        };
    }

    // ──────────────────────────────────────────────────────────────
    // Estilos y pista "Falta elegir" (flujo del paciente)
    // ──────────────────────────────────────────────────────────────
    (function estilos() {
        if (document.getElementById('kd-reglas-styles')) return;
        const st = document.createElement('style');
        st.id = 'kd-reglas-styles';
        st.textContent = `
.nci-faltan{flex:1;align-self:center;text-align:left;font-size:12px;font-weight:600;color:#92400e;
  background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:7px 10px;line-height:1.35}
.nci-faltan.alerta{color:#b91c1c;background:#fef2f2;border-color:#fca5a5}
.nci-falta{outline:2px solid #ef4444!important;outline-offset:2px;border-radius:8px}
.nci-ok:not(.listo):not(:disabled){cursor:pointer}
.kd-faltan-pac{font-size:12px;font-weight:600;color:#92400e;background:#fffbeb;border:1px solid #fde68a;
  border-radius:8px;padding:7px 10px;margin:0 0 8px;line-height:1.35}`;
        document.head.appendChild(st);
    })();

    function pintarPistaPaciente() {
        const btn = document.getElementById('btnConfirmarCita');
        let el = document.getElementById('kd-faltan-pac');
        if (!btn) { if (el) el.remove(); return; }
        const faltan = [];
        const f = (typeof selectedDate !== 'undefined') ? selectedDate : null;
        const t = (typeof selectedTanda !== 'undefined') ? selectedTanda : null;
        const tipo = document.getElementById('selectTipoCita');
        if (tipo && !tipo.value) faltan.push('Tipo de consulta');
        if (!f) faltan.push('Fecha disponible');
        if (!t) faltan.push('Tanda');
        if (!el) {
            el = document.createElement('div');
            el.id = 'kd-faltan-pac';
            el.className = 'kd-faltan-pac';
            btn.parentNode.insertBefore(el, btn);
        }
        const txt = faltan.length ? 'Falta elegir: ' + faltan.join('  ·  ') : '';
        const disp = faltan.length ? 'block' : 'none';
        // Solo escribir si cambió: evita que el MutationObserver se dispare a sí mismo
        if (el.textContent !== txt) el.textContent = txt;
        if (el.style.display !== disp) el.style.display = disp;
    }
    let _tObs = null;
    const refrescarPista = () => { clearTimeout(_tObs); _tObs = setTimeout(pintarPistaPaciente, 80); };
    new MutationObserver(refrescarPista).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', refrescarPista, true);
    document.addEventListener('change', refrescarPista, true);
})();
