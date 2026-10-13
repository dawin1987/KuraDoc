/* KuraDoc — Acceso de pacientes gestionado por el personal (Fase 4, navegador)
 *
 * 1) Reemplaza la pestaña "Acceso / Contraseña" de la ficha del paciente:
 *      • 👁 Ver contraseña inicial  → solo si sigue vigente (la valida el servidor)
 *      • 🔄 Restablecer acceso      → contraseña temporal que se muestra UNA sola vez
 * 2) Al entrar un paciente con contraseña temporal, le SUGIERE (sin obligarlo) cambiarla.
 * 3) window._kdNotificarClaveCambiada(): avisa al servidor cuando un paciente cambia su clave.
 *
 * Debe cargarse DESPUÉS de assets/app.logic.js. Los permisos reales se validan en el servidor;
 * aquí solo se decide qué botones mostrar.
 */
(function () {
    'use strict';

    var ROLES_GESTION = ['secretaria', 'adminCentro', 'admin'];

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };
    var rolActual = function () { return window.appState && window.appState.currentUserData && window.appState.currentUserData.rol; };
    var llamar = function (nombre, datos) {
        return firebase.functions().httpsCallable(nombre, { timeout: 30000 })(datos || {}).then(function (r) { return r.data; });
    };
    function mensajeError(e) {
        var c = e && e.code;
        if (c === 'functions/permission-denied') return 'No tienes permiso para realizar esta acción.';
        if (c === 'functions/not-found') return 'Paciente no encontrado.';
        if (c === 'functions/failed-precondition' && e.message) return e.message;
        if (c === 'functions/resource-exhausted') return 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.';
        if (c === 'functions/unauthenticated') return 'Tu sesión expiró. Vuelve a iniciar sesión.';
        if (c === 'functions/unavailable' || /network/i.test((e && e.message) || '')) return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
        return 'No pudimos completar la operación. Inténtalo más tarde.';
    }
    function buscarPaciente(uid) {
        var lista = (window.appState && window.appState.users) || [];
        for (var i = 0; i < lista.length; i++) { if (lista[i].uid === uid || lista[i].id === uid) return lista[i]; }
        return null;
    }

    // ── Ventana propia (no pisa la ficha del paciente que está abierta) ──
    var BTN = 'border:none;border-radius:12px;padding:12px 18px;font-size:13px;font-weight:700;cursor:pointer;';
    var BTN_AZUL = BTN + 'background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;';
    var BTN_NARANJA = BTN + 'background:linear-gradient(135deg,#f59e0b,#d97706);color:white;';
    var BTN_GRIS = BTN + 'background:#f1f5f9;color:#334155;border:1px solid #e2e8f0;';
    var BTN_ROJO = BTN + 'background:linear-gradient(135deg,#ef4444,#dc2626);color:white;';

    function abrirVentana(titulo, cuerpo) {
        cerrarVentana();
        var d = document.createElement('div');
        d.id = 'kdAccesoOverlay';
        d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
        d.innerHTML =
            '<div role="dialog" aria-modal="true" style="background:white;border-radius:18px;max-width:420px;width:100%;max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35);">' +
              '<div style="background:#142535;color:white;padding:16px 20px;font-size:16px;font-weight:800;border-radius:18px 18px 0 0;">' + titulo + '</div>' +
              '<div style="padding:20px;">' + cuerpo + '</div>' +
            '</div>';
        document.body.appendChild(d);
        return d;
    }
    function cerrarVentana() {
        window._kdTemporalActual = null;          // la contraseña temporal no debe quedar en memoria
        var d = $('kdAccesoOverlay');
        if (d && d.parentNode) d.parentNode.removeChild(d);
    }
    window._kdAccesoCerrar = cerrarVentana;

    var P = 'font-size:13px;color:#475569;line-height:1.6;margin:0 0 14px;';

    // ── 1) Pestaña "Acceso" de la ficha ──────────────────────────────
    window._fpTabAcceso = function (p) {
        var uid = p.uid || p.id;
        var puede = ROLES_GESTION.indexOf(rolActual()) !== -1;
        var hayClave = !!(p.claveInicialDisponible || p.clave);   // p.clave: documentos aún sin migrar

        var bloqueClave = hayClave
            ? '<p style="' + P + 'font-size:11px;">Esta es la contraseña con la que se creó la cuenta. Solo se muestra si el paciente todavía no la ha cambiado. ' +
              'Al verla queda un registro de auditoría con tu nombre, fecha y hora.</p>' +
              '<div id="fp-pwd-area"><button type="button" style="' + BTN_NARANJA + '" onclick="_fpVerClave(\'' + esc(uid) + '\')">👁 Ver contraseña inicial</button></div>'
            : '<div id="fp-pwd-area" style="text-align:center;padding:14px;color:#94a3b8;">' +
              '<div style="font-size:26px;margin-bottom:4px;">🔐</div>' +
              '<p style="font-size:12px;margin:0;">No hay contraseña inicial guardada.<br>Si el paciente la olvidó, restablece su acceso.</p></div>';

        var gestion = puede
            ? '<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:14px;">' +
                '<div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:8px;">🔒 Contraseña inicial</div>' + bloqueClave + '</div>' +
              '<div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;padding:16px;margin-bottom:14px;">' +
                '<div style="font-size:11px;font-weight:700;color:#9a3412;margin-bottom:8px;">🔄 ¿El paciente olvidó su contraseña?</div>' +
                '<p style="' + P + 'font-size:11px;">Se genera una <strong>contraseña temporal</strong> que podrás entregarle. La contraseña actual dejará de funcionar y, al entrar, el sistema le sugerirá crear una propia.</p>' +
                '<button type="button" style="' + BTN_ROJO + '" onclick="_fpRestablecer(\'' + esc(uid) + '\')">🔄 Restablecer acceso</button></div>'
            : '<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:14px;font-size:12px;color:#64748b;">' +
              'Solo el personal de secretaría y administración puede gestionar el acceso de los pacientes.</div>';

        return '<div>' +
            '<div style="font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px;">🔑 Datos de acceso al sistema</div>' +
            '<div class="fp-field" style="margin-bottom:10px;"><div class="fp-field-label">📧 Email / Usuario</div><div class="fp-field-value">' + esc(p.email || '—') + '</div></div>' +
            '<div class="fp-field" style="margin-bottom:10px;"><div class="fp-field-label">📱 Teléfono</div><div class="fp-field-value">' + esc(p.telefono || '—') + '</div></div>' +
            '<div class="fp-field" style="margin-bottom:14px;"><div class="fp-field-label">🪪 Código de paciente</div><div class="fp-field-value">' + esc(p.codigoPaciente || '—') + '</div></div>' +
            gestion +
            '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 14px;">' +
              '<div style="font-size:10px;font-weight:700;color:#1d4ed8;margin-bottom:4px;">ℹ️ Información</div>' +
              '<p style="margin:0;font-size:11px;color:#1e40af;line-height:1.5;">El paciente puede cambiar su contraseña desde su perfil, por correo o por WhatsApp. ' +
              'Cuando la cambia, la contraseña inicial deja de mostrarse y solo queda la opción de restablecer. Cada consulta o restablecimiento queda registrado.</p>' +
            '</div></div>';
    };

    // ── 2) Ver contraseña inicial ────────────────────────────────────
    window._fpVerClave = async function (uid) {
        var area = $('fp-pwd-area');
        if (!area) return;
        area.innerHTML = '<p style="font-size:12px;color:#64748b;margin:0;">Verificando…</p>';
        try {
            var r = await llamar('verClaveInicialPaciente', { pacienteUid: uid });
            if (r && r.disponible) {
                var ud = (window.appState && window.appState.currentUserData) || {};
                area.innerHTML =
                    '<div class="fp-pwd-box">' +
                      '<div style="font-size:9px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">🔑 Contraseña inicial</div>' +
                      '<div class="fp-pwd-value" id="kdClaveVista">' + esc(r.clave) + '</div>' +
                      '<div class="fp-audit-note">👁 Visto por: <strong>' + esc(ud.nombre || 'Usuario') + '</strong> (' + esc(ud.rol || '—') + ') · ' +
                      new Date().toLocaleString('es-DO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</div>' +
                    '</div>';
                return;
            }
            var msg = {
                ya_cambio: 'El paciente ya cambió su contraseña, por lo que la inicial ya no es válida. Si necesita ayuda, usa <strong>Restablecer acceso</strong>.',
                sin_clave: 'No hay contraseña inicial guardada. Si el paciente la olvidó, usa <strong>Restablecer acceso</strong>.',
                no_verificable: 'No pudimos verificar la contraseña en este momento. Inténtalo de nuevo en unos minutos o usa <strong>Restablecer acceso</strong>.'
            }[r && r.motivo] || 'La contraseña inicial no está disponible.';
            area.innerHTML = '<p style="' + P + 'margin:0;">ℹ️ ' + msg + '</p>';
        } catch (e) {
            area.innerHTML = '<p style="font-size:12px;color:#b91c1c;font-weight:600;margin:0;">' + esc(mensajeError(e)) + '</p>';
        }
    };

    // ── 3) Restablecer acceso (contraseña temporal) ──────────────────
    window._fpRestablecer = function (uid) {
        var p = buscarPaciente(uid) || {};
        abrirVentana('🔄 Restablecer acceso',
            '<p style="' + P + '">Vas a restablecer el acceso de <strong>' + esc(p.nombre || 'este paciente') + '</strong>.</p>' +
            '<ul style="' + P + 'padding-left:18px;">' +
              '<li>Se generará una contraseña temporal.</li>' +
              '<li>La contraseña actual dejará de funcionar y se cerrarán sus sesiones abiertas.</li>' +
              '<li>La temporal <strong>se mostrará una sola vez</strong>.</li>' +
            '</ul>' +
            '<div id="kdRstAlert" style="display:none"></div>' +
            '<div style="display:flex;gap:10px;">' +
              '<button type="button" style="' + BTN_GRIS + 'flex:1;" onclick="_kdAccesoCerrar()">Cancelar</button>' +
              '<button type="button" id="kdRstBtn" style="' + BTN_ROJO + 'flex:1;" onclick="_kdRestablecerConfirmar(\'' + esc(uid) + '\')">Restablecer</button>' +
            '</div>');
    };

    window._kdRestablecerConfirmar = async function (uid) {
        var btn = $('kdRstBtn');
        btn.disabled = true; btn.textContent = 'Restableciendo…';
        try {
            var r = await llamar('restablecerAccesoPaciente', { pacienteUid: uid });
            if (!r || !r.passwordTemporal) throw new Error('respuesta vacía');
            var temporal = r.passwordTemporal;
            abrirVentana('✅ Acceso restablecido',
                '<p style="' + P + '">Entrega esta contraseña temporal al paciente. <strong>No se volverá a mostrar.</strong></p>' +
                '<div id="kdTemporal" style="font-family:monospace;font-size:28px;font-weight:800;letter-spacing:3px;text-align:center;color:#166534;' +
                  'background:#f0fdf4;border:2px dashed #86efac;padding:16px;border-radius:12px;margin-bottom:12px;user-select:all;">' + esc(temporal) + '</div>' +
                '<button type="button" id="kdCopiarBtn" style="' + BTN_AZUL + 'width:100%;margin-bottom:14px;" onclick="_kdCopiarTemporal()">📋 Copiar contraseña</button>' +
                '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:12px;color:#475569;line-height:1.7;margin-bottom:14px;">' +
                  (r.email ? '📧 Usuario: <strong>' + esc(r.email) + '</strong><br>' : '') +
                  (r.codigoPaciente ? '🪪 Código: <strong>' + esc(r.codigoPaciente) + '</strong><br>' : '') +
                  'Puede entrar con su correo o con su número de teléfono registrado.' +
                '</div>' +
                '<p style="' + P + 'font-size:12px;">Al iniciar sesión, el sistema le sugerirá cambiar esta contraseña por una propia (es opcional).</p>' +
                '<button type="button" style="' + BTN_GRIS + 'width:100%;" onclick="_kdAccesoCerrar()">Listo, ya la entregué</button>');
            window._kdTemporalActual = temporal;
        } catch (e) {
            btn.disabled = false; btn.textContent = 'Restablecer';
            var al = $('kdRstAlert');
            al.style.cssText = 'display:block;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;font-weight:600;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;';
            al.textContent = mensajeError(e);
        }
    };

    window._kdCopiarTemporal = function () {
        var t = window._kdTemporalActual || ($('kdTemporal') && $('kdTemporal').textContent) || '';
        var ok = function () { var b = $('kdCopiarBtn'); if (b) b.textContent = '✅ Copiada'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, function () {});
        else { try { var r = document.createRange(); r.selectNodeContents($('kdTemporal')); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); ok(); } catch (_) {} }
    };
    // ── 4) El paciente cambió su propia contraseña ───────────────────
    window._kdNotificarClaveCambiada = function () {
        return llamar('confirmarCambioPasswordPropio', {}).catch(function (e) {
            console.warn('[KuraDoc] No se pudo notificar el cambio de contraseña:', e && e.code);
        });
    };

    // ── 5) Sugerencia (opcional) de cambiar la contraseña temporal ───
    var sugerenciaMostrada = false;

    function esperarVentanasYMostrar(intentos) {
        var mc = $('modalContainer');
        var ocupado = mc && !mc.classList.contains('hidden') && mc.innerHTML.trim() !== '';
        if (ocupado && intentos > 0) { setTimeout(function () { esperarVentanasYMostrar(intentos - 1); }, 1000); return; }
        mostrarSugerencia();
    }

    function mostrarSugerencia() {
        abrirVentana('🔑 Te recomendamos cambiar tu contraseña',
            '<p style="' + P + '">Entraste con una <strong>contraseña temporal</strong> que te entregó el personal del centro. ' +
            'Para mayor seguridad, te recomendamos crear una contraseña propia.</p>' +
            '<div style="display:flex;gap:10px;">' +
              '<button type="button" style="' + BTN_GRIS + 'flex:1;" onclick="_kdAccesoCerrar()">Más tarde</button>' +
              '<button type="button" style="' + BTN_AZUL + 'flex:1;" onclick="_kdSugerenciaFormulario()">Cambiar ahora</button>' +
            '</div>' +
            '<p style="font-size:11px;color:#94a3b8;margin:12px 0 0;">Si eliges "Más tarde", te lo recordaremos la próxima vez que entres.</p>');
    }

    window._kdSugerenciaFormulario = function () {
        abrirVentana('🔑 Nueva contraseña',
            '<div class="form-group"><label class="form-label" for="kdSugNueva">Nueva contraseña</label>' +
              '<input type="password" class="form-input" id="kdSugNueva" placeholder="Mínimo 6 caracteres" autocomplete="new-password"></div>' +
            '<div class="form-group"><label class="form-label" for="kdSugConf">Confirmar contraseña</label>' +
              '<input type="password" class="form-input" id="kdSugConf" placeholder="Repite la contraseña" autocomplete="new-password"></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#475569;margin-bottom:14px;cursor:pointer;">' +
              '<input type="checkbox" onchange="_kdSugMostrar(this.checked)"> Mostrar contraseñas</label>' +
            '<div id="kdSugAlert" style="display:none"></div>' +
            '<div style="display:flex;gap:10px;">' +
              '<button type="button" style="' + BTN_GRIS + 'flex:1;" onclick="_kdAccesoCerrar()">Cancelar</button>' +
              '<button type="button" id="kdSugBtn" style="' + BTN_AZUL + 'flex:1;" onclick="_kdSugerenciaGuardar()">Guardar</button>' +
            '</div>');
    };
    window._kdSugMostrar = function (ver) {
        ['kdSugNueva', 'kdSugConf'].forEach(function (id) { if ($(id)) $(id).type = ver ? 'text' : 'password'; });
    };

    window._kdSugerenciaGuardar = async function () {
        var a = $('kdSugNueva').value || '', b = $('kdSugConf').value || '';
        var alerta = function (t) {
            var el = $('kdSugAlert');
            el.style.cssText = 'display:block;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;font-weight:600;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;';
            el.textContent = t;
        };
        if (a.length < 6) return alerta('La contraseña debe tener al menos 6 caracteres.');
        if (a !== b) return alerta('Las contraseñas no coinciden.');
        var btn = $('kdSugBtn'); btn.disabled = true; btn.textContent = 'Guardando…';
        try {
            var user = firebase.auth().currentUser;
            await user.updatePassword(a);
            await window._kdNotificarClaveCambiada();
            abrirVentana('✅ Contraseña actualizada',
                '<p style="' + P + '">Tu nueva contraseña ya está activa. Úsala la próxima vez que inicies sesión.</p>' +
                '<button type="button" style="' + BTN_AZUL + 'width:100%;" onclick="_kdAccesoCerrar()">Continuar</button>');
        } catch (e) {
            btn.disabled = false; btn.textContent = 'Guardar';
            if (e && e.code === 'auth/requires-recent-login') alerta('Por seguridad, cierra sesión y vuelve a entrar para cambiarla.');
            else if (e && e.code === 'auth/weak-password') alerta('La contraseña es demasiado débil. Usa al menos 6 caracteres.');
            else alerta('No pudimos cambiar la contraseña. Inténtalo de nuevo.');
        }
    };

    function iniciarSugerencia() {
        if (!window.firebase || !firebase.auth) return;
        firebase.auth().onAuthStateChanged(function (user) {
            if (!user || sugerenciaMostrada) return;
            firebase.firestore().collection('users').doc(user.uid).get().then(function (snap) {
                var d = snap.exists ? snap.data() : null;
                if (!d || d.rol !== 'paciente' || d.mustChangePassword !== true) return;
                sugerenciaMostrada = true;
                setTimeout(function () { esperarVentanasYMostrar(90); }, 800);
            }).catch(function () { /* sin sugerencia si no se puede leer */ });
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarSugerencia);
    else iniciarSugerencia();
})();
