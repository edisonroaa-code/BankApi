export {};

declare global {
  interface Window {
    bankapi?: {
      getAppVersion?: () => Promise<string | null>;
      connection?: {
        get: () => Promise<{ ok: boolean; serverUrl: string | null; error?: string }>;
        save: (payload: { serverUrl: string }) => Promise<{ ok: boolean; serverUrl?: string; error?: string }>;
        clear: () => Promise<{ ok: boolean; error?: string }>;
      };
      services?: {
        status: () => Promise<{
          backend: { available: boolean; running: boolean; pid: number | null; backendDir: string | null };
          ports?: {
            api48300: { listening: boolean; pid: number | null };
            db48543: { listening: boolean; pid: number | null };
          };
          autoStart?: {
            enabled: boolean;
            running: boolean;
            done: boolean;
            ok: boolean | null;
            message: string;
            at: string | null;
            details: any;
          };
        }>;
        autoStartStatus: () => Promise<{
          enabled: boolean;
          running: boolean;
          done: boolean;
          ok: boolean | null;
          message: string;
          at: string | null;
          details: any;
        }>;
        startDb: () => Promise<any>;
        stopDb: () => Promise<any>;
        startBackend: () => Promise<any>;
        stopBackend: () => Promise<any>;
        startAll: () => Promise<any>;
        setMainServer?: () => Promise<any>;
      };
      credentials?: {
        isAvailable: () => Promise<{ ok: boolean; available: boolean }>;
        get: () => Promise<{ ok: boolean; username: string | null; password: string | null; error?: string }>;
        save: (payload: { username: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
        clear: () => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}
