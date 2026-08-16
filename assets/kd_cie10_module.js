/* ═══════════════════════════════════════════════════════════════════
   KuraDoc — Módulo CIE-10
   Codificación diagnóstica interoperable sin romper texto libre

   ARQUITECTURA:
   ┌─────────────────────────────────────────────────────────────┐
   │  §1  _CIE10[]              — Catálogo 174 códigos           │
   │  §2  _cie10Buscar()        — Motor de búsqueda typeahead    │
   │  §3  _cie10Widget()        — Genera HTML del campo combo    │
   │  §4  _cie10Leer()          — Lee valor seleccionado         │
   │  §5  Patch guardarNotaMedica() — Agrega dx_codigo/sistema   │
   │  §6  Patch renderizado notas   — Muestra badge CIE-10       │
   │  §7  Patch ex_diagnostico      — Historia gineco/universal  │
   └─────────────────────────────────────────────────────────────┘

   PRINCIPIOS:
   • Texto libre NUNCA se elimina — dx_codigo y dx_sistema son opcionales
   • Sin consultas extra a Firebase — datos solo en el objeto nota
   • Compatible con historias ya guardadas (campo ausente = texto libre puro)
   • Un solo widget reutilizable para todos los formularios
═══════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════════════
// §1  CATÁLOGO CIE-10
//     174 códigos de alta frecuencia: atención primaria,
//     gineco-obstetricia, urgencias, pediatría, preventivo
// ══════════════════════════════════════════════════════════════════
const _CIE10 = [
  // ── Respiratorio ──────────────────────────────────────────────
  {c:"J00",    d:"Rinofaringitis aguda (resfriado común)"},
  {c:"J02.9",  d:"Faringitis aguda no especificada"},
  {c:"J03.9",  d:"Amigdalitis aguda no especificada"},
  {c:"J04.0",  d:"Laringitis aguda"},
  {c:"J06.9",  d:"Infección aguda de vías respiratorias superiores, no especificada"},
  {c:"J10.1",  d:"Influenza con manifestaciones respiratorias, virus identificado"},
  {c:"J11.1",  d:"Influenza con manifestaciones respiratorias, virus no identificado"},
  {c:"J18.9",  d:"Neumonía no especificada"},
  {c:"J20.9",  d:"Bronquitis aguda no especificada"},
  {c:"J22",    d:"Infección aguda de vías respiratorias inferiores no especificada"},
  {c:"J30.1",  d:"Rinitis alérgica debida al polen"},
  {c:"J30.4",  d:"Rinitis alérgica no especificada"},
  {c:"J32.9",  d:"Sinusitis crónica no especificada"},
  {c:"J35.0",  d:"Amigdalitis crónica"},
  {c:"J40",    d:"Bronquitis no especificada como aguda o crónica"},
  {c:"J45.9",  d:"Asma no especificada"},
  // ── Digestivo ─────────────────────────────────────────────────
  {c:"A09",    d:"Gastroenteritis y colitis de origen infeccioso y no especificado"},
  {c:"K21.0",  d:"Enfermedad por reflujo gastroesofágico con esofagitis"},
  {c:"K21.9",  d:"Enfermedad por reflujo gastroesofágico sin esofagitis"},
  {c:"K25.9",  d:"Úlcera gástrica no especificada"},
  {c:"K29.7",  d:"Gastritis no especificada"},
  {c:"K37",    d:"Apendicitis no especificada"},
  {c:"K52.9",  d:"Colitis y gastroenteritis no infecciosas no especificadas"},
  {c:"K57.30", d:"Enfermedad diverticular del intestino grueso sin perforación"},
  {c:"K58.0",  d:"Síndrome del intestino irritable con diarrea"},
  {c:"K58.9",  d:"Síndrome del intestino irritable sin diarrea"},
  {c:"K59.0",  d:"Estreñimiento"},
  {c:"K59.1",  d:"Diarrea funcional"},
  {c:"K74.6",  d:"Cirrosis del hígado no especificada"},
  {c:"K80.20", d:"Colelitiasis sin colecistitis"},
  {c:"K92.1",  d:"Melena"},
  {c:"K92.2",  d:"Hemorragia gastrointestinal no especificada"},
  // ── Cardiovascular ────────────────────────────────────────────
  {c:"I10",    d:"Hipertensión esencial (primaria)"},
  {c:"I11.9",  d:"Enfermedad cardíaca hipertensiva sin insuficiencia cardíaca"},
  {c:"I20.9",  d:"Angina de pecho no especificada"},
  {c:"I21.9",  d:"Infarto agudo al miocardio no especificado"},
  {c:"I25.10", d:"Enfermedad aterosclerótica del corazón"},
  {c:"I48.0",  d:"Fibrilación auricular paroxística"},
  {c:"I48.2",  d:"Fibrilación auricular crónica"},
  {c:"I50.9",  d:"Insuficiencia cardíaca no especificada"},
  {c:"I63.9",  d:"Infarto cerebral no especificado"},
  {c:"I64",    d:"Accidente vascular encefálico no especificado"},
  {c:"I70.2",  d:"Arteriosclerosis de las arterias de los miembros"},
  {c:"I83.90", d:"Várices de los miembros inferiores sin úlcera ni inflamación"},
  // ── Endocrinología ────────────────────────────────────────────
  {c:"E10.9",  d:"Diabetes mellitus tipo 1 sin complicaciones"},
  {c:"E11.9",  d:"Diabetes mellitus tipo 2 sin complicaciones"},
  {c:"E11.65", d:"Diabetes mellitus tipo 2 con hiperglucemia"},
  {c:"E11.40", d:"Diabetes tipo 2 con neuropatía diabética no especificada"},
  {c:"E11.36", d:"Diabetes tipo 2 con retinopatía diabética"},
  {c:"E03.9",  d:"Hipotiroidismo no especificado"},
  {c:"E05.90", d:"Tirotoxicosis no especificada sin crisis"},
  {c:"E66.9",  d:"Obesidad no especificada"},
  {c:"E78.5",  d:"Hiperlipidemia no especificada"},
  {c:"E78.0",  d:"Hipercolesterolemia pura"},
  {c:"E87.1",  d:"Hiponatremia"},
  {c:"E87.5",  d:"Hiperpotasemia"},
  {c:"E87.6",  d:"Hipopotasemia"},
  // ── Gineco-Obstetricia ────────────────────────────────────────
  {c:"N91.2",  d:"Amenorrea no especificada"},
  {c:"N92.0",  d:"Menstruación excesiva y frecuente con ciclo regular"},
  {c:"N92.6",  d:"Menstruación irregular no especificada"},
  {c:"N93.9",  d:"Hemorragia uterina o vaginal anormal no especificada"},
  {c:"N94.6",  d:"Dismenorrea no especificada"},
  {c:"N95.1",  d:"Menopausia y climaterio femenino"},
  {c:"N76.0",  d:"Vaginitis aguda"},
  {c:"N72",    d:"Enfermedad inflamatoria del cuello uterino"},
  {c:"N83.20", d:"Quiste ovárico no especificado"},
  {c:"N80.0",  d:"Endometriosis del útero"},
  {c:"O09.90", d:"Embarazo no especificado"},
  {c:"O10.02", d:"Hipertensión esencial preexistente en el embarazo"},
  {c:"O13",    d:"Hipertensión gestacional sin proteinuria significativa"},
  {c:"O14.10", d:"Preeclampsia severa"},
  {c:"O20.0",  d:"Amenaza de aborto"},
  {c:"O21.0",  d:"Hiperémesis gravídica leve"},
  {c:"O21.9",  d:"Vómitos del embarazo no especificados"},
  {c:"O26.00", d:"Aumento excesivo de peso en el embarazo"},
  {c:"O30.00", d:"Embarazo gemelar no especificado"},
  {c:"O32.1",  d:"Presentación de nalgas"},
  {c:"O34.21", d:"Cicatriz de cesárea anterior"},
  {c:"O36.09", d:"Incompatibilidad Rh, otras"},
  {c:"O42.90", d:"Rotura prematura de membranas no especificada"},
  {c:"O48.0",  d:"Embarazo postérmino"},
  {c:"O60.00", d:"Parto pretérmino sin trabajo de parto"},
  {c:"O80",    d:"Parto único espontáneo, presentación de vértice"},
  {c:"O82",    d:"Parto único por cesárea"},
  {c:"O90.9",  d:"Complicación del puerperio no especificada"},
  {c:"Z34.00", d:"Supervisión de embarazo normal no especificado"},
  {c:"Z34.90", d:"Supervisión de embarazo normal, trimestre no especificado"},
  {c:"Z36",    d:"Detección antenatal"},
  {c:"Z39.1",  d:"Atención y examen de la madre en lactancia"},
  // ── Salud mental ──────────────────────────────────────────────
  {c:"F32.9",  d:"Episodio depresivo no especificado"},
  {c:"F33.9",  d:"Trastorno depresivo recurrente, episodio no especificado"},
  {c:"F41.1",  d:"Trastorno de ansiedad generalizada"},
  {c:"F41.9",  d:"Trastorno de ansiedad no especificado"},
  {c:"F43.10", d:"Trastorno de estrés postraumático no especificado"},
  {c:"F51.01", d:"Insomnio primario"},
  {c:"F10.20", d:"Dependencia al alcohol no complicada"},
  // ── Neurología ────────────────────────────────────────────────
  {c:"G43.909",d:"Migraña no especificada sin estado migrañoso"},
  {c:"G47.00", d:"Insomnio no especificado"},
  {c:"G89.29", d:"Dolor crónico no especificado"},
  {c:"G35",    d:"Esclerosis múltiple"},
  {c:"G20",    d:"Enfermedad de Parkinson"},
  {c:"R51",    d:"Cefalea"},
  // ── Musculoesquelético ────────────────────────────────────────
  {c:"M06.9",  d:"Artritis reumatoide no especificada"},
  {c:"M10.9",  d:"Gota no especificada"},
  {c:"M15.9",  d:"Poliartrosis no especificada"},
  {c:"M16.9",  d:"Coxartrosis no especificada"},
  {c:"M17.9",  d:"Gonartrosis no especificada"},
  {c:"M47.816",d:"Espondilosis lumbar sin mielopatía ni radiculopatía"},
  {c:"M51.16", d:"Degeneración de disco lumbar"},
  {c:"M54.5",  d:"Lumbago no especificado"},
  {c:"M54.2",  d:"Cervicalgia"},
  {c:"M79.7",  d:"Fibromialgia"},
  // ── Urológico ─────────────────────────────────────────────────
  {c:"N30.00", d:"Cistitis aguda sin hematuria"},
  {c:"N10",    d:"Nefritis tubulointersticial aguda"},
  {c:"N18.9",  d:"Enfermedad renal crónica no especificada"},
  {c:"N20.0",  d:"Cálculo del riñón"},
  {c:"N40.0",  d:"Hiperplasia benigna de próstata sin obstrucción"},
  // ── Dermatología ──────────────────────────────────────────────
  {c:"L20.9",  d:"Dermatitis atópica no especificada"},
  {c:"L23.9",  d:"Dermatitis alérgica de contacto no especificada"},
  {c:"L30.9",  d:"Dermatitis no especificada"},
  {c:"L40.9",  d:"Psoriasis no especificada"},
  {c:"B02.9",  d:"Zóster sin complicaciones"},
  {c:"B35.9",  d:"Tiña no especificada"},
  // ── Infecciones generales ─────────────────────────────────────
  {c:"A90",    d:"Dengue clásico"},
  {c:"A91",    d:"Dengue hemorrágico"},
  {c:"A92.0",  d:"Fiebre chikungunya"},
  {c:"B01.9",  d:"Varicela sin complicaciones"},
  {c:"B34.9",  d:"Infección viral no especificada"},
  // ── Hematología ──────────────────────────────────────────────
  {c:"D50.9",  d:"Anemia por deficiencia de hierro no especificada"},
  {c:"D51.9",  d:"Anemia por deficiencia de vitamina B12 no especificada"},
  {c:"D64.9",  d:"Anemia no especificada"},
  // ── Pediatría ────────────────────────────────────────────────
  {c:"P07.30", d:"Pretérmino no especificado"},
  {c:"P22.0",  d:"Síndrome de dificultad respiratoria del recién nacido"},
  {c:"P36.9",  d:"Sepsis bacteriana del recién nacido no especificada"},
  {c:"Z00.110",d:"Visita de salud del recién nacido no especificada"},
  // ── Preventivo / Seguimiento ─────────────────────────────────
  {c:"Z00.00", d:"Examen médico general sin diagnóstico"},
  {c:"Z00.01", d:"Examen médico general de rutina"},
  {c:"Z12.31", d:"Detección de neoplasia maligna de mama"},
  {c:"Z23",    d:"Vacunación"},
  {c:"Z30.09", d:"Anticoncepción general"},
  // ── Síntomas / signos frecuentes ─────────────────────────────
  {c:"R00.0",  d:"Taquicardia no especificada"},
  {c:"R00.1",  d:"Bradicardia no especificada"},
  {c:"R05",    d:"Tos"},
  {c:"R06.0",  d:"Disnea"},
  {c:"R07.9",  d:"Dolor en el pecho no especificado"},
  {c:"R10.0",  d:"Abdomen agudo"},
  {c:"R10.9",  d:"Dolor abdominal no especificado"},
  {c:"R11",    d:"Náuseas y vómitos"},
  {c:"R19.7",  d:"Diarrea"},
  {c:"R50.9",  d:"Fiebre no especificada"},
  {c:"R53.83", d:"Fatiga"},
  {c:"R55",    d:"Síncope y colapso"},
  {c:"R60.0",  d:"Edema localizado"},
  {c:"R63.0",  d:"Anorexia"},
  {c:"R73.09", d:"Hiperglucemia no especificada"},
];

// ══════════════════════════════════════════════════════════════════
// §2  MOTOR DE BÚSQUEDA
//     Busca por código (J06) o descripción parcial ("ira alta")
//     Devuelve máximo 8 resultados, ordenados por relevancia
// ══════════════════════════════════════════════════════════════════
function _cie10Buscar(q) {
    if (!q || q.trim().length < 1) return [];
    const t = q.trim().toLowerCase();
    const exactos   = [];
    const iniciaCon = [];
    const contiene  = [];
    for (const item of _CIE10) {
        const cod  = item.c.toLowerCase();
        const desc = item.d.toLowerCase();
        if (cod === t || desc === t)                    { exactos.push(item);   continue; }
        if (cod.startsWith(t) || desc.startsWith(t))   { iniciaCon.push(item); continue; }
        if (cod.includes(t)   || desc.includes(t))     { contiene.push(item);  }
    }
    return [...exactos, ...iniciaCon, ...contiene].slice(0, 8);
}

// ══════════════════════════════════════════════════════════════════
// §3  WIDGET TYPEAHEAD
//     Genera el HTML completo del campo CIE-10 para insertar
//     junto a cualquier textarea de diagnóstico.
//
//     Parámetros:
//       fieldId   — id base, ej: "notaDiagnostico"
//                   genera: fieldId + "_cie_input"  (input búsqueda)
//                           fieldId + "_cie_codigo" (input hidden código)
//                           fieldId + "_cie_desc"   (input hidden descripción)
//                           fieldId + "_cie_list"   (ul dropdown)
//                           fieldId + "_cie_badge"  (badge confirmación)
//       valorInicial — objeto {codigo, descripcion} para edición
// ══════════════════════════════════════════════════════════════════
function _cie10Widget(fieldId, valorInicial) {
    const vi = valorInicial || {};
    const badgeHTML = vi.codigo
        ? `<span id="${fieldId}_cie_badge" style="
               display:inline-flex;align-items:center;gap:5px;
               background:#eff6ff;color:#1d4ed8;
               border:1px solid #bfdbfe;border-radius:20px;
               padding:2px 8px;font-size:11px;font-weight:700;cursor:pointer;"
           title="Clic para limpiar"
           onclick="_cie10Limpiar('${fieldId}')">
             🏷️ ${vi.codigo} · ${vi.descripcion}
             <span style="color:#93c5fd;font-size:13px;line-height:1;">×</span>
           </span>`
        : `<span id="${fieldId}_cie_badge" style="display:none;"></span>`;

    return `
    <div style="margin-top:5px;" id="${fieldId}_cie_wrap">
      <!-- Inputs ocultos que se guardan en Firestore -->
      <input type="hidden" id="${fieldId}_cie_codigo" value="${vi.codigo || ''}">
      <input type="hidden" id="${fieldId}_cie_desc"   value="${vi.descripcion || ''}">

      <!-- Si ya hay código seleccionado, mostrar badge; si no, mostrar buscador -->
    <div class="form-group">
                                <label class="form-label" style="font-weight: 600; font-size: 12px;">Códico CIE-10</label>
                             </div>
      <div id="${fieldId}_cie_search_area"
           style="display:${vi.codigo ? 'none' : 'block'};">
        <div style="position:relative;">
          <input type="text"
                 id="${fieldId}_cie_input"
                 placeholder="🔍 Buscar código CIE-10 (ej: J06, gripe, HTA…)"
                 autocomplete="off"
                 style="width:100%;padding:5px 8px;font-size:11px;
                        border:1px solid #cbd5e1;border-radius:6px;
                        color:#334155;background:#f8fafc;outline:none;
                        transition:border .15s;"
                 onfocus="this.style.borderColor='#3b82f6';this.style.background='#fff'"
                 onblur="setTimeout(()=>{const l=document.getElementById('${fieldId}_cie_list');if(l)l.style.display='none';},200);this.style.borderColor='#cbd5e1';this.style.background='#f8fafc'"
                 oninput="_cie10OnInput('${fieldId}', this.value)">
          <ul id="${fieldId}_cie_list"
              style="display:none;position:absolute;z-index:9999;
                     top:100%;left:0;right:0;margin:2px 0 0;
                     background:#fff;border:1px solid #e2e8f0;
                     border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);
                     list-style:none;padding:4px 0;max-height:220px;overflow-y:auto;">
          </ul>
        </div>
        <div style="font-size:9px;color:#94a3b8;margin-top:2px;">
          Opcional · el texto libre del diagnóstico se conserva siempre
        </div>
      </div>

      <!-- Badge cuando ya hay código seleccionado -->
      ${badgeHTML}
    </div>`;
}

// ── Caché de últimos resultados por fieldId (para lookup por índice) ──
const _cie10UltimosResultados = {};

// ── Handler oninput del typeahead ──────────────────────────────
window._cie10OnInput = function(fieldId, q) {
    const list = document.getElementById(fieldId + '_cie_list');
    if (!list) return;
    const resultados = _cie10Buscar(q);
    _cie10UltimosResultados[fieldId] = resultados;
    if (!resultados.length || q.trim() === '') {
        list.style.display = 'none';
        list.innerHTML = '';
        return;
    }
    list.innerHTML = resultados.map((r, i) => `
        <li onclick="_cie10SeleccionarIdx('${fieldId}',${i})"
            data-idx="${i}"
            style="padding:7px 12px;cursor:pointer;font-size:11px;
                   display:flex;align-items:center;gap:8px;
                   border-bottom:1px solid #f1f5f9;transition:background .1s;"
            onmouseover="this.style.background='#eff6ff'"
            onmouseout="this.style.background='#fff'">
          <span style="background:#dbeafe;color:#1d4ed8;border-radius:5px;
                       padding:2px 6px;font-weight:800;font-size:10px;
                       flex-shrink:0;white-space:nowrap;">${r.c}</span>
          <span style="color:#334155;line-height:1.3;">${r.d}</span>
        </li>`).join('');
    list.style.display = 'block';
};

// ── Seleccionar por índice (evita problemas con caracteres especiales en onclick) ──
window._cie10SeleccionarIdx = function(fieldId, idx) {
    const resultados = _cie10UltimosResultados[fieldId] || [];
    const item = resultados[idx];
    if (!item) return;
    window._cie10Seleccionar(fieldId, item.c, item.d);
};

// ── Seleccionar un ítem del dropdown ──────────────────────────
window._cie10Seleccionar = function(fieldId, codigo, descripcion) {
    // Guardar en hidden inputs
    document.getElementById(fieldId + '_cie_codigo').value = codigo;
    document.getElementById(fieldId + '_cie_desc').value   = descripcion;

    // Ocultar buscador, mostrar badge
    const area = document.getElementById(fieldId + '_cie_search_area');
    if (area) area.style.display = 'none';

    const badge = document.getElementById(fieldId + '_cie_badge');
    if (badge) {
        badge.style.display = 'inline-flex';
        badge.innerHTML = `
            🏷️ <strong>${codigo}</strong> · ${descripcion}
            <span style="color:#93c5fd;font-size:13px;line-height:1;margin-left:4px;cursor:pointer;"
                  onclick="_cie10Limpiar('${fieldId}')">×</span>`;
    }

    // Cerrar dropdown
    const list = document.getElementById(fieldId + '_cie_list');
    if (list) list.style.display = 'none';
};

// ── Limpiar selección ─────────────────────────────────────────
window._cie10Limpiar = function(fieldId) {
    document.getElementById(fieldId + '_cie_codigo').value = '';
    document.getElementById(fieldId + '_cie_desc').value   = '';
    const input = document.getElementById(fieldId + '_cie_input');
    if (input) input.value = '';
    const area  = document.getElementById(fieldId + '_cie_search_area');
    if (area) area.style.display = 'block';
    const badge = document.getElementById(fieldId + '_cie_badge');
    if (badge) badge.style.display = 'none';
};

// ══════════════════════════════════════════════════════════════════
// §4  LEER VALOR SELECCIONADO
//     Uso: const dx = _cie10Leer('notaDiagnostico');
//     Devuelve: { codigo: "J06.9", descripcion: "IRA alta..." } | null
// ══════════════════════════════════════════════════════════════════
window._cie10Leer = function(fieldId) {
    const cEl = document.getElementById(fieldId + '_cie_codigo');
    const dEl = document.getElementById(fieldId + '_cie_desc');
    if (!cEl || !cEl.value) return null;
    return { codigo: cEl.value, descripcion: dEl?.value || '' };
};

// §5  PATCH — guardarNotaMedica()
//     Sobreescribe la función original para añadir dx_codigo
//     y dx_sistema — llama a la Cloud Function (no Firestore directo)
// ══════════════════════════════════════════════════════════════════

window.guardarNotaMedica = async function(e, pacienteId) {
    e.preventDefault();

    const btn = e.target.querySelector('button[type="submit"]');
    const textoOriginal = btn?.textContent || '💾 Guardar Registro';

    const esSidebar = !!document.getElementById('sidebarHistorial') &&
                      document.getElementById('sidebarHistorial').style.transform === 'translateX(0px)';

    const motivo      = document.getElementById('notaMotivo').value.trim();
    const historia    = document.getElementById('notaHistoria').value.trim();
    const diagnostico = document.getElementById('notaDiagnostico').value.trim();
    const tratamiento = document.getElementById('notaTratamiento').value.trim();
    const comentario  = document.getElementById('notaComentario').value.trim();

    if (!motivo || !diagnostico || !tratamiento) {
        alert('⚠️ Motivo, diagnóstico y tratamiento son obligatorios.');
        return;
    }

    // ── CIE-10 (opcional) ──────────────────────────────────────
    const cie = _cie10Leer('notaDiagnostico');

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    try {
        const guardarNota = firebase.functions().httpsCallable('guardarNotaMedica');

        await guardarNota({
            pacienteId,
            motivo,
            historia,
            diagnostico,
            tratamiento,
            comentario,
            // CIE-10 — solo si el médico seleccionó uno
            dx_codigo:   cie ? cie.codigo      : null,
            dx_sistema:  cie ? cie.descripcion : null,
        });

        e.target.reset();
        _cie10Limpiar('notaDiagnostico');
        await abrirHistorialPaciente(pacienteId, false, esSidebar);
        alert('Nota guardada correctamente.');

    } catch (error) {
        const mensaje = error?.message || 'Error desconocido.';
        alert('❌ Error al guardar: ' + mensaje);
        console.error('[guardarNotaMedica CIE-10]', error);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
    }
};


// ══════════════════════════════════════════════════════════════════
// §6  INYECTAR WIDGET EN EL FORMULARIO DE EVOLUCIÓN
//     Se dispara cada vez que el DOM contiene #notaDiagnostico
//     (el formulario se regenera con innerHTML en abrirHistorialPaciente)
// ══════════════════════════════════════════════════════════════════

/** Inyecta el widget CIE-10 después del textarea #notaDiagnostico */
function _cie10InyectarEnFormulario() {
    const textarea = document.getElementById('notaDiagnostico');
    if (!textarea) return;
    // Evitar duplicados
    if (document.getElementById('notaDiagnostico_cie_wrap')) return;
    textarea.insertAdjacentHTML('afterend', _cie10Widget('notaDiagnostico'));
}

