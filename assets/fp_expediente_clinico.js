/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  KuraDoc — Expediente Clínico Único Nacional                    ║
 * ║  fp_expediente_clinico.js  v2.0                                 ║
 * ║                                                                  ║
 * ║  Archivo independiente — cargar después de app.logic.js         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ── Shell inicial con skeleton ────────────────────────────────
function _fpTabExpedienteShell(p) {
    const uid = p.uid || p.id;
    setTimeout(() => _fpCargarExpediente(uid), 50);
    return `
    <div id="fp-expediente-${uid}">
        <div style="padding:16px 0 12px;">
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button onclick="_fpAccion('notas','${uid}')"
                    style="flex:1;min-width:200px;padding:14px;
                           background:linear-gradient(135deg,#1e3a5f,#2563eb);
                           color:white;border:none;border-radius:12px;cursor:pointer;
                           font-size:14px;font-weight:700;
                           display:flex;align-items:center;justify-content:center;gap:8px;
                           box-shadow:0 4px 14px rgba(37,99,235,.3);transition:all .2s;"
                    onmouseover="this.style.transform='translateY(-1px)'"
                    onmouseout="this.style.transform=''">
                    ✏️ Nueva Evolución Médica
                </button>
                <button onclick="window._fpAbrirDocumentos('${uid}')"
                    style="flex:1;min-width:200px;padding:14px;
                           background:linear-gradient(135deg,#065f46,#059669);
                           color:white;border:none;border-radius:12px;cursor:pointer;
                           font-size:14px;font-weight:700;
                           display:flex;align-items:center;justify-content:center;gap:8px;
                           box-shadow:0 4px 14px rgba(5,150,105,.3);transition:all .2s;"
                    onmouseover="this.style.transform='translateY(-1px)'"
                    onmouseout="this.style.transform=''">
                    📄 Documentos Clínicos Especializados
                </button>
            </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;padding:10px 0;">
            ${[80,60,90,50,70].map(w=>`
            <div style="height:14px;width:${w}%;background:var(--t);opacity:0.08;
                        border-radius:7px;animation:fpPulse 1.4s ease-in-out infinite;"></div>
            `).join('')}
        </div>
    </div>
    <style>
        @keyframes fpPulse{0%,100%{opacity:.06}50%{opacity:.13}}
    </style>`;
}

// ── Carga asíncrona ───────────────────────────────────────────
async function _fpCargarExpediente(pacienteId) {
    const contenedor = document.getElementById(`fp-expediente-${pacienteId}`);
    if (!contenedor) return;
    try {
        const [notasSnap, recetasSnap, analiticasSnap, estudiosSnap,
               ginecoSnap, pedSnap, nutriSnap, univSnap] = await Promise.all([
            db.collection('historias_clinicas')
              .where('pacienteId','==',pacienteId)
              .orderBy('fecha','desc').limit(10).get(),
            db.collection('solicitudes_recetas')
              .where('pacienteId','==',pacienteId)
              .orderBy('fecha','desc').limit(5).get(),
            db.collection('solicitudes_analiticas')
              .where('pacienteId','==',pacienteId)
              .orderBy('fechaCreacion','desc').limit(5).get(),
            db.collection('solicitudes_estudios')
              .where('pacienteId','==',pacienteId)
              .orderBy('fecha','desc').limit(5).get(),
            db.collection('historia_ginecoobstetrica')
              .where('pacienteId','==',pacienteId).limit(1).get(),
            db.collection('historia_pediatrica')
              .where('pacienteId','==',pacienteId).limit(1).get(),
            db.collection('historia_nutricional')
              .where('pacienteId','==',pacienteId).limit(1).get(),
            db.collection('historias_clinicas_universal')
              .where('pacienteId','==',pacienteId).limit(1).get(),
        ]);

        const notas      = notasSnap.docs.map(d=>({_id:d.id,_tipo:'nota',...d.data()}));
        const recetas    = recetasSnap.docs.map(d=>({_id:d.id,_tipo:'receta',...d.data()}));
        const analiticas = analiticasSnap.docs.map(d=>({_id:d.id,_tipo:'analitica',...d.data()}));
        const estudios   = estudiosSnap.docs.map(d=>({_id:d.id,_tipo:'estudio',...d.data()}));

        const historias = {
            gineco:     !ginecoSnap.empty,
            pediatrica: !pedSnap.empty,
            nutri:      !nutriSnap.empty,
            universal:  !univSnap.empty,
        };

        const timeline = [...notas,...recetas,...analiticas,...estudios]
            .sort((a,b)=>{
                const fa = a.fecha?.seconds || a.fechaCreacion?.seconds || 0;
                const fb = b.fecha?.seconds || b.fechaCreacion?.seconds || 0;
                return fb - fa;
            });

        const diagnosticosUnicos = [...new Set(
            notas.filter(n=>n.diagnostico).map(n=>n.diagnostico)
        )].slice(0,5);

        const citasArr = (appState.citas||[])
            .filter(c=>c.pacienteId===pacienteId)
            .sort((a,b)=>(b.fechaStr||'').localeCompare(a.fechaStr||''));

        const hoy = new Date().toISOString().split('T')[0];
        const proximaCita = citasArr.filter(c=>c.estado==='pendiente'&&(c.fechaStr||'')>=hoy)
            .sort((a,b)=>(a.fechaStr||'').localeCompare(b.fechaStr||''))[0];

        contenedor.innerHTML = _fpRenderExpediente({
            pacienteId, notas, recetas, analiticas, estudios,
            timeline, diagnosticosUnicos, proximaCita,
            totalCitas: citasArr.length, historias,
        });
    } catch(err) {
        console.error('[Expediente]',err);
        contenedor.innerHTML = `
        <div style="text-align:center;padding:40px;color:#ef4444;">
            <div style="font-size:36px;margin-bottom:8px;">⚠️</div>
            <p style="font-weight:600;">Error cargando el expediente</p>
            <p style="font-size:12px;color:#94a3b8;">${err.message}</p>
            <button onclick="_fpCargarExpediente('${pacienteId}')"
                style="margin-top:12px;padding:8px 20px;background:#2563eb;color:white;
                       border:none;border-radius:8px;cursor:pointer;font-size:13px;">
                🔄 Reintentar
            </button>
        </div>`;
    }
}

