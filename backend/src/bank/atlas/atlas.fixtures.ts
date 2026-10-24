/** Respuesta de ejemplo del manual "API de Consulta de Movimientos v1.1" (movimientos-detalle). */
export const MANUAL_MOVIMIENTOS_DETALLE = {
  listaMovimiento: [
    {
      monto: 20000,
      numeroCuenta: '123456',
      moneda: { nombre: 'Guaranies', codigo: 6900, iso: 'PYG', simbolo: 'Gs', abreviatura: 'GS' },
      concepto: 'TRANSFERENCIAS ENTRE CUENTAS',
      tipoMovimiento: 'CREDITO',
      fechaMovimiento: '2020-12-24T07:44:08-03:00',
      nroDocumento: 106188,
      nroTransaccionBancard: 0,
      infoAdicional: {
        estado: 'N',
        cod_usuario: 'HOMEBAN1',
        usu_insercion: 'HOMEBAN1',
        reversado: 'N',
        cod_usu_reversion: null,
        cod_tra_padre: 388.0,
        des_tra_padre: 'TRANSFERENCIAS ENTRE CUENTAS',
        cod_transaccion: 602.0,
        des_transaccion: 'CREDITO EN CUENTA AHORROS',
        nro_doc_remitente: '987654-3',
        nom_remitente: 'USUARIO DE PRUEBA',
        nro_cta_remitente: '111666',
        concepto: 'ayuda',
      },
      'fecha Proceso': '2023-06-10',
    },
  ],
};
