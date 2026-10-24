import React, { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { api } from "../../services/api";
import { User, UserRole } from "../../types";

const ROLE_LABELS: Record<string, string> = {
  [UserRole.ADMIN]: "Administrador",
  [UserRole.SUPERVISOR]: "Supervisor",
  [UserRole.COBRADOR]: "Cobrador",
  [UserRole.CAJERO]: "Caja",
};

export const UsersView = ({
  showToast,
  currentUser,
}: {
  showToast: (t: "success" | "error" | "info", m: string) => void;
  currentUser: User;
}) => {
  const [users, setUsers] = useState<User[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState({ name: "", username: "", password: "", role: UserRole.COBRADOR });

  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await api.get("/users");
      setUsers(data);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingUser) {
        const payload: any = { name: formData.name, username: formData.username, role: formData.role };
        if (formData.password) {
          if (formData.password.length !== 6) {
            showToast("error", "La contraseña debe tener seis caracteres.");
            return;
          }
          payload.password = formData.password;
        }
        await api.patch(`/users/${editingUser.id}`, payload);
        showToast("success", "Usuario actualizado");

        if (editingUser.id === currentUser.id && payload.username && payload.username !== currentUser.username) {
          showToast("info", "Tu usuario de login cambió. Volvé a iniciar sesión.");
          localStorage.removeItem("bankapi_session_v1");
          window.dispatchEvent(new CustomEvent("auth:logout"));
        }
      } else {
        if (!formData.password || formData.password.length !== 6) {
          showToast("error", "La contraseña debe tener seis caracteres.");
          return;
        }
        await api.post("/users", formData);
        showToast("success", "Usuario creado");
      }
      setIsModalOpen(false);
      fetchUsers();
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      const detail = Array.isArray(msg) ? msg.join(" • ") : typeof msg === "string" ? msg : null;
      showToast("error", detail || "Error al guardar usuario");
    }
  };

  const toggleStatus = async (user: User) => {
    if (!window.confirm(`¿${user.isActive ? "Desactivar" : "Activar"} a ${user.name}?`)) return;
    try {
      await api.patch(`/users/${user.id}`, { isActive: !user.isActive });
      fetchUsers();
    } catch (e) {
      showToast("error", "Error al cambiar estado");
    }
  };

  const removeUser = async (user: User) => {
    if (!window.confirm(`Eliminar a ${user.name}? (No podrá iniciar sesión y dejará de aparecer en la lista)`)) return;
    try {
      await api.delete(`/users/${user.id}`);
      showToast("success", "Usuario eliminado");
      fetchUsers();
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      showToast("error", typeof msg === "string" ? msg : "No se pudo eliminar el usuario");
    }
  };

  const openModal = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({ name: user.name, username: user.username, password: "", role: user.role });
    } else {
      setEditingUser(null);
      setFormData({ name: "", username: "", password: "", role: UserRole.COBRADOR });
    }
    setIsModalOpen(true);
  };

  // Solo el admin administra usuarios (decision del 2026-10-07): quien cambia la clave de un cajero
  // puede entrar como el. El supervisor ve la lista sin acciones; el backend tambien se lo niega.
  const isAdmin = currentUser.role === UserRole.ADMIN;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-white p-4 rounded-lg shadow-sm border">
        <h3 className="font-bold text-lg text-slate-800 flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-600" /> Gestión de Usuarios
        </h3>
        {isAdmin ? (
          <button onClick={() => openModal()} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
            + Nuevo Usuario
          </button>
        ) : (
          <span className="text-xs text-slate-500">Solo lectura: los usuarios los administra el admin.</span>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left min-w-[720px]">
            <thead className="bg-gray-50 text-gray-600 font-medium border-b">
              <tr>
                <th className="p-3">Nombre</th>
                <th className="p-3">Usuario</th>
                <th className="p-3">Rol</th>
                <th className="p-3">Estado</th>
                {isAdmin && <th className="p-3 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((u) => {
                return (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="p-3 font-medium">{u.name}</td>
                    <td className="p-3 font-mono text-xs">{u.username}</td>
                    <td className="p-3">
                      <span className="bg-gray-100 px-2 py-1 rounded text-xs border">{ROLE_LABELS[u.role] ?? u.role}</span>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-1 rounded-full text-xs ${u.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {u.isActive ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="p-3 text-right space-x-2">
                        <button onClick={() => openModal(u)} className="font-medium text-xs text-blue-600 hover:text-blue-800">
                          Editar
                        </button>
                        <button
                          onClick={() => toggleStatus(u)}
                          className={`text-xs ${u.isActive ? "text-red-500" : "text-green-600"} hover:underline`}
                        >
                          {u.isActive ? "Desactivar" : "Activar"}
                        </button>
                        <button
                          disabled={u.id === currentUser.id}
                          onClick={() => removeUser(u)}
                          className={`text-xs ${u.id === currentUser.id ? "text-gray-400 cursor-not-allowed" : "text-red-700 hover:underline"}`}
                          title={u.id === currentUser.id ? "No puede eliminar su propio usuario" : "Eliminar usuario"}
                        >
                          Eliminar
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white p-6 rounded-lg w-full max-w-md shadow-xl">
            <h3 className="font-bold text-lg mb-4">{editingUser ? "Editar Usuario" : "Nuevo Usuario"}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Nombre Completo</label>
                <input required type="text" className="w-full p-2 border rounded" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Nombre de Usuario (Login)</label>
                <input required type="text" className="w-full p-2 border rounded" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value })} />
                {editingUser && <p className="text-xs text-gray-500 mt-1">Cuidado: Al cambiar el usuario, la sesión actual se cerrará.</p>}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{editingUser ? "Nueva Contraseña (Opcional)" : "Contraseña"}</label>
                <input
                  type="password"
                  required={!editingUser}
                  minLength={6}
                  maxLength={6}
                  className="w-full p-2 border rounded"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder={editingUser ? "Dejar en blanco para no cambiar" : "Seis caracteres"}
                />
                <p className="text-xs text-gray-500 mt-1">Seis caracteres.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Rol</label>
                <select className="w-full p-2 border rounded" value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}>
                  <option value={UserRole.COBRADOR}>Cobrador</option>
                  <option value={UserRole.CAJERO}>Caja</option>
                  <option value={UserRole.SUPERVISOR}>Supervisor</option>
                  <option value={UserRole.ADMIN}>Administrador</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">
                  Cancelar
                </button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

