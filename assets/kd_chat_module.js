/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  KuraDoc — Inbox Web / Chat en Vivo Nativo                       ║
 * ║  kd_chat_module.js                                               ║
 * ║                                                                  ║
 * ║  Archivo independiente — cargar DESPUÉS de app.logic.js y        ║
 * ║  fp_expediente_clinico.js:                                       ║
 * ║  <script src="assets/kd_chat_module.js"></script>                ║
 * ║                                                                  ║
 * ║  No modifica app.logic.js. Se integra envolviendo (patching)     ║
 * ║  navigateTo() y renderMobileNav(), el mismo patrón que ya usa    ║
 * ║  fp_expediente_clinico.js.                                       ║
 * ║                                                                  ║
 * ║  Estructura en Firestore:                                        ║
 * ║  centrosMedicos/{centroId}/chats/{pacienteId}/mensajes/{msgId}   ║
 * ║                                                                  ║
 * ║  UI: escritorio = estilo "WhatsApp Web" (lista + conversación    ║
 * ║  lado a lado, con buscador). Smartphone = estilo "WhatsApp app"  ║
 * ║  (lista a pantalla completa → toca un chat → conversación a      ║
 * ║  pantalla completa con botón "←"). Incluye indicador de          ║
 * ║  "escribiendo…" y doble check de leído.                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ══════════════════════════════════════════════════════════════════
//  0. ESTADO INTERNO DEL MÓDULO
// ══════════════════════════════════════════════════════════════════
const _kdChat = {
    unsubListaChats: null,     // listener GLOBAL de la bandeja (secretaria/médico) — vive toda la sesión
    bandejaIniciada: false,    // evita arrancar el listener global más de una vez
    chatsListos:     false,    // ya llegó el primer snapshot de la bandeja
    unsubMensajes:   null,     // listener de la conversación abierta (se abre/cierra al navegar)
    chatActivoId:    null,     // pacienteId del chat abierto actualmente
    chats:           [],       // caché de la bandeja de hoy
    filtroLista:     '',       // texto del buscador de la bandeja
    escribiendoTimer: null,    // debounce del indicador "escribiendo…" (lado secretaria)
    escribiendoActivo: false,  // evita re-escribir "true" en Firestore en cada tecla (secretaria)
    renderListaAgendado: false, // agrupa varios snapshots seguidos en un solo repintado (evita el "freeze")
    enviandoSecretaria: false, // evita doble envío / doble submit
    // Estado del widget del paciente
    unsubMensajesPaciente: null,
    centroChatPaciente: null,
    notifPacienteIniciado: false,
    chatsPacienteInfo: [],     // [{centroId, centroNombre, noLeidosPaciente, noLeidosSecretaria, escribiendoSecretaria}]
    escribiendoTimerPaciente: null,
    escribiendoActivoPaciente: false,
    enviandoPaciente: false,
};

// ══════════════════════════════════════════════════════════════════
//  1. FUNCIÓN COMPARTIDA DE ENVÍO — writeBatch (paciente y secretaria)
// ══════════════════════════════════════════════════════════════════

/**
 * Envía un mensaje y actualiza la cabecera del chat en una sola
 * operación atómica (writeBatch). La usan tanto el paciente como
 * la secretaria/médico — solo cambia "autor".
 * @param {string} centroId
 * @param {string} pacienteId
 * @param {string} texto
 * @param {{id:string, nombre:string, rol:'paciente'|'secretaria'|'medico'|'adminCentro'}} autor
 * @param {object} [datosPaciente] - solo necesario la 1ra vez que se crea el chat
 */
async function kdEnviarMensajeChat(centroId, pacienteId, texto, autor, datosPaciente) {
    texto = (texto || '').trim();
    if (!texto) return;
    if (!centroId || !pacienteId) {
        console.error('[kdChat] Falta centroId o pacienteId al enviar mensaje.');
        return;
    }

    const chatRef    = db.collection('centrosMedicos').doc(centroId)
                          .collection('chats').doc(pacienteId);
    const mensajeRef = chatRef.collection('mensajes').doc();

    const batch = db.batch();

    batch.set(mensajeRef, {
        texto,
        autorId:     autor.id,
        autorRol:    autor.rol,
        autorNombre: autor.nombre || '—',
        fecha:       firebase.firestore.FieldValue.serverTimestamp(),
    });

    const esPaciente = autor.rol === 'paciente';
    const contador = esPaciente
        ? { noLeidosSecretaria: firebase.firestore.FieldValue.increment(1) }
        : { noLeidosPaciente:   firebase.firestore.FieldValue.increment(1) };

    // Al enviar, apago mi propio indicador de "escribiendo…" — y también
    // el flag local que evita escrituras repetidas (ver _kdEmitirEscribiendo),
    // para que si vuelve a escribir enseguida, se vuelva a marcar bien.
    const limpiarEscribiendo = esPaciente
        ? { escribiendoPaciente: false }
        : { escribiendoSecretaria: false };
    if (esPaciente) { _kdChat.escribiendoActivoPaciente = false; if (_kdChat.escribiendoTimerPaciente) clearTimeout(_kdChat.escribiendoTimerPaciente); }
    else { _kdChat.escribiendoActivo = false; if (_kdChat.escribiendoTimer) clearTimeout(_kdChat.escribiendoTimer); }

    const centro = (appState.centrosMedicos || []).find(c => c.id === centroId);

    // El nombre/teléfono del PACIENTE solo se escribe cuando realmente lo
    // tenemos: si quien envía es el paciente (autor.nombre es su propio
    // nombre) o si nos pasaron datosPaciente explícitamente. Si es la
    // secretaria/médico quien escribe, NO tocamos estos campos — antes se
    // sobreescribía pacienteNombre con el nombre de la secretaria cada vez
    // que ella respondía, y por eso el nombre "se intercambiaba" en la
    // lista de conversaciones.
    const datosDelPaciente = {};
    if (esPaciente) {
        datosDelPaciente.pacienteNombre   = autor.nombre || '—';
        datosDelPaciente.pacienteTelefono = datosPaciente?.telefono || '';
    } else if (datosPaciente?.nombre) {
        datosDelPaciente.pacienteNombre = datosPaciente.nombre;
        if (datosPaciente?.telefono) datosDelPaciente.pacienteTelefono = datosPaciente.telefono;
    }

    batch.set(chatRef, {
        pacienteId,
        centroId,
        centroNombre:          centro?.nombre || '—',
        ...datosDelPaciente,
        ultimoMensajeTexto:    texto,
        ultimoMensajeAutorRol: autor.rol,
        ultimoMensajeFecha:    firebase.firestore.FieldValue.serverTimestamp(),
        fechaUltimoMensaje:    window.fechaHoy(),
        estado:                'abierto',
        ...contador,
        ...limpiarEscribiendo,
    }, { merge: true });

    // Registra este centro como "chat activo" en el perfil del propio
    // paciente. Así, su cliente sabe a qué centros escuchar para avisarle
    // cuando le contesten — sin necesitar una consulta collectionGroup
    // (que sí pediría un índice nuevo). Esto es solo una lectura/escritura
    // directa por ID, cubierta por las reglas de "users" que ya existen.
    batch.set(db.collection('users').doc(pacienteId), {
        chatsActivos: firebase.firestore.FieldValue.arrayUnion(centroId),
    }, { merge: true });

    await batch.commit();
}