// ── Render principal ──────────────────────────────────────────
function _fpRenderExpediente({pacienteId, notas, recetas, analiticas,
    estudios, timeline, diagnosticosUnicos, proximaCita, totalCitas, historias}) {

    const _fecha = ts => {
        if (!ts) return '—';
        if (ts.seconds) return new Date(ts.seconds*1000)
            .toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'});
        if (typeof ts==='string') return ts;
        return '—';
    };

    const _medico = uid => {
        if (!uid) return { nombre:'—', especialidad:'' };
        const u = appState.users?.find(u=>u.uid===uid||u.id===uid);
        return { nombre: u?.nombre||'—', especialidad: u?.especialidad||'' };
    };

    // ── Tarjetas resumen ──────────────────────────────────────
    const resumen = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
                gap:10px;margin-bottom:10px;">
        ${[
            {n:notas.length,     label:'Evoluciones', color:'#2563eb', bg:'#eff6ff', border:'#bfdbfe', icon:''},
            {n:recetas.length,   label:'Recetas',     color:'#059669', bg:'#f0fdf4', border:'#bbf7d0', icon:''},
            {n:analiticas.length,label:'Analíticas',  color:'#7c3aed', bg:'#f5f3ff', border:'#ddd6fe', icon:''},
            {n:estudios.length,  label:'Estudios',    color:'#d97706', bg:'#fffbeb', border:'#fde68a', icon:''},
            {n:totalCitas,       label:'Citas',       color:'#0891b2', bg:'#ecfeff', border:'#a5f3fc', icon:''},
        ].map(x=>`
        <div style="background:${x.bg};border:1px solid ${x.border};border-radius:12px;
                    padding:4px;text-align:center;">
            <div style="font-size:10px;margin-bottom:2px;">${x.icon}</div>
            <div style="font-size:10px;font-weight:700;color:${x.color};">${x.n}</div>
            <div style="font-size:10px;color:#64748b;margin-top:2px;">${x.label}</div>
        </div>`).join('')}
    </div>`;

    // ── Alertas de diagnósticos ───────────────────────────────
    const alertas = diagnosticosUnicos.length ? `
    <div style="background:#fefce8;border:1px solid #fde047;border-radius:12px;
                padding:10px;margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;color:#854d0e;margin-bottom:8px;">
            🔔 Diagnósticos previos registrados
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${diagnosticosUnicos.map(dx=>`
            <span style="background:white;border:1px solid #fde047;color:#854d0e;
                          padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;">
                ${dx}
            </span>`).join('')}
        </div>
    </div>` : '';

    // ── Próxima cita ──────────────────────────────────────────
    const proxCita = proximaCita ? `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;
                padding:14px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">
        <div style="font-size:28px;">📅</div>
        <div style="flex:1;">
            <div style="font-size:11px;font-weight:700;color:#166534;">PRÓXIMA CITA</div>
            <div style="font-size:14px;font-weight:700;color:#14532d;margin-top:2px;">
                ${proximaCita.fechaStr||'—'} · ${proximaCita.tanda||'—'}
            </div>
            <div style="font-size:12px;color:#15803d;margin-top:2px;">
                Dr. ${proximaCita.nombreMedico||'—'} · ${proximaCita.especialidadMedico||''} · ${proximaCita.nombreCentro||'—'}
            </div>
            ${proximaCita.motivo ? `<div style="font-size:11px;color:#4ade80;margin-top:2px;">Motivo: ${proximaCita.motivo}</div>` : ''}
        </div>
        <span style="background:#dcfce7;color:#166534;padding:5px 12px;border-radius:20px;
                      font-size:11px;font-weight:700;flex-shrink:0;">PENDIENTE</span>
    </div>` : '';

    // ── Historias clínicas disponibles ────────────────────────
    const historiasMap = [
        { key:'universal',  icon:'🏥', label:'Historia Universal',        fn:`window._fpAbrirHistoria('${pacienteId}','universal')` },
        { key:'gineco',     icon:'🩺', label:'Gineco-Obstétrica',          fn:`window._fpAbrirHistoria('${pacienteId}','gineco')` },
        { key:'pediatrica', icon:'👶', label:'Historia Pediátrica',        fn:`window._fpAbrirHistoria('${pacienteId}','pediatrico')` },
        { key:'nutri',      icon:'🥗', label:'Historia Nutricional',       fn:`window._fpAbrirHistoria('${pacienteId}','nutri')` },
    ];

    const secHistorias = `
    <div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;
                    letter-spacing:.6px;margin-bottom:10px;">🩺 Historias clínicas especializadas</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px;">
            ${historiasMap.map(h=>{
                const tiene = historias[h.key];
                return `
                <button onclick="${h.fn}"
                    style="background:${tiene?'white':'#f8fafc'};
                           border:${tiene?'1.5px solid #2563eb':'1px dashed #cbd5e1'};
                           border-radius:12px;padding:14px 16px;cursor:pointer;
                           display:flex;align-items:center;gap:10px;transition:all .2s;text-align:left;"
                    onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,.08)'"
                    onmouseout="this.style.transform='';this.style.boxShadow=''">
                    <span style="font-size:22px;">${h.icon}</span>
                    <div>
                        <div style="font-size:13px;font-weight:700;
                                    color:${tiene?'#1e40af':'#64748b'};">
                            ${h.label}
                        </div>
                        <div style="font-size:10px;margin-top:2px;
                                    color:${tiene?'#3b82f6':'#94a3b8'};">
                            ${tiene?'✅ Registrada — clic para ver':'➕ Sin registro — clic para crear'}
                        </div>
                    </div>
                </button>`;
            }).join('')}
        </div>
    </div>`;

    // ── Línea de tiempo ───────────────────────────────────────
    const tipoConfig = {
        nota:      {icon:'📜',label:'Evolución', color:'#2563eb',bg:'#eff6ff'},
        receta:    {icon:'💊',label:'Receta',    color:'#059669',bg:'#f0fdf4'},
        analitica: {icon:'🧬',label:'Analítica', color:'#7c3aed',bg:'#f5f3ff'},
        estudio:   {icon:'🩻',label:'Estudio',   color:'#d97706',bg:'#fffbeb'},
    };

    const timelineHtml = timeline.length===0 ? `
    <div style="text-align:center;padding:40px;color:#94a3b8;">
        <div style="font-size:40px;margin-bottom:10px;">📭</div>
        <p style="font-weight:600;font-size:14px;">Sin registros clínicos aún</p>
    </div>` : timeline.map((ev,i)=>{
        const cfg   = tipoConfig[ev._tipo]||tipoConfig.nota;
        const fecha = _fecha(ev.fecha||ev.fechaCreacion);
        const med   = _medico(ev.medicoId);

        let cuerpo = '';
        if (ev._tipo==='nota') {
            cuerpo = `
            <div style="font-size:11px;font-weight:680;color:#0f172a;margin-bottom:3px;line-height:1.3;">
                ${ev.diagnostico||ev.motivo||'Sin descripción'}
            </div>
            ${ev.dx_codigo?`<span style="background:#dbeafe;color:#1e40af;font-size:10px;
                padding:2px 8px;border-radius:10px;font-weight:700;margin-bottom:2px;display:inline-block;">
                CIE-10: ${ev.dx_codigo} — ${ev.dx_sistema||''}
            </span><br>`:'' }
            ${ev.tratamiento?`<div style="font-size:10px;color:#374151;margin-bottom:2px;">
                <strong>Tratamiento:</strong> ${ev.tratamiento.substring(0,120)}${ev.tratamiento.length>120?'…':''}
            </div>`:''}
            ${ev.comentario?`<div style="font-size:10px;color:#64748b;">
                <strong>Indicaciones:</strong> ${ev.comentario.substring(0,100)}${ev.comentario.length>100?'…':''}
            </div>`:''}`;
        } else if (ev._tipo==='receta') {
            const meds = Array.isArray(ev.medicamentos)
                ? ev.medicamentos.slice(0,3).map(m=>m.nombre||m).join(' · ')
                : (ev.medicamentos||'');
            cuerpo = `
            <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:2px;">
                ${ev.titulo||ev.diagnostico||'Receta médica'}
            </div>
            ${meds?`<div style="font-size:11px;color:#374151;margin-bottom:2px;">
                💊 ${meds}${Array.isArray(ev.medicamentos)&&ev.medicamentos.length>3?` + ${ev.medicamentos.length-3} más`:''}
            </div>`:''}
            <button onclick="window._verDetalleReceta&&window._verDetalleReceta('${ev._id}')"
                style="background:#f0fdf4;color:#059669;border:1px solid #86efac;
                       padding:4px 12px;border-radius:8px;font-size:11px;font-weight:700;
                       cursor:pointer;transition:all .15s;"
                onmouseover="this.style.background='#dcfce7'"
                onmouseout="this.style.background='#f0fdf4'">
                👁️ Ver receta completa
            </button>`;
        } else if (ev._tipo==='analitica') {
            const cats = Object.keys(ev.analiticas||{}).slice(0,3).join(' · ');
            const {conValor=0,sinValor=0} = typeof contarResultados==='function'
                ? contarResultados(ev.analiticas||{}) : {};
            const total = Object.values(ev.analiticas||{}).flat().length;
            const estado = sinValor===0&&total>0 ? '✅ Completada'
                : conValor>0 ? `⚡ Parcial ${conValor}/${total}` : '⏳ Pendiente';
            cuerpo = `
            <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:4px;">
                ${ev.diagnostico||'Solicitud de laboratorio'}
            </div>
            ${cats?`<div style="font-size:12px;color:#374151;margin-bottom:4px;">
                Áreas: ${cats}${Object.keys(ev.analiticas||{}).length>3?' + más':''}
            </div>`:''}
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-size:11px;color:#7c3aed;font-weight:600;">${estado}</span>
                <button onclick="window.verDetalleSolicitud&&window.verDetalleSolicitud('${ev._id}')"
                    style="background:#f5f3ff;color:#7c3aed;border:1px solid #ddd6fe;
                           padding:4px 12px;border-radius:8px;font-size:11px;font-weight:700;
                           cursor:pointer;transition:all .15s;"
                    onmouseover="this.style.background='#ede9fe'"
                    onmouseout="this.style.background='#f5f3ff'">
                    🧪 Ver detalle solicitud
                </button>
            </div>`;
        } else if (ev._tipo==='estudio') {
            cuerpo = `
            <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:4px;">
                ${ev.titulo||ev.tipo||'Solicitud de estudio'}
            </div>
            ${ev.estado?`<span style="font-size:11px;color:#d97706;font-weight:600;">${ev.estado}</span>`:''}`;
        }

        return `
        <div style="margin-top:11px;display:flex;gap:12px;margin-bottom:14px;position:relative;">
            ${i<timeline.length-1?`
            <div style="position:absolute;left:19px;top:38px;bottom:-14px;width:1px;
                        background:${cfg.color};opacity:0.12;"></div>`:''}
            <div style="width:38px;height:38px;border-radius:50%;background:${cfg.bg};
                        border:2px solid ${cfg.color};display:flex;align-items:center;
                        justify-content:center;font-size:16px;flex-shrink:0;margin-top:2px;">
                ${cfg.icon}
            </div>
            <div style="flex:1;background:white;border:0.5px solid #e2e8f0;border-radius:12px;
                        padding:14px 16px;border-left:3px solid ${cfg.color};">
                <div style="display:flex;justify-content:space-between;
                            align-items:flex-start;gap:8px;margin-bottom:8px;">
                    <span style="background:${cfg.bg};color:${cfg.color};font-size:9px;
                                  font-weight:800;padding:3px 10px;border-radius:10px;
                                  text-transform:uppercase;letter-spacing:.5px;">
                        ${cfg.label}
                    </span>
                    <div style="text-align:right;flex-shrink:0;">
                        <div style="font-size:11px;color:#94a3b8;">${fecha}</div>
                    </div>
                </div>
                ${cuerpo}
                <div style="margin-top:8px;padding-top:8px;border-top:0.5px solid #f1f5f9;
                            display:flex;align-items:center;gap:6px;">
                    <span style="font-size:11px;color:#64748b;font-weight:600;">
                        👨‍⚕️ ${med.nombre}
                    </span>
                    ${med.especialidad?`
                    <span style="font-size:10px;color:#94a3b8;">· ${med.especialidad}  </span>`:''}
                            
                </div>
            </div>
        </div>`;
    }).join('');

    const verTodo = timeline.length>=10 ? `
    <div style="text-align:center;padding:12px 0 8px;">
        <button onclick="_fpAccion('notas','${pacienteId}')"
            style="padding:10px 28px;background:white;border:1px solid #e2e8f0;
                   border-radius:10px;cursor:pointer;font-size:13px;color:#64748b;
                   font-weight:600;transition:all .2s;"
            onmouseover="this.style.borderColor='#2563eb';this.style.color='#2563eb'"
            onmouseout="this.style.borderColor='#e2e8f0';this.style.color='#64748b'">
            Ver historial completo →
        </button>
    </div>` : '';

    return `
    <!-- BOTONES PRINCIPALES -->

 <div class="fp-exp-grid" style="gap:10px;padding-bottom:1px;display:grid;grid-template-columns:800px 1fr;">
      <div style="margin-top:14px;gap:11px;padding-bottom:16px;">
   
           ${resumen}
           ${alertas}
           ${proxCita}
           ${secHistorias}
       </div>
       <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;
                letter-spacing:.6px;margin-bottom:10px; margin-top:11px;">
           <h1 style="margin-left: 10px;color: #595555; font-size: 13px;">📜 Historial clínico — ${timeline.length} registro${timeline.length!==1?'s':''}</h1>
         ${timelineHtml}
         ${verTodo}
      </div>
</div>
`;

 
 
     
  
    
}



// ── Tab Analíticas ────────────────────────────────────────────
function _fpTabAnaliticasFicha(p) {
    const uid = p.uid||p.id;
    setTimeout(()=>_fpCargarAnaliticasFicha(uid),50);
    return `<div id="fp-analiticas-${uid}">
        <div style="text-align:center;padding:40px;color:#94a3b8;">
            <div style="font-size:32px;margin-bottom:8px;animation:fpPulse 1.4s infinite;">⏳</div>
            <p style="font-size:12px;">Cargando analíticas...</p>
        </div>
    </div>`;
}

async function _fpCargarAnaliticasFicha(pacienteId) {
    const c = document.getElementById(`fp-analiticas-${pacienteId}`);
    if (!c) return;
    try {
        const snap = await db.collection('solicitudes_analiticas')
            .where('pacienteId','==',pacienteId)
            .orderBy('fechaCreacion','desc').limit(20).get();

        if (snap.empty) {
            c.innerHTML = `<div style="text-align:center;padding:50px;color:#94a3b8;">
                <div style="font-size:40px;margin-bottom:10px;">🧬</div>
                <p style="font-weight:600;">Sin analíticas registradas</p></div>`;
            return;
        }

        c.innerHTML = `
        <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;
                    letter-spacing:.6px;margin-bottom:12px;">
            🧬 ${snap.size} analítica${snap.size!==1?'s':''} registrada${snap.size!==1?'s':''}
        </div>
        ${snap.docs.map(doc=>{
            const d = doc.data();
            const fecha = d.fechaCreacion?.toDate
                ? d.fechaCreacion.toDate().toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'})
                : d.fecha||'—';
            const cats  = Object.keys(d.analiticas||{});
            const total = Object.values(d.analiticas||{}).flat().length;
            const {conValor=0,sinValor=0} = typeof contarResultados==='function'
                ? contarResultados(d.analiticas||{}) : {};
            const estado = sinValor===0&&total>0 ? {txt:'✅ Completada',   col:'#059669',bg:'#dcfce7'}
                : conValor>0                      ? {txt:`⚡ Parcial ${conValor}/${total}`,col:'#d97706',bg:'#fef9c3'}
                                                  : {txt:'⏳ Pendiente',   col:'#dc2626',bg:'#fef2f2'};
            const urgColor = d.urgencia==='Urgente'?'#f59e0b':d.urgencia==='Stat'?'#dc2626':'#64748b';

            return `
            <div style="background:white;border:0.5px solid #e2e8f0;border-radius:14px;
                        padding:16px;margin-bottom:10px;border-left:3px solid #7c3aed;
                        transition:box-shadow .15s;"
                 onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.07)'"
                 onmouseout="this.style.boxShadow=''">
                <div style="display:flex;justify-content:space-between;
                            align-items:flex-start;gap:10px;margin-bottom:10px;">
                    <div style="flex:1;">
                        <div style="font-size:14px;font-weight:700;color:#0f172a;">
                            🧬 ${d.diagnostico||'Solicitud de laboratorio'}
                        </div>
                        ${d.urgencia?`<span style="background:${urgColor}22;color:${urgColor};
                            font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;
                            margin-top:4px;display:inline-block;">${d.urgencia}</span>`:''}
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div style="font-size:11px;color:#94a3b8;">${fecha}</div>
                        <span style="background:${estado.bg};color:${estado.col};
                                      font-size:10px;font-weight:700;padding:2px 8px;
                                      border-radius:10px;margin-top:4px;display:inline-block;">
                            ${estado.txt}
                        </span>
                    </div>
                </div>
                ${cats.length?`
                <div style="font-size:12px;color:#475569;margin-bottom:10px;">
                    <strong>Áreas:</strong> ${cats.slice(0,4).join(' · ')}${cats.length>4?` + ${cats.length-4} más`:''}
                    <span style="background:#f5f3ff;color:#7c3aed;font-size:10px;font-weight:700;
                                  padding:2px 8px;border-radius:10px;margin-left:6px;">
                        ${total} prueba${total!==1?'s':''}
                    </span>
                </div>`:''}
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button onclick="window.verDetalleSolicitud&&window.verDetalleSolicitud('${doc.id}')"
                        style="background:#f5f3ff;color:#7c3aed;border:1px solid #ddd6fe;
                               padding:7px 16px;border-radius:8px;font-size:12px;font-weight:700;
                               cursor:pointer;transition:all .15s;flex:1;min-width:120px;"
                        onmouseover="this.style.background='#ede9fe'"
                        onmouseout="this.style.background='#f5f3ff'">
                        🧪 Ver Detalle Solicitud
                    </button>
                    <button onclick="window.reimprimir_solicitud&&window.reimprimir_solicitud('${doc.id}')"
                        style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;
                               padding:7px 16px;border-radius:8px;font-size:12px;font-weight:700;
                               cursor:pointer;transition:all .15s;"
                        onmouseover="this.style.background='#fee2e2'"
                        onmouseout="this.style.background='#fef2f2'">
                        🖨️ PDF
                    </button>
                </div>
            </div>`;
        }).join('')}`;
    } catch(e) {
        c.innerHTML = `<div style="color:#ef4444;padding:20px;font-size:12px;">Error: ${e.message}</div>`;
    }
}


// ── Tab Documentos ────────────────────────────────────────────
function _fpTabDocsFicha(p) {
    const uid = p.uid||p.id;
    setTimeout(()=>_fpCargarDocsFicha(uid),50);
    return `<div id="fp-docs-${uid}">
        <div style="text-align:center;padding:40px;color:#94a3b8;">
            <div style="font-size:32px;margin-bottom:8px;animation:fpPulse 1.4s infinite;">⏳</div>
            <p style="font-size:12px;">Cargando documentos...</p>
        </div>
    </div>`;
}

async function _fpCargarDocsFicha(pacienteId) {
    const c = document.getElementById(`fp-docs-${pacienteId}`);
    if (!c) return;
    try {
        const [recetasSnap, estudiosSnap] = await Promise.all([
            db.collection('solicitudes_recetas')
              .where('pacienteId','==',pacienteId)
              .orderBy('fecha','desc').limit(15).get(),
            db.collection('solicitudes_estudios')
              .where('pacienteId','==',pacienteId)
              .orderBy('fecha','desc').limit(15).get(),
        ]);

        const _renderSeccion = (docs, icon, color, bg, border, titulo, btnFn) => {
            if (!docs.length) return '';
            return `
            <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;
                        letter-spacing:.6px;margin:16px 0 10px;">${icon} ${titulo}</div>
            ${docs.map(doc=>{
                const d = doc.data();
                const fecha = d.fecha?.seconds
                    ? new Date(d.fecha.seconds*1000)
                        .toLocaleDateString('es-DO',{day:'2-digit',month:'short',year:'numeric'})
                    : d.fecha||'—';
                const medNombre = d.nombreMedico||'—';
                const meds = Array.isArray(d.medicamentos)
                    ? d.medicamentos.slice(0,3).map(m=>m.nombre||m).join(' · ')
                    : '';

                return `
                <div style="background:white;border:0.5px solid ${border};border-radius:14px;
                            padding:16px;margin-bottom:10px;border-left:3px solid ${color};
                            transition:box-shadow .15s;"
                     onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.07)'"
                     onmouseout="this.style.boxShadow=''">
                    <div style="display:flex;justify-content:space-between;
                                align-items:flex-start;gap:10px;margin-bottom:8px;">
                        <div style="flex:1;">
                            <div style="font-size:14px;font-weight:700;color:#0f172a;">
                                ${icon} ${d.titulo||d.tipo||titulo.slice(0,-1)}
                            </div>
                            ${d.diagnostico?`<div style="font-size:12px;color:#64748b;margin-top:3px;">
                                Dx: ${d.diagnostico.substring(0,80)}
                            </div>`:''}
                            ${meds?`<div style="font-size:12px;color:#374151;margin-top:4px;">
                                💊 ${meds}${Array.isArray(d.medicamentos)&&d.medicamentos.length>3?` + ${d.medicamentos.length-3} más`:''}
                            </div>`:''}
                        </div>
                        <div style="text-align:right;flex-shrink:0;">
                            <div style="font-size:11px;color:#94a3b8;">${fecha}</div>
                            <div style="font-size:11px;color:#64748b;margin-top:2px;">
                                Dr. ${medNombre.split(' ')[0]}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button onclick="${btnFn.replace('__ID__',doc.id)}"
                            style="background:${bg};color:${color};border:1px solid ${border};
                                   padding:7px 16px;border-radius:8px;font-size:12px;font-weight:700;
                                   cursor:pointer;transition:all .15s;flex:1;min-width:120px;">
                            👁️ Ver detalle
                        </button>
                    </div>
                </div>`;
            }).join('')}`;
        };

        const html =
            _renderSeccion(recetasSnap.docs,'💊','#059669','#f0fdf4','#86efac',
                'Recetas',`window._verDetalleReceta&&window._verDetalleReceta('__ID__')`) +
            _renderSeccion(estudiosSnap.docs,'🩻','#d97706','#fffbeb','#fde68a',
                'Estudios',`alert('Ver estudio: __ID__')`);

        c.innerHTML = html || `
        <div style="text-align:center;padding:50px;color:#94a3b8;">
            <div style="font-size:40px;margin-bottom:10px;">📄</div>
            <p style="font-weight:600;">Sin documentos registrados</p>
        </div>`;
    } catch(e) {
        c.innerHTML = `<div style="color:#ef4444;padding:20px;font-size:12px;">Error: ${e.message}</div>`;
    }
}


// ── Tab Citas enriquecido ─────────────────────────────────────
// Sobreescribe _fpTabCitas para mostrar especialidad y motivo
function _fpTabCitas(p) {
    const uid = p.uid||p.id;
    const citasPac = (appState.citas||[])
        .filter(c=>c.pacienteId===uid)
        .sort((a,b)=>(b.fechaStr||'').localeCompare(a.fechaStr||''));

    if (!citasPac.length) return `
    <div style="text-align:center;padding:50px;color:#94a3b8;">
        <div style="font-size:40px;margin-bottom:10px;">📭</div>
        <p style="font-weight:600;">Sin citas registradas</p>
    </div>`;

    const estadoCol = {
        pendiente: '#f59e0b', confirmada:'#2563eb',
        atendida:  '#10b981', cancelada: '#ef4444',
    };

    return `
    <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;
                letter-spacing:.6px;margin-bottom:14px;">
        📅 ${citasPac.length} cita${citasPac.length!==1?'s':''} registrada${citasPac.length!==1?'s':''}
    </div>
    ${citasPac.map(c=>{
        const col = estadoCol[c.estado]||'#94a3b8';
        return `
        <div style="background:white;border:0.5px solid #e2e8f0;border-radius:14px;
                    padding:14px 16px;margin-bottom:10px;border-left:3px solid ${col};
                    transition:box-shadow .15s;"
             onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,.06)'"
             onmouseout="this.style.boxShadow=''">
            <div style="display:flex;justify-content:space-between;
                        align-items:flex-start;gap:10px;">
                <div style="flex:1;">
                    <div style="font-size:14px;font-weight:700;color:#0f172a;">
                        👨‍⚕️ ${c.nombreMedico||'Médico'}
                    </div>
                    ${c.especialidadMedico?`
                    <div style="font-size:11px;color:#64748b;margin-top:2px;">
                        🩺 ${c.especialidadMedico}
                    </div>`:''}
                    ${c.motivo?`
                    <div style="font-size:12px;color:#374151;margin-top:4px;
                                background:#f8fafc;padding:6px 10px;border-radius:8px;">
                        <strong>Motivo:</strong> ${c.motivo}
                    </div>`:''}
                    <div style="font-size:11px;color:#94a3b8;margin-top:6px;">
                        📅 ${c.fechaStr||'—'} · ${c.tanda||'—'} · Turno #${c.numeroOrden||'—'}
                    </div>
                    ${c.nombreCentro?`
                    <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
                        🏥 ${c.nombreCentro}
                    </div>`:''}
                </div>
                <span style="background:${col}18;color:${col};padding:4px 12px;
                              border-radius:20px;font-size:10px;font-weight:700;
                              text-transform:capitalize;flex-shrink:0;white-space:nowrap;">
                    ${c.estado||'pendiente'}
                </span>
            </div>
        </div>`;
    }).join('')}`;
}


// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
//  SISTEMA DE MODAL APILADO v2 — z-index + MutationObserver
//  La ficha NUNCA se oculta. Solo baja de z-index cuando hay
//  un modal encima. Sube de vuelta cuando ese modal desaparece.
//  Si el médico navega fuera, la ficha se destruye limpiamente.
// ═══════════════════════════════════════════════════════════════

const _FP_Z_BASE  = 9999;  // z-index normal de la ficha
const _FP_Z_BAJO  = 1200;   // z-index cuando hay modal encima

// ── Bajar ficha (modal secundario va a abrirse) ───────────────
window._fpBajar = function() {
    const overlay = document.getElementById('fp-overlay');
    if (!overlay) return;
    overlay.style.zIndex = _FP_Z_BAJO;
};

// ── Subir ficha (modal secundario se cerró) ───────────────────
window._fpSubir = function() {
    const overlay = document.getElementById('fp-overlay');
    if (!overlay) return;
    overlay.style.zIndex = _FP_Z_BASE;
};

// ── MutationObserver — detecta cuando modalContainer se vacía ─
// o cuando modalDocumentos vuelve a tener 'hidden'
(function _initFpObserver() {
    // Esperar al DOM
    const init = () => {
        const modalContainer = document.getElementById('modalContainer');
        const modalDocumentos = document.getElementById('modalDocumentos');

        if (!modalContainer || !modalDocumentos) {
            // Reintentar si el DOM no está listo
            setTimeout(init, 500);
            return;
        }

        // Observar modalContainer — cuando se vacía, subir ficha
        const obsContainer = new MutationObserver(() => {
            if (!modalContainer.innerHTML.trim()) {
                window._fpSubir();
            }
        });
        obsContainer.observe(modalContainer, { childList: true });

        // Observar modalDocumentos — cuando se agrega clase 'hidden', subir ficha
        const obsDocumentos = new MutationObserver((mutations) => {
            mutations.forEach(m => {
                if (m.attributeName === 'class') {
                    if (modalDocumentos.classList.contains('hidden')) {
                        window._fpSubir();
                    }
                }
            });
        });
        obsDocumentos.observe(modalDocumentos, { attributes: true });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

// ── Reemplaza _fpAccion — baja ficha en lugar de cerrarla ─────
window._fpAccion = function(accion, pacienteId) {
    _uGet(pacienteId); // asegurar paciente en memoria

    window._fpBajar();

    setTimeout(() => {
        switch (accion) {
            case 'editar':
                if (typeof abrirEditarPerfil === 'function') abrirEditarPerfil(pacienteId);
                break;
            case 'agendar':
                if (typeof iniciarAgendadoDesdeSecretaria === 'function') iniciarAgendadoDesdeSecretaria(pacienteId);
                break;
            case 'imprimir':
                if (typeof imprimirExpedientePaciente === 'function') imprimirExpedientePaciente(pacienteId);
                break;
            case 'record':
                if (typeof abrirModalRecordFicha === 'function') abrirModalRecordFicha(pacienteId);
                break;
            case 'notas':
                if (typeof abrirHistorialPaciente === 'function') abrirHistorialPaciente(pacienteId);
                break;
            case 'facturar':
                if (typeof window.abrirModalFacturar === 'function') window.abrirModalFacturar(pacienteId);
                break;
        }
    }, 150);
};

// ── Abrir documentos clínicos — baja ficha ────────────────────
window._fpAbrirDocumentos = function(pacienteId) {
    window._fpBajar();
    setTimeout(() => {
        if (typeof abrirModalDocumentos === 'function') abrirModalDocumentos(pacienteId);
    }, 150);
};

// ── Abrir historia específica — baja ficha ────────────────────
window._fpAbrirHistoria = function(pacienteId, menuDoc) {
    window._fpBajar();
    setTimeout(() => {
        if (typeof abrirModalDocumentos === 'function') {
            abrirModalDocumentos(pacienteId);
            setTimeout(() => {
                if (typeof activarMenuDoc === 'function') activarMenuDoc(menuDoc);
            }, 350);
        }
    }, 150);
};

// ── navigateTo — cierra la ficha si el médico navega fuera ────
// Envuelve la función original para cerrar limpiamente
(function _patchNavigateTo() {
    const _orig = window.navigateTo;
    if (!_orig) return;
    window.navigateTo = function(view) {
        // Si hay una ficha abierta, cerrarla antes de navegar
        const overlay = document.getElementById('fp-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
            window._fpSubir(); // reset z-index para la próxima vez
        }
        _orig(view);
    };
})();