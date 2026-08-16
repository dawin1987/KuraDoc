/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  KuraDoc — Módulo de Facturación                                 ║
 * ║  kd_facturacion_module.js  v1.0                                  ║
 * ║                                                                    ║
 * ║  Archivo independiente — cargar después de app.logic.js y de     ║
 * ║  fp_expediente_clinico.js. No modifica la lógica de esos          ║
 * ║  archivos: se conecta a través de los puntos de extensión         ║
 * ║  ya existentes (_fpAccion, _fpBodyContent, tabs de la ficha).     ║
 * ║                                                                    ║
 * ║  Colecciones de Firestore que utiliza:                            ║
 * ║    - facturas            (documentos de factura)                  ║
 * ║    - contadoresFactura   (contador atómico de numeración/centro)  ║
 * ║    - servicios           (catálogo de servicios/artículos)        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
(function () {

    // ── Estado privado del módulo ───────────────────────────────────
    let _facLineas          = [];   // líneas de la factura en edición
    let _facPacienteActual  = null;
    let _facCitaOrigen      = null;
    let _facGuardando       = false;
    let _facContadorLinea   = 0;

    let _facCatalogo        = null; // caché del catálogo de servicios
    let _facCatalogoPromise = null;

    function _facNuevoIdLinea() {
        return 'ln' + (++_facContadorLinea) + '_' + Date.now().toString(36);
    }


    // ══════════════════════════════════════════════════════════════
    //  CATÁLOGO DE SERVICIOS — carga perezosa y compartida
    // ══════════════════════════════════════════════════════════════
    function _facCargarCatalogo() {
        if (_facCatalogo !== null) return Promise.resolve(_facCatalogo);
        if (_facCatalogoPromise) return _facCatalogoPromise;

        _facCatalogoPromise = db.collection('servicios').get()
            .then(snap => {
                _facCatalogo = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                return _facCatalogo;
            })
            .catch(e => {
                console.error('[Facturación] Error cargando catálogo de servicios:', e);
                _facCatalogo = [];
                return _facCatalogo;
            })
            .finally(() => { _facCatalogoPromise = null; });

        return _facCatalogoPromise;
    }

    // Guarda en el catálogo (best-effort) los servicios nuevos que el
    // usuario escribió a mano y que no venían de una sugerencia existente.
    async function _facGuardarServiciosNuevos(detalles, centroMedicoId) {
        try {
            const nuevos = detalles.filter(d => !d.servicioId);
            for (const d of nuevos) {
                const yaExiste = (_facCatalogo || []).some(s =>
                    s.centroMedicoId === centroMedicoId &&
                    (s.nombre || '').toLowerCase() === d.nombre.toLowerCase()
                );
                if (yaExiste) continue;
                const ref = await db.collection('servicios').add({
                    nombre: d.nombre,
                    precio: d.precioUnitario,
                    centroMedicoId,
                    activo: true,
                    fechaCreacion: firebase.firestore.FieldValue.serverTimestamp()
                });
                if (_facCatalogo) {
                    _facCatalogo.push({ id: ref.id, nombre: d.nombre, precio: d.precioUnitario, centroMedicoId, activo: true });
                }
            }
        } catch (e) {
            console.warn('[Facturación] No se pudo actualizar el catálogo de servicios:', e);
        }
    }

    window._facBuscarCatalogo = function (lineaId, texto) {
        const cont = document.getElementById(`facSug${lineaId}`);
        if (!cont) return;
        const q = (texto || '').trim().toLowerCase();
        if (q.length < 2) { cont.style.display = 'none'; return; }

        const lista = _facCatalogo || [];
        const res = lista.filter(s => (s.nombre || '').toLowerCase().indexOf(q) > -1).slice(0, 6);
        if (!res.length) { cont.style.display = 'none'; return; }

        cont.style.display = 'block';
        cont.innerHTML = res.map(s => `
            <div onmousedown="_facSeleccionarCatalogo('${lineaId}','${s.id}')"
                 style="padding:8px 10px;font-size:12px;cursor:pointer;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;gap:8px;">
                <span>${s.nombre}</span>
                <span style="color:#16a34a;font-weight:700;white-space:nowrap;">RD$ ${(Number(s.precio) || 0).toLocaleString()}</span>
            </div>`).join('');
    };

    window._facSeleccionarCatalogo = function (lineaId, servicioId) {
        const s = (_facCatalogo || []).find(x => x.id === servicioId);
        const l = _facLineas.find(x => x.id === lineaId);
        if (!s || !l) return;
        l.nombre = s.nombre;
        l.precioUnitario = Number(s.precio) || 0;
        l.servicioId = s.id;
        _facRenderLineas();
        _facRecalcular();
    };


    // ══════════════════════════════════════════════════════════════
    //  NUMERACIÓN CONSECUTIVA — transacción atómica por centro
    // ══════════════════════════════════════════════════════════════
    async function _facSiguienteNumero(centroMedicoId) {
        const contadorRef = db.collection('contadoresFactura').doc(centroMedicoId);
        return await db.runTransaction(async (tx) => {
            const snap = await tx.get(contadorRef);
            const actual = snap.exists ? (Number(snap.data().ultimo) || 0) : 0;
            const siguiente = actual + 1;
            tx.set(contadorRef, {
                ultimo: siguiente,
                centroMedicoId,
                ultimaActualizacion: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            return `FAC-${String(siguiente).padStart(6, '0')}`;
        });
    }


    // ══════════════════════════════════════════════════════════════
    //  MODAL — NUEVA FACTURA
    // ══════════════════════════════════════════════════════════════

    // Punto de entrada. citaId es opcional: si viene de una cita puntual,
    // precarga una línea con el costo de esa cita (sin tocar el flujo
    // del recibo rápido de la Ficha de Recepción, que sigue siendo
    // independiente).
    window.abrirModalFacturar = function (pacienteId, citaId) {
        // Si la ficha del paciente está abierta, bajamos su z-index para
        // que este modal quede visible por encima (mismo mecanismo que
        // usan 'editar', 'imprimir', 'record', etc.)
        if (typeof window._fpBajar === 'function') window._fpBajar();

        const p = window._uGet(pacienteId);
        if (!p) { window._mostrarToast('No se encontró el paciente.', 'error'); return; }

        const user = appState.currentUserData;
        let medicosDisponibles = [];

        if (user.rol === 'medico') {
            medicosDisponibles = appState.users.filter(u => (u.uid || u.id) === (user.uid || user.id));
        } else if (user.rol === 'secretaria') {
            const asignados = Array.isArray(user.medicoAsignadoId)
                ? user.medicoAsignadoId
                : [user.medicoAsignadoId].filter(Boolean);
            medicosDisponibles = appState.users.filter(u => u.rol === 'medico' && asignados.includes(u.uid || u.id));
        } else {
            medicosDisponibles = appState.users.filter(u => u.rol === 'medico');
        }

        if (!medicosDisponibles.length) {
            window._mostrarToast('No hay médicos disponibles para facturar.', 'error');
            return;
        }

        let medicoPreseleccionado = medicosDisponibles[0];
        let lineaInicial = null;

        if (citaId) {
            const cita = appState.citas.find(c => c.id === citaId);
            if (cita) {
                const medCita = medicosDisponibles.find(m => (m.uid || m.id) === cita.medicoId);
                if (medCita) medicoPreseleccionado = medCita;
                const costo = Number(cita.costoFinal || cita.costoBase || 0);
                if (costo > 0) {
                    lineaInicial = {
                        id: _facNuevoIdLinea(),
                        nombre: cita.tipoCitaLabel || cita.tipoCita || 'Consulta médica',
                        cantidad: 1,
                        precioUnitario: costo,
                        descuento: 0
                    };
                }
            }
        }

        _facLineas = lineaInicial
            ? [lineaInicial]
            : [{ id: _facNuevoIdLinea(), nombre: '', cantidad: 1, precioUnitario: 0, descuento: 0 }];
        _facPacienteActual = p;
        _facCitaOrigen = citaId || null;
        _facGuardando = false;

        document.getElementById('modalContainer').innerHTML = _facRenderModal(p, medicosDisponibles, medicoPreseleccionado);
        _facRenderLineas();
        _facRecalcular();
        _facCargarCatalogo();
    };

    function _facRenderModal(p, medicos, medicoSel) {
        const centro = (appState.centrosMedicos || []).find(c => c.id === medicoSel.centroMedicoId);
        return `
        <div class="modal-overlay">
            <div class="modal" onclick="event.stopPropagation()" style="max-width:640px;max-height:92vh;overflow-y:auto;border-radius:12px;">
                <div class="modal-header" style="border:none;padding:22px 24px 8px;">
                    <h2 class="modal-title">🧾 Nueva Factura</h2>
                    <button class="modal-close" onclick="closeModal()">×</button>
                </div>
                <div class="modal-body" style="padding:6px 24px 24px;">

                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin-bottom:12px;">
                        <div style="font-size:15px;font-weight:700;color:#0f172a;">${p.nombre || '—'}</div>
                        <div style="font-size:11.5px;color:#64748b;margin-top:2px;">
                            ${p.cedula ? 'Cédula: ' + p.cedula + ' &bull; ' : ''}${p.telefono || ''}
                        </div>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                        <div class="form-group">
                            <label class="form-label">Médico</label>
                            ${medicos.length > 1 ? `
                            <select class="form-input" id="facMedicoId" onchange="_facCambiarMedico()">
                                ${medicos.map(m => `<option value="${m.uid || m.id}" ${(m.uid || m.id) === (medicoSel.uid || medicoSel.id) ? 'selected' : ''}>${m.nombre}</option>`).join('')}
                            </select>` : `
                            <input class="form-input" value="${medicoSel.nombre || ''}" disabled>
                            <input type="hidden" id="facMedicoId" value="${medicoSel.uid || medicoSel.id}">`}
                        </div>
                        <div class="form-group">
                            <label class="form-label">Centro</label>
                            <input class="form-input" id="facCentroNombre" value="${centro?.nombre || '—'}" disabled>
                        </div>
                    </div>

                    <div style="margin-bottom:8px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                            <label class="form-label" style="margin:0;">Servicios / Artículos</label>
                            <button type="button" onclick="_facAgregarLinea()"
                                style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:5px 12px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;">
                                + Agregar
                            </button>
                        </div>
                        <div id="facLineasWrap"></div>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                        <div class="form-group">
                            <label class="form-label">Descuento adicional (RD$)</label>
                            <input type="number" class="form-input" id="facDescuentoGlobal" value="0" min="0" oninput="_facRecalcular()">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Impuestos (RD$)</label>
                            <input type="number" class="form-input" id="facImpuestos" value="0" min="0" oninput="_facRecalcular()">
                        </div>
                    </div>

                    <div style="background:#0f172a;color:#fff;border-radius:12px;padding:12px 16px;margin-bottom:12px;">
                        <div style="display:flex;justify-content:space-between;font-size:11px;opacity:.75;margin-bottom:2px;"><span>Subtotal</span><span id="facSubtotalTxt">RD$ 0</span></div>
                        <div style="display:flex;justify-content:space-between;font-size:11px;opacity:.75;margin-bottom:2px;"><span>Descuento</span><span id="facDescuentoTxt">RD$ 0</span></div>
                        <div style="display:flex;justify-content:space-between;font-size:11px;opacity:.75;margin-bottom:8px;"><span>Impuestos</span><span id="facImpuestosTxt">RD$ 0</span></div>
                        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,.15);padding-top:8px;">
                            <span style="font-size:12px;font-weight:700;text-transform:uppercase;">Total</span>
                            <span id="facTotalTxt" style="font-size:24px;font-weight:900;color:#4ade80;">RD$ 0</span>
                        </div>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px;">
                        <div class="form-group">
                            <label class="form-label">Método de pago</label>
                            <select class="form-input" id="facMetodoPago">
                                <option value="Efectivo">Efectivo</option>
                                <option value="Tarjeta">Tarjeta</option>
                                <option value="Transferencia">Transferencia</option>
                                <option value="Cheque">Cheque</option>
                                <option value="Seguro médico">Seguro médico</option>
                                <option value="Otro">Otro</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Monto pagado (RD$)</label>
                            <input type="number" class="form-input" id="facMontoPagado" value="0" min="0" oninput="_facRecalcular()">
                        </div>
                    </div>
                    <div id="facSaldoInfo" style="font-size:11.5px;color:#64748b;margin-bottom:12px;"></div>

                    <div class="form-group" style="margin-bottom:14px;">
                        <label class="form-label">Observaciones (opcional)</label>
                        <textarea class="form-input" id="facObservacion" rows="2" placeholder="Notas sobre esta factura..."></textarea>
                    </div>

                    <button type="button" id="facBtnGuardar" onclick="_facGuardarFactura()"
                        style="width:100%;padding:13px;background:linear-gradient(135deg,#0f172a,#334155);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">
                        💾 Guardar Factura
                    </button>
                </div>
            </div>
        </div>`;
    }

    window._facCambiarMedico = function () {
        const medicoId = document.getElementById('facMedicoId')?.value;
        const medico = window._uGet(medicoId);
        const centro = (appState.centrosMedicos || []).find(c => c.id === medico?.centroMedicoId);
        const centroInput = document.getElementById('facCentroNombre');
        if (centroInput) centroInput.value = centro?.nombre || '—';
    };


    // ── Líneas de servicio ──────────────────────────────────────────
    function _facRenderLineas() {
        const wrap = document.getElementById('facLineasWrap');
        if (!wrap) return;
        wrap.innerHTML = _facLineas.map(l => {
            const sub = (Number(l.cantidad) || 0) * (Number(l.precioUnitario) || 0) - (Number(l.descuento) || 0);
            return `
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px;margin-bottom:8px;position:relative;">
                <div style="display:flex;gap:8px;margin-bottom:8px;position:relative;">
                    <input type="text" class="form-input" placeholder="Nombre del servicio o artículo"
                        value="${(l.nombre || '').replace(/"/g, '&quot;')}"
                        oninput="_facActualizarLinea('${l.id}','nombre',this.value);_facBuscarCatalogo('${l.id}',this.value)"
                        onblur="setTimeout(()=>{var d=document.getElementById('facSug${l.id}');if(d)d.style.display='none';},200)"
                        style="flex:1;font-size:12.5px;padding:8px 10px;">
                    <button type="button" onclick="_facEliminarLinea('${l.id}')" title="Eliminar servicio"
                        style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;border-radius:8px;width:34px;cursor:pointer;font-size:13px;">🗑</button>
                </div>
                <div id="facSug${l.id}" style="display:none;position:absolute;left:10px;right:44px;top:44px;z-index:20;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.1);max-height:160px;overflow-y:auto;"></div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;">
                    <div>
                        <label style="font-size:9px;color:#94a3b8;font-weight:700;text-transform:uppercase;">Cant.</label>
                        <input type="number" min="1" value="${l.cantidad}" class="form-input" style="font-size:12px;padding:6px 8px;"
                            oninput="_facActualizarLinea('${l.id}','cantidad',this.value)">
                    </div>
                    <div>
                        <label style="font-size:9px;color:#94a3b8;font-weight:700;text-transform:uppercase;">Precio</label>
                        <input type="number" min="0" value="${l.precioUnitario}" class="form-input" style="font-size:12px;padding:6px 8px;"
                            oninput="_facActualizarLinea('${l.id}','precioUnitario',this.value)">
                    </div>
                    <div>
                        <label style="font-size:9px;color:#94a3b8;font-weight:700;text-transform:uppercase;">Desc.</label>
                        <input type="number" min="0" value="${l.descuento}" class="form-input" style="font-size:12px;padding:6px 8px;"
                            oninput="_facActualizarLinea('${l.id}','descuento',this.value)">
                    </div>
                    <div>
                        <label style="font-size:9px;color:#94a3b8;font-weight:700;text-transform:uppercase;">Total</label>
                        <div id="facLineaTotal${l.id}" style="font-size:13px;font-weight:700;color:#166534;padding:7px 0;">RD$ ${sub.toLocaleString()}</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    window._facAgregarLinea = function () {
        _facLineas.push({ id: _facNuevoIdLinea(), nombre: '', cantidad: 1, precioUnitario: 0, descuento: 0 });
        _facRenderLineas();
        _facRecalcular();
    };

    window._facEliminarLinea = function (id) {
        if (_facLineas.length <= 1) {
            window._mostrarToast('Debe haber al menos un servicio en la factura.', 'error');
            return;
        }
        _facLineas = _facLineas.filter(x => x.id !== id);
        _facRenderLineas();
        _facRecalcular();
    };

    // Actualiza solo el total de la línea afectada (sin re-renderizar todo
    // el bloque) para no perder el foco mientras la secretaria escribe.
    window._facActualizarLinea = function (id, campo, valor) {
        const l = _facLineas.find(x => x.id === id);
        if (!l) return;
        l[campo] = (campo === 'nombre') ? valor : (parseFloat(valor) || 0);

        if (campo !== 'nombre') {
            const totalEl = document.getElementById(`facLineaTotal${id}`);
            if (totalEl) {
                const sub = (Number(l.cantidad) || 0) * (Number(l.precioUnitario) || 0) - (Number(l.descuento) || 0);
                totalEl.textContent = `RD$ ${sub.toLocaleString()}`;
            }
        }
        _facRecalcular();
    };

    window._facRecalcular = function () {
        const subtotal = _facLineas.reduce((s, l) =>
            s + (Number(l.cantidad) || 0) * (Number(l.precioUnitario) || 0) - (Number(l.descuento) || 0), 0);
        const descGlobal = parseFloat(document.getElementById('facDescuentoGlobal')?.value) || 0;
        const impuestos = parseFloat(document.getElementById('facImpuestos')?.value) || 0;
        const total = Math.max(0, subtotal - descGlobal + impuestos);
        const pagado = parseFloat(document.getElementById('facMontoPagado')?.value) || 0;
        const saldo = Math.max(0, total - pagado);

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('facSubtotalTxt', `RD$ ${subtotal.toLocaleString()}`);
        set('facDescuentoTxt', `RD$ ${descGlobal.toLocaleString()}`);
        set('facImpuestosTxt', `RD$ ${impuestos.toLocaleString()}`);
        set('facTotalTxt', `RD$ ${total.toLocaleString()}`);

        const info = document.getElementById('facSaldoInfo');
        if (info) {
            if (pagado <= 0) {
                info.innerHTML = `<span style="color:#92400e;">⚠️ Sin pago registrado — la factura quedará como <b>Pendiente</b>.</span>`;
            } else if (pagado < total) {
                info.innerHTML = `<span style="color:#1d4ed8;">Pago parcial — saldo pendiente: <b>RD$ ${saldo.toLocaleString()}</b>. Estado: <b>Parcial</b>.</span>`;
            } else {
                info.innerHTML = `<span style="color:#166534;">✔ Cubre el total. Estado: <b>Pagada</b>.</span>`;
            }
        }
    };


    // ── Guardado ──────────────────────────────────────────────────
    window._facGuardarFactura = async function () {
        if (_facGuardando) return; // evita doble clic / doble envío
        if (!_facPacienteActual) { window._mostrarToast('No hay paciente seleccionado.', 'error'); return; }

        const medicoId = document.getElementById('facMedicoId')?.value;
        const medico = window._uGet(medicoId);
        if (!medico) { window._mostrarToast('Debe seleccionar un médico.', 'error'); return; }

        const centroMedicoId = medico.centroMedicoId;
        if (!centroMedicoId) { window._mostrarToast('El médico no tiene un centro médico asignado.', 'error'); return; }

        const lineasValidas = _facLineas.filter(l => (l.nombre || '').trim() !== '');
        if (!lineasValidas.length) { window._mostrarToast('Agregue al menos un servicio con nombre.', 'error'); return; }

        for (const l of lineasValidas) {
            if ((Number(l.cantidad) || 0) <= 0) { window._mostrarToast(`Cantidad inválida en "${l.nombre}".`, 'error'); return; }
            if ((Number(l.precioUnitario) || 0) < 0) { window._mostrarToast(`Precio inválido en "${l.nombre}".`, 'error'); return; }
            if ((Number(l.descuento) || 0) < 0) { window._mostrarToast(`Descuento inválido en "${l.nombre}".`, 'error'); return; }
        }

        // Recalculamos en el cliente por seguridad, sin confiar únicamente
        // en lo que ya estaba pintado en pantalla.
        const detalles = lineasValidas.map(l => {
            const cantidad = Number(l.cantidad) || 0;
            const precioUnitario = Number(l.precioUnitario) || 0;
            const descuento = Number(l.descuento) || 0;
            const subtotalLinea = Math.max(0, cantidad * precioUnitario - descuento);
            return {
                servicioId: l.servicioId || null,
                nombre: l.nombre.trim(),
                cantidad, precioUnitario, descuento,
                subtotal: subtotalLinea
            };
        });

        const subtotal = detalles.reduce((s, d) => s + d.subtotal, 0);
        const descuentoGlobal = parseFloat(document.getElementById('facDescuentoGlobal')?.value) || 0;
        const impuestos = parseFloat(document.getElementById('facImpuestos')?.value) || 0;
        const total = Math.max(0, subtotal - descuentoGlobal + impuestos);
        const metodoPago = document.getElementById('facMetodoPago')?.value || 'Efectivo';
        const montoPagado = Math.min(total, Math.max(0, parseFloat(document.getElementById('facMontoPagado')?.value) || 0));
        const saldoPendiente = Math.max(0, total - montoPagado);
        const observacion = (document.getElementById('facObservacion')?.value || '').trim();
        const estado = montoPagado <= 0 ? 'pendiente' : (montoPagado < total ? 'parcial' : 'pagada');

        _facGuardando = true;
        const btn = document.getElementById('facBtnGuardar');
        if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = 'Guardando...'; }

        try {
            const numeroFactura = await _facSiguienteNumero(centroMedicoId);
            const user = appState.currentUserData;

            const docRef = await db.collection('facturas').add({
                numeroFactura,
                centroMedicoId,
                pacienteId: _facPacienteActual.uid || _facPacienteActual.id,
                medicoId: medico.uid || medico.id,
                creadoPor: user.uid || user.id,
                citaId: _facCitaOrigen || null,
                detalles,
                subtotal, descuento: descuentoGlobal, impuestos, total,
                metodoPago, montoPagado, saldoPendiente, estado,
                observacion,
                rnc: '', ncf: '', tipoComprobante: '',           // reservados p/ facturación fiscal futura
                anulada: false, fechaAnulacion: null, motivoAnulacion: null, anuladaPor: null,
                fechaCreacion: firebase.firestore.FieldValue.serverTimestamp(),
                ultimaActualizacion: firebase.firestore.FieldValue.serverTimestamp()
            });

            _facGuardarServiciosNuevos(detalles, centroMedicoId); // best-effort, no bloquea

            window._mostrarToast(`✅ Factura ${numeroFactura} creada correctamente.`, 'success');
            closeModal();

            if (typeof window._facCargarFacturasPaciente === 'function') {
                window._facCargarFacturasPaciente(_facPacienteActual.uid || _facPacienteActual.id);
            }

            setTimeout(() => window._facImprimirFactura(docRef.id), 400);

        } catch (e) {
            console.error('[Facturación] Error guardando factura:', e);
            window._mostrarToast('❌ No se pudo guardar la factura: ' + e.message, 'error');
        } finally {
            _facGuardando = false;
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '💾 Guardar Factura'; }
        }
    };


    // ══════════════════════════════════════════════════════════════
    //  HISTORIAL — pestaña "Facturas" dentro de la Ficha del Paciente
    // ══════════════════════════════════════════════════════════════
    window._fpTabFacturas = function (p) {
        const uid = p.uid || p.id;
        setTimeout(() => window._facCargarFacturasPaciente(uid), 50);
        return `
        <div id="fac-historial-${uid}">
            <div style="text-align:center;padding:30px;color:#94a3b8;font-size:12px;">Cargando facturas...</div>
        </div>`;
    };

    window._facCargarFacturasPaciente = async function (pacienteId) {
        const cont = document.getElementById(`fac-historial-${pacienteId}`);
        if (!cont) return;

        try {
            const snap = await db.collection('facturas')
                .where('pacienteId', '==', pacienteId)
                .orderBy('fechaCreacion', 'desc')
                .limit(30).get();
            const facturas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

            if (!facturas.length) {
                cont.innerHTML = `
                <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
                    <button onclick="window.abrirModalFacturar('${pacienteId}')"
                        style="background:#0f172a;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:11.5px;font-weight:700;cursor:pointer;">
                        + Nueva Factura
                    </button>
                </div>
                <div style="text-align:center;padding:34px 20px;color:#94a3b8;">
                    <div style="font-size:30px;margin-bottom:8px;">🧾</div>
                    <p style="font-size:13px;font-weight:600;">Este paciente aún no tiene facturas</p>
                </div>`;
                return;
            }

            const estadoCfg = {
                pagada:    { bg: '#dcfce7', color: '#166534', label: 'PAGADA' },
                parcial:   { bg: '#dbeafe', color: '#1d4ed8', label: 'PARCIAL' },
                pendiente: { bg: '#fef3c7', color: '#92400e', label: 'PENDIENTE' },
                anulada:   { bg: '#fee2e2', color: '#991b1b', label: 'ANULADA' },
            };

            cont.innerHTML = `
            <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
                <button onclick="window.abrirModalFacturar('${pacienteId}')"
                    style="background:#0f172a;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:11.5px;font-weight:700;cursor:pointer;">
                    + Nueva Factura
                </button>
            </div>
            ${facturas.map(f => {
                const cfg = estadoCfg[f.anulada ? 'anulada' : (f.estado || 'pendiente')] || estadoCfg.pendiente;
                const fecha = f.fechaCreacion?.seconds
                    ? new Date(f.fechaCreacion.seconds * 1000).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' })
                    : '—';
                return `
                <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
                    <div>
                        <div style="font-size:13px;font-weight:700;color:#0f172a;font-family:'Courier New',monospace;">${f.numeroFactura}</div>
                        <div style="font-size:11px;color:#64748b;margin-top:2px;">${fecha} &bull; RD$ ${(Number(f.total) || 0).toLocaleString()}</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="background:${cfg.bg};color:${cfg.color};padding:3px 10px;border-radius:20px;font-size:9.5px;font-weight:800;">${cfg.label}</span>
                        <button onclick="window._facVerFactura('${f.id}')" title="Ver factura"
                            style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;width:30px;height:30px;cursor:pointer;">👁️</button>
                    </div>
                </div>`;
            }).join('')}`;

        } catch (err) {
            console.error('[Facturación] Error cargando historial:', err);
            cont.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;font-size:12px;">⚠️ Error al cargar las facturas: ${err.message}</div>`;
        }
    };


    // ══════════════════════════════════════════════════════════════
    //  VER FACTURA — detalle + acciones (imprimir / anular)
    // ══════════════════════════════════════════════════════════════
    window._facVerFactura = async function (facturaId) {
        if (typeof window._fpBajar === 'function') window._fpBajar();

        let f;
        try {
            const doc = await db.collection('facturas').doc(facturaId).get();
            if (!doc.exists) { window._mostrarToast('Factura no encontrada.', 'error'); return; }
            f = { id: doc.id, ...doc.data() };
        } catch (e) {
            window._mostrarToast('Error cargando la factura: ' + e.message, 'error');
            return;
        }

        const paciente = window._uGet(f.pacienteId);
        const medico = window._uGet(f.medicoId);
        const fecha = f.fechaCreacion?.seconds
            ? new Date(f.fechaCreacion.seconds * 1000).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' })
            : '—';

        document.getElementById('modalContainer').innerHTML = `
        <div class="modal-overlay">
            <div class="modal" onclick="event.stopPropagation()" style="max-width:520px;border-radius:12px;max-height:88vh;overflow-y:auto;">
                <div class="modal-header" style="border:none;padding:22px 24px 8px;">
                    <h2 class="modal-title">${f.numeroFactura}</h2>
                    <button class="modal-close" onclick="closeModal()">×</button>
                </div>
                <div class="modal-body" style="padding:6px 24px 24px;">
                    ${f.anulada ? `<div style="background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;margin-bottom:12px;">🚫 FACTURA ANULADA${f.motivoAnulacion ? ' — ' + f.motivoAnulacion : ''}</div>` : ''}
                    <div style="font-size:12px;color:#64748b;margin-bottom:10px;">${fecha} &bull; ${paciente?.nombre || '—'} &bull; Dr. ${medico?.nombre || '—'}</div>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px;">
                        <thead><tr style="background:#f1f5f9;"><th style="text-align:left;padding:6px 8px;">Servicio</th><th style="text-align:right;padding:6px 8px;">Total</th></tr></thead>
                        <tbody>
                            ${(f.detalles || []).map(d => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;">${d.nombre}${d.cantidad > 1 ? ' x' + d.cantidad : ''}</td><td style="text-align:right;padding:6px 8px;border-bottom:1px solid #f1f5f9;">RD$ ${(Number(d.subtotal) || 0).toLocaleString()}</td></tr>`).join('')}
                        </tbody>
                    </table>
                    <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:800;background:#0f172a;color:#fff;padding:10px 14px;border-radius:8px;margin-bottom:6px;">
                        <span>TOTAL</span><span style="color:#4ade80;">RD$ ${(Number(f.total) || 0).toLocaleString()}</span>
                    </div>
                    <div style="font-size:11px;color:#64748b;margin-bottom:14px;">
                        Pagado: RD$ ${(Number(f.montoPagado) || 0).toLocaleString()} &bull; Saldo: RD$ ${(Number(f.saldoPendiente) || 0).toLocaleString()} &bull; ${f.metodoPago || '—'}
                    </div>
                    <div style="display:grid;grid-template-columns:${f.anulada ? '1fr' : '1fr 1fr'};gap:8px;">
                        <button onclick="window._facImprimirFactura('${f.id}')" style="background:#0f172a;color:#fff;border:none;padding:10px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">🖨️ Imprimir</button>
                        ${!f.anulada ? `<button onclick="window._facAnularFactura('${f.id}')" style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;padding:10px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">🚫 Anular</button>` : ''}
                    </div>
                </div>
            </div>
        </div>`;
    };


    // ══════════════════════════════════════════════════════════════
    //  ANULAR — nunca se borra físicamente, se marca como anulada
    // ══════════════════════════════════════════════════════════════
    window._facAnularFactura = async function (facturaId) {
        const motivo = prompt('Indique el motivo de anulación de esta factura:');
        if (motivo === null) return; // el usuario canceló
        if (!motivo.trim()) { window._mostrarToast('Debe indicar un motivo para anular.', 'error'); return; }
        if (!confirm('¿Confirma que desea anular esta factura?\n\nLa factura no se eliminará, quedará marcada como ANULADA en el historial.')) return;

        try {
            const user = appState.currentUserData;
            await db.collection('facturas').doc(facturaId).update({
                anulada: true,
                estado: 'anulada',
                fechaAnulacion: firebase.firestore.FieldValue.serverTimestamp(),
                motivoAnulacion: motivo.trim(),
                anuladaPor: user.uid || user.id,
                ultimaActualizacion: firebase.firestore.FieldValue.serverTimestamp()
            });
            window._mostrarToast('Factura anulada correctamente.', 'success');
            closeModal();
        } catch (e) {
            console.error('[Facturación] Error anulando factura:', e);
            window._mostrarToast('No se pudo anular la factura: ' + e.message, 'error');
        }
    };


    // ══════════════════════════════════════════════════════════════
    //  IMPRESIÓN — ventana media carta (5.5 x 8.5 in), consistente
    //  con el resto del sistema de impresión de KuraDoc.
    // ══════════════════════════════════════════════════════════════
    window._facImprimirFactura = async function (facturaId) {
        let f;
        try {
            const doc = await db.collection('facturas').doc(facturaId).get();
            if (!doc.exists) { window._mostrarToast('Factura no encontrada.', 'error'); return; }
            f = { id: doc.id, ...doc.data() };
        } catch (e) {
            window._mostrarToast('Error: ' + e.message, 'error');
            return;
        }

        const paciente = window._uGet(f.pacienteId);
        const medico = window._uGet(f.medicoId);
        const emisor = window._uGet(f.creadoPor) || appState.currentUserData;
        const centro = (appState.centrosMedicos || []).find(c => c.id === f.centroMedicoId);

        const fechaDoc = f.fechaCreacion?.seconds ? new Date(f.fechaCreacion.seconds * 1000) : new Date();
        const fechaEmision = fechaDoc.toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
        const horaEmision = fechaDoc.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });

        const estadoCfg = {
            pagada:    { bg: '#dcfce7', color: '#166534', label: '✔ PAGADA' },
            parcial:   { bg: '#dbeafe', color: '#1d4ed8', label: '◐ PAGO PARCIAL' },
            pendiente: { bg: '#fef3c7', color: '#92400e', label: '⏳ PENDIENTE DE PAGO' },
        };
        const cfg = f.anulada ? { bg: '#fee2e2', color: '#991b1b', label: '🚫 ANULADA' } : (estadoCfg[f.estado] || estadoCfg.pendiente);

        const filas = (f.detalles || []).map(d => `
            <tr>
                <td>${d.nombre}</td>
                <td class="right">${d.cantidad}</td>
                <td class="right">RD$ ${(Number(d.precioUnitario) || 0).toLocaleString()}</td>
                <td class="right">${d.descuento > 0 ? '− RD$ ' + Number(d.descuento).toLocaleString() : '—'}</td>
                <td class="right">RD$ ${(Number(d.subtotal) || 0).toLocaleString()}</td>
            </tr>`).join('');

        const contenidoHTML = `
<style>
#facPrintOverlay, #facPrintOverlay * { margin:0; padding:0; box-sizing:border-box; }
#facPrintOverlay {
    position:fixed; inset:0; z-index:5000;
    overflow-y:auto; -webkit-overflow-scrolling:touch;
    font-family:'Segoe UI', Arial, sans-serif; color:#1e293b; background:#f1f5f9; font-size:11.5px;
}
@media print {
    body > *:not(#facPrintOverlay) { display:none !important; }
    #facPrintOverlay { position:static !important; background:#fff !important; overflow:visible !important; }
    #facPrintOverlay .no-print { display:none !important; }
    #facPrintOverlay .fac-sheet { box-shadow:none !important; margin:0 !important; }
    @page { size: 139.7mm 215.9mm; margin: 10mm; }
}
#facPrintOverlay .fac-sheet { width:139.7mm; min-height:215.9mm; background:#fff; margin:14px auto; padding:9mm 8mm; box-shadow:0 2px 10px rgba(0,0,0,.12); position:relative; }
#facPrintOverlay .fac-header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2.5px solid #0f172a; padding-bottom:8px; margin-bottom:10px; }
#facPrintOverlay .fac-logo { font-size:16px; font-weight:900; color:#0f172a; }
#facPrintOverlay .fac-logo span { color:#2563eb; }
#facPrintOverlay .fac-centro { font-size:8.5px; color:#64748b; margin-top:2px; line-height:1.4; max-width:150px; }
#facPrintOverlay .fac-doc { text-align:right; }
#facPrintOverlay .fac-doc .tag { display:inline-block; background:#0f172a; color:#fff; font-size:9.5px; font-weight:800; padding:3px 9px; border-radius:4px; margin-bottom:4px; }
#facPrintOverlay .fac-doc .codigo { font-size:13px; font-weight:900; color:#0f172a; font-family:'Courier New',monospace; }
#facPrintOverlay .fac-doc .fecha { font-size:8.5px; color:#64748b; margin-top:2px; }
#facPrintOverlay .fac-estado { text-align:center; margin-bottom:10px; }
#facPrintOverlay .fac-estado span { display:inline-block; background:${cfg.bg}; color:${cfg.color}; border:1px solid ${cfg.color}55; font-size:10px; font-weight:800; padding:3px 14px; border-radius:20px; }
#facPrintOverlay .fac-box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; margin-bottom:8px; }
#facPrintOverlay .fac-box h4 { font-size:8.5px; text-transform:uppercase; color:#94a3b8; font-weight:800; margin-bottom:4px; }
#facPrintOverlay .fac-box .nombre { font-size:12.5px; font-weight:700; color:#0f172a; }
#facPrintOverlay .fac-row { display:flex; justify-content:space-between; font-size:9.5px; color:#475569; margin-top:2px; }
#facPrintOverlay .fac-row b { color:#1e293b; }
#facPrintOverlay table.fac-tabla { width:100%; border-collapse:collapse; margin-bottom:8px; font-size:9.5px; }
#facPrintOverlay table.fac-tabla thead th { text-align:left; font-size:8px; text-transform:uppercase; color:#fff; background:#0f172a; padding:5px 6px; }
#facPrintOverlay table.fac-tabla thead th.right, #facPrintOverlay table.fac-tabla td.right { text-align:right; }
#facPrintOverlay table.fac-tabla tbody td { padding:5px 6px; border-bottom:1px solid #e2e8f0; }
#facPrintOverlay .fac-resumen .r { display:flex; justify-content:space-between; font-size:10px; color:#475569; padding:2px 2px; }
#facPrintOverlay .fac-total { background:#0f172a; color:#fff; border-radius:8px; padding:10px 12px; display:flex; justify-content:space-between; align-items:center; margin:8px 0; }
#facPrintOverlay .fac-total .lbl { font-size:9.5px; text-transform:uppercase; opacity:.75; }
#facPrintOverlay .fac-total .val { font-size:18px; font-weight:900; color:#4ade80; }
#facPrintOverlay .fac-pago { display:flex; justify-content:space-between; font-size:9.5px; color:#475569; margin-bottom:12px; }
#facPrintOverlay .fac-firma { margin-top:20px; display:flex; justify-content:space-between; gap:14px; }
#facPrintOverlay .fac-firma div { flex:1; text-align:center; border-top:1px solid #94a3b8; padding-top:4px; font-size:8.5px; color:#64748b; }
#facPrintOverlay .fac-footer { position:absolute; bottom:8mm; left:8mm; right:8mm; text-align:center; font-size:7.5px; color:#94a3b8; border-top:1px dashed #e2e8f0; padding-top:6px; line-height:1.5; }
#facPrintOverlay .print-btn { display:flex; gap:8px; justify-content:center; padding:14px 12px 6px; flex-wrap:wrap; position:sticky; top:0; background:#f1f5f9; z-index:2; }
#facPrintOverlay .print-btn button { padding:9px 16px; border:none; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; }
#facPrintOverlay .print-btn button:disabled { opacity:.6; cursor:wait; }
#facPrintOverlay .btn-print { background:#0f172a; color:#fff; }
#facPrintOverlay .btn-share { background:linear-gradient(135deg,#16a34a,#15803d); color:#fff; }
#facPrintOverlay .btn-close { background:#e2e8f0; color:#1e293b; }
</style>
<div class="print-btn no-print">
    <button class="btn-print" onclick="window.print()">🖨️ Imprimir</button>
    <button class="btn-share" id="btnCompartirFac" onclick="_kdCompartirFactura(this)">📤 Compartir / Descargar PDF</button>
    <button class="btn-close" onclick="document.getElementById('facPrintOverlay').remove()">✕ Cerrar</button>
</div>
<div class="fac-sheet">
    <div class="fac-header">
        <div>
            <div class="fac-logo">Kura<span>Doc</span></div>
            <div class="fac-centro">${centro?.nombre || 'KuraDoc'}${centro?.direccion ? '<br>' + centro.direccion : ''}${centro?.telefono ? '<br>Tel: ' + centro.telefono : ''}</div>
        </div>
        <div class="fac-doc">
            <div class="tag">FACTURA</div>
            <div class="codigo">${f.numeroFactura}</div>
            <div class="fecha">${fechaEmision} · ${horaEmision}</div>
        </div>
    </div>
    <div class="fac-estado"><span>${cfg.label}</span></div>
    <div class="fac-box">
        <h4>Paciente</h4>
        <div class="nombre">${paciente?.nombre || '—'}</div>
        <div class="fac-row"><span>Cédula</span><b>${paciente?.cedula || '—'}</b></div>
        <div class="fac-row"><span>Teléfono</span><b>${paciente?.telefono || '—'}</b></div>
    </div>
    <div class="fac-box">
        <h4>Atendido por</h4>
        <div class="fac-row"><span>Médico</span><b>${medico?.nombre || '—'}</b></div>
        <div class="fac-row"><span>Especialidad</span><b>${medico?.especialidad || '—'}</b></div>
    </div>
    <table class="fac-tabla">
        <thead><tr><th>Servicio</th><th class="right">Cant.</th><th class="right">Precio</th><th class="right">Desc.</th><th class="right">Total</th></tr></thead>
        <tbody>${filas}</tbody>
    </table>
    <div class="fac-resumen">
        <div class="r"><span>Subtotal</span><b>RD$ ${(Number(f.subtotal) || 0).toLocaleString()}</b></div>
        ${Number(f.descuento) > 0 ? `<div class="r"><span>Descuento</span><b>− RD$ ${Number(f.descuento).toLocaleString()}</b></div>` : ''}
        ${Number(f.impuestos) > 0 ? `<div class="r"><span>Impuestos</span><b>RD$ ${Number(f.impuestos).toLocaleString()}</b></div>` : ''}
    </div>
    <div class="fac-total"><span class="lbl">Total</span><span class="val">RD$ ${(Number(f.total) || 0).toLocaleString()}</span></div>
    <div class="fac-pago">
        <span>Pagado: <b>RD$ ${(Number(f.montoPagado) || 0).toLocaleString()}</b>${Number(f.saldoPendiente) > 0 ? ' · Pendiente: RD$ ' + Number(f.saldoPendiente).toLocaleString() : ''}</span>
        <span>${f.metodoPago || '—'}</span>
    </div>
    ${f.observacion ? `<div style="font-size:9.5px;color:#64748b;margin-bottom:10px;"><b>Obs.:</b> ${f.observacion}</div>` : ''}
    <div class="fac-firma">
        <div>Firma del paciente</div>
        <div>Facturado por: ${emisor?.nombre || '—'}</div>
    </div>
    <div class="fac-footer">
        Este documento es un recibo interno de KuraDoc y no constituye un comprobante fiscal (NCF) válido ante la DGII.<br>
        Conserve este recibo como constancia de su pago. · ${f.numeroFactura}
    </div>
</div>`;

        // Elimina un overlay de factura anterior si quedó abierto
        const facAnterior = document.getElementById('facPrintOverlay');
        if (facAnterior) facAnterior.remove();

        // Inyecta el overlay DIRECTAMENTE en la página actual (sin window.open).
        // Esto evita por completo el bloqueador de ventanas emergentes y el
        // comportamiento inestable de window.open() dentro de la PWA instalada
        // en Android (donde no hay "chrome" de navegador para mostrar la
        // ventana nueva y termina cerrándose sola).
        const facOverlay = document.createElement('div');
        facOverlay.id = 'facPrintOverlay';
        facOverlay.innerHTML = contenidoHTML;
        facOverlay.addEventListener('click', function (e) {
            if (e.target === facOverlay) facOverlay.remove();
        });
        document.body.appendChild(facOverlay);

        // Carga html2pdf.js solo una vez (bajo demanda) — antes se cargaba
        // vía <script src> dentro del documento de la ventana emergente.
        function _kdCargarHtml2Pdf() {
            if (window.html2pdf) return Promise.resolve();
            if (window._kdHtml2PdfLoading) return window._kdHtml2PdfLoading;
            window._kdHtml2PdfLoading = new Promise(function (resolve, reject) {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
                s.onload = function () { resolve(); };
                s.onerror = function () { reject(new Error('No se pudo cargar html2pdf')); };
                document.head.appendChild(s);
            });
            return window._kdHtml2PdfLoading;
        }

        // Genera el PDF a partir ÚNICAMENTE del nodo .fac-sheet dentro del
        // overlay (los botones viven fuera de ese nodo, así que nunca quedan
        // incluidos en el PDF ni en lo que se comparte).
        window._kdCompartirFactura = async function (btn) {
            const original = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '⏳ Generando PDF...';

            try {
                await _kdCargarHtml2Pdf();

                const elemento = facOverlay.querySelector('.fac-sheet');
                const prevShadow = elemento.style.boxShadow;
                const prevMargin = elemento.style.margin;
                elemento.style.boxShadow = 'none';
                elemento.style.margin = '0';

                const nombreArchivo = 'Factura_' + f.numeroFactura + '.pdf';
                const opciones = {
                    margin: 0,
                    filename: nombreArchivo,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true },
                    jsPDF: { unit: 'mm', format: [139.7, 215.9], orientation: 'portrait' }
                };

                const blob = await window.html2pdf().set(opciones).from(elemento).outputPdf('blob');

                elemento.style.boxShadow = prevShadow;
                elemento.style.margin = prevMargin;

                const archivo = new File([blob], nombreArchivo, { type: 'application/pdf' });
                if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
                    await navigator.share({
                        files: [archivo],
                        title: 'Factura ' + f.numeroFactura,
                        text: 'Factura ' + f.numeroFactura
                    }).catch(function () {});
                } else {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = nombreArchivo;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
                }
            } catch (err) {
                console.error('Error generando PDF:', err);
                alert('No se pudo generar el PDF para compartir. Intenta con "Imprimir" y elige "Guardar como PDF" desde ahí.');
            } finally {
                btn.disabled = false;
                btn.innerHTML = original;
            }
        };
    };

})();
