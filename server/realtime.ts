import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import type { AuthUser } from './auth.ts';
import { db } from './db.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'logicore-dev-secret-change-in-production';

interface ConnectedClient {
  ws: WebSocket;
  userId: number;
  role: string;
  sessionId?: number;
}

const clientsByUser = new Map<number, Set<ConnectedClient>>();
let wssInstance: WebSocketServer | null = null;

function registerClient(client: ConnectedClient) {
  let set = clientsByUser.get(client.userId);
  if (!set) {
    set = new Set();
    clientsByUser.set(client.userId, set);
  }
  set.add(client);
  broadcastPresence();
}

function unregisterClient(client: ConnectedClient) {
  const set = clientsByUser.get(client.userId);
  if (set) {
    set.delete(client);
    if (set.size === 0) {
      clientsByUser.delete(client.userId);
    }
  }
  broadcastPresence();
}

export function disconnectSession(sessionId: number, reason = 'Session terminated by Super Admin') {
  if (!sessionId) return;
  const serialized = JSON.stringify({ event: 'session:terminated', payload: { sessionId, reason } });
  for (const set of clientsByUser.values()) {
    for (const c of Array.from(set)) {
      if (c.sessionId === sessionId) {
        try {
          if (c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(serialized);
          }
          c.ws.close(4001, reason.slice(0, 120));
        } catch {
          // ignore close errors
        }
        unregisterClient(c);
      }
    }
  }
}

export function getOnlineUserIds(): number[] {
  return Array.from(clientsByUser.keys());
}

export function sendToUser(userId: number, event: string, payload: unknown) {
  const set = clientsByUser.get(userId);
  if (!set || set.size === 0) return;
  const serialized = JSON.stringify({ event, payload });
  for (const c of set) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(serialized);
    }
  }
}

export function sendToSuperAdmins(event: string, payload: unknown) {
  sendToRoles(['super_admin'], event, payload);
}

export function sendToRoles(roles: string[], event: string, payload: unknown) {
  if (!roles.length) return;
  const placeholders = roles.map(() => '?').join(',');
  const users = db
    .prepare(`SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name IN (${placeholders}) AND u.status = 'Active'`)
    .all(...roles) as { id: number }[];
  for (const u of users) {
    sendToUser(u.id, event, payload);
  }
}

export function broadcastAll(event: string, payload: unknown) {
  const serialized = JSON.stringify({ event, payload });
  for (const set of clientsByUser.values()) {
    for (const c of set) {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(serialized);
      }
    }
  }
}

export function broadcastPresence() {
  const onlineIds = getOnlineUserIds();
  const serialized = JSON.stringify({ event: 'presence:update', payload: { onlineUserIds: onlineIds } });
  for (const set of clientsByUser.values()) {
    for (const c of set) {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(serialized);
      }
    }
  }
}

function getIdleTimeoutMs(): number {
  try {
    const row = db
      .prepare("SELECT value_json FROM integration_settings WHERE key = 'security_session_policy'")
      .get() as { value_json: string } | undefined;
    if (row) {
      const mins = Number(JSON.parse(row.value_json)?.idleTimeoutMinutes);
      if (Number.isFinite(mins) && mins >= 5) return mins * 60_000;
    }
  } catch {
    // ignore
  }
  return 60 * 60_000;
}

export function attachRealtimeWebSocket(server: HttpServer) {
  if (wssInstance) return wssInstance;

  const wss = new WebSocketServer({ noServer: true });
  wssInstance = wss;

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') {
        // Leave other upgrade paths (e.g. Vite) untouched
        return;
      }

      const token = url.searchParams.get('token') || '';
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      const dbUser = db
        .prepare('SELECT u.id, u.status, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?')
        .get(decoded.id) as { id: number; status: string; role: string } | undefined;

      if (!dbUser || dbUser.status !== 'Active') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (decoded.session_id) {
        const sess = db
          .prepare('SELECT id, is_active, login_at, last_activity_at FROM login_sessions WHERE id = ? AND user_id = ?')
          .get(decoded.session_id, dbUser.id) as
          | { id: number; is_active: number; login_at: string; last_activity_at?: string | null }
          | undefined;
        if (!sess || !sess.is_active) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const lastTs = new Date(sess.last_activity_at || sess.login_at).getTime();
        if (Number.isFinite(lastTs) && Date.now() - lastTs > getIdleTimeoutMs()) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const client: ConnectedClient = { ws, userId: dbUser.id, role: dbUser.role, sessionId: decoded.session_id };
        registerClient(client);

        ws.send(JSON.stringify({ event: 'presence:update', payload: { onlineUserIds: getOnlineUserIds() } }));

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg?.event === 'ping') {
              ws.send(JSON.stringify({ event: 'pong', payload: { ts: Date.now() } }));
            }
          } catch {
            // ignore malformed frames
          }
        });

        ws.on('close', () => {
          unregisterClient(client);
        });
        ws.on('error', () => {
          unregisterClient(client);
        });
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}