/** Marca como leídos los mensajes de un chat para el rol que lo abre */
async function kdMarcarChatLeido(centroId, pacienteId, rolQueAbre) {
    const chatRef = db.collection('centrosMedicos').doc(centroId)
                       .collection('chats').doc(pacienteId);
    const campo = rolQueAbre === 'paciente' ? 'noLeidosPaciente' : 'noLeidosSecretaria';
    try {
        await chatRef.set({ [campo]: 0 }, { merge: true });
    } catch (e) {
        console.warn('[kdChat] No se pudo marcar como leído:', e.message);
    }
}

/**
 * Escribe (con debounce) el indicador de "escribiendo…" en la cabecera
 * del chat. Se limpia solo a los 3s de inactividad o al enviar.
 * @param {string} campo - 'escribiendoPaciente' | 'escribiendoSecretaria'
 */
function _kdEmitirEscribiendo(centroId, pacienteId, campo, timerKey) {
    const chatRef = db.collection('centrosMedicos').doc(centroId).collection('chats').doc(pacienteId);

    // Clave del flag "ya está marcado como escribiendo" según el campo.
    // IMPORTANTE: solo escribimos "true" en Firestore la PRIMERA vez que
    // el usuario empieza a teclear, no en cada tecla. Escribir en cada
    // tecla dispara el listener GLOBAL de la bandeja en cada pulsación
    // (Firestore aplica la escritura de forma optimista/local al instante),
    // lo que reconstruye toda la lista de conversaciones decenas de veces
    // mientras se escribe un solo mensaje — esa es la causa del "freeze".
    const flagKey = campo === 'escribiendoPaciente' ? 'escribiendoActivoPaciente' : 'escribiendoActivo';
    if (!_kdChat[flagKey]) {
        _kdChat[flagKey] = true;
        chatRef.set({ [campo]: true }, { merge: true }).catch(() => {});
    }

    if (_kdChat[timerKey]) clearTimeout(_kdChat[timerKey]);
    _kdChat[timerKey] = setTimeout(() => {
        _kdChat[flagKey] = false;
        chatRef.set({ [campo]: false }, { merge: true }).catch(() => {});
    }, 3000);
}

/** Formatea un Timestamp de Firestore a hora local corta (HH:MM) */
function _kdChatHora(ts) {
    if (!ts?.toDate) return '';
    return ts.toDate().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
}

