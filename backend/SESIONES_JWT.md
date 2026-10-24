# Versionado de sesiones JWT

- `users.tokenVersion` se agrega por migración con valor inicial `0`. Cada nuevo JWT incluye ese valor. Los JWT antiguos que no lo incluyen se rechazan: los usuarios deben volver a iniciar sesión tras desplegar este cambio.
- Cambiar una contraseña desde la API, eliminar una cuenta o restablecer la clave con la utilidad de emergencia incrementa `tokenVersion` en la misma transacción que la mutación y su auditoría. Las peticiones HTTP posteriores con JWT previos reciben 401.
- El WebSocket valida `tokenVersion` y vencimiento al conectar, y corta la conexión cuando vence el JWT. Un cambio de contraseña, rol o estado hecho por la API desconecta las conexiones locales mediante un evento en proceso.
- **Límite pendiente:** un restablecimiento por CLI o un cambio en otra instancia no transmite ese evento a los sockets ya conectados. Esos sockets podrían seguir recibiendo eventos hasta vencer su JWT (máximo la duración configurada, hoy un día) o desconectarse; al reconectar, su JWT anterior se rechaza. Para revocación inmediata multiinstancia se necesita evento distribuido o revalidación controlada, sin sondeo frecuente de Neon.
- Aplicar la migración primero en una base descartable y luego en rama de Neon. No usar `DB_SYNCHRONIZE` para este cambio. La migración `down` está bloqueada para no perder el historial de revocaciones.
