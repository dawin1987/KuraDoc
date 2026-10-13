/* KuraDoc — Login por teléfono (Fase 2, lado del navegador)
 * Se usa solo cuando el campo NO contiene "@". El flujo por correo no se toca.
 * La validación real ocurre en la Cloud Function `loginTelefono`; aquí solo se
 * muestra/oculta el campo de código de paciente y se inicia sesión con el token. */
(function () {
    'use strict';

    function _mostrarCodigoLogin() {
        const g = document.getElementById('loginCodigoGroup');
        if (!g) return;
        g.classList.remove('hidden');
        setTimeout(() => document.getElementById('loginCodigo')?.focus(), 100);
    }
    function _ocultarCodigoLogin() {
        const g = document.getElementById('loginCodigoGroup');
        if (g) g.classList.add('hidden');
        const c = document.getElementById('loginCodigo');
        if (c) { c.value = ''; c.classList.remove('input-error'); }
    }

    // Si el usuario cambia a un correo o borra el campo, se oculta el código.
    window._loginCampoCambio = function () {
        const v = (document.getElementById('loginEmail')?.value || '').trim();
        if (!v || v.includes('@')) _ocultarCodigoLogin();
    };

    // Lanza errores con { code } para que el manejador existente del login los muestre.
    window._loginPorTelefono = async function (telefono, password) {
        const grupo = document.getElementById('loginCodigoGroup');
        const visible = grupo && !grupo.classList.contains('hidden');
        const codigo = visible ? (document.getElementById('loginCodigo')?.value || '').trim() : '';

        let r;
        try {
            const fn = firebase.functions().httpsCallable('loginTelefono', { timeout: 30000 });
            r = (await fn({ telefono, password, codigoPaciente: codigo || undefined })).data;
        } catch (e) {
            if (e && e.code === 'functions/resource-exhausted') throw { code: 'kd/demasiados' };
            if (e && e.code === 'functions/unauthenticated')    throw { code: 'kd/credenciales' };
            if (e && (e.code === 'functions/unavailable' || /network/i.test(e.message || ''))) {
                throw { code: 'auth/network-request-failed' };
            }
            throw e;   // 'functions/internal', etc. → mensaje de "error inesperado"
        }

        if (r && r.necesitaCodigo) { _mostrarCodigoLogin(); throw { code: 'kd/necesita-codigo' }; }
        if (!r || !r.token)        throw { code: 'kd/credenciales' };

        // Sesión Firebase sobre el MISMO UID del paciente; onAuthStateChanged continúa igual que siempre.
        await firebase.auth().signInWithCustomToken(r.token);
    };
})();
