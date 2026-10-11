/* KuraDoc — Recuperación de contraseña (Fase 3, navegador)
 *
 * • Sustituye el contenido de la ventana "¿Olvidaste tu contraseña?":
 *     [ Recuperar por correo ]   → la ventana original de siempre (sin cambios)
 *     [ Recuperar por WhatsApp ] → teléfono + fecha de nacimiento (+ código PAC) → "Abrir WhatsApp"
 * • Atiende el enlace  ?resetPassword=TOKEN  (pantalla de nueva contraseña).
 *
 * Debe cargarse DESPUÉS de assets/app.logic.js (guarda y reutiliza su ventana de correo).
 * Toda la validación real ocurre en las Cloud Functions; aquí solo se muestra la interfaz.
 */
(function () {
    'use strict';

    var WA_NUMERO  = '18099787061';        // número de WhatsApp de KuraDoc (formato wa.me, sin +)
    var WA_VISIBLE = '+1 809 978 7061';

    var ventanaCorreoOriginal = window._mostrarOlvideContrasena;   // la de app.logic.js

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };
    var llamar = function (nombre, datos) {
        return firebase.functions().httpsCallable(nombre, { timeout: 30000 })(datos).then(function (r) { return r.data; });
    };
    function mensajeError(e) {
        var c = e && e.code;
        if (c === 'functions/resource-exhausted') return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
        if (c === 'functions/invalid-argument' && e.message) return e.message;
        if (c === 'functions/unavailable' || /network/i.test((e && e.message) || '')) return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
        return 'No pudimos completar la solicitud. Inténtalo más tarde.';
    }

    var BTN = 'width:100%;padding:13px;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;';
    var BTN_AZUL  = BTN + 'background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;';
    var BTN_VERDE = BTN + 'background:linear-gradient(135deg,#16a34a,#15803d);color:white;';
    var LINK_VOLVER = 'background:none;border:none;color:#2563eb;font-size:12px;font-weight:600;cursor:pointer;padding:0;margin-bottom:12px;';
    var TEXTO = 'font-size:14px;color:#475569;margin-bottom:16px;line-height:1.6;';

    function abrirModal(titulo, cuerpo) {
        var modal = $('modalContainer');
        if (!modal) return null;
        modal.innerHTML =
            '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
              '<div class="modal" onclick="event.stopPropagation()" style="max-width:420px;">' +
                '<div class="modal-header" style="background:#142535;">' +
                  '<h2 class="modal-title" style="color:white;">' + titulo + '</h2>' +
                  '<button class="modal-close" onclick="closeModal()">×</button>' +
                '</div>' +
                '<div class="modal-body" style="background:white;padding:24px;">' + cuerpo + '</div>' +
              '</div>' +
            '</div>';
        modal.classList.remove('hidden');
        return modal;
    }

    function alerta(id, texto, tipo) {
        var el = $(id);
        if (!el) return;
        var estilos = tipo === 'info'
            ? ['#eff6ff', '#1e40af', '#bfdbfe']
            : ['#fef2f2', '#991b1b', '#fecaca'];
        el.style.cssText = 'display:block;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;font-weight:600;' +
            'background:' + estilos[0] + ';color:' + estilos[1] + ';border:1px solid ' + estilos[2] + ';';
        el.textContent = texto;
    }

    // ── 1) Elegir cómo recuperar ─────────────────────────────────────
    window._mostrarOlvideContrasena = function () {
        abrirModal('🔑 Recuperar contraseña',
            '<p style="' + TEXTO + '">¿Cómo deseas recuperar tu acceso?</p>' +
            '<button type="button" style="' + BTN_AZUL + '" onclick="_kdRecPorCorreo()">📧 Recuperar por correo</button>' +
            '<div style="height:10px"></div>' +
            '<button type="button" style="' + BTN_VERDE + '" onclick="_kdRecPorWhatsApp()">💬 Recuperar por WhatsApp</button>' +
            '<p style="font-size:12px;color:#64748b;line-height:1.6;margin-top:16px;">' +
              '¿Necesitas ayuda? Contacta a la <strong>secretaria de tu médico de confianza</strong> y ella podrá ayudarte a recuperar tu acceso.' +
            '</p>');
    };

    // ── 2) Por correo: la ventana original, sin cambios ──────────────
    window._kdRecPorCorreo = function () {
        if (typeof ventanaCorreoOriginal !== 'function') return;
        ventanaCorreoOriginal();
        var inp = $('resetEmail');
        if (inp && inp.value.indexOf('@') === -1) inp.value = '';   // si en el login escribió un teléfono, no copiarlo como correo
        var body = document.querySelector('#modalContainer .modal-body');
        if (body) {
            body.insertAdjacentHTML('afterbegin',
                '<button type="button" style="' + LINK_VOLVER + '" onclick="_mostrarOlvideContrasena()">← Otras opciones</button>');
        }
    };

    // ── 3) Por WhatsApp ──────────────────────────────────────────────
    window._kdRecPorWhatsApp = function () {
        var escrito = (($('loginEmail') && $('loginEmail').value) || '').trim();
        var tel = escrito && escrito.indexOf('@') === -1 ? escrito : '';
        var hoy = new Date().toISOString().slice(0, 10);
        abrirModal('💬 Recuperar por WhatsApp',
            '<button type="button" style="' + LINK_VOLVER + '" onclick="_mostrarOlvideContrasena()">← Otras opciones</button>' +
            '<p style="' + TEXTO + '">Escribe los datos de tu cuenta. Te enviaremos un enlace por WhatsApp al teléfono registrado.</p>' +
            '<div class="form-group"><label class="form-label" for="kdRecTel">Número de teléfono registrado</label>' +
              '<input type="tel" class="form-input" id="kdRecTel" value="' + esc(tel) + '" placeholder="809-555-1234" autocomplete="tel"></div>' +
            '<div class="form-group"><label class="form-label" for="kdRecFecha">Fecha de nacimiento del paciente</label>' +
              '<input type="date" class="form-input" id="kdRecFecha" max="' + hoy + '"></div>' +
            '<div class="form-group hidden" id="kdRecCodGroup"><label class="form-label" for="kdRecCod">Código de paciente</label>' +
              '<input type="text" class="form-input" id="kdRecCod" placeholder="PAC-XXXXXXXX" maxlength="12" autocomplete="off" ' +
              'autocapitalize="characters" spellcheck="false" oninput="this.value=this.value.toUpperCase()"></div>' +
            '<div id="kdRecAlert" style="display:none"></div>' +
            '<button type="button" id="kdRecBtn" style="' + BTN_VERDE + '" onclick="_kdRecSolicitar()">Continuar</button>');
    };

    window._kdRecSolicitar = async function () {
        var tel = ($('kdRecTel').value || '').trim();
        var fecha = ($('kdRecFecha').value || '').trim();
        var cod = ($('kdRecCod').value || '').trim();
        if (!tel || !fecha) { alerta('kdRecAlert', 'Escribe tu teléfono y la fecha de nacimiento.', 'error'); return; }

        var btn = $('kdRecBtn');
        btn.disabled = true; btn.textContent = 'Verificando…';
        try {
            var r = await llamar('solicitarRecuperacionWA', { telefono: tel, fechaNacimiento: fecha, codigoPaciente: cod || undefined });
            if (r && r.necesitaCodigo) {
                $('kdRecCodGroup').classList.remove('hidden');
                alerta('kdRecAlert', 'Este número está asociado a más de una cuenta. Introduce tu código de paciente para continuar.', 'info');
                $('kdRecCod').focus();
            } else if (r && r.codigoSolicitud) {
                pantallaEnviar(r.codigoSolicitud, r.vigenciaMin || 15);
                return;
            } else {
                alerta('kdRecAlert', 'No pudimos completar la solicitud. Inténtalo más tarde.', 'error');
            }
        } catch (e) {
            alerta('kdRecAlert', mensajeError(e), 'error');
        }
        btn.disabled = false; btn.textContent = 'Continuar';
    };

    function pantallaEnviar(codigo, minutos) {
        var texto = 'Recuperar ' + codigo;
        var url = 'https://wa.me/' + WA_NUMERO + '?text=' + encodeURIComponent(texto);
        abrirModal('💬 Último paso',
            '<p style="' + TEXTO + '">Para confirmar que tienes el teléfono contigo, envía este mensaje por WhatsApp:</p>' +
            '<div id="kdRecMensaje" style="font-family:monospace;font-size:18px;font-weight:700;text-align:center;color:#166534;' +
              'background:#f0fdf4;border:1px dashed #86efac;padding:12px;border-radius:10px;margin-bottom:14px;">' + esc(texto) + '</div>' +
            '<a id="kdRecAbrirWA" href="' + url + '" target="_blank" rel="noopener noreferrer" ' +
              'style="display:block;text-align:center;text-decoration:none;' + BTN_VERDE + '">💬 Abrir WhatsApp</a>' +
            '<ol style="font-size:13px;color:#475569;line-height:1.7;margin:16px 0 0 18px;padding:0;">' +
              '<li>Pulsa el botón y envía el mensaje tal como aparece, <strong>desde el WhatsApp del número registrado</strong>.</li>' +
              '<li>Te responderemos con un enlace para crear tu nueva contraseña.</li>' +
              '<li>Este código vence en ' + esc(minutos) + ' minutos.</li>' +
            '</ol>' +
            '<p style="font-size:11px;color:#94a3b8;line-height:1.6;margin-top:12px;">' +
              'Si no se abre WhatsApp, escribe ese mensaje manualmente al ' + WA_VISIBLE + '. ' +
              'Si los datos coinciden con una cuenta, recibirás el enlace por WhatsApp.</p>');
    }

    // ── 4) Enlace ?resetPassword=TOKEN → nueva contraseña ────────────
    var tokenReset = null;     // solo en memoria; se quita de la barra de direcciones

    function enlaceInvalido() {
        abrirModal('🔑 Restablecer contraseña',
            '<p style="' + TEXTO + '">⚠️ Este enlace no es válido o ya venció. Los enlaces duran 15 minutos y se pueden usar una sola vez.</p>' +
            '<button type="button" style="' + BTN_AZUL + '" onclick="_mostrarOlvideContrasena()">Solicitar un enlace nuevo</button>');
    }

    function formularioNuevaClave() {
        abrirModal('🔑 Restablecer contraseña',
            '<p style="' + TEXTO + '">Crea tu nueva contraseña.</p>' +
            '<div class="form-group"><label class="form-label" for="kdNueva">Nueva contraseña</label>' +
              '<input type="password" class="form-input" id="kdNueva" minlength="6" placeholder="Mínimo 6 caracteres" autocomplete="new-password"></div>' +
            '<div class="form-group"><label class="form-label" for="kdConf">Confirmar contraseña</label>' +
              '<input type="password" class="form-input" id="kdConf" minlength="6" placeholder="Repite la contraseña" autocomplete="new-password"></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#475569;margin-bottom:14px;cursor:pointer;">' +
              '<input type="checkbox" id="kdMostrar" onchange="_kdMostrarClaves(this.checked)"> Mostrar contraseñas</label>' +
            '<div id="kdResetAlert" style="display:none"></div>' +
            '<button type="button" id="kdResetBtn" style="' + BTN_AZUL + '" onclick="_kdResetEnviar()">Cambiar contraseña</button>');
    }

    window._kdMostrarClaves = function (ver) {
        ['kdNueva', 'kdConf'].forEach(function (id) { if ($(id)) $(id).type = ver ? 'text' : 'password'; });
    };

    window._kdResetEnviar = async function () {
        var a = ($('kdNueva').value || '');
        var b = ($('kdConf').value || '');
        if (a.length < 6) { alerta('kdResetAlert', 'La contraseña debe tener al menos 6 caracteres.', 'error'); return; }
        if (a !== b)      { alerta('kdResetAlert', 'Las contraseñas no coinciden.', 'error'); return; }

        var btn = $('kdResetBtn');
        btn.disabled = true; btn.textContent = 'Guardando…';
        try {
            var r = await llamar('completarRecuperacion', { token: tokenReset, nuevaPassword: a });
            if (r && r.ok) {
                tokenReset = null;
                abrirModal('✅ Contraseña actualizada',
                    '<p style="' + TEXTO + '">Tu contraseña se cambió correctamente. Ya puedes iniciar sesión con la nueva contraseña.</p>' +
                    '<button type="button" style="' + BTN_VERDE + '" onclick="closeModal()">Ir a iniciar sesión</button>');
                return;
            }
            tokenReset = null;
            enlaceInvalido();
            return;
        } catch (e) {
            alerta('kdResetAlert', mensajeError(e), 'error');
        }
        btn.disabled = false; btn.textContent = 'Cambiar contraseña';
    };

    function iniciarReset() {
        var p = new URLSearchParams(window.location.search);
        var t = p.get('resetPassword');
        if (!t) return;
        // El token no debe quedar visible en la barra de direcciones ni en el historial
        p.delete('resetPassword');
        try {
            var resto = p.toString();
            history.replaceState(null, '', window.location.pathname + (resto ? '?' + resto : '') + window.location.hash);
        } catch (_) { /* no crítico */ }
        tokenReset = t;
        abrirModal('🔑 Restablecer contraseña', '<p style="' + TEXTO + '">Verificando enlace…</p>');
        llamar('validarEnlaceRecuperacion', { token: t })
            .then(function (r) { if (r && r.valido) formularioNuevaClave(); else enlaceInvalido(); })
            .catch(function (e) {
                abrirModal('🔑 Restablecer contraseña', '<p style="' + TEXTO + '">' + esc(mensajeError(e)) + '</p>');
            });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarReset);
    else setTimeout(iniciarReset, 0);
})();
