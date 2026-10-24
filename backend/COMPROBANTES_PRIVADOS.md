# Contrato y despliegue de comprobantes privados

Estado: implementado en esta rama local; **no desplegado ni probado con la cuenta real de Cloudinary**.

## Contrato

- `POST /payments` exige archivo validado y guarda los nuevos activos de Cloudinary como `raw/authenticated`. La base conserva una referencia opaca `cld-auth-raw:...`, no una URL pública. En desarrollo sin Cloudinary, la referencia `local-private:...` queda fuera del servidor estático.
- Todas las respuestas `Payment` del controlador presentan `proofUrl` como `/payments/{id}/proof` y conservan `hasProof`. Las listas siguen sin incluir ubicación del archivo. La ruta es un identificador de recurso, **no** una URL pública que se pueda abrir sin JWT.
- `GET /payments/{id}/proof` requiere rol y el alcance de la consulta: admin/supervisor o cobrador creador. Sirve bytes por el backend con límite de 10 MB, tipo detectado por firma, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` y `X-Robots-Tag: noindex`. El visor obtiene el blob mediante el cliente API autenticado; no coloca direcciones Cloudinary en el DOM.
- El GET registra `PAYMENT_PROOF_VIEWED` luego de recuperar bytes. Es evidencia de recuperación autorizada, **no prueba de que una persona haya leído el documento**. `POST /payments/{id}/proof-viewed` se mantiene temporalmente para PWA cacheadas, devuelve `deprecated: true` y ya no registra el evento; retirar tras comprobar actualización de clientes.

## Históricos y migración

- Las URL antiguas `https://res.cloudinary.com/...` siguen siendo públicas en Cloudinary aunque el backend deje de exponerlas. Este cambio no las revoca. La lectura histórica por el nuevo visor pasa por el proxy, restringido al cloud configurado y sin redirecciones.
- Los archivos históricos `/uploads/...` no se borran y dejan de servirse estáticamente. El proxy los lee con validación de ruta, tamaño, firma y rechazo de enlaces simbólicos. Clientes PWA antiguos que pidan `/uploads` directamente pueden fallar hasta su actualización.
- Antes de migrar Cloudinary histórico: inventario de referencias de base y activos; respaldo verificado; plan de mapeo y reversión; ensayo en entorno aislado; aprobación de operación y ventana de despliegue coordinado. No borrar ni cambiar activos de producción desde esta rama.

## Fallos y verificación pendiente

- Si la base rechaza un alta luego de subir un archivo nuevo, el backend intenta eliminar **solo ese activo nuevo**. Una respuesta ambigua de Cloudinary o un fallo de compensación todavía puede dejar un huérfano. Reconciliar periódicamente el prefijo de nuevos activos con referencias de base, registrar la excepción y revisar individualmente antes de borrar; no hay limpieza automática.
- En una cuenta de laboratorio Cloudinary, verificar un PDF y una imagen `raw/authenticated` de extremo a extremo, la descarga por `private_download_url`, acceso directo sin firma denegado, respuesta 403 del proxy para cobrador ajeno y lectura de un histórico. La suite con mocks y los builds no sustituyen esa prueba.
- Desplegar backend y PWA de manera coordinada. Vigilar errores 403/404 de comprobantes, sesiones de PWA cacheadas, latencia/consumo de Cloudinary y eventos de compensación. No declarar cerrada la brecha histórica hasta revocar o migrar las URL antiguas.
