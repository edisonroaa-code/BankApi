import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum UserRole {
  ADMIN = 'ADMIN',
  SUPERVISOR = 'SUPERVISOR',
  COBRADOR = 'COBRADOR',
  CAJERO = 'CAJERO',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', unique: true })
  username: string; // Added for login

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ select: false })
  password: string;

  /** Incremented atomically whenever credentials change; older JWTs are rejected. */
  @Column({ type: 'integer', default: 0 })
  tokenVersion: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ default: true })
  isActive: boolean;

  // Soft-delete (keeps history/audit integrity)
  @Column({ type: 'timestamp', nullable: true })
  deletedAt?: Date | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