/** Hace crecer el textarea del chat con el texto (como WhatsApp), hasta un máximo, luego scrollea */
function _kdAutoAlturaTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function _kdChatEscapar(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

/** Color de avatar estable según el nombre (mismo nombre = mismo color siempre) */
function _kdColorAvatar(nombre) {
    const paleta = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c', '#059669', '#4f46e5', '#c2410c'];
    const str = nombre || '?';
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return paleta[Math.abs(hash) % paleta.length];
}

/** Icono de check estilo WhatsApp: 1 check gris (enviado) / 2 checks azules (leído) */
function _kdTicks(leido) {
    return leido
        ? `<span style="color:#53bdeb;font-size:13px;letter-spacing:-3px;margin-left:2px;">✓✓</span>`
        : `<span style="color:#94a3b8;font-size:13px;margin-left:2px;">✓</span>`;
}

// ══════════════════════════════════════════════════════════════════
//  2. VISTA DE LA SECRETARIA / MÉDICO — "WhatsApp Web" style
// ══════════════════════════════════════════════════════════════════

function renderInboxChatSecretaria() {
    appState.currentView = 'mensajes';
    const mainContent = document.getElementById('mainContent');
    const centroId = appState.currentUserData?.centroMedicoId;

    if (!centroId) {
        mainContent.innerHTML = `
            <div style="text-align:center;padding:60px 20px;color:#64748b;">
                <div style="font-size:36px;margin-bottom:10px;">🏥</div>
                <p style="font-weight:600;">Tu usuario no tiene un centro médico asignado.</p>
                <p style="font-size:13px;">Contacta al administrador para poder usar la bandeja de mensajes.</p>
            </div>`;
        return;
    }

    mainContent.innerHTML = `
        <div class="page-header">
            <h1 class="page-title">💬 Mensajes</h1>
        </div>
        <div id="kd-chat-shell" class="kd-chat-shell">
            <!-- Columna izquierda: bandeja del día -->
            <div id="kd-chat-lista" class="kd-chat-lista">
                <div class="kd-chat-lista-head">
                    <div class="kd-chat-lista-titulo">Conversaciones de hoy</div>
                    <div class="kd-chat-search-wrap">
                        <span class="kd-chat-search-icon">🔎</span>
                        <input id="kd-chat-search" type="text" placeholder="Buscar paciente…" autocomplete="off"
                               oninput="_kdFiltrarLista(this.value)">
                    </div>
                </div>
                <div id="kd-chat-lista-items" class="kd-chat-lista-items">
                    <div style="padding:30px;text-align:center;color:#94a3b8;font-size:13px;">Cargando…</div>
                </div>
            </div>
            <!-- Columna derecha: conversación activa -->
            <div id="kd-chat-panel" class="kd-chat-panel">
                <div class="kd-chat-vacio">
                    <div style="font-size:56px;margin-bottom:14px;opacity:.5;">💬</div>
                    <p style="font-weight:700;color:#475569;">KuraDoc Mensajes</p>
                    <p style="font-size:13px;max-width:260px;margin:6px auto 0;">
                        Selecciona una conversación de la izquierda para verla aquí.
                    </p>
                </div>
            </div>
        </div>

        <style>
            /* ═══ Layout tipo WhatsApp Web (desktop/tablet) ═══ */
            .kd-chat-shell { display:flex; height:calc(100vh - 180px); min-height:560px; background:#fff;
                border:1px solid #e2e8f0; border-radius:14px; overflow:hidden; position:relative; }
            .kd-chat-lista { width:340px; min-width:280px; border-right:1px solid #e2e8f0; display:flex;
                flex-direction:column; background:#f8fafc; overflow:hidden; }
            .kd-chat-lista-head { padding:12px 14px; border-bottom:1px solid #e2e8f0; background:#fff; flex-shrink:0; }
            .kd-chat-lista-titulo { font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase;
                letter-spacing:.5px; margin-bottom:8px; }
            .kd-chat-search-wrap { position:relative; }
            .kd-chat-search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); font-size:12px; opacity:.5; }
            #kd-chat-search { width:100%; padding:8px 10px 8px 30px; border:1px solid #e2e8f0; border-radius:20px;
                font-size:13px; background:#f1f5f9; outline:none; box-sizing:border-box; }
            #kd-chat-search:focus { background:#fff; border-color:#93c5fd; }
            .kd-chat-lista-items { flex:1; overflow-y:auto; }
            .kd-chat-panel { flex:1; display:flex; flex-direction:column; min-width:0; background:#efeae2; }
            .kd-chat-vacio { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
                color:#94a3b8; text-align:center; padding:20px; background:#f8fafc; }

            .kd-chat-item { display:flex; gap:10px; align-items:flex-start; padding:12px 14px;
                cursor:pointer; border-bottom:1px solid #f1f5f9; transition:background .12s; }
            .kd-chat-item:hover { background:#eff6ff; }
            .kd-chat-item.activo { background:#dbeafe; }
            .kd-chat-avatar { width:42px;height:42px;border-radius:50%;color:white;
                display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0; }
            .kd-chat-badge-mini { background:#25d366;color:white;font-size:10.5px;font-weight:800;
                border-radius:20px;padding:1px 7px;flex-shrink:0; }
            .kd-chat-nombre { font-weight:700;font-size:13.5px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
            .kd-chat-preview { font-size:12.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px; }
            .kd-chat-preview.no-leido { color:#0f172a; font-weight:600; }
            .kd-chat-hora-lista { font-size:11px; color:#94a3b8; flex-shrink:0; }

            /* Header de la conversación */
            .kd-chat-header-conv { padding:11px 18px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;
                gap:12px;background:#f8fafc; flex-shrink:0; }
            .kd-chat-back-mobile { display:none; background:none;border:none;font-size:20px;cursor:pointer;color:#1e293b;padding:0 4px; }
            .kd-chat-nombre-header { font-weight:700;font-size:14.5px;color:#0f172a;line-height:1.25; }
            .kd-chat-status-header { font-size:11.5px;color:#64748b; height:15px; }
            .kd-chat-status-header.escribiendo { color:#059669; font-style:italic; }

            /* Burbujas de mensajes (fondo tipo WhatsApp) */
            #kd-chat-mensajes { flex:1;overflow-y:auto;padding:18px 6% ;display:flex;flex-direction:column;
                background-color:#efeae2;
                background-image: radial-gradient(#d9d2c5 1px, transparent 1px);
                background-size: 18px 18px; }
            .kd-chat-bubble { max-width:65%; padding:7px 10px 8px; border-radius:9px; font-size:14px;
                line-height:1.35; margin-bottom:6px; word-wrap:break-word; box-shadow:0 1px 1px rgba(0,0,0,.08); position:relative; }
            .kd-chat-bubble.entrante { background:#ffffff; color:#0f172a; align-self:flex-start; border-top-left-radius:2px; }
            .kd-chat-bubble.saliente { background:#d9fdd3; color:#0f172a; align-self:flex-end; border-top-right-radius:2px; }
            .kd-chat-hora { font-size:10.5px; opacity:.55; margin-top:2px; display:flex; justify-content:flex-end; align-items:center; gap:2px; }
            #kd-chat-mensajes::-webkit-scrollbar { width:6px; }
            #kd-chat-mensajes::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:3px; }

            .kd-chat-form { display:flex;gap:8px;padding:10px 14px;border-top:1px solid #e2e8f0;background:#f8fafc; flex-shrink:0;
                align-items:flex-end; padding-bottom:calc(10px + env(safe-area-inset-bottom,0px)); }
             
            .kd-chat-form textarea { flex:1;padding:11px 16px;border:1px solid #d1d5db;border-radius:22px;font-size:16px;
                outline:none;resize:none;font-family:inherit;line-height:1.3;max-height:120px;overflow-y:auto;box-sizing:border-box; }
            .kd-chat-form button { background:#2563eb;color:white;border:none;border-radius:50%;
                width:42px;height:42px;font-size:17px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center; }

            /* ═══ Smartphone: patrón "lista → conversación" (como la app de WhatsApp) ═══ */
            @media (max-width: 640px) {
                .kd-chat-shell { height:calc(108vh - 150px); border-radius:0; border:none; margin:0 -14px; }
                .kd-chat-lista { width:100%; min-width:100%; border-right:none; }
                .kd-chat-panel {
                    /* fixed + inset:0, igual que el modal del paciente: así el panel
                       queda anclado al viewport real del teléfono y no al flujo
                       normal de la página, que es lo que hacía que el input del
                       chat de la secretaria se quedara "debajo" del teclado. */
                    position:fixed; inset:0; z-index:9200; background:#efeae2;
                    transform:translateX(100%); transition:transform .22s ease;
                    height:100vh; height:100dvh;
                }
                .kd-chat-panel.kd-chat-panel-abierto { transform:translateX(0); }
                .kd-chat-back-mobile { display:inline-block; }
                #kd-chat-mensajes { padding:14px 4%; }
                .kd-chat-bubble { max-width:80%; }
            }
        </style>
    `;

    // El listener GLOBAL ya está corriendo (arrancó desde renderMobileNav) —
    // aquí solo pintamos lo que ya tengamos en caché.
    if (_kdChat.chatsListos) {
        _kdRenderListaChats();
    }
}

/**
 * Listener GLOBAL de la bandeja del día — arranca UNA SOLA VEZ por sesión
 * (apenas se conoce el centro del usuario, sin esperar a que entre a la
 * vista "Mensajes") y vive mientras dure la sesión. Así el contador del
 * menú se actualiza en tiempo real siempre, no solo dentro de la vista.
 */
function _kdIniciarBandejaGlobal(centroId) {
    if (_kdChat.bandejaIniciada) return;
    _kdChat.bandejaIniciada = true;

    const hoy = window.fechaHoy();
    const query = db.collection('centrosMedicos').doc(centroId)
        .collection('chats')
        .where('fechaUltimoMensaje', '==', hoy);
        // Nota: si ya crearon el índice compuesto (ver documento de arquitectura),
        // pueden encadenar aquí .orderBy('ultimoMensajeFecha','desc') y quitar
        // el .sort() de más abajo.

    _kdChat.unsubListaChats = query.onSnapshot(snap => {
        _kdChat.chats = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.ultimoMensajeFecha?.toMillis?.() || 0) - (a.ultimoMensajeFecha?.toMillis?.() || 0));
        _kdChat.chatsListos = true;
        _kdActualizarBadgeMenu();
        // Si la vista "Mensajes" está abierta en este momento, repintarla también.
        // Se agenda con requestAnimationFrame (agrupando ráfagas de snapshots
        // seguidos, p. ej. varios chats cambiando casi a la vez) en vez de
        // repintar la lista completa de forma síncrona en cada evento —
        // eso era lo que provocaba el "freeze" al escribir/enviar.
        if (appState.currentView === 'mensajes' && !_kdChat.renderListaAgendado) {
            _kdChat.renderListaAgendado = true;
            requestAnimationFrame(() => {
                _kdChat.renderListaAgendado = false;
                _kdRenderListaChats();
                _kdRefrescarHeaderConversacionAbierta();
            });
        }
    }, err => {
        console.error('[kdChat] Error escuchando bandeja global:', err);
        const cont = document.getElementById('kd-chat-lista-items');
        if (cont) cont.innerHTML = `<div style="padding:20px;color:#ef4444;font-size:12px;text-align:center;">
            Error cargando conversaciones.<br>${err.message}</div>`;
    });
}