// Observar cambios en el DOM para detectar cuando se re-renderiza el formulario
(function() {
    const observer = new MutationObserver(() => {
        _cie10InyectarEnFormulario();
        _cie10InyectarEnExDiagnostico();
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();

// ══════════════════════════════════════════════════════════════════
// §7  INYECTAR WIDGET EN ex_diagnostico / ex_diagnosticoSec
//     Formularios: historia gineco-obstétrica y universal
// ══════════════════════════════════════════════════════════════════

function _cie10InyectarEnExDiagnostico() {
    // ex_diagnostico (principal)
    const exDx = document.getElementById('ex_diagnostico');
    if (exDx && !document.getElementById('ex_diagnostico_cie_wrap')) {
        exDx.insertAdjacentHTML('afterend', _cie10Widget('ex_diagnostico'));
        // Actualizar label para indicar que CIE-10 ya es un campo aparte
        const label = exDx.closest('.form-group')?.querySelector('label, .form-label');
        if (label && label.textContent.includes('CIE-10')) {
            label.textContent = 'Diagnóstico principal (texto libre)';
        }
    }
    // ex_diagnosticoSec (secundarios)
    const exDxSec = document.getElementById('ex_diagnosticoSec');
    if (exDxSec && !document.getElementById('ex_diagnosticoSec_cie_wrap')) {
        exDxSec.insertAdjacentHTML('afterend', _cie10Widget('ex_diagnosticoSec'));
    }
}

// ══════════════════════════════════════════════════════════════════
// §8  PATCH — guardado historia gineco/universal
//     Intercepta el evento submit de los formularios que contienen
//     ex_diagnostico para añadir los campos CIE-10 al objeto datos
//     antes de que se ejecute el guardado original.
//
//     Estrategia no invasiva: enganchar en el proceso de lectura
//     de datos (gv = getValue) que ya usa el código existente.
// ══════════════════════════════════════════════════════════════════

/**
 * Enriquece un objeto de datos con los campos CIE-10 si están presentes.
 * Llamar justo antes de hacer el .update() o .add() en Firestore.
 * Uso: datos = _cie10EnriquecerDatos(datos);
 */
window._cie10EnriquecerDatos = function(datos) {
    // Diagnóstico principal
    const cie1 = _cie10Leer('ex_diagnostico');
    if (cie1) {
        datos.dx_codigo   = cie1.codigo;
        datos.dx_sistema  = cie1.descripcion;
    }
    // Diagnóstico secundario
    const cie2 = _cie10Leer('ex_diagnosticoSec');
    if (cie2) {
        datos.dx_codigo_sec  = cie2.codigo;
        datos.dx_sistema_sec = cie2.descripcion;
    }
    return datos;
};

// ══════════════════════════════════════════════════════════════════
// §9  RENDERIZADO — Badge CIE-10 en lista de notas
//     Muestra el código como badge visual junto al diagnóstico
//     en las tarjetas del historial.
//     Compatible con notas antiguas (sin dx_codigo = sin badge).
// ══════════════════════════════════════════════════════════════════

/**
 * Genera el badge HTML para mostrar en la tarjeta de nota.
 * Si no hay dx_codigo devuelve cadena vacía (retrocompatible).
 */
window._cie10Badge = function(nota) {
    if (!nota?.dx_codigo) return '';
    return `<span style="
        display:inline-flex;align-items:center;gap:4px;
        background:#dbeafe;color:#1d4ed8;
        border:1px solid #bfdbfe;border-radius:20px;
        padding:2px 8px;font-size:10px;font-weight:800;
        margin-left:6px;vertical-align:middle;"
        title="${nota.dx_sistema || ''}">
      🏷️ ${nota.dx_codigo}
    </span>`;
};

// ══════════════════════════════════════════════════════════════════
// §10  INSTRUCCIONES DE INTEGRACIÓN PARA ex_diagnostico
//      (Historia gineco y universal — guardado manual necesario)
//
//  En la función que construye el objeto `datos` antes de guardarlo
//  (buscar donde se usa gv('ex_diagnostico')), añadir:
//
//      datos = window._cie10EnriquecerDatos(datos);
//
//  Eso es todo. El resto lo maneja el módulo.
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// §11  CSS GLOBAL del widget
// ══════════════════════════════════════════════════════════════════
(function() {
    if (document.getElementById('kd-cie10-styles')) return;
    const st = document.createElement('style');
    st.id = 'kd-cie10-styles';
    st.textContent = `
/* Scrollbar delgado en el dropdown */
#[id$="_cie_list"]::-webkit-scrollbar { width: 4px; }
#[id$="_cie_list"]::-webkit-scrollbar-track { background: #f8fafc; }
#[id$="_cie_list"]::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }

/* Animación de aparición del dropdown */
ul[id$="_cie_list"] {
    animation: cie10FadeIn .12s ease;
}
@keyframes cie10FadeIn {
    from { opacity:0; transform:translateY(-4px); }
    to   { opacity:1; transform:translateY(0); }
}`;
    document.head.appendChild(st);
})();

console.log('[KuraDoc] Módulo CIE-10 cargado ✅ — ' + _CIE10.length + ' códigos disponibles');