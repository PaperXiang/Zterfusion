import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/shared/protocol.js';
import { RoomManager } from './RoomManager.js';

const port = Number(process.env.PORT || 3000);
const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
    }
    response.writeHead(404);
    response.end('Not found');
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: process.env.NODE_ENV === 'production'
        ? undefined
        : { origin: ['http://localhost:8999', 'http://127.0.0.1:8999'] },
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60_000,
        skipMiddlewares: true
    }
});
const rooms = new RoomManager(io);

io.on('connection', socket => {
    socket.on('clock:ping', (_clientSentAt, ack) => ack(Date.now()));
    socket.on('room:create', (payload, ack) => ack(rooms.create(socket, payload.name)));
    socket.on('room:join', (payload, ack) => ack(rooms.join(socket, payload.code, payload.name)));
    socket.on('room:resume', (identity, ack) => ack(rooms.resume(socket, identity)));
    socket.on('room:leave', ack => ack(rooms.leave(socket)));
    socket.on('room:updateConfig', (config, ack) => ack(rooms.updateConfig(socket.id, config)));
    socket.on('game:start', ack => ack(rooms.start(socket.id)));
    socket.on('game:restart', ack => ack(rooms.start(socket.id)));
    socket.on('game:hit', hit => rooms.hit(socket.id, hit));
    socket.on('game:pause', ack => ack(rooms.pause(socket.id)));
    socket.on('game:resume', ack => ack(rooms.resumeGame(socket.id)));
    socket.on('disconnect', () => rooms.disconnect(socket.id));
});

httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[Server] Socket.IO listening on :${port}`);
});