/** Filtro del buscador de la bandeja (por nombre de paciente) */
window._kdFiltrarLista = function(valor) {
    _kdChat.filtroLista = (valor || '').trim().toLowerCase();
    _kdRenderListaChats();
};

function _kdRenderListaChats() {
    const cont = document.getElementById('kd-chat-lista-items');
    if (!cont) return;

    let lista = _kdChat.chats;
    if (_kdChat.filtroLista) {
        lista = lista.filter(c => (c.pacienteNombre || '').toLowerCase().includes(_kdChat.filtroLista));
    }

    if (lista.length === 0) {
        cont.innerHTML = `<div style="padding:30px 16px;text-align:center;color:#94a3b8;font-size:13px;">
            ${_kdChat.filtroLista ? 'Ningún paciente coincide con tu búsqueda.' : 'Ningún paciente ha escrito hoy todavía.'}
        </div>`;
        return;
    }

    cont.innerHTML = lista.map(c => {
        const inicial = (c.pacienteNombre || '?').trim().charAt(0).toUpperCase();
        const activo  = c.id === _kdChat.chatActivoId ? 'activo' : '';
        const noLeidos = c.noLeidosSecretaria || 0;
        const soyYo = c.ultimoMensajeAutorRol !== 'paciente';
        return `
        <div class="kd-chat-item ${activo}" onclick="_kdAbrirConversacion('${c.id}')">
            <div class="kd-chat-avatar" style="background:${_kdColorAvatar(c.pacienteNombre)};">${inicial}</div>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;">
                    <span class="kd-chat-nombre">${_kdChatEscapar(c.pacienteNombre)}</span>
                    <span class="kd-chat-hora-lista">${_kdChatHora(c.ultimoMensajeFecha)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;">
                    <div class="kd-chat-preview ${noLeidos > 0 ? 'no-leido' : ''}">
                        ${soyYo ? '<span style="color:#94a3b8;">Tú: </span>' : ''}${_kdChatEscapar(c.ultimoMensajeTexto)}
                    </div>
                    ${noLeidos > 0 ? `<span class="kd-chat-badge-mini">${noLeidos}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

/** Abre la conversación de un paciente en el panel derecho */
window._kdAbrirConversacion = function(pacienteId) {
    const centroId = appState.currentUserData?.centroMedicoId;
    const chat = _kdChat.chats.find(c => c.id === pacienteId);
    if (!chat) return;

    _kdChat.chatActivoId = pacienteId;
    _kdRenderListaChats(); // repinta para resaltar el activo

    const panel = document.getElementById('kd-chat-panel');
    panel.classList.add('kd-chat-panel-abierto'); // en mobile: desliza a pantalla completa
    const inicial = (chat.pacienteNombre || '?').trim().charAt(0).toUpperCase();

    panel.innerHTML = `
        <div class="kd-chat-header-conv">
            <button class="kd-chat-back-mobile" onclick="_kdCerrarConversacionMobile()">←</button>
            <div class="kd-chat-avatar" style="background:${_kdColorAvatar(chat.pacienteNombre)};">${inicial}</div>
            <div style="flex:1;min-width:0;">
                <div class="kd-chat-nombre-header">${_kdChatEscapar(chat.pacienteNombre)}</div>
                <div id="kd-chat-status-header" class="kd-chat-status-header">${_kdChatEscapar(chat.pacienteTelefono || '')}</div>
            </div>
        </div>
        <div id="kd-chat-mensajes"></div>
        <form id="kd-chat-form" class="kd-chat-form">
            <textarea id="kd-chat-input" rows="1" placeholder="Escribe un mensaje…" autocomplete="off"></textarea>
            <button type="submit" id="kd-chat-btn-enviar">➤</button>
        </form>
    `;

    const inputEl = document.getElementById('kd-chat-input');
    const formEl  = document.getElementById('kd-chat-form');
    const btnEl   = document.getElementById('kd-chat-btn-enviar');

    inputEl.addEventListener('input', function() {
        _kdAutoAlturaTextarea(this);
        const rolCampo = 'escribiendoSecretaria';
        _kdEmitirEscribiendo(centroId, pacienteId, rolCampo, 'escribiendoTimer');
    });

    // Evita que tocar el botón ➤ le quite el foco al textarea (eso es lo
    // que hace que el teclado se oculte solo al enviar). Con esto, el
    // teclado se queda abierto para seguir escribiendo — solo se oculta
    // si el usuario lo cierra con el propio botón del teclado.
    if (btnEl) btnEl.addEventListener('mousedown', function(e) { e.preventDefault(); });

    // Estilo WhatsApp: en PC, Enter envía. En smartphone, Enter (el botón
    // del teclado táctil) SOLO inserta un salto de línea — el mensaje se
    // envía exclusivamente con la flechita. Shift+Enter siempre inserta
    // salto de línea (en PC y en móvil).
    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 640) {
            e.preventDefault();
            formEl.requestSubmit ? formEl.requestSubmit() : formEl.dispatchEvent(new Event('submit', { cancelable: true }));
        }
    });

    formEl.addEventListener('submit', function(e) {
        e.preventDefault();
        if (_kdChat.enviandoSecretaria) return; // evita doble envío (doble tap / doble Enter)
        const texto = inputEl.value;
        if (!texto.trim()) return;

        inputEl.value = '';
        _kdAutoAlturaTextarea(inputEl);
        inputEl.focus({ preventScroll: true }); // refuerzo: mantiene el teclado abierto
        const u = appState.currentUserData;

        _kdChat.enviandoSecretaria = true;
        if (btnEl) btnEl.style.opacity = '.5';

        // Nunca dejamos la pantalla "colgada": si Firestore tarda demasiado
        // (mala señal), a los 8s liberamos el botón igual — el mensaje se
        // termina de enviar solo cuando la conexión vuelva (writeBatch de
        // Firestore reintenta solo), pero la interfaz sigue respondiendo.
        const liberar = () => { _kdChat.enviandoSecretaria = false; if (btnEl) btnEl.style.opacity = '1'; };
        const timeoutId = setTimeout(liberar, 8000);

        kdEnviarMensajeChat(centroId, pacienteId, texto, {
            id: appState.currentUser.uid,
            nombre: u.nombre || 'Secretaría',
            rol: u.rol === 'medico' ? 'medico' : (u.rol === 'adminCentro' ? 'adminCentro' : 'secretaria'),
        }).catch(err => {
            console.error('[kdChat] Error enviando mensaje:', err);
            inputEl.value = texto; // devuelve el texto para que no se pierda
            _kdAutoAlturaTextarea(inputEl);
        }).finally(() => {
            clearTimeout(timeoutId);
            liberar();
        });
    });

    kdMarcarChatLeido(centroId, pacienteId, 'secretaria');
    _kdEscucharMensajes(centroId, pacienteId);
    _kdRefrescarHeaderConversacionAbierta();
};

