import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from './typeorm-options';

/**
 * DataSource para la CLI de migraciones. Lee solo variables de entorno del proceso:
 * no carga archivos .env para que nunca apunte a produccion por accidente.
 * Ver "Migraciones" en AGENTS.md.
 */
export default new DataSource(
  // La CLI nunca sincroniza: el esquema cambia solo con migraciones.
  buildTypeOrmOptions((key) => (key === 'DB_SYNCHRONIZE' ? 'false' : process.env[key])),
);