/** Botón "←" en mobile: vuelve a la lista. Cierra la conversación de
 *  verdad (no solo la oculta) — así, si el paciente sigue escribiendo
 *  después de que la secretaria sale, el contador de "no leídos" vuelve
 *  a sumar y a mostrarse normalmente, tal como debe ser. */
window._kdCerrarConversacionMobile = function() {
    const panel = document.getElementById('kd-chat-panel');
    if (panel) panel.classList.remove('kd-chat-panel-abierto');
    if (_kdChat.unsubMensajes) { _kdChat.unsubMensajes(); _kdChat.unsubMensajes = null; }
    _kdChat.chatActivoId = null;
    _kdRenderListaChats(); // quita el resaltado "activo" de la lista
};

/** Pinta "escribiendo…" o el teléfono en el header, según el estado en caché de la bandeja */
function _kdRefrescarHeaderConversacionAbierta() {
    if (!_kdChat.chatActivoId) return;
    const chat = _kdChat.chats.find(c => c.id === _kdChat.chatActivoId);
    const el = document.getElementById('kd-chat-status-header');
    if (!chat || !el) return;
    if (chat.escribiendoPaciente) {
        el.textContent = 'escribiendo…';
        el.classList.add('escribiendo');
    } else {
        el.textContent = chat.pacienteTelefono || '';
        el.classList.remove('escribiendo');
    }
}

/** Listener en tiempo real del historial de UNA conversación */
function _kdEscucharMensajes(centroId, pacienteId) {
    if (_kdChat.unsubMensajes) _kdChat.unsubMensajes();

    const query = db.collection('centrosMedicos').doc(centroId)
        .collection('chats').doc(pacienteId)
        .collection('mensajes')
        .orderBy('fecha', 'asc')
        .limit(200);

    _kdChat.unsubMensajes = query.onSnapshot(snap => {
        const cont = document.getElementById('kd-chat-mensajes');
        if (!cont) return; // el usuario ya cambió de vista
        const miUid = appState.currentUser.uid;
        const docs = snap.docs;
        const chat = _kdChat.chats.find(c => c.id === pacienteId);
        const yaLeidoPorPaciente = (chat?.noLeidosPaciente || 0) === 0;

        cont.innerHTML = docs.map((d, i) => {
            const m = d.data();
            const esMio = m.autorId === miUid;
            const clase = esMio ? 'saliente' : 'entrante';
            const esUltimoMio = esMio && (i === docs.length - 1 || docs.slice(i + 1).every(dd => dd.data().autorId !== miUid));
            return `
            <div class="kd-chat-bubble ${clase}">
                ${_kdChatEscapar(m.texto)}
                <span class="kd-chat-hora">${_kdChatHora(m.fecha)}${esMio && i === docs.length - 1 ? _kdTicks(yaLeidoPorPaciente) : ''}</span>
            </div>`;
        }).join('') || `<div style="text-align:center;color:#64748b;font-size:12px;margin:auto;background:rgba(255,255,255,.7);padding:8px 14px;border-radius:8px;">Sin mensajes aún.</div>`;
        cont.scrollTop = cont.scrollHeight;

        // Mientras la secretaria tiene ESTE chat abierto en pantalla, si el
        // paciente sigue escribiendo, marcamos de inmediato como leído —
        // igual que WhatsApp: los mensajes que llegan mientras estás viendo
        // la conversación no se acumulan como "no leídos". Solo aplica si
        // el chat que llegó sigue siendo el que está abierto ahora mismo
        // (si la secretaria ya salió de esta conversación, chatActivoId ya
        // no coincide y aquí no hacemos nada — ahí sí debe volver a sumar).
        const ultimo = docs[docs.length - 1]?.data();
        if (ultimo && ultimo.autorId !== miUid && _kdChat.chatActivoId === pacienteId) {
            kdMarcarChatLeido(centroId, pacienteId, 'secretaria');
        }
    }, err => console.error('[kdChat] Error escuchando mensajes:', err));
}

/** Suma los no-leídos de todos los chats de hoy, para el badge del menú */
function _kdActualizarBadgeMenu() {
    const total = _kdChat.chats.reduce((acc, c) => acc + (c.noLeidosSecretaria || 0), 0);
    document.querySelectorAll('[id^="kd-chat-badge-"]').forEach(el => {
        if (total > 0) {
            el.textContent = total > 99 ? '99+' : total;
            el.style.display = 'inline-block';
        } else {
            el.style.display = 'none';
        }
    });
}

// ══════════════════════════════════════════════════════════════════
//  3. INTEGRACIÓN AL MENÚ — envolvemos navigateTo() y renderMobileNav()
//     sin tocar app.logic.js (mismo patrón que fp_expediente_clinico.js)
// ══════════════════════════════════════════════════════════════════

(function _kdPatchNavigateToChat() {
    const _orig = window.navigateTo;
    if (typeof _orig !== 'function') return;
    window.navigateTo = function(view) {
        _orig(view); // conserva TODO el comportamiento original intacto
        if (view === 'mensajes') renderInboxChatSecretaria();
    };
})();

(function _kdPatchRenderMobileNavChat() {
    const _orig = window.renderMobileNav;
    if (typeof _orig !== 'function') return;
    window.renderMobileNav = function() {
        _orig();
        const rol = appState.currentUserData?.rol;
        if (rol !== 'secretaria' && rol !== 'medico' && rol !== 'adminCentro') return;

        // Arranca (una sola vez por sesión) el listener global de la
        // bandeja de hoy, independientemente de si el usuario ha entrado
        // a la vista "Mensajes" — así el contador del menú se mantiene
        // en tiempo real todo el tiempo.
        const miCentroId = appState.currentUserData?.centroMedicoId;
        if (miCentroId) _kdIniciarBandejaGlobal(miCentroId);

        const activo = appState.currentView === 'mensajes' ? 'active' : '';
        const badgeStyle = 'position:absolute;top:2px;right:2px;background:#ef4444;color:white;' +
            'font-size:9px;font-weight:800;border-radius:20px;padding:1px 5px;display:none;';

        const mobileNav = document.getElementById('mobileNav');
        if (mobileNav && !document.getElementById('kd-chat-nav-mobile')) {
            mobileNav.insertAdjacentHTML('beforeend', `
                <button id="kd-chat-nav-mobile" class="nav-item ${activo}" onclick="navigateTo('mensajes')" style="position:relative;">
                    <span class="nav-item-icon">💬</span>
                    <span class="nav-item-label">Mensajes</span>
                    <span id="kd-chat-badge-mobile" style="${badgeStyle}"></span>
                </button>`);
        }

        const sidebarNav = document.getElementById('sidebarNav');
        if (sidebarNav && !document.getElementById('kd-chat-nav-sidebar')) {
            sidebarNav.insertAdjacentHTML('beforeend', `
                <button id="kd-chat-nav-sidebar" class="sidebar-nav-item ${activo}" onclick="navigateTo('mensajes')" title="Mensajes" style="position:relative;">
                    <span class="sidebar-nav-icon">💬</span>
                    <span class="sidebar-nav-label">Mensajes</span>
                    <span id="kd-chat-badge-sidebar" style="${badgeStyle}"></span>
                </button>`);
        }
        _kdActualizarBadgeMenu();
    };
})();

// ══════════════════════════════════════════════════════════════════
//  4. WIDGET DEL PACIENTE — "💬 Chatear con el centro" (estilo WhatsApp)
// ══════════════════════════════════════════════════════════════════

/**
 * Abre un chat entre el paciente logueado y la secretaría del centro
 * indicado. En smartphone ocupa toda la pantalla (como la app de
 * WhatsApp); en PC se ve como una ventana de chat centrada.
 * @param {string} centroId
 * @param {string} centroNombre
 */
window.kdAbrirChatConCentro = function(centroId, centroNombre) {
    if (!centroId) return alert('No se pudo determinar el centro médico de esta conversación.');
    const u = appState.currentUserData;
    const uid = appState.currentUser.uid;

    _kdChat.centroChatPaciente = centroId;

    let picker = document.getElementById('kd-chat-picker-paciente');
    if (picker) picker.remove();
    let modalPrev = document.getElementById('kd-chat-modal-paciente');
    if (modalPrev) modalPrev.remove();

    document.body.insertAdjacentHTML('beforeend', `
        <div id="kd-chat-modal-paciente" class="kd-chat-modal-paciente">
            <div class="kd-chat-ventana-paciente">
                <div class="kd-chat-header-paciente">
                    <button class="kd-chat-close-paciente" onclick="_kdCerrarChatPaciente()">←</button>
                    <div class="kd-chat-avatar" style="background:${_kdColorAvatar(centroNombre)};">🏥</div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:800;font-size:14.5px;">${_kdChatEscapar(centroNombre || 'Centro Médico')}</div>
                        <div id="kd-chat-status-paciente" style="font-size:11.5px;opacity:.85;">Secretaría</div>
                    </div>
                </div>
                <div id="kd-chat-mensajes-paciente"></div>
                <form id="kd-chat-form-paciente" class="kd-chat-form-paciente">
                    <textarea id="kd-chat-input-paciente" rows="1" placeholder="Escribe un mensaje…" autocomplete="off"></textarea>
                    <button type="submit" id="kd-chat-btn-enviar-paciente">➤</button>
                </form>
            </div>
        </div>
        <style>
            .kd-chat-modal-paciente { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:9998;
                display:flex; align-items:center; justify-content:center; padding:24px; }
            .kd-chat-ventana-paciente { background:#efeae2; width:100%; max-width:420px; height:min(680px,88vh);
                border-radius:16px; display:flex; flex-direction:column; overflow:hidden;
                box-shadow:0 20px 60px rgba(0,0,0,.35); }
            .kd-chat-header-paciente { padding:12px 16px; background:linear-gradient(135deg,#1e3a5f,#2563eb); color:white;
                display:flex; align-items:center; gap:10px; flex-shrink:0; }
            .kd-chat-close-paciente { background:rgba(255,255,255,.18); border:none; color:white; width:32px;height:32px;
                border-radius:50%; font-size:17px; cursor:pointer; flex-shrink:0; }
            #kd-chat-mensajes-paciente { flex:1; overflow-y:auto; padding:16px 5%; display:flex; flex-direction:column;
                background-color:#efeae2;
                background-image: radial-gradient(#d9d2c5 1px, transparent 1px);
                background-size: 18px 18px; }
            #kd-chat-mensajes-paciente::-webkit-scrollbar { width:5px; }
            #kd-chat-mensajes-paciente::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:3px; }

            /* Smartphone: pantalla completa, como la app real de WhatsApp */
           .kd-chat-form-paciente {display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #e2e8f0;background: #f8fafc;flex-shrink: 0; align-items:flex-end; padding-bottom:calc(10px + env(safe-area-inset-bottom,0px)); }
            .kd-chat-form-paciente textarea { flex: 1;padding: 11px 16px;border: 1px solid #d1d5db;border-radius: 22px; font-size: 16px;
                outline: none;resize:none;font-family:inherit;line-height:1.3;max-height:120px;overflow-y:auto;box-sizing:border-box;}
            .kd-chat-form-paciente button {background: #2563eb; color: white;border: none; border-radius: 50%;width: 42px;height: 42px; font-size: 17px;cursor: pointer;flex-shrink: 0;display: flex; align-items: center;justify-content: center;}
            @media (max-width: 640px) {
                .kd-chat-modal-paciente { padding:0; align-items:stretch; }
                .kd-chat-ventana-paciente { max-width:100%; height:100vh; height:100dvh; border-radius:0; }
                .kd-chat-header-paciente { padding-top:calc(12px + env(safe-area-inset-top,0px)); }
                .kd-chat-form { padding-bottom:calc(10px + env(safe-area-inset-bottom,0px)); }
            }
        </style>
    `);

    const inputEl = document.getElementById('kd-chat-input-paciente');
    const formEl  = document.getElementById('kd-chat-form-paciente');
    const btnEl   = document.getElementById('kd-chat-btn-enviar-paciente');

    inputEl.addEventListener('input', function() {
        _kdAutoAlturaTextarea(this);
        _kdEmitirEscribiendo(centroId, uid, 'escribiendoPaciente', 'escribiendoTimerPaciente');
    });

    if (btnEl) btnEl.addEventListener('mousedown', function(e) { e.preventDefault(); });

    // Igual que en el chat de la secretaria: en PC, Enter envía; en
    // smartphone, Enter solo hace salto de línea y se envía con la flechita.
    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 640) {
            e.preventDefault();
            formEl.requestSubmit ? formEl.requestSubmit() : formEl.dispatchEvent(new Event('submit', { cancelable: true }));
        }
    });

    formEl.addEventListener('submit', function(e) {
        e.preventDefault();
        if (_kdChat.enviandoPaciente) return;
        const texto = inputEl.value;
        if (!texto.trim()) return;

        inputEl.value = '';
        _kdAutoAlturaTextarea(inputEl);
        inputEl.focus({ preventScroll: true });

        _kdChat.enviandoPaciente = true;
        if (btnEl) btnEl.style.opacity = '.5';
        const liberar = () => { _kdChat.enviandoPaciente = false; if (btnEl) btnEl.style.opacity = '1'; };
        const timeoutId = setTimeout(liberar, 8000);

        kdEnviarMensajeChat(centroId, uid, texto,
            { id: uid, nombre: u.nombre || 'Paciente', rol: 'paciente' },
            { nombre: u.nombre, telefono: u.telefono }
        ).catch(err => {
            console.error('[kdChat-paciente] Error enviando mensaje:', err);
            inputEl.value = texto;
            _kdAutoAlturaTextarea(inputEl);
        }).finally(() => {
            clearTimeout(timeoutId);
            liberar();
        });
    });

    kdMarcarChatLeido(centroId, uid, 'paciente');

    if (_kdChat.unsubMensajesPaciente) _kdChat.unsubMensajesPaciente();
    _kdChat.unsubMensajesPaciente = db.collection('centrosMedicos').doc(centroId)
        .collection('chats').doc(uid)
        .collection('mensajes')
        .orderBy('fecha', 'asc')
        .limit(200)
        .onSnapshot(snap => {
            const cont = document.getElementById('kd-chat-mensajes-paciente');
            if (!cont) return;
            const info = _kdChat.chatsPacienteInfo.find(a => a.centroId === centroId);
            const yaLeidoPorSecretaria = (info?.noLeidosSecretaria || 0) === 0;
            const docs = snap.docs;

            cont.innerHTML = docs.map((d, i) => {
                const m = d.data();
                const esMio = m.autorRol === 'paciente';
                const clase = esMio ? 'saliente' : 'entrante';
                const bg = esMio ? '#d9fdd3' : '#ffffff';
                const align = esMio ? 'flex-end' : 'flex-start';
                const radius = esMio ? '9px 2px 9px 9px' : '2px 9px 9px 9px';
                const esUltimoMio = esMio && i === docs.length - 1;
                return `
                <div style="max-width:78%;align-self:${align};background:${bg};color:#0f172a;
                            padding:7px 10px 8px;border-radius:${radius};font-size:14px;line-height:1.35;
                            margin-bottom:6px;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08);">
                    ${_kdChatEscapar(m.texto)}
                    <span style="font-size:10.5px;opacity:.55;display:flex;justify-content:flex-end;align-items:center;gap:2px;margin-top:2px;">
                        ${_kdChatHora(m.fecha)}${esUltimoMio ? _kdTicks(yaLeidoPorSecretaria) : ''}
                    </span>
                </div>`;
            }).join('') || `<div style="text-align:center;color:#64748b;font-size:12px;margin:auto;background:rgba(255,255,255,.7);padding:8px 14px;border-radius:8px;">
                Escribe tu primer mensaje a la secretaría del centro.</div>`;
            cont.scrollTop = cont.scrollHeight;
        }, err => console.error('[kdChat-paciente] Error:', err));
};

window._kdCerrarChatPaciente = function() {
    const modal = document.getElementById('kd-chat-modal-paciente');
    if (modal) modal.remove();
    if (_kdChat.unsubMensajesPaciente) { _kdChat.unsubMensajesPaciente(); _kdChat.unsubMensajesPaciente = null; }
};

// ══════════════════════════════════════════════════════════════════
//  4.b NOTIFICACIONES DEL PACIENTE — burbuja flotante en tiempo real
//      Avisa al paciente cuando la secretaría le responde, incluso si
//      no tiene el chat abierto en ese momento. No usa collectionGroup
//      (evita el índice extra): lee su propio perfil (users/{uid}.
//      chatsActivos) para saber a qué centros escuchar, y luego abre
//      un listener directo por documento (sin query) por cada centro.
// ══════════════════════════════════════════════════════════════════

function _kdInsertarFabPaciente() {
    if (document.getElementById('kd-chat-fab-paciente')) return;
    document.body.insertAdjacentHTML('beforeend', `
        <button id="kd-chat-fab-paciente" onclick="_kdAbrirPickerChatsPaciente()" title="Mis mensajes"
            style="position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;
                   background:linear-gradient(135deg,#1e3a5f,#2563eb);color:white;border:none;
                   box-shadow:0 6px 20px rgba(37,99,235,.4);font-size:24px;cursor:pointer;z-index:9990;
                   display:none;align-items:center;justify-content:center;">
            💬
            <span id="kd-chat-fab-badge" style="position:absolute;top:-2px;right:-2px;background:#ef4444;color:white;
                        font-size:11px;font-weight:800;border-radius:20px;padding:2px 6px;display:none;min-width:14px;"></span>
        </button>
    `);
}

function _kdActualizarFabPaciente() {
    const fab   = document.getElementById('kd-chat-fab-paciente');
    const badge = document.getElementById('kd-chat-fab-badge');
    if (!fab) return;
    fab.style.display = 'flex'; // ya tiene al menos 1 chat activo -> se muestra siempre
    const total = _kdChat.chatsPacienteInfo.reduce((acc, a) => acc + (a.noLeidosPaciente || 0), 0);
    if (badge) {
        if (total > 0) {
            badge.textContent = total > 99 ? '99+' : total;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
}

/** Click en la burbuja: si solo hay 1 chat activo lo abre directo; si hay varios, muestra un selector */
window._kdAbrirPickerChatsPaciente = function() {
    const activos = _kdChat.chatsPacienteInfo || [];
    if (activos.length === 0) return;

    if (activos.length === 1) {
        return window.kdAbrirChatConCentro(activos[0].centroId, activos[0].centroNombre);
    }

    let picker = document.getElementById('kd-chat-picker-paciente');
    if (picker) { picker.remove(); return; } // toggle: si ya estaba abierto, ciérralo

    const ordenados = [...activos].sort((a, b) => (b.noLeidosPaciente || 0) - (a.noLeidosPaciente || 0));

    document.body.insertAdjacentHTML('beforeend', `
        <div id="kd-chat-picker-paciente" style="position:fixed;bottom:86px;right:20px;background:white;
                    border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.22);width:270px;overflow:hidden;
                    z-index:9991;border:1px solid #e2e8f0;">
            <div style="padding:10px 14px;font-weight:800;font-size:11px;color:#64748b;text-transform:uppercase;
                        letter-spacing:.5px;border-bottom:1px solid #f1f5f9;">
                Tus conversaciones
            </div>
            ${ordenados.map(a => `
                <div onclick="document.getElementById('kd-chat-picker-paciente').remove(); window.kdAbrirChatConCentro('${a.centroId}','${_kdChatEscapar(a.centroNombre).replace(/'/g, "\\'")}')"
                     style="padding:12px 14px;cursor:pointer;border-bottom:1px solid #f8fafc;display:flex;
                            justify-content:space-between;align-items:center;gap:8px;">
                    <span style="font-size:13px;font-weight:600;color:#0f172a;">🏥 ${_kdChatEscapar(a.centroNombre)}</span>
                    ${a.noLeidosPaciente > 0 ? `<span class="kd-chat-badge-mini" style="background:#ef4444;color:white;font-size:10px;font-weight:800;border-radius:20px;padding:1px 7px;flex-shrink:0;">${a.noLeidosPaciente}</span>` : ''}
                </div>`).join('')}
        </div>
    `);
};

/** Arranca (una sola vez por sesión) la escucha de todos los chats activos del paciente */
function _kdIniciarNotificacionesPaciente() {
    if (_kdChat.notifPacienteIniciado) return;
    _kdChat.notifPacienteIniciado = true;

    const uid = appState.currentUser.uid;
    const centrosEscuchados = {}; // centroId -> función para cancelar ese listener

    function escucharCentro(centroId) {
        if (centrosEscuchados[centroId]) return; // ya está escuchando este centro
        centrosEscuchados[centroId] = db.collection('centrosMedicos').doc(centroId)
            .collection('chats').doc(uid)
            .onSnapshot(doc => {
                if (!doc.exists) return;
                const data = doc.data();
                const info = {
                    centroId,
                    centroNombre: data.centroNombre || '—',
                    noLeidosPaciente: data.noLeidosPaciente || 0,
                    noLeidosSecretaria: data.noLeidosSecretaria || 0,
                    escribiendoSecretaria: !!data.escribiendoSecretaria,
                };
                const idx = _kdChat.chatsPacienteInfo.findIndex(a => a.centroId === centroId);
                if (idx >= 0) _kdChat.chatsPacienteInfo[idx] = info;
                else _kdChat.chatsPacienteInfo.push(info);
                _kdActualizarFabPaciente();

                // Si el chat de ESTE centro está abierto en pantalla ahora
                // mismo, refresca su indicador de "escribiendo…" en vivo.
                if (_kdChat.centroChatPaciente === centroId && document.getElementById('kd-chat-modal-paciente')) {
                    const statusEl = document.getElementById('kd-chat-status-paciente');
                    if (statusEl) {
                        statusEl.textContent = info.escribiendoSecretaria ? 'escribiendo…' : 'Secretaría';
                        statusEl.style.fontStyle = info.escribiendoSecretaria ? 'italic' : 'normal';
                    }
                }
            }, err => console.error('[kdChat] Error escuchando chat del paciente en centro', centroId, err));
    }

    // Escucha el propio perfil: cada vez que se agregue un centro nuevo a
    // chatsActivos (al enviar el primer mensaje a ese centro), empieza a
    // escucharlo también, sin necesidad de recargar la página.
    db.collection('users').doc(uid).onSnapshot(doc => {
        const activos = doc.data()?.chatsActivos || [];
        activos.forEach(escucharCentro);
    }, err => console.error('[kdChat] Error leyendo chatsActivos del paciente:', err));

    _kdInsertarFabPaciente();
}

// ══════════════════════════════════════════════════════════════════
//  5. REFRESH DE TOKEN + ARRANQUE DE NOTIFICACIONES — 1 vez por sesión
//     (ver sección 2.4 del documento de arquitectura)
// ══════════════════════════════════════════════════════════════════

(function _kdInicializarSesion() {
    let yaRefrescado = false;

    // appState.currentUserData tarda un poco en llegar (se carga aparte,
    // después del login) — reintentamos unas cuantas veces en vez de
    // asumir que ya está listo apenas dispara onAuthStateChanged.
    function esperarRolYActivarNotificaciones(intentosRestantes) {
        const rol = appState.currentUserData?.rol;
        if (!rol) {
            if (intentosRestantes > 0) setTimeout(() => esperarRolYActivarNotificaciones(intentosRestantes - 1), 400);
            return;
        }
        if (rol === 'paciente') _kdIniciarNotificacionesPaciente();
        // Para secretaria/medico/adminCentro, _kdIniciarBandejaGlobal ya se
        // dispara solo desde renderMobileNav en cuanto se pinta el menú.
    }

    firebase.auth().onAuthStateChanged(user => {
        if (user && !yaRefrescado) {
            yaRefrescado = true;
            user.getIdToken(true).catch(e =>
                console.warn('[kdChat] No se pudo refrescar el token de claims:', e.message)
            );
            esperarRolYActivarNotificaciones(15); // ~6 segundos de margen
        }
        if (!user) yaRefrescado = false; // permite repetir todo esto en el próximo login
    });
})();

// ══════════════════════════════════════════════════════════════════
//  6. LIMPIEZA — cerrar el listener de UNA conversación al salir de ella
//     (la bandeja global NO se cierra: debe seguir viva toda la sesión
//     para que el contador del menú se mantenga en tiempo real)
// ══════════════════════════════════════════════════════════════════

(function _kdPatchNavigateToLimpiarChat() {
    const _orig = window.navigateTo;
    window.navigateTo = function(view) {
        if (view !== 'mensajes' && appState.currentView === 'mensajes') {
            if (_kdChat.unsubMensajes) { _kdChat.unsubMensajes(); _kdChat.unsubMensajes = null; }
            _kdChat.chatActivoId = null;
        }
        _orig(view);
    };
})();

// ══════════════════════════════════════════════════════════════════
//  7. TECLADO MÓVIL — mantiene el campo de escritura pegado al teclado
//     (secretaria Y paciente), y lo regresa solo a su posición cuando
//     el teclado se oculta.
//
//     Por qué hace falta: "100vh"/"100dvh" en CSS le dicen al panel
//     que ocupe el alto de la pantalla, pero en varios navegadores
//     móviles ese valor NO se reduce cuando aparece el teclado — solo
//     la "visual viewport" (el área realmente visible) lo hace. Por
//     eso escuchamos window.visualViewport en vez de confiar solo en
//     el CSS: es el mismo mecanismo que usan WhatsApp Web, Telegram
//     Web, etc. para que el input "suba" pegado al teclado.
// ══════════════════════════════════════════════════════════════════
(function _kdInicializarTecladoMovil() {
    if (!window.visualViewport) return; // navegador muy viejo: se queda con el comportamiento normal del CSS

    const vv = window.visualViewport;

    function _kdEsMobile() { return window.innerWidth <= 640; }

    function _kdAjustarTecladoMovil() {
        if (!_kdEsMobile()) return;

        // Evita que la página quede desplazada por detrás del teclado
        if (window.scrollY !== 0) window.scrollTo(0, 0);

        // --- Chat de la secretaria/médico ---
        const panelSec = document.querySelector('#kd-chat-panel.kd-chat-panel-abierto');
        if (panelSec) {
            panelSec.style.height = vv.height + 'px';
            const msjSec = document.getElementById('kd-chat-mensajes');
            if (msjSec) msjSec.scrollTop = msjSec.scrollHeight;
        }

        // --- Chat del paciente (refuerzo: ya funcionaba con 100dvh; esto
        //     lo hace robusto también en navegadores sin buen soporte de dvh) ---
        const modalPac = document.getElementById('kd-chat-modal-paciente');
        if (modalPac) {
            const ventana = modalPac.querySelector('.kd-chat-ventana-paciente');
            if (ventana) ventana.style.height = vv.height + 'px';
            const msjPac = document.getElementById('kd-chat-mensajes-paciente');
            if (msjPac) msjPac.scrollTop = msjPac.scrollHeight;
        }
    }

    // Se dispara cada vez que el teclado sube, baja, o cambia de tamaño
    // (ej. sugerencias de texto de Android). Al ocultarse el teclado,
    // este mismo evento devuelve todo a su alto completo automáticamente.
    vv.addEventListener('resize', _kdAjustarTecladoMovil);
    vv.addEventListener('scroll', _kdAjustarTecladoMovil);

    // Al enfocar el input de cualquiera de los dos chats, nos aseguramos
    // de que quede visible apenas termine de subir el teclado (que tarda
    // ~150-300ms en desplegarse en iOS/Android).
    document.addEventListener('focusin', function(e) {
        if (!_kdEsMobile()) return;
        const id = e.target && e.target.id;
        if (id === 'kd-chat-input' || id === 'kd-chat-input-paciente') {
            setTimeout(() => {
                _kdAjustarTecladoMovil();
                e.target.scrollIntoView({ block: 'end', behavior: 'smooth' });
            }, 300);
        }
    });
})();
